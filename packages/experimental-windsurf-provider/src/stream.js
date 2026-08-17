import { ProviderBoundaryError, safeErrorCode } from "./errors.js";

const finishReasons = new Set(["stop", "length", "tool_call", "content_filter"]);
const upstreamErrorCodes = new Set(["aborted", "upstream_rejected", "upstream_rate_limited", "upstream_unavailable"]);

function normalizeUsage(value) {
  if (!value || typeof value !== "object") {
    return { inputTokens: null, outputTokens: null };
  }

  return {
    inputTokens: Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 ? value.inputTokens : null,
    outputTokens: Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0 ? value.outputTokens : null
  };
}

function safeUpstreamErrorCode(value) {
  return upstreamErrorCodes.has(value) ? value : "upstream_error";
}

function validText(value) {
  return typeof value === "string";
}

function nextWithAbort(iterator, signal) {
  if (!signal) {
    return iterator.next();
  }

  if (signal.aborted) {
    return Promise.reject(new ProviderBoundaryError("aborted"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", rejectOnAbort);
      callback();
    };
    const rejectOnAbort = () => settle(() => reject(new ProviderBoundaryError("aborted")));
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    if (signal.aborted) {
      rejectOnAbort();
    }
    Promise.resolve()
      .then(() => {
        if (signal.aborted) {
          throw new ProviderBoundaryError("aborted");
        }
        return iterator.next();
      })
      .then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error))
      );
  });
}

function closeIterator(iterator) {
  if (!iterator || typeof iterator.return !== "function") {
    return;
  }

  try {
    Promise.resolve(iterator.return()).catch(() => {});
  } catch {
  }
}

export async function* adaptNativeStream({ transport, request } = {}) {
  yield {
    type: "start",
    providerId: request?.providerId,
    modelUid: request?.modelUid
  };

  if (request?.signal?.aborted) {
    yield { type: "error", code: "aborted" };
    return;
  }

  let iterator;
  try {
    if (!transport || typeof transport.stream !== "function") {
      throw new ProviderBoundaryError("transport_not_configured");
    }

    const upstream = transport.stream(request);
    if (!upstream || typeof upstream[Symbol.asyncIterator] !== "function") {
      throw new ProviderBoundaryError("invalid_transport_stream");
    }
    iterator = upstream[Symbol.asyncIterator]();

    while (true) {
      const step = await nextWithAbort(iterator, request?.signal);
      if (!step || step.done) {
        break;
      }
      const event = step.value;
      if (request?.signal?.aborted) {
        yield { type: "error", code: "aborted" };
        return;
      }

      if (!event || typeof event.type !== "string") {
        yield { type: "error", code: "invalid_transport_event" };
        return;
      }

      if (event.type === "text_delta" && validText(event.text)) {
        yield { type: "delta", channel: "text", text: event.text };
        continue;
      }

      if (event.type === "reasoning_delta" && validText(event.text)) {
        yield { type: "delta", channel: "reasoning", text: event.text };
        continue;
      }

      if (event.type === "tool_call_delta" && event.toolCall && typeof event.toolCall === "object") {
        yield { type: "delta", channel: "tool_call", toolCall: event.toolCall };
        continue;
      }

      if (event.type === "usage") {
        yield { type: "usage", ...normalizeUsage(event.usage) };
        continue;
      }

      if (event.type === "finish") {
        const reason = event.reason ?? "stop";
        if (!finishReasons.has(reason)) {
          yield { type: "error", code: "invalid_finish_reason" };
          return;
        }
        yield {
          type: "done",
          reason,
          usage: normalizeUsage(event.usage)
        };
        return;
      }

      if (event.type === "error") {
        yield { type: "error", code: safeUpstreamErrorCode(event.code) };
        return;
      }

      yield { type: "error", code: "invalid_transport_event" };
      return;
    }

    yield { type: "error", code: "missing_terminal_event" };
  } catch (error) {
    yield { type: "error", code: safeErrorCode(error, "transport_failed") };
  } finally {
    closeIterator(iterator);
  }
}
