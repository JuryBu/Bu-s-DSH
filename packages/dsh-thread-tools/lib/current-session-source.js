import { NativeRecallUnavailableError, ThreadIntegrationError } from "./errors.js";
import {
  decodeCursor,
  encodeCursor,
  estimateTokens,
  fingerprint,
  normalizeBudget,
  normalizeRanges,
  normalizeRoles,
  sha256,
  stableJson,
} from "./util.js";

const DEFAULT_VISIBLE_ROLES = new Set(["user", "assistant"]);
const MAX_TOOL_EVENT_CHARS = 8_000;

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

function boundedToolText(value) {
  const text = contentToText(value);
  if (text.length <= MAX_TOOL_EVENT_CHARS) return { text, trimmed: false };
  const headLength = Math.floor(MAX_TOOL_EVENT_CHARS * 0.7);
  const tailLength = MAX_TOOL_EVENT_CHARS - headLength;
  return {
    text: `${text.slice(0, headLength)}\n\n【工具输出过长，已省略中间 ${text.length - MAX_TOOL_EVENT_CHARS} 个字符；以下保留尾部】\n\n${text.slice(-tailLength)}`,
    trimmed: true,
  };
}

function renderRawEvent(event) {
  if (event.type === "user/message" && event.data?.source?.kind === "user") {
    return { role: "user", text: `### 用户\n${contentToText(event.data?.content ?? event.data?.message?.content)}`, startsRound: true };
  }
  if (event.type === "assistant/message") {
    return { role: "assistant", text: `### 助手\n${contentToText(event.data?.message?.content ?? event.data?.content)}` };
  }
  if (event.type === "tool/call") {
    const rendered = boundedToolText(event.data?.arguments);
    return { role: "tool", text: `### 工具调用 ${event.data?.name ?? "unknown"}\n${rendered.text}`, toolOutputTrimmed: rendered.trimmed };
  }
  if (event.type === "tool/result") {
    const rendered = boundedToolText(event.data?.message?.content ?? event.data?.content);
    return { role: "tool", text: `### 工具结果\n${rendered.text}`, toolOutputTrimmed: rendered.trimmed };
  }
  return undefined;
}

function eventSeq(event, index) {
  return Number.isSafeInteger(event?.seq) && event.seq >= 0 ? event.seq : index;
}

function sessionId(session) {
  return String(session?.id ?? session?.meta?.id ?? session?.header?.id ?? "");
}

function inRequestedRange(round, request) {
  if (Array.isArray(request.ranges) && request.ranges.length > 0) {
    return request.ranges.some(range => round >= range.start && round <= range.end);
  }
  return (request.startRound === undefined || round >= request.startRound)
    && (request.endRound === undefined || round <= request.endRound);
}

function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function charIndexAtByteOffset(value, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new ThreadIntegrationError("native_recall_cursor_stale", "thread_recall 续读光标的 UTF-8 字节偏移无效");
  }
  let seenBytes = 0;
  let charIndex = 0;
  for (const character of value) {
    if (seenBytes === byteOffset) return charIndex;
    const nextBytes = seenBytes + Buffer.byteLength(character, "utf8");
    if (nextBytes > byteOffset) {
      throw new ThreadIntegrationError("native_recall_cursor_stale", "thread_recall 续读光标落在 UTF-8 字符中间");
    }
    seenBytes = nextBytes;
    charIndex += character.length;
  }
  if (seenBytes !== byteOffset) {
    throw new ThreadIntegrationError("native_recall_cursor_stale", "thread_recall 续读光标超出轮内容");
  }
  return charIndex;
}

function fragmentCursor(round, sourceRevision, byteOffset) {
  return {
    version: 1,
    round: round.round,
    blockId: round.source.blockId,
    byteOffset,
    contentHash: sha256(round.content),
    sourceRevision,
  };
}

