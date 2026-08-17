export class ThreadIntegrationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ThreadIntegrationError";
    this.code = code;
  }
}

export class MemoryStoreUnavailableError extends ThreadIntegrationError {
  constructor(message, options) {
    super("memory_store_unavailable", message, options);
    this.name = "MemoryStoreUnavailableError";
  }
}

export class MemoryStoreCallError extends ThreadIntegrationError {
  constructor(message, options) {
    super("memory_store_call_failed", message, options);
    this.name = "MemoryStoreCallError";
  }
}

export class NativeRecallUnavailableError extends ThreadIntegrationError {
  constructor(message, options) {
    super("native_recall_unavailable", message, options);
    this.name = "NativeRecallUnavailableError";
  }
}

export class LargeSessionFallbackDeniedError extends ThreadIntegrationError {
  constructor(sessionId, measuredBytes, maximumBytes, options = {}) {
    const measured = Number.isFinite(measuredBytes) ? `${measuredBytes} 字节` : "大小未知";
    super(
      "large_session_requires_memory_store",
      `会话 ${sessionId} 的持久化日志为 ${measured}，${options.reason || `超过官方小会话兜底上限 ${maximumBytes} 字节`}。为避免 readSession() 整体加载大日志，本次读取已拒绝；请恢复 Memory Store 后重试。`,
      options,
    );
    this.name = "LargeSessionFallbackDeniedError";
    this.sessionId = sessionId;
    this.measuredBytes = measuredBytes;
    this.maximumBytes = maximumBytes;
  }
}

export class ThreadCursorError extends ThreadIntegrationError {
  constructor(message) {
    super("invalid_thread_cursor", message);
    this.name = "ThreadCursorError";
  }
}
