import { MemoryStoreCallError } from "./errors.js";
import {
  parseMemoryStoreList,
  parseMemoryStoreRead,
  parseMemoryStoreRecall,
  parseMemoryStoreSearch,
} from "./memory-store-parser.js";
import {
  decodeCursor,
  encodeCursor,
  estimateTokens,
  fingerprint,
  normalizeBudget,
  normalizeRanges,
  normalizeRoles,
  sha256,
} from "./util.js";

function mapMessageRoles(roles) {
  if (!roles) return undefined;
  return roles.map(role => role === "assistant" ? "assistant" : role);
}

const MAX_SEARCH_LIMIT = 100;
const MAX_SEARCH_PREVIEW_BYTES = 8_192;
const MAX_SEARCH_RESPONSE_BYTES = 4 * 1024 * 1024;

function searchBudget(request) {
  const limit = Math.max(1, Math.min(request.limit ?? 20, MAX_SEARCH_LIMIT));
  const previewBytes = Math.max(32, Math.min(request.previewBytes ?? 240, MAX_SEARCH_PREVIEW_BYTES));
  const maxBytes = Math.min(Math.max(previewBytes * limit * 4, 16_384), MAX_SEARCH_RESPONSE_BYTES);
  return { limit, previewBytes, maxBytes };
}

function requestKey(sessionId, ranges, roles) {
  return fingerprint({ sessionId, ranges, roles });
}

function nextRoundAtBoundary(cursor) {
  if (Number.isSafeInteger(cursor?.nextStartRound) && cursor.nextStartRound >= 1) return cursor.nextStartRound;
  const position = cursor?.memoryPosition;
  if (!Number.isSafeInteger(position?.roundIndex) || position.roundIndex < 1) return undefined;
  if ((position.stepIndex ?? 0) !== 0 || (position.charPosition ?? 0) !== 0) return undefined;
  return position.roundIndex;
}

function canContinueAfterSourceGrowth(cursor, parsed) {
  const nextRound = nextRoundAtBoundary(cursor);
  return Number.isSafeInteger(cursor?.sourceRoundCount)
    && Number.isSafeInteger(parsed.roundCount)
    && parsed.roundCount > cursor.sourceRoundCount
    && Number.isSafeInteger(nextRound)
    && parsed.rounds[0]?.round === nextRound;
}

function fragmentForRound(round, sourceRevision) {
  const source = round?.source;
  const contentHash = typeof source?.contentHash === "string" && /^[0-9a-f]{64}$/iu.test(source.contentHash)
    ? source.contentHash
    : round?.partial === true ? undefined : sha256(round?.content ?? "");
  if (!round || typeof source?.blockId !== "string" || source.blockId.length === 0 || contentHash === undefined) return undefined;
  if (round.partial === true) {
    if (source.unit !== "utf8-byte"
      || !Number.isSafeInteger(source.startOffset) || source.startOffset < 0
      || !Number.isSafeInteger(source.endOffset) || source.endOffset <= source.startOffset) return undefined;
    return {
      version: 1,
      round: round.round,
      blockId: source.blockId,
      byteOffset: source.endOffset,
      contentHash,
      sourceRevision,
    };
  }
  return {
    version: 1,
    round: round.round,
    blockId: source.blockId,
    byteOffset: Buffer.byteLength(round.content ?? "", "utf8"),
    contentHash,
    sourceRevision,
  };
}

function assertContinuationFragment(cursor, parsed, allowSourceRevisionChange = false) {
  const fragment = cursor?.fragment;
  const first = parsed?.rounds?.[0];
  if (!fragment || fragment.version !== 1 || (!allowSourceRevisionChange && fragment.sourceRevision !== parsed.sourceFingerprint)) {
    throw new MemoryStoreCallError("续读光标缺少稳定的轮、block、字节偏移或内容版本");
  }
  if (allowSourceRevisionChange) return;
  if (first?.round !== fragment.round) return;
  const source = first.source;
  const contentHash = source?.contentHash;
  if (source?.blockId !== fragment.blockId
    || source?.unit !== "utf8-byte"
    || source.startOffset !== fragment.byteOffset
    || typeof contentHash !== "string"
    || contentHash !== fragment.contentHash) {
    throw new MemoryStoreCallError("Memory Store 续读期间轮内 block、字节偏移或内容版本已经变化");
  }
}

