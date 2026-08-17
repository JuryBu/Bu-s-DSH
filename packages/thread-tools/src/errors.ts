export class ThreadToolsError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ThreadToolsError";
  }
}

export class UnsupportedFormatVersionError extends ThreadToolsError {
  constructor(formatVersion: unknown) {
    super(
      "unsupported_format_version",
      `Only formatVersion=0 is accepted by the fixture fallback; received ${String(formatVersion)}.`,
    );
    this.name = "UnsupportedFormatVersionError";
  }
}

export class MalformedThreadLogError extends ThreadToolsError {
  constructor(message: string) {
    super("malformed_thread_log", message);
    this.name = "MalformedThreadLogError";
  }
}

export class SourceRewriteError extends ThreadToolsError {
  constructor(sourceId: string) {
    super(
      "source_rewritten",
      `Append-only source ${sourceId} became shorter than its committed prefix. Rebuild a new reader instead of reusing this index.`,
    );
    this.name = "SourceRewriteError";
  }
}

export class CursorError extends ThreadToolsError {
  constructor(message: string) {
    super("invalid_cursor", message);
    this.name = "CursorError";
  }
}

export class SnapshotUnavailableError extends ThreadToolsError {
  constructor(snapshotId: string) {
    super(
      "snapshot_unavailable",
      `The immutable snapshot ${snapshotId} is no longer available for this continuation cursor.`,
    );
    this.name = "SnapshotUnavailableError";
  }
}