function assertFragmentCursor(cursor, candidates, sourceRevision) {
  const fragment = cursor?.fragment;
  const candidate = candidates[cursor?.nextIndex ?? -1];
  if (fragment?.version !== 1 || !candidate
    || fragment.round !== candidate.round
    || fragment.blockId !== candidate.source?.blockId
    || fragment.sourceRevision !== sourceRevision
    || fragment.contentHash !== sha256(candidate.content)
    || fragment.byteOffset !== cursor.nextByteOffset) {
    throw new ThreadIntegrationError("native_recall_cursor_stale", "thread_recall 续读光标的轮、block、字节偏移或内容版本已经失效");
  }
  charIndexAtByteOffset(candidate.content, cursor.nextByteOffset);
}

function fitFragment(round, startByteOffset, contentHash, remainingBudget) {
  const startOffset = charIndexAtByteOffset(round.content, startByteOffset);
  const codePoints = Array.from(round.content.slice(startOffset));
  let low = 0;
  let high = codePoints.length;
  let best;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const content = codePoints.slice(0, count).join("");
    const endByteOffset = startByteOffset + Buffer.byteLength(content, "utf8");
    const candidate = {
      ...round,
      content,
      partial: true,
      source: {
        ...round.source,
        startOffset: startByteOffset,
        endOffset: endByteOffset,
        unit: "utf8-byte",
        contentHash,
      },
    };
    const bytes = Buffer.byteLength(stableJson(candidate), "utf8");
    if (count > 0 && bytes <= remainingBudget) {
      best = { round: candidate, bytes, endByteOffset };
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
}

function nextRoundPage(candidates, startIndex, byteOffset, effectiveBytes) {
  const rounds = [];
  let returnedBytes = 0;
  let nextIndex = startIndex;
  let nextByteOffset = byteOffset;
  while (nextIndex < candidates.length && returnedBytes < effectiveBytes) {
    const round = candidates[nextIndex];
    const whole = nextByteOffset === 0 ? round : undefined;
    const wholeBytes = whole ? Buffer.byteLength(stableJson(whole), "utf8") : Number.POSITIVE_INFINITY;
    if (wholeBytes <= effectiveBytes - returnedBytes) {
      rounds.push(whole);
      returnedBytes += wholeBytes;
      nextIndex += 1;
      nextByteOffset = 0;
      continue;
    }

    const remainingBudget = effectiveBytes - returnedBytes;
    const fitted = fitFragment(round, nextByteOffset, sha256(round.content), remainingBudget);
    if (!fitted) break;
    rounds.push(fitted.round);
    returnedBytes += fitted.bytes;
    const endByteOffset = fitted.endByteOffset;
    const roundBytes = Buffer.byteLength(round.content, "utf8");
    if (endByteOffset >= roundBytes) {
      nextIndex += 1;
      nextByteOffset = 0;
    } else {
      nextByteOffset = endByteOffset;
    }
    break;
  }
  return { rounds, returnedBytes, nextIndex, nextByteOffset };
}

function requestedRoleSet(roles) {
  if (!roles) return DEFAULT_VISIBLE_ROLES;
  return new Set(roles);
}

function truncatePreview(value, maxBytes) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 3) end -= 1;
  return `${text.slice(0, end)}…`;
}

export class CurrentSessionThreadSource {
  currentSessionId(exec) {
    return sessionId(exec?.agent?.session) || undefined;
  }

  readThread(request, exec) {
    return this.recallThread({
      ...request,
      recallMode: "manual",
      startRound: undefined,
      endRound: undefined,
    }, exec);
  }

