import { createHash } from "node:crypto";

import { InMemoryThreadArtifactStore, type ThreadArtifactStore } from "./artifact.ts";
import { paginateRead } from "./budget.ts";
import { decodeCursor, encodeCursor, fingerprintCursorRequest } from "./cursor.ts";
import {
  CursorError,
  MalformedThreadLogError,
  SnapshotUnavailableError,
  SourceRewriteError,
  UnsupportedFormatVersionError,
} from "./errors.ts";
import {
  mergeAdjacentRoundRanges,
  normalizeRoles,
  rolesEqual,
  roundRangesEqual,
  selectRoundsByRange,
} from "./ranges.ts";
import type {
  ThreadListRequest,
  ThreadListResult,
  ThreadReadRequest,
  ThreadReadResult,
  ThreadRole,
  ThreadRound,
  ThreadRoundRange,
  ThreadSearchMatch,
  ThreadSearchRequest,
  ThreadSearchResult,
  ThreadSessionHeader,
  ThreadSourceFormat,
  ThreadSourceRange,
  ThreadToolsHost,
} from "./types.ts";

export interface AppendOnlyByteSource {
  readonly sourceId: string;
  getSize(): Promise<number>;
  readFrom(offset: number): Promise<Uint8Array>;
}

/** A test-only appendable source. It never discovers or opens a DSH session path. */
export class MemoryAppendOnlySource implements AppendOnlyByteSource {
  readonly sourceId: string;
  private bytes: Uint8Array;

  constructor(sourceId: string, initial: string | Uint8Array = "") {
    this.sourceId = sourceId;
    this.bytes = typeof initial === "string" ? new TextEncoder().encode(initial) : initial.slice();
  }

  async getSize(): Promise<number> {
    return this.bytes.byteLength;
  }

  async readFrom(offset: number): Promise<Uint8Array> {
    return this.bytes.slice(offset);
  }

  append(value: string | Uint8Array): void {
    const suffix = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const merged = new Uint8Array(this.bytes.byteLength + suffix.byteLength);
    merged.set(this.bytes, 0);
    merged.set(suffix, this.bytes.byteLength);
    this.bytes = merged;
  }
}

export interface FixtureDecodedZstdFrame {
  sourceStartOffset: number;
  sourceEndOffset: number;
  text: string;
}

/**
 * The production package deliberately has no Zstandard dependency. A host may
 * inject a verified frame decoder; tests inject a synthetic frame decoder.
 */
export interface FixtureZstdDecoder {
  decodeAvailable(input: Uint8Array, absoluteOffset: number): Promise<{
    frames: FixtureDecodedZstdFrame[];
    committedThroughOffset: number;
  }>;
}

interface WireHeader {
  formatVersion: unknown;
  sessionId: unknown;
  title?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface FixtureBlock {
  source: ThreadSourceRange;
  rounds: number[];
}

export interface FixtureThreadSnapshot {
  header: ThreadSessionHeader;
  rounds: ThreadRound[];
  blocks: FixtureBlock[];
}

export interface FixtureIndexDiagnostics {
  syncCount: number;
  scannedFromOffsets: number[];
  committedThroughOffset: number;
  observedSize: number;
  indexedRoundCount: number;
  indexedBlockCount: number;
  hasPendingTail: boolean;
}

export interface IncrementalFixtureThreadIndexOptions {
  sourceFormat: ThreadSourceFormat;
  zstdDecoder?: FixtureZstdDecoder;
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function knownRole(value: unknown): ThreadRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool" ? value : "unknown";
}

function valueToRecord(value: unknown, columns?: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const names = Array.isArray(columns) ? columns : ["round", "role", "content", "timestamp"];
    return Object.fromEntries(names.map((name, index) => [String(name), value[index]]));
  }
  if (!value || typeof value !== "object") {
    throw new MalformedThreadLogError("A packed row must be an object or a positional row array.");
  }
  return value as Record<string, unknown>;
}

function findRowRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(record.rows)) {
    return record.rows.map(row => valueToRecord(row, record.columns));
  }
  if (record.type === "round" || record.kind === "round" || Object.hasOwn(record, "round")) {
    return [record];
  }
  throw new MalformedThreadLogError("A committed JSONL record is neither a round nor packed rows.");
}

