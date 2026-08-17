import { writeThreadRound, type ThreadArtifactStore, type ThreadArtifactWriter } from "./artifact.ts";
import { estimateTokens, normalizeReadBudget, roundBytes } from "./budget.ts";
import { decodeCursor, encodeCursor, fingerprintCursorRequest } from "./cursor.ts";
import { CursorError, MalformedThreadLogError, SnapshotUnavailableError } from "./errors.ts";
import {
  mergeAdjacentRoundRanges,
  mergeAdjacentSourceRanges,
  normalizeRoles,
  rolesEqual,
  roundIsSelected,
  roundRangesEqual,
} from "./ranges.ts";
import type {
  ThreadArtifactRef,
  ThreadListRequest,
  ThreadListResult,
  ThreadReadRequest,
  ThreadReadResult,
  ThreadRole,
  ThreadRound,
  ThreadRoundRange,
  ThreadSearchRequest,
  ThreadSearchResult,
  ThreadSessionHeader,
  ThreadSourceRange,
  ThreadToolsHost,
} from "./types.ts";

/**
 * Adapter-facing seam only. It intentionally describes the behaviours supplied
 * by rc.6 packages, not their exact exported TypeScript signatures.
 */
export interface Rc6PersistenceJsonlSeam {
  listReadonlyHeaders(request: ThreadListRequest): Promise<ThreadListResult>;
  readFrom(request: Rc6ReadFromRequest): AsyncIterable<Rc6CommittedProjectionBlock>;
}

export interface Rc6ReadFromRequest {
  sessionId: string;
  snapshotId: string;
  fromOffset: number;
  toOffset: number;
}

export interface Rc6CommittedProjectionBlock {
  source: ThreadSourceRange;
  rounds: Iterable<ThreadRound>;
}

export interface Rc6SessionQuerySeam {
  search(request: ThreadSearchRequest): Promise<ThreadSearchResult>;
}

export interface Rc6RoundLocator {
  round: number;
  role: ThreadRole;
  source: ThreadSourceRange;
  /** Conservative upper bounds for the model-facing serialized round. */
  estimatedBytes: number;
  estimatedTokens: number;
}

export interface Rc6ProjectionSnapshot {
  session: ThreadSessionHeader;
  snapshotId: string;
  roundIndex: Rc6RoundLocator[];
  livePersistedReconciled: boolean;
}

export interface Rc6SessionProjectionCacheSeam {
  getSnapshot(request: { sessionId: string; snapshotId?: string }): Promise<Rc6ProjectionSnapshot | undefined>;
}

export interface Rc6ThreadHostSeams {
  persistence: Rc6PersistenceJsonlSeam;
  query: Rc6SessionQuerySeam;
  projectionCache: Rc6SessionProjectionCacheSeam;
}

interface ReadCursorPayload {
  sessionId: string;
  snapshotId: string;
  ranges: ThreadRoundRange[];
  roles?: ThreadRole[];
  nextLocatorIndex: number;
  requestKey: string;
}

interface ReadPlan {
  inlineLocatorIndexes: number[];
  candidateCount: number;
  candidateBytes: number;
  candidateTokens: number;
  truncated: boolean;
  nextLocatorIndex?: number;
}

function readRequestKey(sessionId: string, ranges: readonly ThreadRoundRange[], roles: readonly ThreadRole[] | undefined): string {
  return fingerprintCursorRequest({ sessionId, ranges, roles });
}

function normalizeReadCursor(
  cursor: ReadCursorPayload,
  request: ThreadReadRequest,
): { ranges: ThreadRoundRange[]; roles: ThreadRole[] | undefined; startLocatorIndex: number } {
  if (cursor.sessionId !== request.sessionId) {
    throw new CursorError("Read cursor belongs to a different session.");
  }
  const ranges = mergeAdjacentRoundRanges(cursor.ranges);
  const roles = normalizeRoles(cursor.roles);
  if (cursor.requestKey !== readRequestKey(cursor.sessionId, ranges, roles)) {
    throw new CursorError("Read cursor request binding is invalid.");
  }
  if (!Number.isInteger(cursor.nextLocatorIndex) || cursor.nextLocatorIndex < 0) {
    throw new CursorError("Read cursor position is invalid.");
  }
  if (request.ranges !== undefined && !roundRangesEqual(mergeAdjacentRoundRanges(request.ranges), ranges)) {
    throw new CursorError("Read ranges cannot change while continuing a cursor.");
  }
  if (request.roles !== undefined && !rolesEqual(normalizeRoles(request.roles), roles)) {
    throw new CursorError("Read roles cannot change while continuing a cursor.");
  }
  return { ranges, roles, startLocatorIndex: cursor.nextLocatorIndex };
}