function recallRequestKey(sessionId, recallMode, dataChain, startRound, endRound, roles) {
  return fingerprint({ sessionId, recallMode, dataChain, startRound, endRound, roles });
}

function responseText(response) {
  return typeof response?.text === "string" ? response.text : "";
}

export class MemoryStoreThreadSource {
  constructor(client) {
    this.client = client;
  }

  async listThreads(request = {}) {
    const response = await this.client.callConversation({
      action: "list",
      dataChain: "dsh",
      source: "auto",
      limit: request.limit,
      continuationCursor: request.continuationCursor,
    });
    return parseMemoryStoreList(response);
  }

  async searchThreads(request) {
    if (!request.query?.trim()) throw new RangeError("thread_search.query 不能为空");
    const { limit, previewBytes, maxBytes } = searchBudget(request);
    if (!request.sessionId) {
      const response = await this.client.callConversation({
        action: "list",
        dataChain: "dsh",
        source: "auto",
        query: request.query,
        limit,
        continuationCursor: request.continuationCursor,
      });
      const listed = parseMemoryStoreList(response, previewBytes);
      return {
        matches: listed.sessions.map(session => ({
          sessionId: session.sessionId,
          snapshotId: listed.snapshotId,
          title: session.title,
          preview: session.title || session.sessionId,
          matchKind: "title",
        })),
        snapshotId: listed.snapshotId,
        truncated: listed.truncated,
        continuationCursor: listed.continuationCursor,
        dataSource: "memory-store-cache",
      };
    }
    const response = await this.client.callConversation({
      action: "search",
      conversationId: request.sessionId,
      dataChain: "dsh",
      source: "auto",
      query: request.query,
      limit,
      messageRoles: mapMessageRoles(normalizeRoles(request.roles)),
      continuationCursor: request.continuationCursor,
      maxBytes,
    });
    return parseMemoryStoreSearch(response, previewBytes);
  }