function normalizeRound(
  record: Record<string, unknown>,
  source: ThreadSourceRange,
): ThreadRound {
  const roundValue = record.round ?? record.roundNumber;
  if (!Number.isInteger(roundValue) || (roundValue as number) < 0) {
    throw new MalformedThreadLogError("Round records require a non-negative integer round field.");
  }
  const content = record.content ?? record.text;
  if (typeof content !== "string") {
    throw new MalformedThreadLogError("Round records require string content.");
  }
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
  return {
    round: roundValue as number,
    role: knownRole(record.role),
    content,
    timestamp,
    source,
  };
}

function previewAround(content: string, query: string, maxBytes: number): string {
  const lower = content.toLocaleLowerCase();
  const index = lower.indexOf(query.toLocaleLowerCase());
  const window = index >= 0 ? content.slice(Math.max(0, index - 48), index + query.length + 96) : content;
  if (Buffer.byteLength(window, "utf8") <= maxBytes) {
    return window;
  }
  let output = "";
  for (const character of window) {
    if (Buffer.byteLength(`${output}${character}`, "utf8") > Math.max(1, maxBytes - 3)) {
      break;
    }
    output += character;
  }
  return `${output}...`;
}

export class IncrementalFixtureThreadIndex {
  private readonly source: AppendOnlyByteSource;
  private readonly options: IncrementalFixtureThreadIndexOptions;
  private headerSource: Omit<ThreadSessionHeader, "snapshotId" | "roundCount" | "committedThroughOffset" | "hasPendingTail"> | undefined;
  private rounds: ThreadRound[] = [];
  private readonly seenRounds = new Set<number>();
  private blocks: FixtureBlock[] = [];
  private committedThroughOffset = 0;
  private observedSize = 0;
  private pendingJsonlOffset: number | undefined;
  private pendingDecodedText = "";
  private pendingDecodedStartOffset: number | undefined;
  private readonly snapshots = new Map<string, FixtureThreadSnapshot>();
  private currentSnapshotId: string | undefined;
  private syncCount = 0;
  private readonly scannedFromOffsets: number[] = [];

  constructor(
    source: AppendOnlyByteSource,
    options: IncrementalFixtureThreadIndexOptions,
  ) {
    this.source = source;
    this.options = options;
    if (options.sourceFormat === "zstd-v0" && !options.zstdDecoder) {
      throw new MalformedThreadLogError("zstd-v0 fixture fallback requires an injected decoder.");
    }
  }

  async sync(): Promise<void> {
    const size = await this.source.getSize();
    if (size < this.observedSize) {
      throw new SourceRewriteError(this.source.sourceId);
    }
    this.syncCount += 1;
    if (this.options.sourceFormat === "jsonl-v0") {
      await this.syncJsonl(size);
    } else {
      await this.syncZstd(size);
    }
    this.observedSize = size;
    this.publishSnapshot();
  }

  async getSnapshot(snapshotId?: string): Promise<FixtureThreadSnapshot> {
    await this.sync();
    const id = snapshotId ?? this.currentSnapshotId;
    const snapshot = id ? this.snapshots.get(id) : undefined;
    if (!snapshot) {
      throw new SnapshotUnavailableError(id ?? "unpublished");
    }
    return snapshot;
  }

  getDiagnostics(): FixtureIndexDiagnostics {
    return {
      syncCount: this.syncCount,
      scannedFromOffsets: [...this.scannedFromOffsets],
      committedThroughOffset: this.committedThroughOffset,
      observedSize: this.observedSize,
      indexedRoundCount: this.rounds.length,
      indexedBlockCount: this.blocks.length,
      hasPendingTail: this.hasPendingTail(),
    };
  }

