export class ProviderBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProviderBoundaryError";
    this.code = code;
  }
}

export function safeErrorCode(error, fallbackCode) {
  if (error instanceof ProviderBoundaryError) {
    return error.code;
  }

  if (error && typeof error === "object" && error.name === "AbortError") {
    return "aborted";
  }

  return fallbackCode;
}

export function toBoundaryError(error, fallbackCode) {
  return new ProviderBoundaryError(safeErrorCode(error, fallbackCode));
}
