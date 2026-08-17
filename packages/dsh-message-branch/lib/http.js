import { branchError, MessageBranchError } from "./errors.js";

export const DEFAULT_MESSAGE_BRANCH_BODY_BYTES = 32 * 1024 * 1024;

function localRequest(request) {
  const remoteAddress = request.socket?.remoteAddress ?? "";
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function expectedLocalOrigin(request) {
  const host = request.headers?.host;
  if (typeof host === "string" && /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/iu.test(host)) {
    return "http://" + host;
  }
  return `http://127.0.0.1:${request.socket?.localPort}`;
}

function trustedOrigin(request) {
  const origin = request.headers?.origin;
  return origin === undefined || origin === expectedLocalOrigin(request);
}

function trustedFetchSite(request) {
  const fetchSite = request.headers?.["sec-fetch-site"];
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "same-site";
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function guard(request, response, method) {
  if (!localRequest(request) || !trustedOrigin(request) || !trustedFetchSite(request)) {
    sendJson(response, 403, { ok: false, error: { code: "forbidden", message: "请求来源不受信任" } });
    return false;
  }
  if (request.method !== method) {
    response.setHeader("allow", method);
    sendJson(response, 405, { ok: false, error: { code: "method_not_allowed", message: `此端点只接受 ${method}` } });
    return false;
  }
  return true;
}

function contentLength(request) {
  const value = request.headers?.["content-length"];
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  return Number(value);
}

async function readJson(request, maxBodyBytes) {
  const mediaType = request.headers?.["content-type"];
  if (typeof mediaType !== "string" || !mediaType.toLowerCase().startsWith("application/json")) {
    throw branchError("unsupported_media_type", "编辑并重发请求必须使用 application/json");
  }
  const declaredLength = contentLength(request);
  if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
    throw branchError("request_too_large", "编辑并重发请求超过本地接口大小上限");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBodyBytes) throw branchError("request_too_large", "编辑并重发请求超过本地接口大小上限");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw branchError("invalid_request", "编辑并重发请求不是合法 JSON");
  }
}

function failureStatus(error) {
  if (!(error instanceof MessageBranchError)) return 500;
  if (error.code === "request_too_large") return 413;
  if (error.code === "unsupported_media_type") return 415;
  if (error.code === "session_not_found") return 404;
  if ([
    "session_running",
    "pending_input",
    "stale_source_message",
    "operation_conflict",
    "operation_incomplete",
    "operation_failed",
  ].includes(error.code)) return 409;
  if (error.code === "message_acceptance_timeout") return 504;
  if (["invalid_request", "invalid_attachment", "no_real_user_message", "message_not_found", "snapshot_missing"].includes(error.code)) return 400;
  return 500;
}

function sendFailure(response, error) {
  const known = error instanceof MessageBranchError;
  sendJson(response, failureStatus(error), {
    ok: false,
    error: {
      code: known ? error.code : "internal",
      message: known ? error.message : "消息分支操作失败",
    },
  });
}

export function createMessageBranchRoutes(service, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MESSAGE_BRANCH_BODY_BYTES;
  return [
    {
      kind: "exact",
      path: "/message-branch/availability",
      handler: async (request, response) => {
        if (!guard(request, response, "GET")) return;
        try {
          const requestUrl = new URL(request.url ?? "/message-branch/availability", expectedLocalOrigin(request));
          const sessionId = requestUrl.searchParams.get("sessionId")?.trim();
          if (!sessionId) throw branchError("invalid_request", "sessionId 不能为空");
          const messageId = requestUrl.searchParams.get("messageId")?.trim() || undefined;
          const rawSeq = requestUrl.searchParams.get("sourceEventSeq");
          const sourceEventSeq = rawSeq === null ? undefined : Number(rawSeq);
          if (rawSeq !== null && (!Number.isSafeInteger(sourceEventSeq) || sourceEventSeq < 0)) {
            throw branchError("invalid_request", "sourceEventSeq 必须是非负整数");
          }
          sendJson(response, 200, { ok: true, availability: await service.availability(sessionId, { messageId, sourceEventSeq }) });
        } catch (error) {
          sendFailure(response, error);
        }
      },
    },
    {
      kind: "exact",
      path: "/message-branch/edit-and-resend",
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          const body = await readJson(request, maxBodyBytes);
          sendJson(response, 201, { ok: true, result: await service.editAndResend(body) });
        } catch (error) {
          sendFailure(response, error);
        }
      },
    },
  ];
}