  private async syncJsonl(size: number): Promise<void> {
    const fromOffset = this.pendingJsonlOffset ?? this.committedThroughOffset;
    if (size <= fromOffset) {
      return;
    }
    this.scannedFromOffsets.push(fromOffset);
    const bytes = await this.source.readFrom(fromOffset);
    let lineStart = 0;
    let committedEnd = fromOffset;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) {
        continue;
      }
      const lineBytes = bytes.slice(lineStart, index);
      const text = new TextDecoder().decode(lineBytes).replace(/\r$/, "");
      this.consumeWireLine(text, fromOffset + lineStart, fromOffset + index + 1, "jsonl");
      committedEnd = fromOffset + index + 1;
      lineStart = index + 1;
    }
    this.committedThroughOffset = committedEnd;
    this.pendingJsonlOffset = lineStart < bytes.byteLength ? fromOffset + lineStart : undefined;
  }

  private async syncZstd(size: number): Promise<void> {
    const fromOffset = this.committedThroughOffset;
    if (size <= fromOffset) {
      return;
    }
    this.scannedFromOffsets.push(fromOffset);
    const bytes = await this.source.readFrom(fromOffset);
    const decoder = this.options.zstdDecoder;
    if (!decoder) {
      throw new MalformedThreadLogError("Missing injected zstd decoder.");
    }
    const decoded = await decoder.decodeAvailable(bytes, fromOffset);
    if (decoded.committedThroughOffset < fromOffset || decoded.committedThroughOffset > size) {
      throw new MalformedThreadLogError("Injected zstd decoder returned an invalid committed prefix.");
    }
    for (const frame of decoded.frames) {
      if (frame.sourceStartOffset < fromOffset || frame.sourceEndOffset > decoded.committedThroughOffset || frame.sourceEndOffset < frame.sourceStartOffset) {
        throw new MalformedThreadLogError("Injected zstd frame offsets are invalid.");
      }
      this.consumeDecodedFrame(frame);
    }
    this.committedThroughOffset = decoded.committedThroughOffset;
  }

  private consumeDecodedFrame(frame: FixtureDecodedZstdFrame): void {
    const combined = `${this.pendingDecodedText}${frame.text}`;
    let lineStart = this.pendingDecodedStartOffset ?? frame.sourceStartOffset;
    let characterStart = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== "\n") {
        continue;
      }
      const line = combined.slice(characterStart, index).replace(/\r$/, "");
      this.consumeWireLine(line, lineStart, frame.sourceEndOffset, "zstd");
      characterStart = index + 1;
      lineStart = frame.sourceStartOffset;
    }
    this.pendingDecodedText = combined.slice(characterStart);
    this.pendingDecodedStartOffset = this.pendingDecodedText ? lineStart : undefined;
  }

  private consumeWireLine(text: string, startOffset: number, endOffset: number, prefix: "jsonl" | "zstd"): void {
    if (!text.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MalformedThreadLogError("A committed JSONL line is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new MalformedThreadLogError("A committed JSONL line must contain an object.");
    }
    const record = parsed as Record<string, unknown>;
    if (!this.headerSource) {
      const header = record as WireHeader;
      if (header.formatVersion !== 0) {
        throw new UnsupportedFormatVersionError(header.formatVersion);
      }
      if (typeof header.sessionId !== "string" || !header.sessionId) {
        throw new MalformedThreadLogError("formatVersion=0 header requires a sessionId.");
      }
      this.headerSource = {
        sessionId: header.sessionId,
        title: typeof header.title === "string" ? header.title : undefined,
        createdAt: typeof header.createdAt === "string" ? header.createdAt : undefined,
        updatedAt: typeof header.updatedAt === "string" ? header.updatedAt : undefined,
        sourceFormat: this.options.sourceFormat,
      };
      return;
    }

    const source: ThreadSourceRange = {
      blockId: `${prefix}:${startOffset}-${endOffset}`,
      startOffset,
      endOffset,
    };
    const rows = findRowRecords(record).map(row => normalizeRound(row, source));
    const incomingRounds = new Set<number>();
    for (const row of rows) {
      if (this.seenRounds.has(row.round) || incomingRounds.has(row.round)) {
        throw new MalformedThreadLogError(`Round ${row.round} appears more than once in the committed prefix.`);
      }
      incomingRounds.add(row.round);
    }
    for (const row of rows) {
      this.seenRounds.add(row.round);
      let low = 0;
      let high = this.rounds.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.rounds[middle].round < row.round) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      this.rounds.splice(low, 0, row);
    }
    this.blocks.push({ source, rounds: rows.map(row => row.round) });
  }

  private hasPendingTail(): boolean {
    return this.pendingJsonlOffset !== undefined
      || this.pendingDecodedText.length > 0
      || this.observedSize > this.committedThroughOffset;
  }

  private publishSnapshot(): void {
    if (!this.headerSource) {
      return;
    }
    const hasPendingTail = this.hasPendingTail();
    const fingerprint = stableId([
      this.source.sourceId,
      this.options.sourceFormat,
      this.committedThroughOffset,
      hasPendingTail ? "pending" : "committed",
    ].join("\n"));
    if (this.currentSnapshotId === fingerprint) {
      return;
    }
    const header: ThreadSessionHeader = {
      ...this.headerSource,
      snapshotId: fingerprint,
      roundCount: this.rounds.length,
      committedThroughOffset: this.committedThroughOffset,
      hasPendingTail,
    };
    this.snapshots.set(fingerprint, {
      header,
      rounds: this.rounds.map(round => ({ ...round, source: { ...round.source } })),
      blocks: this.blocks.map(block => ({ source: { ...block.source }, rounds: [...block.rounds] })),
    });
    this.currentSnapshotId = fingerprint;
  }
}

