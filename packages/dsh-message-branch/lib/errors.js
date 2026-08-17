export class MessageBranchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MessageBranchError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function branchError(code, message, details) {
  return new MessageBranchError(code, message, details);
}

export function asFailure(error) {
  if (error instanceof MessageBranchError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}
