import { LargeSessionFallbackDeniedError, MemoryStoreUnavailableError, NativeRecallUnavailableError, ThreadIntegrationError } from "./errors.js";
import { decodeCursor } from "./util.js";

function shouldFallbackOfficial(error) {
  return error instanceof LargeSessionFallbackDeniedError
    || error instanceof ThreadIntegrationError && ["rc6_official_unavailable", "session_not_found"].includes(error.code);
}

export class HybridThreadSource {
  constructor({ memoryStore, officialSmall, currentSession, onFallback }) {
    this.memoryStore = memoryStore;
    this.officialSmall = officialSmall;
    this.currentSession = currentSession;
    this.onFallback = onFallback;
  }

  async run(method, request) {
    try {
      return await this.memoryStore[method](request);
    } catch (error) {
      if (!(error instanceof MemoryStoreUnavailableError)) throw error;
      this.onFallback?.({ method, error });
      return this.officialSmall[method](request);
    }
  }

  listThreads(request) {
    return this.run("listThreads", request);
  }

  async searchThreads(request, exec) {
    const currentSessionId = this.currentSession?.currentSessionId(exec);
    let cursorSessionId;
    if (String(request.continuationCursor ?? "").startsWith("dsh-native-thread-v1.")) {
      cursorSessionId = decodeCursor(request.continuationCursor, "current-session-search")?.sessionId;
    }
    if (cursorSessionId && currentSessionId && cursorSessionId !== currentSessionId) {
      throw new ThreadIntegrationError("native_search_session_mismatch", "thread_search 续读光标属于另一条 DSH 会话，不能送入 Memory Store");
    }
    const targetSessionId = request.sessionId ?? cursorSessionId;
    if (targetSessionId && currentSessionId && targetSessionId === currentSessionId) {
      try {
        return await this.currentSession.searchThreads({ ...request, sessionId: targetSessionId }, exec);
      } catch (error) {
        if (!(error instanceof NativeRecallUnavailableError)) throw error;
        const fallbackReason = `native-unavailable:${error.code}`;
        this.onFallback?.({ method: "searchThreads", error, fallbackReason });
        return this.memoryStore.searchThreads({ ...request, fallbackReason });
      }
    }
    if (targetSessionId) {
      if (typeof this.officialSmall?.searchThreads !== "function") return this.memoryStore.searchThreads(request);
      try {
        return await this.officialSmall.searchThreads({ ...request, sessionId: targetSessionId });
      } catch (error) {
        if (!shouldFallbackOfficial(error)) throw error;
        const fallbackReason = `official-small-unavailable:${error.code ?? "unknown"}`;
        this.onFallback?.({ method: "searchThreads", error, fallbackReason });
        return this.memoryStore.searchThreads({ ...request, fallbackReason });
      }
    }
    return this.run("searchThreads", request);
  }

  async readThread(request, exec) {
    const currentSessionId = this.currentSession?.currentSessionId(exec);
    if (request.sessionId && currentSessionId && request.sessionId === currentSessionId) {
      try {
        return await this.currentSession.readThread(request, exec);
      } catch (error) {
        if (!(error instanceof NativeRecallUnavailableError)) throw error;
        const fallbackReason = `native-unavailable:${error.code}`;
        this.onFallback?.({ method: "readThread", error, fallbackReason });
        return this.memoryStore.readThread({ ...request, fallbackReason });
      }
    }
    if (request.sessionId) {
      if (typeof this.officialSmall?.readThread !== "function") return this.memoryStore.readThread(request);
      try {
        return await this.officialSmall.readThread(request);
      } catch (error) {
        if (!shouldFallbackOfficial(error)) throw error;
        const fallbackReason = `official-small-unavailable:${error.code ?? "unknown"}`;
        this.onFallback?.({ method: "readThread", error, fallbackReason });
        return this.memoryStore.readThread({ ...request, fallbackReason });
      }
    }
    return this.run("readThread", request);
  }

  async recallThread(request, exec) {
    const recallMode = request.recallMode ?? "manual";
    const dataChain = request.dataChain ?? "dsh";
    const isLocalDsh = dataChain === "dsh" || dataChain === "deepseek-harness";
    const currentSessionId = this.currentSession?.currentSessionId(exec);
    const targetSessionId = request.sessionId ?? currentSessionId;
    const routeReasons = [];
    if (!isLocalDsh) routeReasons.push(`cross-host:${dataChain}`);
    if (targetSessionId && currentSessionId && targetSessionId !== currentSessionId) routeReasons.push("cross-session");
    if (recallMode === "full" || recallMode === "auto") routeReasons.push(`deep-recall:${recallMode}`);

    if (isLocalDsh && recallMode === "manual" && targetSessionId && targetSessionId === currentSessionId) {
      try {
        return await this.currentSession.recallThread({ ...request, sessionId: targetSessionId }, exec);
      } catch (error) {
        if (!(error instanceof NativeRecallUnavailableError)) throw error;
        const fallbackReason = `native-unavailable:${error.code}`;
        this.onFallback?.({ method: "recallThread", error, fallbackReason });
        return this.memoryStore.recallThread({ ...request, sessionId: targetSessionId, fallbackReason });
      }
    }
    return this.memoryStore.recallThread({
      ...request,
      sessionId: targetSessionId,
      fallbackReason: routeReasons.join(",") || "native-current-session-not-addressable",
    });
  }
}