interface ListCursorPayload {
  snapshotId: string;
  nextIndex: number;
}

interface SearchCursorPayload {
  snapshotId: string;
  nextIndex: number;
  requestKey: string;
}

interface ReadCursorPayload {
  sessionId: string;
  snapshotId: string;
  ranges: ThreadRoundRange[];
  roles?: ThreadRole[];
  nextIndex: number;
  requestKey: string;
}

interface SearchSnapshot {
  snapshotId: string;
  requestKey: string;
  matches: ThreadSearchMatch[];
}

interface NormalizedSearchRequest {
  query: string;
  sessionId?: string;
  roles?: ThreadRole[];
  previewBytes: number;
  requestKey: string;
}

function readRequestKey(sessionId: string, ranges: readonly ThreadRoundRange[], roles: readonly ThreadRole[] | undefined): string {
  return fingerprintCursorRequest({ sessionId, ranges, roles });
}

function normalizeReadCursor(
  cursor: ReadCursorPayload,
  request: ThreadReadRequest,
): { ranges: ThreadRoundRange[]; roles: ThreadRole[] | undefined; startIndex: number } {
  if (cursor.sessionId !== request.sessionId) {
    throw new CursorError("Read cursor belongs to a different session.");
  }
  const ranges = mergeAdjacentRoundRanges(cursor.ranges);
  const roles = normalizeRoles(cursor.roles);
  if (cursor.requestKey !== readRequestKey(cursor.sessionId, ranges, roles)) {
    throw new CursorError("Read cursor request binding is invalid.");
  }
  if (!Number.isInteger(cursor.nextIndex) || cursor.nextIndex < 0) {
    throw new CursorError("Read cursor position is invalid.");
  }
  if (request.ranges !== undefined && !roundRangesEqual(mergeAdjacentRoundRanges(request.ranges), ranges)) {
    throw new CursorError("Read ranges cannot change while continuing a cursor.");
  }
  if (request.roles !== undefined && !rolesEqual(normalizeRoles(request.roles), roles)) {
    throw new CursorError("Read roles cannot change while continuing a cursor.");
  }
  return { ranges, roles, startIndex: cursor.nextIndex };
}

function normalizeSearchRequest(request: ThreadSearchRequest): NormalizedSearchRequest {
  const query = request.query.trim().toLocaleLowerCase();
  if (!query) {
    throw new RangeError("thread_search requires a non-empty query.");
  }
  const previewBytes = request.previewBytes ?? 240;
  if (!Number.isInteger(previewBytes) || previewBytes < 16 || previewBytes > 1024) {
    throw new RangeError("previewBytes must be an integer from 16 to 1024.");
  }
  const roles = normalizeRoles(request.roles);
  return {
    query,
    sessionId: request.sessionId,
    roles,
    previewBytes,
    requestKey: fingerprintCursorRequest({ query, sessionId: request.sessionId, roles, previewBytes }),
  };
}