  async readThread(request) {
    const rangesFromRequest = normalizeRanges(request.ranges);
    const rolesFromRequest = normalizeRoles(request.roles);
    const cursor = request.continuationCursor ? decodeCursor(request.continuationCursor, "memory-store-read") : undefined;
    if (cursor && cursor.sessionId !== request.sessionId) throw new MemoryStoreCallError("续读光标属于另一条会话");
    const ranges = cursor?.ranges ?? rangesFromRequest;
    const roles = cursor?.roles ?? rolesFromRequest;
    if (cursor && request.ranges !== undefined && fingerprint(rangesFromRequest) !== fingerprint(ranges)) {
      throw new MemoryStoreCallError("续读期间不能修改轮次范围");
    }
    if (cursor && request.roles !== undefined && fingerprint(rolesFromRequest) !== fingerprint(roles)) {
      throw new MemoryStoreCallError("续读期间不能修改角色过滤");
    }
    if (cursor?.requestKey !== undefined && cursor.requestKey !== requestKey(request.sessionId, ranges, roles)) {
      throw new MemoryStoreCallError("续读光标的请求绑定无效");
    }

    const { requestedMaxBytes, requestedMaxTokens } = normalizeBudget(request.maxBytes, request.maxTokens);
    const effectiveBytes = Math.min(requestedMaxBytes, requestedMaxTokens * 4);
    const rangeIndex = cursor?.rangeIndex ?? 0;
    const activeRange = ranges[rangeIndex];
    const currentStart = cursor?.nextStartRound ?? activeRange?.start;
    const currentEnd = activeRange?.end;
    const response = await this.client.callConversation({
      action: "read",
      conversationId: request.sessionId,
      dataChain: "dsh",
      source: "auto",
      depth: "normal",
      ...(currentStart !== undefined ? { startRound: currentStart } : {}),
      ...(currentEnd !== undefined ? { endRound: currentEnd } : {}),
      ...(cursor?.memoryCursor ? { continuationCursor: cursor.memoryCursor } : {}),
      ...(mapMessageRoles(roles)?.length ? { messageRoles: mapMessageRoles(roles) } : {}),
      maxBytes: effectiveBytes,
      link: "reference",
    });
    const parsed = parseMemoryStoreRead(response, {
      conversationId: request.sessionId,
      roles,
      sourceFingerprint: cursor?.sourceFingerprint,
      currentRound: cursor?.memoryRound ?? currentStart,
    });
    const sourceAdvanced = Boolean(cursor?.sourceFingerprint && cursor.sourceFingerprint !== parsed.sourceFingerprint);
    if (sourceAdvanced && !canContinueAfterSourceGrowth(cursor, parsed)) {
      throw new MemoryStoreCallError("Memory Store 缓存快照已经改变，无法从安全的轮次边界续读");
    }
    if (cursor) assertContinuationFragment(cursor, parsed, sourceAdvanced);

    let nextRangeIndex = rangeIndex;
    let nextStartRound = Number.isSafeInteger(parsed.nextParams?.startRound) ? parsed.nextParams.startRound : undefined;
    let memoryCursor = parsed.nestedCursor;
    let memoryRound = parsed.nestedPosition?.roundIndex ?? parsed.rounds.at(-1)?.round;
    if (!memoryCursor && nextStartRound === undefined) {
      nextRangeIndex += 1;
      if (nextRangeIndex < ranges.length) nextStartRound = ranges[nextRangeIndex].start;
    }
    const hasMore = Boolean(memoryCursor || nextStartRound !== undefined || nextRangeIndex < ranges.length);
    const fragment = parsed.rounds.at(-1) ? fragmentForRound(parsed.rounds.at(-1), parsed.sourceFingerprint) : undefined;
    if (hasMore && !fragment) throw new MemoryStoreCallError("Memory Store 返回的续读位置没有稳定 UTF-8 片段定位符");
    const continuationCursor = hasMore ? encodeCursor("memory-store-read", {
      sessionId: request.sessionId,
      ranges,
      roles,
      rangeIndex: nextRangeIndex,
      nextStartRound,
      memoryCursor,
      memoryRound,
      memoryPosition: parsed.nestedPosition,
      sourceFingerprint: parsed.sourceFingerprint,
      sourceRoundCount: parsed.roundCount,
      snapshotId: parsed.snapshotId,
      requestKey: requestKey(request.sessionId, ranges, roles),
      fragment,
    }) : undefined;
    const returnedBytes = parsed.rounds.reduce((total, round) => total + Buffer.byteLength(JSON.stringify(round), "utf8") + 1, 0);
    return {
      sessionId: request.sessionId,
      snapshotId: parsed.snapshotId,
      rounds: parsed.rounds,
      truncated: hasMore || parsed.truncated === true || parsed.partial === true || parsed.rounds.some(round => round.partial === true),
      continuationCursor,
      ...(nextStartRound === undefined ? {} : { nextStartRound }),
      budget: {
        requestedMaxBytes,
        requestedMaxTokens,
        candidateEstimate: "conservative",
        candidateBytes: Math.max(returnedBytes, Buffer.byteLength(responseText(response), "utf8")),
        candidateTokens: estimateTokens(Math.max(returnedBytes, Buffer.byteLength(responseText(response), "utf8"))),
        returnedBytes,
        returnedTokens: estimateTokens(returnedBytes),
      },
      dataSource: "memory-store-cache",
      sourceRevision: parsed.sourceFingerprint,
      sourceRoundCount: parsed.roundCount,
      sourceAdvanced,
    };
  }