  async searchThreads(request, exec) {
    const session = exec?.agent?.session;
    const currentSessionId = this.currentSessionId(exec);
    if (!currentSessionId) throw new NativeRecallUnavailableError("当前 DSH 执行上下文没有可识别的 session id");
    if (!Array.isArray(session?.events)) throw new NativeRecallUnavailableError("当前 DSH session 没有暴露原生 events 数组");
    if (request.sessionId && request.sessionId !== currentSessionId) {
      throw new ThreadIntegrationError("native_search_session_mismatch", "原生 thread_search 只能搜索当前 DSH 会话");
    }
    const cursor = request.continuationCursor ? decodeCursor(request.continuationCursor, "current-session-search") : undefined;
    const suppliedQuery = request.query?.trim();
    const query = String(suppliedQuery ?? cursor?.query ?? "").trim().toLocaleLowerCase();
    if (!query) throw new RangeError("thread_search 首次搜索时 query 不能为空；续读时可以只传 continuation_cursor");
    const suppliedRoles = normalizeRoles(request.roles);
    const roles = request.roles === undefined ? cursor?.roles : suppliedRoles;
    const roleFilter = requestedRoleSet(roles);
    const sourceRevision = `dsh-current-event-log-v1:${fingerprint({
      sessionId: currentSessionId,
      createdAt: session.header?.createdAt,
      lineageAnchor: session.events[0] ?? { type: "empty" },
    })}`;
    if (cursor && (cursor.sessionId !== currentSessionId || cursor.sourceRevision !== sourceRevision
      || (suppliedQuery !== undefined && cursor.query !== query)
      || (request.roles !== undefined && fingerprint(cursor.roles) !== fingerprint(roles)))) {
      throw new ThreadIntegrationError("native_search_cursor_mismatch", "thread_search 续读光标与当前会话、查询或角色过滤不一致");
    }
    const suppliedLimit = request.limit === undefined ? undefined : Math.max(1, Math.min(request.limit, 100));
    const suppliedPreviewBytes = request.previewBytes === undefined ? undefined : Math.max(32, Math.min(request.previewBytes, 8_192));
    const limit = suppliedLimit ?? cursor?.limit ?? 20;
    const previewBytes = suppliedPreviewBytes ?? cursor?.previewBytes ?? 240;
    if (cursor && ((suppliedLimit !== undefined && cursor.limit !== suppliedLimit)
      || (suppliedPreviewBytes !== undefined && cursor.previewBytes !== suppliedPreviewBytes))) {
      throw new ThreadIntegrationError("native_search_cursor_budget_mismatch", "thread_search 续读时不能改变每页条数或预览长度");
    }
    const startIndex = cursor?.nextEventIndex ?? 0;
    const matches = [];
    let currentRound = 0;
    let nextEventIndex;
    for (let index = 0; index < session.events.length; index += 1) {
      const event = session.events[index];
      const rendered = renderRawEvent(event);
      if (!rendered) continue;
      if (rendered.startsRound) currentRound += 1;
      if (index < startIndex || (roleFilter && !roleFilter.has(rendered.role))) continue;
      if (!rendered.text.toLocaleLowerCase().includes(query)) continue;
      matches.push({
        sessionId: currentSessionId,
        snapshotId: `dsh-current-search:${fingerprint({ sourceRevision, eventCount: session.events.length })}`,
        round: Number.isSafeInteger(event.data?.turn) && event.data.turn >= 1 ? event.data.turn : currentRound,
        role: rendered.role,
        preview: truncatePreview(rendered.text, previewBytes),
        matchKind: "content",
      });
      if (matches.length >= limit) {
        nextEventIndex = index + 1;
        break;
      }
    }
    const snapshotId = matches[0]?.snapshotId ?? `dsh-current-search:${fingerprint({ sourceRevision, eventCount: session.events.length })}`;
    return {
      matches,
      snapshotId,
      truncated: nextEventIndex !== undefined,
      ...(nextEventIndex === undefined ? {} : {
        continuationCursor: encodeCursor("current-session-search", {
          sessionId: currentSessionId,
          sourceRevision,
          query,
          roles,
          limit,
          previewBytes,
          nextEventIndex,
        }),
      }),
      dataSource: "dsh-current-event-log-raw",
      sourceRevision,
      fallbackReason: null,
    };
  }