function normalizedLimit(limit: number | undefined, fallback: number): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value <= 0 || value > 500) {
    throw new RangeError("limit must be an integer from 1 to 500.");
  }
  return value;
}

function catalogSnapshotId(headers: readonly ThreadSessionHeader[]): string {
  return stableId(headers.map(header => `${header.sessionId}:${header.snapshotId}`).join("|"));
}

/**
 * Explicitly non-production fallback. It supports synthetic fixtures and a
 * future compatibility adapter only; its constructor never scans directories.
 */
export class FixtureThreadHost implements ThreadToolsHost {
  private readonly indexes: IncrementalFixtureThreadIndex[];
  private readonly catalogSnapshots = new Map<string, ThreadSessionHeader[]>();
  private readonly searchSnapshots = new Map<string, SearchSnapshot>();
  private readonly artifactStore: ThreadArtifactStore;

  constructor(
    indexes: IncrementalFixtureThreadIndex[],
    options: { artifactStore?: ThreadArtifactStore } = {},
  ) {
    this.indexes = indexes;
    this.artifactStore = options.artifactStore ?? new InMemoryThreadArtifactStore();
  }

  async listThreads(request: ThreadListRequest): Promise<ThreadListResult> {
    const cursor = request.continuationCursor
      ? decodeCursor<ListCursorPayload>(request.continuationCursor, "fixture-list")
      : undefined;
    let headers: ThreadSessionHeader[];
    let snapshotId: string;
    if (cursor) {
      headers = this.catalogSnapshots.get(cursor.snapshotId) ?? [];
      if (headers.length === 0) {
        throw new SnapshotUnavailableError(cursor.snapshotId);
      }
      snapshotId = cursor.snapshotId;
    } else {
      headers = await this.listCurrentHeaders();
      snapshotId = catalogSnapshotId(headers);
      this.catalogSnapshots.set(snapshotId, headers.map(header => ({ ...header })));
    }
    const startIndex = cursor?.nextIndex ?? 0;
    const limit = normalizedLimit(request.limit, 50);
    const sessions = headers.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + sessions.length;
    return {
      sessions,
      snapshotId,
      continuationCursor: nextIndex < headers.length
        ? encodeCursor("fixture-list", { snapshotId, nextIndex } satisfies ListCursorPayload)
        : undefined,
    };
  }

  async searchThreads(request: ThreadSearchRequest): Promise<ThreadSearchResult> {
    const normalized = normalizeSearchRequest(request);
    const cursor = request.continuationCursor
      ? decodeCursor<SearchCursorPayload>(request.continuationCursor, "fixture-search")
      : undefined;
    let snapshot: SearchSnapshot;
    if (cursor) {
      if (cursor.requestKey !== normalized.requestKey) {
        throw new CursorError("Search query or filters cannot change while continuing a cursor.");
      }
      if (!Number.isInteger(cursor.nextIndex) || cursor.nextIndex < 0) {
        throw new CursorError("Search cursor position is invalid.");
      }
      const found = this.searchSnapshots.get(cursor.snapshotId);
      if (!found || found.requestKey !== cursor.requestKey) {
        throw new SnapshotUnavailableError(cursor.snapshotId);
      }
      snapshot = found;
    } else {
      snapshot = await this.buildSearchSnapshot(normalized);
      this.searchSnapshots.set(snapshot.snapshotId, snapshot);
    }
    const startIndex = cursor?.nextIndex ?? 0;
    const limit = normalizedLimit(request.limit, 30);
    return {
      matches: snapshot.matches.slice(startIndex, startIndex + limit),
      snapshotId: snapshot.snapshotId,
      continuationCursor: startIndex + limit < snapshot.matches.length
        ? encodeCursor("fixture-search", {
          snapshotId: snapshot.snapshotId,
          nextIndex: startIndex + limit,
          requestKey: snapshot.requestKey,
        } satisfies SearchCursorPayload)
        : undefined,
    };
  }