function shortPreview(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let preview = "";
  for (const character of value) {
    const candidate = `${preview}${character}`;
    if (Buffer.byteLength(candidate, "utf8") > Math.max(1, maxBytes - 3)) {
      break;
    }
    preview = candidate;
  }
  return `${preview}...`;
}

function locatorIsSelected(
  locator: Rc6RoundLocator,
  ranges: readonly ThreadRoundRange[],
  roles: readonly ThreadRole[] | undefined,
): boolean {
  return roundIsSelected(locator.round, ranges) && (!roles || roles.includes(locator.role));
}

function validateProjectionIndex(roundIndex: readonly Rc6RoundLocator[]): void {
  let previousRound = -1;
  let previousSourceOffset = -1;
  for (const locator of roundIndex) {
    if (!Number.isInteger(locator.round) || locator.round < 0 || locator.round <= previousRound) {
      throw new MalformedThreadLogError("Projection round locators must have unique, increasing round numbers.");
    }
    if (!locator.source.blockId || !Number.isInteger(locator.source.startOffset)
      || !Number.isInteger(locator.source.endOffset) || locator.source.startOffset < 0
      || locator.source.endOffset < locator.source.startOffset
      || locator.source.startOffset < previousSourceOffset) {
      throw new MalformedThreadLogError("Projection round locators must have monotonic valid source ranges.");
    }
    if (!Number.isSafeInteger(locator.estimatedBytes) || locator.estimatedBytes <= 0
      || !Number.isSafeInteger(locator.estimatedTokens) || locator.estimatedTokens <= 0) {
      throw new MalformedThreadLogError("Projection round locators require positive conservative byte and token estimates.");
    }
    previousRound = locator.round;
    previousSourceOffset = locator.source.startOffset;
  }
}

function addSafeEstimate(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new MalformedThreadLogError("Projection locator estimates exceed the supported numeric range.");
  }
  return result;
}

function planRead(
  roundIndex: readonly Rc6RoundLocator[],
  startLocatorIndex: number,
  ranges: readonly ThreadRoundRange[],
  roles: readonly ThreadRole[] | undefined,
  requestedMaxBytes: number,
  requestedMaxTokens: number,
): ReadPlan {
  if (startLocatorIndex > roundIndex.length) {
    throw new CursorError("Read cursor position exceeds the projection index.");
  }
  const inlineLocatorIndexes: number[] = [];
  let candidateCount = 0;
  let candidateBytes = 0;
  let candidateTokens = 0;
  let inlineBytes = 0;
  let inlineTokens = 0;
  let inlineClosed = false;

  for (let index = startLocatorIndex; index < roundIndex.length; index += 1) {
    const locator = roundIndex[index];
    if (!locatorIsSelected(locator, ranges, roles)) {
      continue;
    }
    candidateCount += 1;
    candidateBytes = addSafeEstimate(candidateBytes, locator.estimatedBytes);
    candidateTokens = addSafeEstimate(candidateTokens, locator.estimatedTokens);
    if (inlineClosed) {
      continue;
    }
    const nextBytes = inlineBytes + locator.estimatedBytes;
    const nextTokens = inlineTokens + locator.estimatedTokens;
    if (nextBytes > requestedMaxBytes || nextTokens > requestedMaxTokens) {
      inlineClosed = true;
      continue;
    }
    inlineLocatorIndexes.push(index);
    inlineBytes = nextBytes;
    inlineTokens = nextTokens;
  }

  const truncated = inlineLocatorIndexes.length < candidateCount;
  return {
    inlineLocatorIndexes,
    candidateCount,
    candidateBytes,
    candidateTokens,
    truncated,
    nextLocatorIndex: truncated && inlineLocatorIndexes.length > 0
      ? inlineLocatorIndexes.at(-1)! + 1
      : undefined,
  };
}

function findLocatorIndex(roundIndex: readonly Rc6RoundLocator[], round: number): number {
  let low = 0;
  let high = roundIndex.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (roundIndex[middle].round < round) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < roundIndex.length && roundIndex[low].round === round ? low : -1;
}

