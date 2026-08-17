import { MemoryStoreCallError } from "./errors.js";
import { sha256, truncateUtf8 } from "./util.js";

function responseText(input) {
  if (typeof input === "string") return input;
  return typeof input?.text === "string" ? input.text : "";
}

function structuredContent(input) {
  let value = input?.structuredContent ?? input?.raw?.structuredContent;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of ["result", "data", "payload"]) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) value = value[key];
  }
  return value;
}

function structuredNextParams(value) {
  const next = value?.nextParams ?? value?.nextParameters ?? value?.pagination?.nextParams ?? {};
  const continuationCursor = typeof next?.continuationCursor === "string"
    ? next.continuationCursor
    : typeof value?.continuationCursor === "string"
      ? value.continuationCursor
      : typeof value?.nextCursor === "string"
        ? value.nextCursor
        : undefined;
  const startRound = Number.isSafeInteger(next?.startRound)
    ? next.startRound
    : Number.isSafeInteger(next?.nextStartRound)
      ? next.nextStartRound
      : Number.isSafeInteger(value?.nextStartRound)
        ? value.nextStartRound
        : undefined;
  return {
    ...(next && typeof next === "object" ? next : {}),
    ...(continuationCursor === undefined ? {} : { continuationCursor }),
    ...(startRound === undefined ? {} : { startRound }),
  };
}

function structuredFingerprint(value, fallback) {
  return typeof value?.sourceFingerprint === "string"
    ? value.sourceFingerprint
    : typeof value?.sourceRevision === "string"
      ? value.sourceRevision
      : fallback;
}

function isSummaryContent(content) {
  return /(?:^|\n)#{3,4}\s+[^\n]*(?:系统|压缩|compaction|summary|record|上下文|context)/iu.test(content)
    || /(?:^|\n)\s*【\s*Record\s*来源[｜|]/iu.test(content)
    || /(?:^|\n)#{3,4}\s+[^\n]*(?:来源|source)\s*[:：]?\s*(?!user\b)/iu.test(content);
}

function assertSuccessText(text, action) {
  const firstError = text.split(/\r?\n/u).find(line => line.trimStart().startsWith("❌"));
  if (firstError) throw new MemoryStoreCallError(`conversation_read_original(${action})：${firstError.replace(/^\s*❌\s*/u, "")}`);
}

function parseJsonAfterMarker(text, marker) {
  const expressions = [];
  let from = 0;
  while (true) {
    const markerIndex = text.indexOf(marker, from);
    if (markerIndex < 0) break;
    const rest = text.slice(markerIndex + marker.length);
    const line = rest.split(/\r?\n/u).map(item => item.trim()).find(Boolean);
    if (line?.startsWith("{")) {
      try { expressions.push(JSON.parse(line)); } catch {}
    }
    from = markerIndex + marker.length;
  }
  return expressions.at(-1);
}

