import { stat as defaultStat } from "node:fs/promises";

import { LargeSessionFallbackDeniedError, ThreadIntegrationError } from "./errors.js";
import {
  decodeCursor,
  encodeCursor,
  estimateTokens,
  fingerprint,
  normalizeBudget,
  normalizeRanges,
  normalizeRoles,
  sha256,
  truncateUtf8,
} from "./util.js";

const DEFAULT_SMALL_SESSION_MAX_BYTES = 1024 * 1024;

function headerId(record) {
  return String(record?.header?.id ?? record?.session?.id ?? record?.id ?? "");
}

function statIdentity(fileStat) {
  return {
    size: Number(fileStat.size),
    mtimeMs: Number(fileStat.mtimeMs),
    ctimeMs: Number(fileStat.ctimeMs),
  };
}

function sameIdentity(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isBoundedJsonlLocation(location) {
  const path = String(location?.path ?? "").toLowerCase();
  return location?.kind === "jsonl" && (path.endsWith(".jsonl") || path.endsWith(".jsonl.zstd"));
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content.map(block => {
    if (typeof block === "string") return block;
    if (typeof block?.text === "string") return block.text;
    if (typeof block?.content === "string") return block.content;
    return JSON.stringify(block);
  }).filter(Boolean).join("\n");
}

function renderEvent(event) {
  if (event.type === "user/message") {
    const sourceKind = event.data?.source?.kind;
    const isHuman = sourceKind === "user";
    const label = isHuman ? "用户，来源 user" : `系统消息，来源 ${sourceKind || "unknown"}`;
    return { role: isHuman ? "user" : "system", text: `### ${label}\n${contentToText(event.data?.content ?? event.data?.message?.content)}` };
  }
  if (event.type === "assistant/message") {
    return { role: "assistant", text: `### 助手\n${contentToText(event.data?.message?.content)}` };
  }
  if (event.type === "tool/call") {
    return { role: "tool", text: `### 工具调用 ${event.data?.name ?? "unknown"}\n${event.data?.arguments ?? ""}` };
  }
  if (event.type === "tool/result") {
    return { role: "tool", text: `### 工具结果\n${contentToText(event.data?.message?.content)}` };
  }
  return undefined;
}

function normalizeOfficialRounds(events, requestedRoles) {
  const groups = new Map();
  let currentTurn = 0;
  for (const event of events) {
    if (event.type === "turn/start" && Number.isSafeInteger(event.data?.turn)) currentTurn = event.data.turn;
    const rendered = renderEvent(event);
    if (!rendered) continue;
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : currentTurn;
    if (!Number.isSafeInteger(turn) || turn < 1) continue;
    const parts = groups.get(turn) ?? [];
    parts.push({
      ...rendered,
      text: rendered.text,
      seq: event.seq,
      time: event.time,
    });
    groups.set(turn, parts);
  }

  const filter = requestedRoles && !requestedRoles.some(role => role === "mixed" || role === "unknown")
    ? new Set(requestedRoles)
    : undefined;
  return [...groups.entries()].sort(([left], [right]) => left - right).flatMap(([round, originalParts]) => {
    const parts = filter ? originalParts.filter(part => filter.has(part.role)) : originalParts;
    if (parts.length === 0) return [];
    const roles = [...new Set(parts.map(part => part.role))];
    return [{
      round,
      role: roles.length === 1 ? roles[0] : "mixed",
      content: `## 轮次 ${round}\n${parts.map(part => part.text).join("\n\n")}`,
      timestamp: parts[0]?.time ? new Date(parts[0].time).toISOString() : undefined,
      source: {
        blockId: `rc6-events:round:${round}`,
        startOffset: Math.min(...parts.map(part => part.seq)),
        endOffset: Math.max(...parts.map(part => part.seq)),
        unit: "event-seq",
      },
    }];
  });
}

function inRanges(round, ranges) {
  return ranges.length === 0 || ranges.some(range => round >= range.start && round <= range.end);
}

function charIndexAtByteOffset(value, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new ThreadIntegrationError("official_cursor_stale", "官方小会话续读光标的 UTF-8 字节偏移无效");
  }
  let seenBytes = 0;
  let charIndex = 0;
  for (const character of value) {
    if (seenBytes === byteOffset) return charIndex;
    const nextBytes = seenBytes + Buffer.byteLength(character, "utf8");
    if (nextBytes > byteOffset) {
      throw new ThreadIntegrationError("official_cursor_stale", "官方小会话续读光标落在 UTF-8 字符中间");
    }
    seenBytes = nextBytes;
    charIndex += character.length;
  }
  if (seenBytes !== byteOffset) {
    throw new ThreadIntegrationError("official_cursor_stale", "官方小会话续读光标超出轮内容");
  }
  return charIndex;
}

