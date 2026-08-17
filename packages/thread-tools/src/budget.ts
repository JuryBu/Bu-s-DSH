import { putThreadRoundsArtifact, type ThreadArtifactStore } from "./artifact.ts";
import type {
  ThreadArtifactRef,
  ThreadReadBudget,
  ThreadReadResult,
  ThreadRound,
} from "./types.ts";

export const DEFAULT_MAX_BYTES = 96 * 1024;
export const DEFAULT_MAX_TOKENS = 24 * 1024;

export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function roundBytes(round: ThreadRound): number {
  return Buffer.byteLength(JSON.stringify(round), "utf8") + 2;
}

export function normalizeReadBudget(maxBytes?: number, maxTokens?: number): {
  requestedMaxBytes: number;
  requestedMaxTokens: number;
} {
  const requestedMaxBytes = maxBytes ?? DEFAULT_MAX_BYTES;
  const requestedMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isFinite(requestedMaxBytes) || !Number.isFinite(requestedMaxTokens)
    || requestedMaxBytes <= 0 || requestedMaxTokens <= 0) {
    throw new RangeError("maxBytes and maxTokens must be positive finite numbers.");
  }
  return { requestedMaxBytes, requestedMaxTokens };
}

export interface PaginateReadInput {
  sessionId: string;
  snapshotId: string;
  rounds: ThreadRound[];
  startIndex: number;
  maxBytes?: number;
  maxTokens?: number;
  artifactStore: ThreadArtifactStore;
  makeContinuationCursor(nextIndex: number): string;
}

export async function paginateRead(input: PaginateReadInput): Promise<ThreadReadResult> {
  const { requestedMaxBytes, requestedMaxTokens } = normalizeReadBudget(input.maxBytes, input.maxTokens);

  const candidate = input.rounds.slice(input.startIndex);
  const candidateBytes = candidate.reduce((total, round) => total + roundBytes(round), 0);
  const candidateTokens = estimateTokens(candidateBytes);
  const returned: ThreadRound[] = [];
  let returnedBytes = 0;

  for (const round of candidate) {
    const nextBytes = roundBytes(round);
    const nextTokens = estimateTokens(returnedBytes + nextBytes);
    if (returnedBytes + nextBytes > requestedMaxBytes || nextTokens > requestedMaxTokens) {
      break;
    }
    returned.push(round);
    returnedBytes += nextBytes;
  }

  const truncated = returned.length < candidate.length;
  let artifact: ThreadArtifactRef | undefined;
  let continuationCursor: string | undefined;
  if (truncated) {
    artifact = await putThreadRoundsArtifact(input.artifactStore, candidate);
    if (returned.length > 0) {
      continuationCursor = input.makeContinuationCursor(input.startIndex + returned.length);
    }
  }

  const budget: ThreadReadBudget = {
    requestedMaxBytes,
    requestedMaxTokens,
    candidateEstimate: "exact",
    candidateBytes,
    candidateTokens,
    returnedBytes,
    returnedTokens: estimateTokens(returnedBytes),
  };
  return {
    sessionId: input.sessionId,
    snapshotId: input.snapshotId,
    rounds: returned,
    truncated,
    continuationCursor,
    artifact,
    budget,
  };
}