function *iterateSelectedSourceRanges(
  roundIndex: readonly Rc6RoundLocator[],
  startLocatorIndex: number,
  ranges: readonly ThreadRoundRange[],
  roles: readonly ThreadRole[] | undefined,
): Generator<ThreadSourceRange> {
  let current: ThreadSourceRange | undefined;
  for (let index = startLocatorIndex; index < roundIndex.length; index += 1) {
    const locator = roundIndex[index];
    if (!locatorIsSelected(locator, ranges, roles)) {
      continue;
    }
    if (!current || locator.source.startOffset > current.endOffset) {
      if (current) {
        yield current;
      }
      current = { ...locator.source };
      continue;
    }
    current.endOffset = Math.max(current.endOffset, locator.source.endOffset);
    current.blockId = `${current.blockId}+${locator.source.blockId}`;
  }
  if (current) {
    yield current;
  }
}

function validateDecodedRoundEstimate(round: ThreadRound, locator: Rc6RoundLocator): number {
  const bytes = roundBytes(round);
  if (bytes > locator.estimatedBytes || estimateTokens(bytes) > locator.estimatedTokens) {
    throw new MalformedThreadLogError(`Projection estimate for round ${round.round} is not a conservative upper bound.`);
  }
  return bytes;
}

function validateDecodedRoundIdentity(
  round: ThreadRound,
  locator: Rc6RoundLocator,
  requestedRange: ThreadSourceRange,
): void {
  if (round.round !== locator.round || round.role !== locator.role
    || round.source.blockId !== locator.source.blockId
    || round.source.startOffset !== locator.source.startOffset
    || round.source.endOffset !== locator.source.endOffset) {
    throw new MalformedThreadLogError(`Decoded round ${round.round} does not match its projection locator.`);
  }
  if (locator.source.startOffset < requestedRange.startOffset
    || locator.source.endOffset > requestedRange.endOffset) {
    throw new MalformedThreadLogError(`Decoded round ${round.round} falls outside the requested source range.`);
  }
}

/**
 * Production-path adapter. Parsing, persistence, search and live reconciliation
 * stay on official host seams. Only budget-bounded inline rounds are retained;
 * oversized results stream block-by-block into the host artifact writer.
 */
export class Rc6ThreadToolsHostAdapter implements ThreadToolsHost {
  private readonly artifactStore: ThreadArtifactStore;
  private readonly seams: Rc6ThreadHostSeams;

  constructor(
    seams: Rc6ThreadHostSeams,
    options: { artifactStore: ThreadArtifactStore },
  ) {
    this.seams = seams;
    this.artifactStore = options.artifactStore;
  }

  listThreads(request: ThreadListRequest): Promise<ThreadListResult> {
    return this.seams.persistence.listReadonlyHeaders(request);
  }

  async searchThreads(request: ThreadSearchRequest): Promise<ThreadSearchResult> {
    const page = await this.seams.query.search(request);
    const previewBytes = request.previewBytes ?? 240;
    if (!Number.isInteger(previewBytes) || previewBytes < 16 || previewBytes > 1024) {
      throw new RangeError("previewBytes must be an integer from 16 to 1024.");
    }
    return {
      ...page,
      matches: page.matches.map(match => ({ ...match, preview: shortPreview(match.preview, previewBytes) })),
    };
  }