  async readThread(request: ThreadReadRequest): Promise<ThreadReadResult> {
    const cursor = request.continuationCursor
      ? decodeCursor<ReadCursorPayload>(request.continuationCursor, "fixture-read")
      : undefined;
    const normalizedCursor = cursor ? normalizeReadCursor(cursor, request) : undefined;
    const snapshot = await this.findSessionSnapshot(request.sessionId, cursor?.snapshotId);
    const ranges = normalizedCursor?.ranges ?? mergeAdjacentRoundRanges(request.ranges ?? []);
    const roles = normalizedCursor?.roles ?? normalizeRoles(request.roles);
    const selected = selectRoundsByRange(snapshot.rounds, ranges, roles);
    const startIndex = normalizedCursor?.startIndex ?? 0;
    if (startIndex > selected.length) {
      throw new CursorError("Read cursor position exceeds the selected rounds.");
    }
    const rounds = selected.slice(startIndex);
    return paginateRead({
      sessionId: request.sessionId,
      snapshotId: snapshot.header.snapshotId,
      rounds,
      startIndex: 0,
      maxBytes: request.maxBytes,
      maxTokens: request.maxTokens,
      artifactStore: this.artifactStore,
      makeContinuationCursor: nextIndex => encodeCursor("fixture-read", {
        sessionId: request.sessionId,
        snapshotId: snapshot.header.snapshotId,
        ranges,
        roles,
        nextIndex: startIndex + nextIndex,
        requestKey: readRequestKey(request.sessionId, ranges, roles),
      } satisfies ReadCursorPayload),
    });
  }

  private async listCurrentHeaders(): Promise<ThreadSessionHeader[]> {
    const snapshots = await Promise.all(this.indexes.map(index => index.getSnapshot()));
    return snapshots
      .map(snapshot => snapshot.header)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  private async findSessionSnapshot(sessionId: string, snapshotId?: string): Promise<FixtureThreadSnapshot> {
    for (const index of this.indexes) {
      try {
        const snapshot = await index.getSnapshot(snapshotId);
        if (snapshot.header.sessionId === sessionId) {
          return snapshot;
        }
      } catch (error) {
        if (snapshotId && error instanceof SnapshotUnavailableError) {
          continue;
        }
        throw error;
      }
    }
    throw new SnapshotUnavailableError(snapshotId ?? sessionId);
  }

  private async buildSearchSnapshot(request: NormalizedSearchRequest): Promise<SearchSnapshot> {
    const { previewBytes, query } = request;
    const snapshots = await Promise.all(this.indexes.map(index => index.getSnapshot()));
    const selectedSnapshots = request.sessionId
      ? snapshots.filter(snapshot => snapshot.header.sessionId === request.sessionId)
      : snapshots;
    const matches: ThreadSearchMatch[] = [];
    for (const snapshot of selectedSnapshots) {
      if (snapshot.header.title?.toLocaleLowerCase().includes(query)) {
        matches.push({
          sessionId: snapshot.header.sessionId,
          snapshotId: snapshot.header.snapshotId,
          title: snapshot.header.title,
          preview: previewAround(snapshot.header.title, query, previewBytes),
          matchKind: "title",
        });
      }
      for (const round of snapshot.rounds) {
        if (request.roles && !request.roles.includes(round.role)) {
          continue;
        }
        const contentMatch = round.content.toLocaleLowerCase().includes(query);
        const roundMatch = String(round.round).includes(query);
        if (!contentMatch && !roundMatch) {
          continue;
        }
        matches.push({
          sessionId: snapshot.header.sessionId,
          snapshotId: snapshot.header.snapshotId,
          title: snapshot.header.title,
          round: round.round,
          role: round.role,
          preview: previewAround(round.content, query, previewBytes),
          matchKind: contentMatch ? "content" : "round",
        });
      }
    }
    matches.sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId) || (left.round ?? -1) - (right.round ?? -1),
    );
    const snapshotId = stableId(JSON.stringify({
      query,
      sessionId: request.sessionId,
      roles: request.roles,
      matches: matches.map(match => [match.sessionId, match.snapshotId, match.round, match.matchKind]),
    }));
    return { snapshotId, requestKey: request.requestKey, matches };
  }
}