  async recallThread(request, exec) {
    const session = exec?.agent?.session;
    const currentSessionId = this.currentSessionId(exec);
    if (!currentSessionId) {
      throw new NativeRecallUnavailableError("当前 DSH 执行上下文没有可识别的 session id");
    }
    if (!Array.isArray(session?.events)) {
      throw new NativeRecallUnavailableError("当前 DSH session 没有暴露原生 events 数组");
    }
    const cursor = request.continuationCursor ? decodeCursor(request.continuationCursor, "current-session-recall") : undefined;
    if (request.sessionId && request.sessionId !== currentSessionId) {
      throw new ThreadIntegrationError("native_recall_session_mismatch", "原生 recall 只能读取当前 DSH 会话");
    }
    if (cursor?.sessionId && cursor.sessionId !== currentSessionId) {
      throw new ThreadIntegrationError("native_recall_cursor_mismatch", "thread_recall 续读光标属于另一条当前会话");
    }
    const recallMode = request.recallMode ?? cursor?.recallMode ?? "manual";
    if (recallMode !== "manual") {
      throw new ThreadIntegrationError("native_recall_mode_unsupported", "原生 recall 只支持 manual；full 与 auto 必须交给 Memory Store");
    }
    if (request.startRound !== undefined && (!Number.isSafeInteger(request.startRound) || request.startRound < 1)) {
      throw new RangeError("start_round 必须是正整数");
    }
    if (request.endRound !== undefined && (!Number.isSafeInteger(request.endRound) || request.endRound < 1)) {
      throw new RangeError("end_round 必须是正整数");
    }
    if (request.startRound !== undefined && request.endRound !== undefined && request.endRound < request.startRound) {
      throw new RangeError("end_round 不能小于 start_round");
    }

    const suppliedRoles = normalizeRoles(request.roles);
    const roles = request.roles === undefined ? cursor?.roles : suppliedRoles;
    const suppliedRanges = normalizeRanges(request.ranges);
    const ranges = request.ranges === undefined ? (cursor?.ranges ?? []) : suppliedRanges;
    const startRound = request.startRound === undefined ? cursor?.startRound : request.startRound;
    const endRound = request.endRound === undefined ? cursor?.endRound : request.endRound;
    const requestedMaxBytes = request.maxBytes ?? cursor?.requestedMaxBytes;
    const requestedMaxTokens = request.maxTokens ?? cursor?.requestedMaxTokens;
    if (cursor && ((request.roles !== undefined && !sameValue(suppliedRoles, cursor.roles))
      || (request.ranges !== undefined && !sameValue(suppliedRanges, cursor.ranges))
      || (request.startRound !== undefined && request.startRound !== cursor.startRound)
      || (request.endRound !== undefined && request.endRound !== cursor.endRound)
      || (request.maxBytes !== undefined && request.maxBytes !== cursor.requestedMaxBytes)
      || (request.maxTokens !== undefined && request.maxTokens !== cursor.requestedMaxTokens))) {
      throw new ThreadIntegrationError("native_recall_cursor_mismatch", "thread_recall 续读时不能改变轮次范围、角色或分页预算");
    }
    const effectiveRequest = { ranges, startRound, endRound };
    const roleFilter = requestedRoleSet(roles);
    const snapshotEventCount = cursor?.snapshotEventCount ?? session.events.length;
    if (!Number.isSafeInteger(snapshotEventCount) || snapshotEventCount < 0 || session.events.length < snapshotEventCount) {
      throw new ThreadIntegrationError("native_recall_cursor_stale", "thread_recall 续读光标引用的事件快照已不可用，请重新开始读取");
    }
    const snapshotEvents = session.events.slice(0, snapshotEventCount);
    const groups = new Map();
    let rawEventCount = 0;
    let lineageAnchor;
    let snapshotTail;
    let currentRound = 0;
    let filteredSummaryEvents = 0;
    for (let index = 0; index < snapshotEvents.length; index += 1) {
      const event = snapshotEvents[index];
      const rendered = renderRawEvent(event);
      if (!rendered) {
        if (String(event?.type ?? "").startsWith("compaction/")
          || event?.type === "record/context"
          || (event?.type === "user/message" && event?.data?.source?.kind !== "user")) {
          filteredSummaryEvents += 1;
        }
        continue;
      }
      if (rendered.startsRound) currentRound += 1;
      const explicitTurn = Number.isSafeInteger(event.data?.turn) && event.data.turn >= 1 ? event.data.turn : undefined;
      const round = explicitTurn ?? currentRound;
      if (!Number.isSafeInteger(round) || round < 1) continue;
      const seq = eventSeq(event, index);
      const anchor = { seq, type: event.type, data: event.data };
      rawEventCount += 1;
      lineageAnchor ??= anchor;
      snapshotTail = anchor;
      if (!inRequestedRange(round, effectiveRequest) || (roleFilter && !roleFilter.has(rendered.role))) continue;
      const parts = groups.get(round) ?? [];
      parts.push({ ...rendered, seq, time: event.time });
      groups.set(round, parts);
    }

    lineageAnchor ??= { seq: -1, type: "empty" };
    const sourceRevision = `dsh-current-event-log-v1:${fingerprint({
      sessionId: currentSessionId,
      createdAt: session.header?.createdAt,
      lineageAnchor,
    })}`;
    const snapshotId = `dsh-current:${fingerprint({
      sourceRevision,
      rawEventCount,
      snapshotTail,
    })}`;
    if (cursor && cursor.sourceRevision !== sourceRevision) {
      throw new ThreadIntegrationError("native_recall_cursor_stale", "thread_recall 续读光标引用的来源谱系已变化，请重新开始读取");
    }
    const candidates = [...groups.entries()].sort(([left], [right]) => left - right).map(([round, parts]) => {
      const presentRoles = [...new Set(parts.map(part => part.role))];
      const toolOutputsTrimmed = parts.some(part => part.toolOutputTrimmed === true);
      return {
        round,
        role: presentRoles.length === 1 ? presentRoles[0] : "mixed",
        content: `## 轮次 ${round}\n${parts.map(part => part.text).join("\n\n")}`,
        timestamp: parts[0]?.time ? new Date(parts[0].time).toISOString() : undefined,
        contentKind: "raw",
        toolOutputsTrimmed,
        source: {
          blockId: `${snapshotId}:round:${round}`,
          startOffset: Math.min(...parts.map(part => part.seq)),
          endOffset: Math.max(...parts.map(part => part.seq)),
          unit: "event-seq",
          contentKind: "raw",
          toolOutputsTrimmed,
        },
      };
    });
    if (candidates.length === 0) {
      throw new ThreadIntegrationError("native_recall_no_raw_rounds", "当前范围没有可作为原文交付的用户、助手或工具事件");
    }

    const budget = normalizeBudget(requestedMaxBytes, requestedMaxTokens);
    const effectiveBytes = Math.min(budget.requestedMaxBytes, budget.requestedMaxTokens * 4);
    if (cursor) assertFragmentCursor(cursor, candidates, sourceRevision);
    const page = nextRoundPage(candidates, cursor?.nextIndex ?? 0, cursor?.nextByteOffset ?? 0, effectiveBytes);
    if (page.rounds.length === 0) {
      throw new ThreadIntegrationError("native_recall_budget_too_small", "本次预算连稳定片段的定位信息也放不下，请提高 max_bytes 或 max_tokens");
    }

    const candidateBytes = candidates.reduce((total, round) => total + Buffer.byteLength(stableJson(round), "utf8"), 0);
    const truncated = page.nextIndex < candidates.length;
    const hasPartial = page.rounds.some(round => round.partial === true);
    return {
      sessionId: currentSessionId,
      snapshotId,
      sourceRevision,
      dataSource: "dsh-current-event-log-raw",
      fallbackReason: null,
      contentKind: "raw",
      rounds: page.rounds,
      partial: hasPartial,
      truncated,
      ...(truncated ? {
        continuationCursor: encodeCursor("current-session-recall", {
          sessionId: currentSessionId,
          sourceRevision,
          snapshotEventCount,
          recallMode,
          roles,
          ranges,
          startRound,
          endRound,
          requestedMaxBytes: budget.requestedMaxBytes,
          requestedMaxTokens: budget.requestedMaxTokens,
          nextIndex: page.nextIndex,
          nextByteOffset: page.nextByteOffset,
          fragment: fragmentCursor(candidates[page.nextIndex], sourceRevision, page.nextByteOffset),
        }),
        nextStartRound: candidates[page.nextIndex]?.round ?? page.rounds.at(-1).round,
      } : {}),
      filteredSummaryEvents,
      budget: {
        requestedMaxBytes: budget.requestedMaxBytes,
        requestedMaxTokens: budget.requestedMaxTokens,
        candidateEstimate: "exact",
        candidateBytes,
        candidateTokens: estimateTokens(candidateBytes),
        returnedBytes: page.returnedBytes,
        returnedTokens: estimateTokens(page.returnedBytes),
      },
    };
  }
}