  async recallThread(request) {
    if (!request.sessionId) throw new MemoryStoreCallError("Memory Store recall 必须提供目标会话编号");
    const cursor = request.continuationCursor ? decodeCursor(request.continuationCursor, "memory-store-recall") : undefined;
    if (cursor && cursor.sessionId !== request.sessionId) throw new MemoryStoreCallError("recall 续读光标属于另一条会话");
    const recallMode = cursor?.recallMode ?? request.recallMode ?? "manual";
    if (!["manual", "full", "auto"].includes(recallMode)) throw new RangeError("recall_mode 必须是 manual、full 或 auto");
    if (cursor && request.recallMode !== undefined && request.recallMode !== recallMode) throw new MemoryStoreCallError("recall 续读期间不能修改 recall_mode");
    const dataChain = cursor?.dataChain ?? request.dataChain ?? "dsh";
    if (cursor && request.dataChain !== undefined && request.dataChain !== dataChain) throw new MemoryStoreCallError("recall 续读期间不能修改 data_chain");
    const requestedRoles = normalizeRoles(request.roles);
    const roles = cursor?.roles ?? requestedRoles;
    if (cursor && request.roles !== undefined && fingerprint(requestedRoles) !== fingerprint(roles)) throw new MemoryStoreCallError("recall 续读期间不能修改角色过滤");
    const startRound = cursor?.startRound ?? request.startRound;
    const endRound = cursor?.endRound ?? request.endRound;
    if (cursor && request.startRound !== undefined && request.startRound !== startRound) throw new MemoryStoreCallError("recall 续读期间不能修改起始轮");
    if (cursor && request.endRound !== undefined && request.endRound !== endRound) throw new MemoryStoreCallError("recall 续读期间不能修改结束轮");
    const requestFingerprint = recallRequestKey(request.sessionId, recallMode, dataChain, startRound, endRound, roles);
    if (cursor?.requestKey !== undefined && cursor.requestKey !== requestFingerprint) throw new MemoryStoreCallError("recall 续读光标的请求绑定无效");
    const { requestedMaxBytes, requestedMaxTokens } = normalizeBudget(request.maxBytes, request.maxTokens);
    const effectiveBytes = Math.min(requestedMaxBytes, requestedMaxTokens * 4);
    const currentStart = cursor?.nextStartRound ?? startRound;
    const response = await this.client.callConversation({
      action: "recall",
      conversationId: request.sessionId,
      dataChain,
      source: "auto",
      recallMode,
      compactionMode: "omit",
      ...(currentStart !== undefined ? { startRound: currentStart } : {}),
      ...(endRound !== undefined ? { endRound } : {}),
      ...(cursor?.memoryCursor ? { continuationCursor: cursor.memoryCursor } : {}),
      ...(mapMessageRoles(roles)?.length ? { messageRoles: mapMessageRoles(roles) } : {}),
      maxBytes: effectiveBytes,
      link: "reference",
    });
    const parsed = parseMemoryStoreRecall(response, {
      conversationId: request.sessionId,
      roles,
      sourceFingerprint: cursor?.sourceFingerprint,
      currentRound: cursor?.memoryRound ?? currentStart,
    });
    if (cursor) assertContinuationFragment(cursor, parsed);
    if (parsed.rounds.length === 0) {
      throw new MemoryStoreCallError("Memory Store recall 没有交付可签发回执的 raw 原文轮次");
    }
    const returnedBytes = parsed.rounds.reduce((total, round) => total + Buffer.byteLength(JSON.stringify(round), "utf8") + 1, 0);
    const memoryCursor = parsed.nestedCursor;
    const nextStartRound = Number.isSafeInteger(parsed.nextParams?.startRound) ? parsed.nextParams.startRound : undefined;
    const hasMore = Boolean(memoryCursor || nextStartRound !== undefined);
    const fragment = parsed.rounds.at(-1) ? fragmentForRound(parsed.rounds.at(-1), parsed.sourceFingerprint) : undefined;
    if (hasMore && !fragment) throw new MemoryStoreCallError("Memory Store recall 的续读位置没有稳定 UTF-8 片段定位符");
    const continuationCursor = hasMore ? encodeCursor("memory-store-recall", {
      sessionId: request.sessionId,
      recallMode,
      dataChain,
      roles,
      startRound,
      endRound,
      nextStartRound,
      memoryCursor,
      memoryRound: parsed.nestedPosition?.roundIndex ?? parsed.rounds.at(-1)?.round,
      sourceFingerprint: parsed.sourceFingerprint,
      requestKey: requestFingerprint,
      fragment,
    }) : undefined;
    return {
      sessionId: request.sessionId,
      snapshotId: parsed.snapshotId,
      sourceRevision: parsed.sourceFingerprint,
      dataSource: `memory-store-recall-${recallMode}`,
      contentKind: "raw",
      rounds: parsed.rounds,
      truncated: hasMore || parsed.truncated === true || parsed.partial === true || parsed.rounds.some(round => round.partial === true),
      continuationCursor,
      ...(nextStartRound === undefined ? {} : { nextStartRound }),
      filteredSummaryRounds: parsed.filteredSummaryRounds,
      fallbackReason: request.fallbackReason,
      budget: {
        requestedMaxBytes,
        requestedMaxTokens,
        candidateEstimate: "conservative",
        candidateBytes: Math.max(returnedBytes, Buffer.byteLength(responseText(response), "utf8")),
        candidateTokens: estimateTokens(Math.max(returnedBytes, Buffer.byteLength(responseText(response), "utf8"))),
        returnedBytes,
        returnedTokens: estimateTokens(returnedBytes),
      },
    };
  }
}