  async readThread(request: ThreadReadRequest): Promise<ThreadReadResult> {
    const cursor = request.continuationCursor
      ? decodeCursor<ReadCursorPayload>(request.continuationCursor, "official-read")
      : undefined;
    const normalizedCursor = cursor ? normalizeReadCursor(cursor, request) : undefined;
    const projection = await this.seams.projectionCache.getSnapshot({
      sessionId: request.sessionId,
      snapshotId: cursor?.snapshotId,
    });
    if (!projection || !projection.livePersistedReconciled
      || projection.session.sessionId !== request.sessionId
      || (cursor && projection.snapshotId !== cursor.snapshotId)) {
      throw new SnapshotUnavailableError(cursor?.snapshotId ?? request.sessionId);
    }

    validateProjectionIndex(projection.roundIndex);
    const ranges = normalizedCursor?.ranges ?? mergeAdjacentRoundRanges(request.ranges ?? []);
    const roles = normalizedCursor?.roles ?? normalizeRoles(request.roles);
    const startLocatorIndex = normalizedCursor?.startLocatorIndex ?? 0;
    const { requestedMaxBytes, requestedMaxTokens } = normalizeReadBudget(request.maxBytes, request.maxTokens);
    const plan = planRead(
      projection.roundIndex,
      startLocatorIndex,
      ranges,
      roles,
      requestedMaxBytes,
      requestedMaxTokens,
    );
    const inlineIndexes = new Set(plan.inlineLocatorIndexes);
    const inlineRounds = new Map<number, ThreadRound>();
    let artifactWriter: ThreadArtifactWriter | undefined;
    let artifact: ThreadArtifactRef | undefined;
    let artifactRoundCount = 0;
    let lastArtifactLocatorIndex = -1;

    const sourceRanges: Iterable<ThreadSourceRange> = plan.truncated
      ? iterateSelectedSourceRanges(projection.roundIndex, startLocatorIndex, ranges, roles)
      : mergeAdjacentSourceRanges(plan.inlineLocatorIndexes.map(index => projection.roundIndex[index].source));

    try {
      if (plan.truncated) {
        artifactWriter = await this.artifactStore.createTextArtifact();
      }
      for (const sourceRange of sourceRanges) {
        for await (const block of this.seams.persistence.readFrom({
          sessionId: request.sessionId,
          snapshotId: projection.snapshotId,
          fromOffset: sourceRange.startOffset,
          toOffset: sourceRange.endOffset,
        })) {
          for (const round of block.rounds) {
            const locatorIndex = findLocatorIndex(projection.roundIndex, round.round);
            if (locatorIndex < startLocatorIndex) {
              continue;
            }
            const locator = projection.roundIndex[locatorIndex];
            if (!locator || !locatorIsSelected(locator, ranges, roles)) {
              continue;
            }
            if (!plan.truncated && !inlineIndexes.has(locatorIndex)) {
              continue;
            }
            validateDecodedRoundIdentity(round, locator, sourceRange);
            const bytes = validateDecodedRoundEstimate(round, locator);
            if (inlineIndexes.has(locatorIndex)) {
              if (inlineRounds.has(locatorIndex)) {
                throw new MalformedThreadLogError("Official persistence yielded the same inline round more than once.");
              }
              inlineRounds.set(locatorIndex, round);
            }
            if (artifactWriter) {
              if (locatorIndex <= lastArtifactLocatorIndex) {
                throw new MalformedThreadLogError("Official persistence yielded selected rounds out of projection order.");
              }
              await writeThreadRound(artifactWriter, round, artifactRoundCount > 0);
              artifactRoundCount += 1;
              lastArtifactLocatorIndex = locatorIndex;
            }
            if (inlineIndexes.has(locatorIndex) && bytes > requestedMaxBytes) {
              throw new MalformedThreadLogError("A planned inline round exceeds the byte budget.");
            }
          }
        }
      }

      if (inlineRounds.size !== plan.inlineLocatorIndexes.length) {
        throw new SnapshotUnavailableError(projection.snapshotId);
      }
      if (artifactWriter) {
        if (artifactRoundCount !== plan.candidateCount) {
          throw new SnapshotUnavailableError(projection.snapshotId);
        }
        artifact = await artifactWriter.complete();
        artifactWriter = undefined;
      }
    } catch (error) {
      if (artifactWriter) {
        try {
          await artifactWriter.abort(error);
        } catch {
        }
      }
      throw error;
    }

    const rounds = plan.inlineLocatorIndexes.map(index => inlineRounds.get(index)!);
    const returnedBytes = rounds.reduce((total, round) => total + roundBytes(round), 0);
    const returnedTokens = estimateTokens(returnedBytes);
    if (returnedBytes > requestedMaxBytes || returnedTokens > requestedMaxTokens) {
      throw new MalformedThreadLogError("Projection estimates underreported the inline page budget.");
    }

    return {
      sessionId: request.sessionId,
      snapshotId: projection.snapshotId,
      rounds,
      truncated: plan.truncated,
      continuationCursor: plan.nextLocatorIndex === undefined
        ? undefined
        : encodeCursor("official-read", {
          sessionId: request.sessionId,
          snapshotId: projection.snapshotId,
          ranges,
          roles,
          nextLocatorIndex: plan.nextLocatorIndex,
          requestKey: readRequestKey(request.sessionId, ranges, roles),
        } satisfies ReadCursorPayload),
      artifact,
      budget: {
        requestedMaxBytes,
        requestedMaxTokens,
        candidateEstimate: "conservative",
        candidateBytes: plan.candidateBytes,
        candidateTokens: plan.candidateTokens,
        returnedBytes,
        returnedTokens,
      },
    };
  }
}