export function decodeMemoryStoreContinuation(cursor) {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.version !== 1 || typeof parsed.sourceFingerprint !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function parseMemoryStoreList(input, previewBytes = 240) {
  const structured = structuredContent(input);
  if (Array.isArray(structured?.sessions)) {
    const snapshotId = typeof structured.snapshotId === "string" ? structured.snapshotId : `memory-store-list:${sha256(JSON.stringify(structured)).slice(0, 24)}`;
    const nextParams = structuredNextParams(structured);
    return {
      sessions: structured.sessions.map(session => {
        const sessionId = String(session?.sessionId ?? session?.conversationId ?? session?.id ?? "").trim();
        if (!sessionId) return undefined;
        const title = typeof session?.title === "string" ? session.title : typeof session?.name === "string" ? session.name : undefined;
        return {
          sessionId,
          ...(title === undefined ? {} : { title: truncateUtf8(title, previewBytes) }),
          ...(typeof session?.updatedAt === "string" ? { updatedAt: session.updatedAt } : {}),
          sourceFormat: typeof session?.sourceFormat === "string" ? session.sourceFormat : "memory-store-structured-v1",
          snapshotId,
          roundCount: Number.isSafeInteger(session?.roundCount) ? session.roundCount : 0,
          roundCountKnown: typeof session?.roundCountKnown === "boolean" ? session.roundCountKnown : Number.isSafeInteger(session?.roundCount),
          committedThroughOffset: Number.isSafeInteger(session?.committedThroughOffset) ? session.committedThroughOffset : 0,
          hasPendingTail: Boolean(session?.hasPendingTail),
        };
      }).filter(Boolean),
      snapshotId,
      truncated: structured.truncated === true || Boolean(nextParams.continuationCursor),
      continuationCursor: nextParams.continuationCursor,
      dataSource: "memory-store-cache",
    };
  }
  const text = responseText(input);
  assertSuccessText(text, "list");
  const nextParams = parseJsonAfterMarker(text, "➡️ 下一段参数");
  const continuationCursor = typeof nextParams?.continuationCursor === "string" ? nextParams.continuationCursor : undefined;
  const snapshotId = `memory-store-list:${sha256(text).slice(0, 24)}`;
  const sessions = [];
  const pattern = /(?:^|\n)(\d+)\. ([^\n]*)\n\s+ID: ([^\n]+)\n\s+更新时间: ([^\n|]+)([^\n]*)/gu;
  for (const match of text.matchAll(pattern)) {
    sessions.push({
      sessionId: match[3].trim(),
      title: truncateUtf8(match[2].trim(), previewBytes),
      updatedAt: match[4].trim() === "(未知)" ? undefined : match[4].trim(),
      sourceFormat: "memory-store-normalized-v3",
      snapshotId,
      roundCount: 0,
      roundCountKnown: false,
      committedThroughOffset: 0,
      hasPendingTail: false,
    });
  }
  return {
    sessions,
    snapshotId,
    truncated: Boolean(continuationCursor),
    continuationCursor,
    dataSource: "memory-store-cache",
  };
}

export function splitRoundSections(text) {
  const matches = [...text.matchAll(/^## 轮次 (\d+)(?: \(steps ([^)]+)\))?\s*$/gmu)];
  const rounds = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const start = current.index;
    const end = matches[index + 1]?.index ?? text.length;
    rounds.push({ round: Number(current[1]), content: text.slice(start, end).trimEnd(), steps: current[2] });
  }
  return rounds;
}

function roleForSection(content, requestedRoles) {
  if (requestedRoles?.length === 1 && !["mixed", "unknown"].includes(requestedRoles[0])) return requestedRoles[0];
  const labels = [
    ["### 👤 用户", "user"],
    ["### 🤖 AI", "assistant"],
    ["### 🧩 系统/压缩内容", "system"],
    ["#### 🔧 工具调用", "tool"],
  ].filter(([label]) => content.includes(label)).map(([, role]) => role);
  return labels.length === 1 ? labels[0] : "mixed";
}

function extractPartialBody(text) {
  const marker = "📄 本页正文（原样片段）";
  const index = text.indexOf(marker);
  if (index >= 0) return text.slice(index + marker.length).trimStart();
  return text;
}

function contentHashFor(round, source) {
  const candidates = [
    source?.contentHash,
    source?.content_hash,
    source?.contentSha256,
    source?.content_sha256,
    round?.contentHash,
    round?.content_hash,
    round?.contentSha256,
    round?.content_sha256,
  ];
  return candidates.find(value => typeof value === "string" && value.length > 0);
}

function sourceForRound(round, fallback) {
  const source = round?.source && typeof round.source === "object" ? { ...round.source } : fallback;
  const contentHash = contentHashFor(round, source);
  return contentHash === undefined ? source : { ...source, contentHash };
}

export function parseMemoryStoreRead(input, options = {}) {
  const structured = structuredContent(input);
  if (Array.isArray(structured?.rounds)) {
    const nextParams = structuredNextParams(structured);
    const nestedCursor = nextParams.continuationCursor;
    const decodedNested = decodeMemoryStoreContinuation(nestedCursor);
    const sourceFingerprint = structuredFingerprint(structured, decodedNested?.sourceFingerprint || options.sourceFingerprint || sha256(JSON.stringify(structured)));
    const snapshotId = typeof structured.snapshotId === "string" ? structured.snapshotId : `memory-store:${sourceFingerprint}`;
    const rounds = structured.rounds.map((round, index) => {
      const roundNumber = Number(round?.round ?? round?.roundNumber);
      if (!Number.isSafeInteger(roundNumber) || roundNumber < 1) return undefined;
      const content = typeof round?.content === "string" ? round.content : typeof round?.text === "string" ? round.text : "";
      return {
        round: roundNumber,
        role: typeof round?.role === "string" ? round.role : roleForSection(content, options.roles),
        content,
        source: sourceForRound(round, {
          blockId: `${snapshotId}:round:${roundNumber}:${index}`,
          startOffset: roundNumber,
          endOffset: roundNumber,
          unit: "cache-round",
        }),
        partial: Boolean(round?.partial || round?.truncated || round?.incomplete),
        ...(typeof round?.contentKind === "string" ? { contentKind: round.contentKind } : {}),
      };
    }).filter(Boolean);
    return {
      conversationId: typeof structured.conversationId === "string" ? structured.conversationId : typeof structured.sessionId === "string" ? structured.sessionId : options.conversationId,
      snapshotId,
      sourceFingerprint,
      roundCount: Number.isSafeInteger(structured.roundCount) ? structured.roundCount : 0,
      rounds,
      nextParams,
      nestedCursor,
      nestedPosition: decodedNested,
      partial: Boolean(structured.partial || structured.incomplete),
      truncated: structured.truncated === true,
    };
  }
  const text = responseText(input);
  assertSuccessText(text, "read");
  const nextParams = parseJsonAfterMarker(text, "➡️ 下一段参数");
  const nestedCursor = nextParams?.continuationCursor;
  const decodedNested = decodeMemoryStoreContinuation(nestedCursor);
  const roundCount = Number(text.match(/📊 统计: (\d+) 轮对话/u)?.[1] || 0);
  const parsedSections = splitRoundSections(text);
  const sourceFingerprint = decodedNested?.sourceFingerprint || options.sourceFingerprint || sha256(text);
  const snapshotId = `memory-store:${sourceFingerprint}`;
  const rounds = parsedSections.map(section => ({
    round: section.round,
    role: roleForSection(section.content, options.roles),
    content: section.content,
    source: {
      blockId: `${snapshotId}:round:${section.round}`,
      startOffset: section.round,
      endOffset: section.round,
      unit: "cache-round",
    },
    partial: /单个(?:代码围栏|details 块|同一轮长内容)超过本次预算|📄\s*本页正文（原样片段）/u.test(text),
  }));
  if (rounds.length === 0 && options.currentRound) {
    rounds.push({
      round: options.currentRound,
      role: roleForSection(text, options.roles),
      content: extractPartialBody(text),
      source: {
        blockId: `${snapshotId}:round:${options.currentRound}:partial`,
        startOffset: options.currentRound,
        endOffset: options.currentRound,
        unit: "cache-round",
      },
      partial: true,
    });
  }
  return {
    conversationId: text.match(/📂 对话: ([^\s\n]+)/u)?.[1] || options.conversationId,
    snapshotId,
    sourceFingerprint,
    roundCount,
    rounds,
    nextParams,
    nestedCursor,
    nestedPosition: decodedNested,
    partial: /单个(?:代码围栏|details 块|同一轮长内容)超过本次预算|📄\s*本页正文（原样片段）/u.test(text),
    truncated: Boolean(nestedCursor || nextParams?.startRound),
  };
}

export function parseMemoryStoreRecall(input, options = {}) {
  const parsed = parseMemoryStoreRead(input, options);
  const rounds = parsed.rounds.filter(round => (
    round.role !== "system"
    && round.contentKind !== "summary"
    && round.source?.contentKind !== "summary"
    && !isSummaryContent(round.content)
  )).map(round => ({
    ...round,
    contentKind: "raw",
    source: {
      ...round.source,
      unit: round.partial === true ? round.source?.unit : "memory-store-recall-round",
      contentKind: "raw",
    },
  }));
  return { ...parsed, rounds, filteredSummaryRounds: parsed.rounds.length - rounds.length };
}

export function parseMemoryStoreSearch(input, previewBytes = 240) {
  const structured = structuredContent(input);
  if (Array.isArray(structured?.matches)) {
    const snapshotId = typeof structured.snapshotId === "string" ? structured.snapshotId : `memory-store-search:${sha256(JSON.stringify(structured)).slice(0, 24)}`;
    const nextParams = structuredNextParams(structured);
    const conversationId = typeof structured.conversationId === "string" ? structured.conversationId : structured.sessionId;
    return {
      matches: structured.matches.map(match => ({
        sessionId: String(match?.sessionId ?? match?.conversationId ?? conversationId ?? ""),
        snapshotId,
        ...(Number.isSafeInteger(match?.round) ? { round: match.round } : {}),
        role: typeof match?.role === "string" ? match.role : "unknown",
        preview: truncateUtf8(String(match?.preview ?? match?.snippet ?? match?.content ?? ""), previewBytes),
        matchKind: typeof match?.matchKind === "string" ? match.matchKind : "content",
      })),
      snapshotId,
      truncated: structured.truncated === true || Boolean(nextParams.continuationCursor),
      continuationCursor: nextParams.continuationCursor,
      dataSource: "memory-store-cache",
    };
  }
  const text = responseText(input);
  assertSuccessText(text, "search");
  const nextParams = parseJsonAfterMarker(text, "➡️ 下一段参数");
  const continuationCursor = typeof nextParams?.continuationCursor === "string" ? nextParams.continuationCursor : undefined;
  const conversationId = text.match(/📂 对话: ([^\s\n]+)/u)?.[1];
  const snapshotId = `memory-store-search:${sha256(text).slice(0, 24)}`;
  const matches = splitRoundSections(text).map(section => ({
    sessionId: conversationId,
    snapshotId,
    round: section.round,
    role: roleForSection(section.content),
    preview: truncateUtf8(section.content.replace(/\s+/gu, " ").trim(), previewBytes),
    matchKind: "content",
  }));
  return {
    matches,
    snapshotId,
    truncated: Boolean(continuationCursor),
    continuationCursor,
    dataSource: "memory-store-cache",
  };
}
