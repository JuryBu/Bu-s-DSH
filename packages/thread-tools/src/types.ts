/** Public candidate contracts for DSH native thread tools. */

export const THREAD_TOOLS_API_VERSION = 1 as const;

export type ThreadRole = "system" | "user" | "assistant" | "tool" | "mixed" | "unknown";
export type ThreadSourceFormat =
  | "jsonl-v0"
  | "zstd-v0"
  | "memory-store-normalized-v3"
  | "rc6-events-v0";
export type ThreadDataSource = "memory-store-cache" | "rc6-official-small" | "fixture";

export interface ThreadRoundRange {
  start: number;
  end: number;
}

export interface ThreadSourceRange {
  blockId: string;
  startOffset: number;
  endOffset: number;
  unit?: "byte" | "event-seq" | "cache-round" | "character";
}

export interface ThreadRound {
  round: number;
  role: ThreadRole;
  content: string;
  timestamp?: string;
  source: ThreadSourceRange;
  partial?: boolean;
}

export interface ThreadSessionHeader {
  sessionId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceFormat: ThreadSourceFormat;
  snapshotId: string;
  roundCount: number;
  roundCountKnown?: boolean;
  committedThroughOffset: number;
  hasPendingTail: boolean;
}

export interface ThreadListRequest {
  limit?: number;
  continuationCursor?: string;
}

export interface ThreadListResult {
  sessions: ThreadSessionHeader[];
  snapshotId: string;
  continuationCursor?: string;
  dataSource?: ThreadDataSource;
}

export interface ThreadSearchRequest {
  query: string;
  sessionId?: string;
  roles?: ThreadRole[];
  limit?: number;
  previewBytes?: number;
  continuationCursor?: string;
}

export interface ThreadSearchMatch {
  sessionId: string;
  snapshotId: string;
  title?: string;
  round?: number;
  role?: ThreadRole;
  preview: string;
  matchKind: "title" | "round" | "content";
}

export interface ThreadSearchResult {
  matches: ThreadSearchMatch[];
  snapshotId: string;
  continuationCursor?: string;
  dataSource?: ThreadDataSource;
}

export interface ThreadReadRequest {
  sessionId: string;
  ranges?: ThreadRoundRange[];
  roles?: ThreadRole[];
  maxBytes?: number;
  maxTokens?: number;
  continuationCursor?: string;
}

export interface ThreadArtifactRef {
  artifactId: string;
  sha256: string;
  bytes: number;
  lines: number;
  mediaType: "text/plain";
}

export interface ThreadReadBudget {
  requestedMaxBytes?: number;
  requestedMaxTokens?: number;
  candidateEstimate: "exact" | "conservative";
  candidateBytes: number;
  candidateTokens: number;
  returnedBytes: number;
  returnedTokens: number;
}

export interface ThreadReadResult {
  sessionId: string;
  snapshotId: string;
  rounds: ThreadRound[];
  truncated: boolean;
  continuationCursor?: string;
  artifact?: ThreadArtifactRef;
  budget: ThreadReadBudget;
  dataSource?: ThreadDataSource;
}

/**
 * The three writes below are intentionally contracts only. Their execution,
 * quota checks, and heat ledger remain outside this read-only candidate.
 */
export interface ThreadMarkUsefulRequest {
  sessionId: string;
  rounds: number[];
  orderedRounds?: number[];
}

export interface ThreadProtectRequest {
  sessionId: string;
  ranges: ThreadRoundRange[];
}

export interface ThreadReleaseProtectionRequest {
  sessionId: string;
  protectionId: string;
}

/** Internal event drafts; readReceiptId is not a model-facing tool parameter. */
export interface ThreadReadRegisteredEventDraft {
  type: "thread.read.registered";
  version: 1;
  sessionId: string;
  contextGenerationId: string;
  readReceiptId: string;
  snapshotId: string;
  rounds: number[];
}

export interface ThreadUsefulMarkedEventDraft {
  type: "thread.useful.marked";
  version: 1;
  sessionId: string;
  contextGenerationId: string;
  readReceiptId: string;
  rounds: number[];
  orderedRounds?: number[];
}

export interface ThreadProtectionCreatedEventDraft {
  type: "thread.protection.created";
  version: 1;
  sessionId: string;
  contextGenerationId: string;
  protectionId: string;
  ranges: ThreadRoundRange[];
}

export interface ThreadProtectionReleasedEventDraft {
  type: "thread.protection.released";
  version: 1;
  sessionId: string;
  contextGenerationId: string;
  protectionId: string;
}

export type ThreadLifecycleEventDraft =
  | ThreadReadRegisteredEventDraft
  | ThreadUsefulMarkedEventDraft
  | ThreadProtectionCreatedEventDraft
  | ThreadProtectionReleasedEventDraft;

export const THREAD_EVENT_DRAFTS = Object.freeze({
  readRegistered: "thread.read.registered",
  usefulMarked: "thread.useful.marked",
  protectionCreated: "thread.protection.created",
  protectionReleased: "thread.protection.released",
});

export interface ThreadToolsHost {
  listThreads(request: ThreadListRequest): Promise<ThreadListResult>;
  searchThreads(request: ThreadSearchRequest): Promise<ThreadSearchResult>;
  readThread(request: ThreadReadRequest): Promise<ThreadReadResult>;
}