function fragmentCursor(round, sourceFingerprint, byteOffset) {
  return {
    version: 1,
    round: round.round,
    blockId: round.source.blockId,
    byteOffset,
    contentHash: sha256(round.content),
    sourceRevision: sourceFingerprint,
  };
}

function assertFragmentCursor(cursor, rounds, sourceFingerprint) {
  const fragment = cursor?.fragment;
  const round = rounds[cursor?.roundIndex ?? -1];
  if (fragment?.version !== 1 || !round
    || fragment.round !== round.round
    || fragment.blockId !== round.source?.blockId
    || fragment.sourceRevision !== sourceFingerprint
    || fragment.contentHash !== sha256(round.content)
    || fragment.byteOffset !== cursor.byteOffset) {
    throw new ThreadIntegrationError("official_cursor_stale", "官方小会话续读光标的轮、block、字节偏移或内容版本已经失效");
  }
  charIndexAtByteOffset(round.content, cursor.byteOffset);
}

function paginateRounds(rounds, startIndex, byteOffset, maxBytes) {
  const output = [];
  let usedBytes = 0;
  let nextIndex = startIndex;
  let nextByteOffset = byteOffset;
  while (nextIndex < rounds.length && usedBytes < maxBytes) {
    const round = rounds[nextIndex];
    const startCharOffset = charIndexAtByteOffset(round.content, nextByteOffset);
    const remainder = round.content.slice(startCharOffset);
    const remainingBudget = maxBytes - usedBytes;
    const remainderBytes = Buffer.byteLength(remainder, "utf8");
    const contentHash = sha256(round.content);
    if (remainderBytes <= remainingBudget && nextByteOffset === 0) {
      output.push({ ...round, content: remainder });
      usedBytes += remainderBytes;
      nextIndex += 1;
      nextByteOffset = 0;
      continue;
    }
    if (remainderBytes <= remainingBudget) {
      output.push({
        ...round,
        content: remainder,
        partial: true,
        source: {
          ...round.source,
          startOffset: nextByteOffset,
          endOffset: nextByteOffset + remainderBytes,
          unit: "utf8-byte",
          contentHash,
        },
      });
      usedBytes += remainderBytes;
      nextIndex += 1;
      nextByteOffset = 0;
      continue;
    }
    if (remainingBudget < 64 && output.length > 0) break;
    const codePoints = Array.from(remainder);
    let low = 0;
    let high = codePoints.length;
    let best;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const content = codePoints.slice(0, count).join("");
      const bytes = Buffer.byteLength(content, "utf8");
      if (count > 0 && bytes <= remainingBudget) {
        best = { content, bytes };
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    if (!best) break;
    output.push({
      ...round,
      content: best.content,
      partial: true,
      source: {
        ...round.source,
        startOffset: nextByteOffset,
        endOffset: nextByteOffset + best.bytes,
        unit: "utf8-byte",
        contentHash,
      },
    });
    usedBytes += best.bytes;
    nextByteOffset += best.bytes;
    break;
  }
  return { rounds: output, nextIndex, nextByteOffset, usedBytes };
}

export class Rc6OfficialSmallSource {
  constructor({
    sessionQuery,
    sessionPersistence,
    statFile = defaultStat,
    smallSessionMaxBytes = DEFAULT_SMALL_SESSION_MAX_BYTES,
  }) {
    this.sessionQuery = sessionQuery;
    this.sessionPersistence = sessionPersistence;
    this.statFile = statFile;
    this.smallSessionMaxBytes = smallSessionMaxBytes;
  }

  assertAvailable() {
    if (!this.sessionQuery || !this.sessionPersistence) {
      throw new ThreadIntegrationError("rc6_official_unavailable", "DSH 官方会话查询或持久化服务未挂载，无法使用小会话降级");
    }
  }

  async listThreads(request = {}) {
    this.assertAvailable();
    const records = await this.sessionQuery.listSessions();
    const normalized = records.map(record => ({
      sessionId: headerId(record),
      createdAt: record.header?.createdAt ? new Date(record.header.createdAt).toISOString() : undefined,
      updatedAt: record.header?.createdAt ? new Date(record.header.createdAt).toISOString() : undefined,
      sourceFormat: "rc6-events-v0",
      roundCount: 0,
      roundCountKnown: false,
      committedThroughOffset: 0,
      hasPendingTail: Boolean(record.live),
    })).filter(record => record.sessionId);
    const sourceFingerprint = fingerprint(normalized);
    const snapshotId = `rc6-list:${sourceFingerprint}`;
    const cursor = request.continuationCursor ? decodeCursor(request.continuationCursor, "official-list") : undefined;
    if (cursor?.snapshotId && cursor.snapshotId !== snapshotId) {
      throw new ThreadIntegrationError("official_list_changed", "DSH 会话列表已变化，请重新开始翻页");
    }
    const start = cursor?.index ?? 0;
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const page = normalized.slice(start, start + limit).map(session => ({ ...session, snapshotId }));
    const next = start + page.length;
    return {
      sessions: page,
      snapshotId,
      continuationCursor: next < normalized.length ? encodeCursor("official-list", { snapshotId, index: next }) : undefined,
      dataSource: "rc6-official-small",
      sourceRevision: sourceFingerprint,
    };
  }

  async searchThreads(request) {
    this.assertAvailable();
    if (!request.query?.trim()) throw new RangeError("thread_search.query 不能为空");
    const limit = Math.max(1, Math.min(request.limit ?? 20, 100));
    const cursor = request.continuationCursor;
    const page = request.sessionId
      ? await this.sessionQuery.searchEvents({ sessionId: request.sessionId, query: request.query, limit, cursor })
      : await this.sessionQuery.searchSessions({ query: request.query, limit, cursor });
    const sessionId = request.sessionId ? String(page.session?.id ?? request.sessionId) : undefined;
    const items = page.items ?? [];
    const matches = items.map(item => {
      const event = request.sessionId ? item : item.bestMatch;
      return {
        sessionId: request.sessionId ? sessionId : headerId(item),
        snapshotId: `rc6-search:${fingerprint({ query: request.query, cursor, items })}`,
        round: undefined,
        preview: truncateUtf8(event?.snippet ?? "", request.previewBytes ?? 240),
        matchKind: "content",
      };
    });
    const snapshotId = matches[0]?.snapshotId ?? `rc6-search:${fingerprint({ query: request.query, cursor, items: [] })}`;
    return { matches, snapshotId, continuationCursor: page.nextCursor, dataSource: "rc6-official-small" };
  }

  async inspectSmallSession(sessionId) {
    const records = await this.sessionQuery.listSessions();
    const record = records.find(candidate => headerId(candidate) === sessionId);
    if (!record) throw new ThreadIntegrationError("session_not_found", `找不到 DSH 会话 ${sessionId}`);
    const location = this.sessionPersistence.locate(record.header);
    if (!isBoundedJsonlLocation(location)) {
      throw new LargeSessionFallbackDeniedError(sessionId, Number.NaN, this.smallSessionMaxBytes, {
        reason: "官方降级只能安全读取已确认的小型 JSONL 或 JSONL Zstandard 独立日志；当前会话无独立文件或格式未知",
      });
    }
    const before = statIdentity(await this.statFile(location.path));
    if (before.size > this.smallSessionMaxBytes) {
      throw new LargeSessionFallbackDeniedError(sessionId, before.size, this.smallSessionMaxBytes);
    }
    return { record, location, before };
  }

  async readThread(request) {
    this.assertAvailable();
    const rangesFromRequest = normalizeRanges(request.ranges);
    const rolesFromRequest = normalizeRoles(request.roles);
    const cursor = request.continuationCursor ? decodeCursor(request.continuationCursor, "official-read") : undefined;
    if (cursor && cursor.sessionId !== request.sessionId) {
      throw new ThreadIntegrationError("official_cursor_session_mismatch", "续读光标属于另一条会话");
    }
    const ranges = cursor?.ranges ?? rangesFromRequest;
    const roles = cursor?.roles ?? rolesFromRequest;
    const requestFingerprint = fingerprint({ sessionId: request.sessionId, ranges, roles });
    if (cursor?.requestFingerprint && cursor.requestFingerprint !== requestFingerprint) {
      throw new ThreadIntegrationError("official_cursor_request_mismatch", "续读期间不能修改会话、轮次范围或角色过滤");
    }

    const { requestedMaxBytes, requestedMaxTokens } = normalizeBudget(request.maxBytes, request.maxTokens);
    const effectiveBytes = Math.min(requestedMaxBytes, requestedMaxTokens * 4);
    const inspected = await this.inspectSmallSession(request.sessionId);
    const sourceFingerprint = fingerprint({ sessionId: request.sessionId, identity: inspected.before });
    if (cursor?.sourceFingerprint && cursor.sourceFingerprint !== sourceFingerprint) {
      throw new ThreadIntegrationError("official_source_changed", "DSH 会话文件在续读期间已经变化，请从头读取");
    }

    const snapshot = await this.sessionQuery.readSession(request.sessionId);
    const after = statIdentity(await this.statFile(inspected.location.path));
    if (!sameIdentity(inspected.before, after)) {
      throw new ThreadIntegrationError("official_source_changed_during_read", "DSH 会话在读取过程中发生变化，结果已丢弃");
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot.events), "utf8");
    if (serializedBytes > this.smallSessionMaxBytes * 4) {
      throw new LargeSessionFallbackDeniedError(request.sessionId, serializedBytes, this.smallSessionMaxBytes * 4, {
        reason: "官方读取返回的解码事件远大于安全线",
      });
    }

    const allRounds = normalizeOfficialRounds(snapshot.events, roles).filter(round => inRanges(round.round, ranges));
    if (cursor) assertFragmentCursor(cursor, allRounds, sourceFingerprint);
    const page = paginateRounds(allRounds, cursor?.roundIndex ?? 0, cursor?.byteOffset ?? 0, effectiveBytes);
    const hasMore = page.nextIndex < allRounds.length || page.nextByteOffset > 0;
    const snapshotId = `rc6-small:${sourceFingerprint}`;
    return {
      sessionId: request.sessionId,
      snapshotId,
      sourceRevision: sourceFingerprint,
      rounds: page.rounds.map(round => ({
        ...round,
        source: { ...round.source, blockId: `${snapshotId}:${round.source.blockId}` },
      })),
      truncated: hasMore,
      continuationCursor: hasMore ? encodeCursor("official-read", {
        sessionId: request.sessionId,
        ranges,
        roles,
        requestFingerprint,
        sourceFingerprint,
        roundIndex: page.nextIndex,
        byteOffset: page.nextByteOffset,
        fragment: fragmentCursor(allRounds[page.nextIndex], sourceFingerprint, page.nextByteOffset),
      }) : undefined,
      budget: {
        requestedMaxBytes,
        requestedMaxTokens,
        candidateEstimate: "exact",
        candidateBytes: allRounds.reduce((total, round) => total + Buffer.byteLength(round.content, "utf8"), 0),
        candidateTokens: estimateTokens(allRounds.reduce((total, round) => total + Buffer.byteLength(round.content, "utf8"), 0)),
        returnedBytes: page.usedBytes,
        returnedTokens: estimateTokens(page.usedBytes),
      },
      dataSource: "rc6-official-small",
    };
  }
}
