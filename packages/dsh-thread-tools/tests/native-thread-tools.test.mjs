import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply as applyThreadTools } from "../lib/index.js";

import {
  CurrentSessionThreadSource,
  HybridThreadSource,
  LargeSessionFallbackDeniedError,
  MemoryStoreCallError,
  MemoryStoreThreadSource,
  MemoryStoreUnavailableError,
  NativeRecallUnavailableError,
  Rc6OfficialSmallSource,
  Rc6SessionEventWriter,
  SidecarThreadLedgerAdapter,
  THREAD_LEDGER_EVENTS,
  ThreadEventLedger,
  ThreadIntegrationError,
  createThreadToolDefinitions,
  decodeCursor,
} from "../lib/testing.js";

function nestedCursor(sourceFingerprint, roundIndex, charPosition = 0) {
  return Buffer.from(JSON.stringify({ version: 1, sourceFingerprint, roundIndex, stepIndex: 0, charPosition }), "utf8").toString("base64url");
}

function memoryReadPage({ sessionId = "session-large", round = 1, roundCount = 50000, sourceFingerprint = "cache-generation-a", next }) {
  return [
    `📂 对话: ${sessionId}`,
    `📊 统计: ${roundCount} 轮对话`,
    `📖 读取轮次 ${round}-${round}`,
    "",
    `## 轮次 ${round} (steps 1-2)`,
    "### 👤 用户",
    `第 ${round} 轮用户内容`,
    "",
    "### 🤖 AI",
    `第 ${round} 轮助手内容`,
    ...(next ? ["", "➡️ 下一段参数", JSON.stringify({ continuationCursor: next })] : []),
  ].join("\n");
}

function memoryListPage({ sessionId = "session-large", title = "大会话", next }) {
  return [
    `1. ${title}`,
    `   ID: ${sessionId}`,
    "   更新时间: 2026-08-15",
    ...(next ? ["", "➡️ 下一段参数", JSON.stringify({ continuationCursor: next })] : []),
  ].join("\n");
}

function makeSessionExec() {
  const events = [];
  const session = {
    id: "caller-session",
    append(type, data) { events.push({ type, data }); },
  };
  return { exec: { agent: { session, contextGenerationId: "generation-7" } }, session, events };
}

function makeRecallExec() {
  const events = [
    { seq: 0, type: "turn/start", data: { turn: 1 } },
    { seq: 1, type: "user/message", data: { turn: 1, source: { kind: "user" }, content: "第一轮用户原文" } },
    { seq: 2, type: "assistant/message", data: { turn: 1, message: { content: "第一轮助手原文" } } },
    { seq: 3, type: "compaction/start", data: { turn: 1 } },
    { seq: 4, type: "compaction/summary", data: { content: "不得交付的压缩摘要" } },
    { seq: 5, type: "record/context", data: { content: "不得交付的 Record" } },
    { seq: 6, type: "user/message", data: { source: { kind: "compaction" }, content: "不得伪装成用户原文的替换摘要" } },
    { seq: 7, type: "compaction/end", data: { turn: 1 } },
    { seq: 8, type: "user/message", data: { turn: 2, source: { kind: "user" }, content: "第二轮用户原文" } },
    { seq: 9, type: "assistant/message", data: { turn: 2, message: { content: "第二轮助手原文" } } },
  ];
  const session = { id: "current-session", header: { createdAt: 1234 }, events };
  return { exec: { agent: { session, contextGenerationId: "generation-current" } }, session };
}

test("当前会话 manual recall 零 MCP，并隔离 compaction、Record 与替换摘要", async () => {
  let memoryCalls = 0;
  const source = new HybridThreadSource({
    currentSession: new CurrentSessionThreadSource(),
    memoryStore: { async recallThread() { memoryCalls += 1; throw new Error("不应调用 Memory Store"); } },
    officialSmall: {},
  });
  const { exec } = makeRecallExec();
  const result = await source.recallThread({ recallMode: "manual", dataChain: "dsh" }, exec);
  assert.equal(memoryCalls, 0);
  assert.equal(result.dataSource, "dsh-current-event-log-raw");
  assert.equal(result.contentKind, "raw");
  assert.deepEqual(result.rounds.map(round => round.round), [1, 2]);
  assert.equal(result.rounds.every(round => round.contentKind === "raw" && round.source.contentKind === "raw"), true);
  assert.match(result.rounds[0].content, /第一轮用户原文/u);
  assert.doesNotMatch(JSON.stringify(result.rounds), /压缩摘要|Record|替换摘要/u);
  assert.equal(result.filteredSummaryEvents, 5);
  assert.match(result.snapshotId, /^dsh-current:/u);
  assert.match(result.sourceRevision, /^dsh-current-event-log-v1:/u);
  assert.equal(result.fallbackReason, null);
});

test("当前会话追加 raw 事件只更新 snapshot，不更换来源谱系", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec, session } = makeRecallExec();
  const first = await source.recallThread({ recallMode: "manual" }, exec);
  session.events.push({ seq: 10, type: "user/message", data: { turn: 3, source: { kind: "user" }, content: "第三轮原文" } });
  const second = await source.recallThread({ recallMode: "manual" }, exec);
  assert.equal(second.sourceRevision, first.sourceRevision);
  assert.notEqual(second.snapshotId, first.snapshotId);
});

test("当前会话超大单轮跨上下文代次稳定续读，并且后续追加事件不污染既有快照", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec, session } = makeRecallExec();
  session.events[1].data.content = `第一轮巨大原文-${"长内容".repeat(5000)}`;
  const first = await source.recallThread({
    recallMode: "manual",
    startRound: 1,
    endRound: 1,
    roles: ["user"],
    maxBytes: 4096,
    maxTokens: 1024,
  }, exec);
  assert.equal(first.rounds.length, 1);
  assert.equal(first.rounds[0].partial, true);
  assert.equal(first.rounds[0].source.unit, "utf8-byte");
  assert.match(first.rounds[0].source.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal(typeof first.continuationCursor, "string");
  const firstCursor = decodeCursor(first.continuationCursor, "current-session-recall");
  assert.deepEqual(firstCursor.fragment, {
    version: 1,
    round: 1,
    blockId: first.rounds[0].source.blockId,
    byteOffset: first.rounds[0].source.endOffset,
    contentHash: first.rounds[0].source.contentHash,
    sourceRevision: first.sourceRevision,
  });
  const firstEnd = first.rounds[0].source.endOffset;

  session.events.push({ seq: 10, type: "user/message", data: { turn: 3, source: { kind: "user" }, content: "分页开始后追加的新轮" } });
  exec.agent.contextGenerationId = "generation-after-bpc";
  const second = await source.recallThread({ continuationCursor: first.continuationCursor }, exec);
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.rounds[0].round, 1);
  assert.equal(second.rounds[0].source.startOffset, firstEnd);
  assert.equal(second.rounds[0].source.contentHash, first.rounds[0].source.contentHash);
  assert.doesNotMatch(JSON.stringify(second.rounds), /分页开始后追加的新轮/u);
});

test("线程工具把完整续读参数固定放在渲染回显尾部", () => {
  const tools = createThreadToolDefinitions({
    defineTool: definition => definition,
    source: {},
    ledger: {},
  });
  const threadRead = tools.find(tool => tool.name === "thread_read");
  const cursor = `dsh-native-thread-v1.${"x".repeat(1200)}.checksum`;
  const text = threadRead.output.render({}, { continuationCursor: cursor })[0].text;
  assert.match(text, /➡️ 下一段参数（必须原样复制）/u);
  assert.equal(text.endsWith(JSON.stringify({ continuation_cursor: cursor })), true);
});

test("当前会话片段读取可以签发回执，确认热度仍归属原轮", async t => {
  const ledgerRootDir = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-current-fragment-"));
  t.after(async () => rm(ledgerRootDir, { recursive: true, force: true }));
  const { exec, session } = makeRecallExec();
  session.events[1].data.content = `需要确认的超大原文-${"段落".repeat(5000)}`;
  const adapter = new SidecarThreadLedgerAdapter({ rootDir: ledgerRootDir });
  const tools = createThreadToolDefinitions({
    defineTool: definition => definition,
    source: new CurrentSessionThreadSource(),
    ledger: adapter,
  });
  const recalled = await tools.find(tool => tool.name === "thread_recall").execute({
    recall_mode: "manual",
    start_round: 1,
    end_round: 1,
    roles: ["user"],
    max_bytes: 4096,
    max_tokens: 1024,
  }, exec);
  assert.equal(recalled.readReceiptTracked, true);
  assert.deepEqual(recalled.receiptRounds, [1]);
  assert.equal(recalled.rounds[0].partial, true);
  const confirmed = await tools.find(tool => tool.name === "thread_confirm").execute({ rounds: [1] }, exec);
  assert.deepEqual(confirmed.confirmedRounds, [1]);
  const persisted = (await adapter.open("current-session", "current-session", "generation-current", recalled.sourceRevision)).inspect();
  assert.deepEqual(persisted.receipts[0].fragments, [{
    round: 1,
    blockId: recalled.rounds[0].source.blockId,
    startOffset: recalled.rounds[0].source.startOffset,
    endOffset: recalled.rounds[0].source.endOffset,
    contentHash: recalled.rounds[0].source.contentHash,
  }]);
});

test("当前会话续读光标拒绝中途更改预算或范围", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec, session } = makeRecallExec();
  session.events[1].data.content = `超大原文-${"内容".repeat(5000)}`;
  const first = await source.recallThread({
    recallMode: "manual",
    startRound: 1,
    endRound: 1,
    maxBytes: 4096,
    maxTokens: 1024,
  }, exec);
  await assert.rejects(
    source.recallThread({ continuationCursor: first.continuationCursor, maxBytes: 8192 }, exec),
    error => error instanceof ThreadIntegrationError && error.code === "native_recall_cursor_mismatch",
  );
});

test("当前会话续读光标拒绝同一轮内容变化", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec, session } = makeRecallExec();
  session.events[1].data.content = `稳定片段-${"内容".repeat(5000)}`;
  const first = await source.recallThread({ startRound: 1, endRound: 1, maxBytes: 4096, maxTokens: 1024 }, exec);
  session.events[1].data.content = `内容已变化-${"内容".repeat(5000)}`;
  await assert.rejects(
    source.recallThread({ continuationCursor: first.continuationCursor }, exec),
    error => error instanceof ThreadIntegrationError && error.code === "native_recall_cursor_stale",
  );
});

test("显式搜索当前会话直接扫描原生事件，并返回可继续分页的原文命中", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec } = makeRecallExec();
  const result = await source.searchThreads({
    sessionId: "current-session",
    query: "第二轮",
    limit: 1,
    maxBytes: 4096,
  }, exec);
  assert.equal(result.dataSource, "dsh-current-event-log-raw");
  assert.equal(result.matches.length, 1);
  assert.match(JSON.stringify(result.matches[0]), /第二轮用户原文/u);
  assert.match(result.snapshotId, /^dsh-current-search:/u);
});

test("混合搜索只把跨会话查询交给 Memory Store，当前会话命中原生源", async () => {
  let memoryCalls = 0;
  const source = new HybridThreadSource({
    currentSession: new CurrentSessionThreadSource(),
    memoryStore: {
      async searchThreads(request) {
        memoryCalls += 1;
        return { matches: [], dataSource: "memory-store-cache", requested: request.sessionId };
      },
    },
    officialSmall: {},
  });
  const { exec } = makeRecallExec();
  const current = await source.searchThreads({ sessionId: "current-session", query: "第一轮" }, exec);
  assert.equal(current.dataSource, "dsh-current-event-log-raw");
  assert.equal(memoryCalls, 0);
  const remote = await source.searchThreads({ sessionId: "remote-session", query: "第一轮" }, exec);
  assert.equal(remote.dataSource, "memory-store-cache");
  assert.equal(memoryCalls, 1);
});

test("当前会话搜索续页只传光标仍留在原生源", async () => {
  let memoryCalls = 0;
  const source = new HybridThreadSource({
    currentSession: new CurrentSessionThreadSource(),
    memoryStore: { async searchThreads() { memoryCalls += 1; throw new Error("不应调用 Memory Store"); } },
    officialSmall: {},
  });
  const { exec } = makeRecallExec();
  const first = await source.searchThreads({
    sessionId: "current-session",
    query: "原文",
    limit: 1,
    maxBytes: 4096,
  }, exec);
  assert.equal(first.matches.length, 1);
  assert.equal(typeof first.continuationCursor, "string");
  const second = await source.searchThreads({ continuationCursor: first.continuationCursor }, exec);
  assert.equal(second.dataSource, "dsh-current-event-log-raw");
  assert.equal(second.matches.length, 1);
  assert.equal(memoryCalls, 0);
});

test("thread 角色过滤拒绝 mixed 和未知角色，不静默扩大读取范围", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec } = makeRecallExec();
  await assert.rejects(
    source.searchThreads({ sessionId: "current-session", query: "原文", roles: ["mixed"] }, exec),
    /roles 只接受 system、user、assistant、tool/u,
  );
  await assert.rejects(
    source.searchThreads({ sessionId: "current-session", query: "原文", roles: ["owner"] }, exec),
    /roles 只接受 system、user、assistant、tool/u,
  );
});

test("当前会话 recall 预算不足时只交付完整轮并返回下一起始轮", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec } = makeRecallExec();
  const firstRound = await source.recallThread({ recallMode: "manual", startRound: 1, endRound: 1 }, exec);
  const result = await source.recallThread({
    recallMode: "manual",
    maxBytes: firstRound.budget.returnedBytes + 8,
    maxTokens: 10000,
  }, exec);
  assert.deepEqual(result.rounds.map(round => round.round), [1]);
  assert.equal(result.truncated, true);
  assert.equal(result.nextStartRound, 2);
});

test("跨会话 manual、当前 full/auto 和跨宿主只路由 Memory Store", async () => {
  const calls = [];
  let nativeCalls = 0;
  const source = new HybridThreadSource({
    currentSession: {
      currentSessionId() { return "current-session"; },
      async recallThread() { nativeCalls += 1; return {}; },
    },
    memoryStore: { async recallThread(request) { calls.push(request); return request; } },
    officialSmall: {},
  });
  const exec = makeRecallExec().exec;
  await source.recallThread({ sessionId: "other-session", recallMode: "manual", dataChain: "dsh" }, exec);
  await source.recallThread({ sessionId: "current-session", recallMode: "full", dataChain: "dsh" }, exec);
  await source.recallThread({ sessionId: "current-session", recallMode: "auto", dataChain: "dsh" }, exec);
  await source.recallThread({ sessionId: "current-session", recallMode: "manual", dataChain: "codex" }, exec);
  assert.equal(nativeCalls, 0);
  assert.deepEqual(calls.map(call => call.fallbackReason), [
    "cross-session",
    "deep-recall:full",
    "deep-recall:auto",
    "cross-host:codex",
  ]);
});

test("只有明确的原生不可用才回退 Memory Store", async () => {
  let memoryCalls = 0;
  const unavailable = new HybridThreadSource({
    currentSession: {
      currentSessionId() { return "current-session"; },
      async recallThread() { throw new NativeRecallUnavailableError("events unavailable"); },
    },
    memoryStore: { async recallThread(request) { memoryCalls += 1; return request; } },
    officialSmall: {},
  });
  const exec = makeRecallExec().exec;
  const fallback = await unavailable.recallThread({ recallMode: "manual", dataChain: "dsh" }, exec);
  assert.equal(fallback.fallbackReason, "native-unavailable:native_recall_unavailable");
  assert.equal(memoryCalls, 1);

  const invalid = new HybridThreadSource({
    currentSession: {
      currentSessionId() { return "current-session"; },
      async recallThread() { throw new ThreadIntegrationError("native_recall_parse_failed", "bad native event"); },
    },
    memoryStore: { async recallThread() { memoryCalls += 1; } },
    officialSmall: {},
  });
  await assert.rejects(invalid.recallThread({ recallMode: "manual", dataChain: "dsh" }, exec), /bad native event/u);
  assert.equal(memoryCalls, 1);
});

test("Memory Store recall 透传 manual/full/auto 契约并过滤 summary", async () => {
  const calls = [];
  const rawAndSummary = [
    "📂 对话: remote-session",
    "📊 统计: 2 轮对话",
    "## 轮次 1 (steps 1-2)",
    "### 👤 用户",
    "远端 raw 原文",
    "## 轮次 2 (steps 3-4)",
    "### 🧩 系统/压缩内容",
    "不得签回执的 summary",
  ].join("\n");
  const source = new MemoryStoreThreadSource({
    async callConversation(args) { calls.push(args); return { text: rawAndSummary }; },
  });
  for (const recallMode of ["manual", "full", "auto"]) {
    const result = await source.recallThread({ sessionId: "remote-session", dataChain: "codex", recallMode });
    assert.equal(result.dataSource, `memory-store-recall-${recallMode}`);
    assert.deepEqual(result.rounds.map(round => round.round), [1]);
    assert.equal(result.filteredSummaryRounds, 1);
  }
  assert.deepEqual(calls.map(call => call.action), ["recall", "recall", "recall"]);
  assert.equal(calls.every(call => call.dataChain === "codex" && call.compactionMode === "omit"), true);
  assert.deepEqual(calls.map(call => call.recallMode), ["manual", "full", "auto"]);
});

test("Memory Store 大会话按缓存光标续读，不触碰官方整体读取", async () => {
  const calls = [];
  const firstNested = nestedCursor("cache-generation-a", 2);
  const client = {
    async callConversation(args) {
      calls.push(args);
      return { text: args.continuationCursor
        ? memoryReadPage({ round: 2, next: undefined })
        : memoryReadPage({ round: 1, next: firstNested }) };
    },
  };
  const source = new MemoryStoreThreadSource(client);
  const first = await source.readThread({ sessionId: "session-large", maxBytes: 512, maxTokens: 50 });
  assert.equal(first.dataSource, "memory-store-cache");
  assert.equal(first.rounds[0].round, 1);
  assert.equal(first.truncated, true);
  assert.equal(calls[0].source, "auto");
  assert.equal(calls[0].maxBytes, 200);

  const second = await source.readThread({
    sessionId: "session-large",
    maxBytes: 512,
    maxTokens: 50,
    continuationCursor: first.continuationCursor,
  });
  assert.equal(second.rounds[0].round, 2);
  assert.equal(second.truncated, false);
  assert.equal(calls[1].continuationCursor, firstNested);
  assert.equal(calls.length, 2);
});

test("Memory Store list 和 search 透传分页游标", async () => {
  const calls = [];
  const client = {
    async callConversation(args) {
      calls.push(args);
      if (args.action === "search") return { text: memoryReadPage({ sessionId: args.conversationId, round: 7, next: "search-next" }) };
      if (args.query) return { text: memoryListPage({ sessionId: "title-match", next: "title-next-2" }) };
      return { text: memoryListPage({ sessionId: args.continuationCursor ? "second" : "first", next: args.continuationCursor ? undefined : "list-next" }) };
    },
  };
  const source = new MemoryStoreThreadSource(client);

  const listed = await source.listThreads({ limit: 1 });
  assert.equal(listed.truncated, true);
  assert.equal(listed.continuationCursor, "list-next");
  const listedNext = await source.listThreads({ limit: 1, continuationCursor: listed.continuationCursor });
  assert.equal(calls[1].continuationCursor, "list-next");
  assert.equal(listedNext.sessions[0].sessionId, "second");

  const titleSearch = await source.searchThreads({ query: "大会话", continuationCursor: "title-next" });
  assert.equal(calls[2].action, "list");
  assert.equal(calls[2].continuationCursor, "title-next");
  assert.equal(titleSearch.continuationCursor, "title-next-2");
  assert.equal(titleSearch.truncated, true);
  const contentSearch = await source.searchThreads({ sessionId: "session-large", query: "用户", continuationCursor: "content-next" });
  assert.equal(calls[3].action, "search");
  assert.equal(calls[3].continuationCursor, "content-next");
  assert.equal(contentSearch.continuationCursor, "search-next");
  assert.equal(contentSearch.truncated, true);
});

test("Memory Store 搜索对条数、预览和总返回量设置本地上限", async () => {
  const calls = [];
  const source = new MemoryStoreThreadSource({
    async callConversation(args) {
      calls.push(args);
      return { text: memoryReadPage({ round: 1 }) };
    },
  });
  await source.searchThreads({
    sessionId: "session-large",
    query: "原文",
    limit: 100000,
    previewBytes: 100000,
  });
  assert.equal(calls[0].limit, 100);
  assert.equal(calls[0].maxBytes, 8_192 * 100 * 4);
  assert.ok(calls[0].maxBytes <= 4 * 1024 * 1024);
});

test("Memory Store 源增长后只在完整轮次边界连续续读", async () => {
  const calls = [];
  const firstNested = nestedCursor("cache-generation-a", 2);
  const secondNested = nestedCursor("cache-generation-b", 3);
  const thirdNested = nestedCursor("cache-generation-b", 4);
  const pages = new Map([
    [undefined, memoryReadPage({ round: 1, roundCount: 3, next: firstNested })],
    [firstNested, memoryReadPage({ round: 2, roundCount: 4, sourceFingerprint: "cache-generation-b", next: secondNested })],
    [secondNested, memoryReadPage({ round: 3, roundCount: 4, sourceFingerprint: "cache-generation-b", next: thirdNested })],
    [thirdNested, memoryReadPage({ round: 4, roundCount: 4, sourceFingerprint: "cache-generation-b" })],
  ]);
  const source = new MemoryStoreThreadSource({
    async callConversation(args) {
      calls.push(args);
      return { text: pages.get(args.continuationCursor) };
    },
  });
  let cursor;
  const rounds = [];
  let sourceAdvanced = false;
  do {
    const page = await source.readThread({ sessionId: "session-large", continuationCursor: cursor, maxBytes: 512, maxTokens: 50 });
    rounds.push(...page.rounds.map(item => item.round));
    sourceAdvanced ||= page.sourceAdvanced;
    cursor = page.continuationCursor;
  } while (cursor);
  assert.deepEqual(rounds, [1, 2, 3, 4]);
  assert.equal(sourceAdvanced, true);
  assert.deepEqual(calls.map(call => call.continuationCursor), [undefined, firstNested, secondNested, thirdNested]);
});

test("Memory Store 源变化未落在完整轮次边界时拒绝续读", async () => {
  const firstNested = nestedCursor("cache-generation-a", 2, 1);
  const client = {
    async callConversation(args) {
      return { text: args.continuationCursor
        ? memoryReadPage({ round: 2, roundCount: 4, sourceFingerprint: "cache-generation-b", next: nestedCursor("cache-generation-b", 3) })
        : memoryReadPage({ round: 1, roundCount: 3, next: firstNested }) };
    },
  };
  const source = new MemoryStoreThreadSource(client);
  const first = await source.readThread({ sessionId: "session-large", maxBytes: 512, maxTokens: 50 });
  await assert.rejects(
    source.readThread({ sessionId: "session-large", continuationCursor: first.continuationCursor, maxBytes: 512, maxTokens: 50 }),
    /安全的轮次边界/u,
  );
});

test("Memory Store 续读光标绑定会话、范围、角色和缓存代次", async () => {
  const firstNested = nestedCursor("cache-generation-a", 4);
  const client = {
    async callConversation(args) {
      return { text: args.continuationCursor
        ? memoryReadPage({ sessionId: "stable", round: 4, sourceFingerprint: "cache-generation-b" })
        : memoryReadPage({ sessionId: "stable", round: 3, next: firstNested }) };
    },
  };
  const source = new MemoryStoreThreadSource(client);
  const first = await source.readThread({ sessionId: "stable", ranges: [{ start: 3, end: 6 }], roles: ["user"] });
  await assert.rejects(
    source.readThread({ sessionId: "stable", ranges: [{ start: 4, end: 6 }], roles: ["user"], continuationCursor: first.continuationCursor }),
    /不能修改轮次范围/u,
  );
  await assert.rejects(
    source.readThread({ sessionId: "other", continuationCursor: first.continuationCursor }),
    /另一条会话/u,
  );
});

test("官方降级面对大文件时在调用 readSession 前拒绝", async () => {
  let readSessionCalls = 0;
  const source = new Rc6OfficialSmallSource({
    sessionQuery: {
      async listSessions() { return [{ header: { id: "huge", createdAt: 1 }, live: false, persisted: true }]; },
      async readSession() { readSessionCalls += 1; throw new Error("绝不应调用"); },
    },
    sessionPersistence: { locate() { return { kind: "jsonl", path: "C:\\fixture\\huge.jsonl" }; } },
    statFile: async () => ({ size: 2 * 1024 * 1024, mtimeMs: 1, ctimeMs: 1 }),
    smallSessionMaxBytes: 1024 * 1024,
  });
  await assert.rejects(source.readThread({ sessionId: "huge" }), LargeSessionFallbackDeniedError);
  assert.equal(readSessionCalls, 0);
});

test("官方小会话单轮分页使用 UTF-8 字节游标并拒绝内容变化", async () => {
  const events = [
    { seq: 0, type: "turn/start", data: { turn: 1 } },
    { seq: 1, type: "user/message", data: { turn: 1, source: { kind: "user" }, content: `官方超大轮-${"内容".repeat(5000)}` } },
  ];
  const sessionQuery = {
    async listSessions() { return [{ header: { id: "official-small", createdAt: 1 }, live: false, persisted: true }]; },
    async readSession() { return { events }; },
  };
  const source = new Rc6OfficialSmallSource({
    sessionQuery,
    sessionPersistence: { locate() { return { kind: "jsonl", path: "C:\\fixture\\small.jsonl" }; } },
    statFile: async () => ({ size: 1024, mtimeMs: 1, ctimeMs: 1 }),
    smallSessionMaxBytes: 1024 * 1024,
  });
  const first = await source.readThread({ sessionId: "official-small", maxBytes: 1024, maxTokens: 256 });
  assert.equal(first.rounds[0].partial, true);
  assert.equal(first.rounds[0].source.unit, "utf8-byte");
  const firstCursor = decodeCursor(first.continuationCursor, "official-read");
  assert.equal(firstCursor.fragment.round, 1);
  assert.equal(firstCursor.fragment.byteOffset, first.rounds[0].source.endOffset);
  assert.equal(firstCursor.fragment.contentHash, first.rounds[0].source.contentHash);
  const second = await source.readThread({ sessionId: "official-small", continuationCursor: first.continuationCursor });
  assert.equal(second.rounds[0].source.startOffset, first.rounds[0].source.endOffset);

  events[1].data.content = `官方内容已变化-${"内容".repeat(5000)}`;
  await assert.rejects(
    source.readThread({ sessionId: "official-small", continuationCursor: first.continuationCursor }),
    error => error instanceof ThreadIntegrationError && error.code === "official_cursor_stale",
  );
});

test("官方降级允许有边界的压缩会话并继续校验解码结果", async () => {
  let readSessionCalls = 0;
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 1001, data: { turn: 1, content: "隔离候选原文", source: { kind: "user" } } },
    { type: "assistant/message", seq: 2, time: 1002, data: { turn: 1, message: { role: "assistant", content: "读取成功" } } },
  ];
  const source = new Rc6OfficialSmallSource({
    sessionQuery: {
      async listSessions() { return [{ header: { id: "compressed", createdAt: 1 } }]; },
      async readSession() { readSessionCalls += 1; return { events }; },
    },
    sessionPersistence: { locate() { return { kind: "jsonl", path: "C:\\fixture\\small.jsonl.zstd" }; } },
    statFile: async () => ({ size: 128, mtimeMs: 1, ctimeMs: 1 }),
  });
  const result = await source.readThread({ sessionId: "compressed" });
  assert.equal(readSessionCalls, 1);
  assert.equal(result.dataSource, "rc6-official-small");
  assert.match(result.rounds[0].content, /隔离候选原文/u);
  assert.match(result.rounds[0].content, /读取成功/u);
});

test("官方降级只对小型明文会话读取，并标出来源和预算", async () => {
  let readSessionCalls = 0;
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 1001, data: { turn: 1, content: "你好", source: { kind: "user" } } },
    { type: "assistant/message", seq: 2, time: 1002, data: { turn: 1, step: 1, message: { role: "assistant", content: "收到" } } },
  ];
  const source = new Rc6OfficialSmallSource({
    sessionQuery: {
      async listSessions() { return [{ header: { id: "small", createdAt: 1 } }]; },
      async readSession() { readSessionCalls += 1; return { session: { id: "small" }, events }; },
    },
    sessionPersistence: { locate() { return { kind: "jsonl", path: "C:\\fixture\\small.jsonl" }; } },
    statFile: async () => ({ size: 256, mtimeMs: 10, ctimeMs: 11 }),
    smallSessionMaxBytes: 4096,
  });
  const result = await source.readThread({ sessionId: "small", maxBytes: 2048, maxTokens: 200 });
  assert.equal(readSessionCalls, 1);
  assert.equal(result.dataSource, "rc6-official-small");
  assert.equal(result.rounds[0].role, "mixed");
  assert.match(result.rounds[0].content, /你好/u);
  assert.equal(result.budget.requestedMaxTokens, 200);
  assert.equal(result.budget.returnedBytes <= 800, true);
});

test("官方小会话续读检测文件变化，变化后不再整体读取", async () => {
  let readSessionCalls = 0;
  let statRound = 0;
  const source = new Rc6OfficialSmallSource({
    sessionQuery: {
      async listSessions() { return [{ header: { id: "moving", createdAt: 1 } }]; },
      async readSession() {
        readSessionCalls += 1;
        return { events: [
          { type: "user/message", seq: 1, time: 1001, data: { turn: 1, content: "x".repeat(600), source: { kind: "user" } } },
        ] };
      },
    },
    sessionPersistence: { locate() { return { kind: "jsonl", path: "C:\\fixture\\moving.jsonl" }; } },
    statFile: async () => {
      statRound += 1;
      return { size: statRound <= 2 ? 700 : 701, mtimeMs: statRound <= 2 ? 10 : 11, ctimeMs: 10 };
    },
    smallSessionMaxBytes: 4096,
  });
  const first = await source.readThread({ sessionId: "moving", maxBytes: 128, maxTokens: 100 });
  assert.equal(first.truncated, true);
  await assert.rejects(source.readThread({ sessionId: "moving", continuationCursor: first.continuationCursor }), /已经变化/u);
  assert.equal(readSessionCalls, 1);
});

test("官方小会话列表回退返回稳定来源版本", async () => {
  const source = new Rc6OfficialSmallSource({
    sessionQuery: { async listSessions() { return [{ header: { id: "small-list", createdAt: 1 } }]; } },
    sessionPersistence: {},
  });
  const result = await source.listThreads();
  assert.equal(result.dataSource, "rc6-official-small");
  assert.equal(typeof result.sourceRevision, "string");
  assert.match(result.snapshotId, new RegExp(result.sourceRevision, "u"));
});

test("Memory Store 传输不可用时 thread_list 可以回退官方小会话列表", async () => {
  const officialSmall = new Rc6OfficialSmallSource({
    sessionQuery: { async listSessions() { return [{ header: { id: "fallback-list", createdAt: 1 } }]; } },
    sessionPersistence: {},
  });
  const source = new HybridThreadSource({
    memoryStore: { async listThreads() { throw new MemoryStoreUnavailableError("offline"); } },
    officialSmall,
  });
  const result = await source.listThreads({ limit: 10 });
  assert.deepEqual(result.sessions.map(session => session.sessionId), ["fallback-list"]);
  assert.equal(result.dataSource, "rc6-official-small");
});

test("跨会话优先官方小会话，官方不可用时才回退 Memory Store", async () => {
  let fallbackCalls = 0;
  const officialSmall = { async readThread() { fallbackCalls += 1; return { dataSource: "rc6-official-small" }; } };
  const unavailable = new HybridThreadSource({
    memoryStore: { async readThread() { throw new MemoryStoreUnavailableError("offline"); } },
    officialSmall,
  });
  assert.equal((await unavailable.readThread({ sessionId: "a" })).dataSource, "rc6-official-small");
  assert.equal(fallbackCalls, 1);

  const businessError = new HybridThreadSource({
    memoryStore: { async readThread() { throw new MemoryStoreCallError("bad cursor"); } },
    officialSmall: { async readThread() { throw new ThreadIntegrationError("rc6_official_unavailable", "offline"); } },
  });
  await assert.rejects(businessError.readThread({ sessionId: "a" }), MemoryStoreCallError);
  assert.equal(fallbackCalls, 1);
});

test("本机跨会话读取优先使用真实小会话文件，不接受陈旧 Memory Store 缓存", async () => {
  let memoryCalls = 0;
  const source = new HybridThreadSource({
    currentSession: { currentSessionId() { return "caller"; } },
    officialSmall: { async readThread() { return { dataSource: "rc6-official-small", rounds: [{ round: 1, content: "真实原文" }] }; } },
    memoryStore: { async readThread() { memoryCalls += 1; return { dataSource: "memory-store-cache", rounds: [] }; } },
  });
  const result = await source.readThread({ sessionId: "target" }, {});
  assert.equal(result.dataSource, "rc6-official-small");
  assert.equal(result.rounds[0].content, "真实原文");
  assert.equal(memoryCalls, 0);
});

test("回执只允许确认已读轮，并对重复确认去重", () => {
  let id = 0;
  const { exec, events } = makeSessionExec();
  const writer = new Rc6SessionEventWriter(new Set(Object.values(THREAD_LEDGER_EVENTS)));
  const ledger = new ThreadEventLedger({ idFactory: () => String(++id), eventWriter: writer });
  const receipt = ledger.registerRead(exec, {
    sessionId: "target",
    snapshotId: "snapshot-1",
    dataSource: "memory-store-cache",
    rounds: [{ round: 3 }, { round: 4 }, { round: 5 }],
  });
  assert.equal(receipt.ledgerDurability, "session-event-log");
  assert.deepEqual(receipt.rounds, [3, 4, 5]);
  const first = ledger.confirm(exec, { readReceiptId: receipt.readReceiptId, rounds: [5, 3], orderedRounds: [3, 5] });
  assert.deepEqual(first.confirmedRounds, [5, 3]);
  const duplicate = ledger.confirm(exec, { readReceiptId: receipt.readReceiptId, rounds: [3] });
  assert.deepEqual(duplicate.confirmedRounds, []);
  assert.deepEqual(duplicate.alreadyConfirmedRounds, [3]);
  assert.throws(() => ledger.confirm(exec, { readReceiptId: receipt.readReceiptId, rounds: [99] }), /实际交付/u);
  assert.deepEqual(events.map(event => event.type), [THREAD_LEDGER_EVENTS.readRegistered, THREAD_LEDGER_EVENTS.usefulMarked]);
});

test("保护和解除只写调用者账本，不修改目标原始会话", () => {
  let id = 10;
  const { exec, events } = makeSessionExec();
  const writer = new Rc6SessionEventWriter(new Set(Object.values(THREAD_LEDGER_EVENTS)));
  const ledger = new ThreadEventLedger({ idFactory: () => String(++id), eventWriter: writer });
  const protection = ledger.protect(exec, { sessionId: "remote-original", ranges: [{ start: 7, end: 9 }] });
  const released = ledger.release(exec, { protectionId: protection.protectionId, sessionId: "remote-original" });
  assert.equal(released.targetSessionId, "remote-original");
  assert.deepEqual(events.map(event => event.type), [THREAD_LEDGER_EVENTS.protectionCreated, THREAD_LEDGER_EVENTS.protectionReleased]);
  assert.equal(events.every(event => event.data.targetSessionId === "remote-original"), true);
});

test("rc.6 未登记自定义事件时明确拒绝，不写坏会话日志", () => {
  const { exec, events } = makeSessionExec();
  const ledger = new ThreadEventLedger({ eventWriter: new Rc6SessionEventWriter(new Set()) });
  assert.throws(() => ledger.registerRead(exec, {
    sessionId: "target",
    snapshotId: "snapshot",
    rounds: [{ round: 1 }],
  }), /已知事件目录尚未注册/u);
  assert.equal(events.length, 0);
});

test("Cordis 工具定义包含七个中文原生工具，read 在后台记录回执", async () => {
  const source = {
    async readThread() {
      return {
        sessionId: "target",
        snapshotId: "snapshot",
        rounds: [{ round: 2, role: "user", content: "原文", source: { blockId: "b", startOffset: 2, endOffset: 2 } }],
        truncated: false,
        budget: { candidateEstimate: "exact", candidateBytes: 6, candidateTokens: 2, returnedBytes: 6, returnedTokens: 2 },
        dataSource: "memory-store-cache",
      };
    },
  };
  const ledger = new ThreadEventLedger({ idFactory: () => "receipt" });
  const tools = createThreadToolDefinitions({ defineTool: definition => definition, source, ledger });
  assert.deepEqual(tools.map(tool => tool.name), [
    "thread_list", "thread_search", "thread_read", "thread_recall", "thread_confirm", "thread_protect", "thread_release_protection",
  ]);
  assert.equal(tools.every(tool => /[\u4e00-\u9fff]/u.test(tool.description)), true);
  const { exec } = makeSessionExec();
  const result = await tools.find(tool => tool.name === "thread_read").execute({ session_id: "target" }, exec);
  assert.equal(result.readReceiptTracked, true);
  assert.equal("readReceiptId" in result, false);
  assert.equal(result.ledgerDurability, "volatile-current-process");
});

test("thread_recall 只为 raw 轮签发可确认的本地回执", async () => {
  const source = {
    async recallThread() {
      return {
        sessionId: "caller-session",
        snapshotId: "native-snapshot",
        sourceRevision: "native-lineage",
        dataSource: "dsh-current-event-log-raw",
        contentKind: "raw",
        rounds: [{
          round: 2,
          role: "user",
          content: "原文",
          contentKind: "raw",
          source: { blockId: "native:2", startOffset: 2, endOffset: 2, unit: "event-seq", contentKind: "raw" },
        }],
        truncated: false,
      };
    },
  };
  const ledger = new ThreadEventLedger({ idFactory: () => "recall-receipt" });
  const tools = createThreadToolDefinitions({ defineTool: definition => definition, source, ledger });
  const { exec } = makeSessionExec();
  const recalled = await tools.find(tool => tool.name === "thread_recall").execute({ recall_mode: "manual" }, exec);
  assert.equal(recalled.readReceiptTracked, true);
  assert.equal("readReceiptId" in recalled, false);
  const confirmed = await tools.find(tool => tool.name === "thread_confirm").execute({
    rounds: [2],
  }, exec);
  assert.deepEqual(confirmed.confirmedRounds, [2]);
});

test("Cordis 插件默认装配的当前会话 manual recall 不访问 Memory Store", async t => {
  const ledgerRootDir = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-native-recall-plugin-"));
  t.after(async () => rm(ledgerRootDir, { recursive: true, force: true }));
  let memoryCalls = 0;
  const definitions = [];
  const ctx = {
    get() { return undefined; },
    tools: { register(definition) { definitions.push(definition); return () => undefined; } },
  };
  const dispose = await applyThreadTools(ctx, {
    defineTool: definition => definition,
    memoryStoreClient: {
      async callConversation() { memoryCalls += 1; throw new Error("当前会话原生 recall 不应访问 broker"); },
      close() {},
    },
    ledgerRootDir,
  });
  const { exec } = makeRecallExec();
  const result = await definitions.find(tool => tool.name === "thread_recall").execute({
    recall_mode: "manual",
    operation_id: "native-plugin-recall",
  }, exec);
  assert.equal(memoryCalls, 0);
  assert.equal(result.dataSource, "dsh-current-event-log-raw");
  assert.equal(result.fallbackReason, null);
  assert.equal(result.ledgerDurability, "sidecar-hash-chain");
  await dispose();
});

test("Sidecar adapter 的 registerRead 使用同 operationId 返回同一回执", async t => {
  const ledgerRootDir = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-adapter-idempotent-"));
  t.after(async () => rm(ledgerRootDir, { recursive: true, force: true }));
  const adapter = new SidecarThreadLedgerAdapter({ rootDir: ledgerRootDir });
  const exec = { agent: { session: { id: "owner-session" }, contextGenerationId: "generation-a" } };
  const result = {
    sessionId: "target-session",
    snapshotId: "snapshot-a",
    sourceRevision: "source-a",
    dataSource: "dsh-current-event-log-raw",
    rounds: [{ round: 1 }],
  };
  const first = await adapter.registerRead(exec, result, { operationId: "stable-read" });
  const duplicate = await adapter.registerRead(exec, result, { operationId: "stable-read" });
  assert.equal(duplicate.readReceiptId, first.readReceiptId);
  assert.equal(duplicate.ledgerSeq, first.ledgerSeq);
  assert.equal(duplicate.duplicate, true);
});

test("Sidecar adapter 允许在完整轮边界分页并为本页签发回执", async t => {
  const ledgerRootDir = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-adapter-paged-"));
  t.after(async () => rm(ledgerRootDir, { recursive: true, force: true }));
  const adapter = new SidecarThreadLedgerAdapter({ rootDir: ledgerRootDir });
  const exec = { agent: { session: { id: "owner-session" }, contextGenerationId: "generation-a" } };
  const receipt = await adapter.registerRead(exec, {
    sessionId: "target-session",
    snapshotId: "snapshot-a",
    sourceRevision: "source-a",
    dataSource: "fixture",
    rounds: [{ round: 7, partial: false }],
    truncated: true,
    continuationCursor: "next-page",
    nextStartRound: 8,
  }, { operationId: "paged-read" });
  assert.deepEqual(receipt.rounds, [7]);
});

test("Sidecar adapter 把稳定超大轮片段写入回执，但确认仍只使用轮号", async t => {
  const ledgerRootDir = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-adapter-fragment-"));
  t.after(async () => rm(ledgerRootDir, { recursive: true, force: true }));
  const adapter = new SidecarThreadLedgerAdapter({ rootDir: ledgerRootDir });
  const exec = { agent: { session: { id: "owner-session" }, contextGenerationId: "generation-a" } };
  const receipt = await adapter.registerRead(exec, {
    sessionId: "target-session",
    snapshotId: "snapshot-a",
    sourceRevision: "source-a",
    dataSource: "memory-store-recall-full",
    partial: true,
    rounds: [{
      round: 7,
      partial: true,
      source: { blockId: "block-7", startOffset: 320, endOffset: 640, unit: "utf8-byte", contentHash: "c".repeat(64) },
    }],
  }, { operationId: "fragment-read" });
  assert.deepEqual(receipt.rounds, [7]);
  assert.deepEqual(receipt.fragments, [{
    round: 7, blockId: "block-7", startOffset: 320, endOffset: 640, contentHash: "c".repeat(64),
  }]);
  const confirmation = await adapter.confirm(exec, {
    readReceiptId: receipt.readReceiptId,
    rounds: [7],
    operationId: "fragment-confirm",
  });
  assert.deepEqual(confirmation.confirmedRounds, [7]);
  assert.equal("fragments" in confirmation, false);
});

test("Cordis 工具返回值会移除 undefined，满足 DSH 无损 JSON 边界", async () => {
  const source = {
    async searchThreads() {
      return {
        matches: [],
        snapshotId: "snapshot",
        truncated: false,
        continuationCursor: undefined,
        dataSource: "memory-store-cache",
      };
    },
  };
  const tools = createThreadToolDefinitions({
    defineTool: definition => definition,
    source,
    ledger: new ThreadEventLedger(),
  });
  const result = await tools.find(tool => tool.name === "thread_search").execute({ query: "标题" });
  assert.equal("continuationCursor" in result, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("thread_search 首次查询由执行层校验，Schema 允许当前会话只传续读光标", () => {
  const tools = createThreadToolDefinitions({
    defineTool: definition => definition,
    source: {},
    ledger: new ThreadEventLedger(),
  });
  const search = tools.find(tool => tool.name === "thread_search");
  assert.equal(search.parameters.query.required, undefined);
});

test("Cordis 插件默认使用 sidecar，重启后仍可确认、保护和解除", async t => {
  const ledgerRootDir = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-plugin-sidecar-"));
  t.after(async () => rm(ledgerRootDir, { recursive: true, force: true }));
  const source = {
    async readThread() {
      return {
        sessionId: "target-session",
        snapshotId: "snapshot-a",
        sourceRevision: "source-revision-a",
        rounds: [{ round: 8, role: "user", content: "原文", source: { blockId: "b", startOffset: 8, endOffset: 8 } }],
        truncated: false,
        budget: { candidateEstimate: "exact", candidateBytes: 6, candidateTokens: 2, returnedBytes: 6, returnedTokens: 2 },
        dataSource: "memory-store-cache",
      };
    },
  };
  const exec = { agent: { session: { id: "owner-session" }, contextGenerationId: "generation-a" } };
  const definitions = [];
  const ctx = { tools: { register(definition) { definitions.push(definition); return () => undefined; } } };
  const dispose = await applyThreadTools(ctx, {
    defineTool: definition => definition,
    memoryStoreClient: { close() {} },
    source,
    ledgerRootDir,
    idFactory: (() => { let value = 0; return () => `id-${++value}`; })(),
  });
  const read = await definitions.find(tool => tool.name === "thread_read").execute({ session_id: "target-session", operation_id: "read-op" }, exec);
  assert.equal(read.ledgerDurability, "sidecar-hash-chain");
  await definitions.find(tool => tool.name === "thread_confirm").execute({
    session_id: "target-session",
    rounds: [8],
    operation_id: "confirm-op",
  }, exec);
  const protection = await definitions.find(tool => tool.name === "thread_protect").execute({
    session_id: "target-session",
    ranges: [{ start: 8, end: 8 }],
    operation_id: "protect-op",
  }, exec);
  await dispose();

  const restartedDefinitions = [];
  const restartedContext = { tools: { register(definition) { restartedDefinitions.push(definition); return () => undefined; } } };
  const disposeRestarted = await applyThreadTools(restartedContext, {
    defineTool: definition => definition,
    memoryStoreClient: { close() {} },
    source,
    ledgerRootDir,
  });
  const released = await restartedDefinitions.find(tool => tool.name === "thread_release_protection").execute({
    protection_id: protection.protectionId,
    session_id: "target-session",
    operation_id: "release-op",
  }, exec);
  assert.equal(released.ledgerDurability, "sidecar-hash-chain");
  await disposeRestarted();
});

test("完全相同的 thread_confirm 重试忽略动态 owner 轮次", async t => {
  const ledgerRootDir = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-confirm-retry-"));
  t.after(async () => rm(ledgerRootDir, { recursive: true, force: true }));
  const adapter = new SidecarThreadLedgerAdapter({ rootDir: ledgerRootDir });
  const exec = {
    agent: {
      contextGenerationId: "generation-a",
      session: {
        id: "owner-session",
        events: [{ type: "user/message", data: { source: { kind: "user" } } }],
      },
    },
  };
  const read = await adapter.registerRead(exec, {
    sessionId: "target-session",
    snapshotId: "snapshot-a",
    sourceRevision: "source-a",
    dataSource: "fixture",
    rounds: [{ round: 1 }],
  }, { operationId: "stable-read" });
  const first = await adapter.confirm(exec, {
    readReceiptId: read.readReceiptId,
    rounds: [1],
    orderedRounds: [1],
    operationId: "stable-confirm",
  });
  exec.agent.session.events.push({ type: "user/message", data: { source: { kind: "user" } } });
  const duplicate = await adapter.confirm(exec, {
    readReceiptId: read.readReceiptId,
    rounds: [1],
    orderedRounds: [1],
    operationId: "stable-confirm",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ledgerSeq, first.ledgerSeq);
  assert.deepEqual(duplicate.confirmedRounds, first.confirmedRounds);
});

test("包含半轮的 read 和 recall 不会签发可确认回执", async () => {
  let receiptCalls = 0;
  const source = {
    async readThread() {
      return {
        sessionId: "target-session",
        snapshotId: "snapshot-a",
        sourceRevision: "source-a",
        dataSource: "fixture",
        rounds: [{ round: 1, partial: true }],
        truncated: true,
        continuationCursor: "next-read",
      };
    },
    async recallThread() {
      return {
        sessionId: "target-session",
        snapshotId: "snapshot-a",
        sourceRevision: "source-a",
        dataSource: "fixture",
        contentKind: "raw",
        rounds: [{
          round: 1,
          role: "user",
          content: "片段",
          partial: true,
          contentKind: "raw",
          source: { blockId: "fixture:1", startOffset: 1, endOffset: 1, unit: "fixture", contentKind: "raw" },
        }],
        truncated: true,
        nextStartRound: 2,
      };
    },
  };
  const tools = createThreadToolDefinitions({
    defineTool: definition => definition,
    source,
    ledger: { async registerRead() { receiptCalls += 1; } },
  });
  const exec = makeSessionExec().exec;
  await assert.rejects(
    tools.find(tool => tool.name === "thread_read").execute({ session_id: "target-session" }, exec),
    error => error instanceof ThreadIntegrationError && error.code === "thread_read_partial_round",
  );
  await assert.rejects(
    tools.find(tool => tool.name === "thread_recall").execute({ session_id: "target-session", recall_mode: "full" }, exec),
    error => error instanceof ThreadIntegrationError && error.code === "thread_read_partial_round",
  );
  assert.equal(receiptCalls, 0);
});

test("Memory Store 只有提供稳定片段定位符时才为超大半轮签发回执，热度仍确认原轮", async () => {
  const hash = "a".repeat(64);
  const registered = [];
  const source = {
    async recallThread() {
      return {
        sessionId: "target-session",
        snapshotId: "snapshot-a",
        sourceRevision: "source-a",
        dataSource: "memory-store-recall-full",
        contentKind: "raw",
        partial: true,
        rounds: [{
          round: 7,
          role: "assistant",
          content: "超大轮的稳定片段",
          partial: true,
          contentKind: "raw",
          source: { blockId: "block-7", startOffset: 320, endOffset: 640, unit: "utf8-byte", contentHash: hash, contentKind: "raw" },
        }],
        continuationCursor: "next-fragment",
      };
    },
  };
  const tools = createThreadToolDefinitions({
    defineTool: definition => definition,
    source,
    ledger: {
      async registerRead(_exec, result) {
        registered.push(result);
        return { readReceiptId: "receipt-fragment", rounds: [7], ledgerDurability: "fixture" };
      },
      async confirm(_exec, input) { return { confirmedRounds: input.rounds, heatTarget: "round" }; },
    },
  });
  const exec = makeSessionExec().exec;
  const recalled = await tools.find(tool => tool.name === "thread_recall").execute({ session_id: "target-session", recall_mode: "full" }, exec);
  assert.equal(recalled.readReceiptTracked, true);
  assert.equal(recalled.continuationCursor, "next-fragment");
  assert.equal(registered[0].rounds[0].round, 7);
  const confirmed = await tools.find(tool => tool.name === "thread_confirm").execute({ rounds: [7] }, exec);
  assert.deepEqual(confirmed.confirmedRounds, [7]);
  assert.equal(confirmed.heatTarget, "round");
});

test("分页只要停在完整轮边界，read 和 recall 都为本页签发回执", async () => {
  const registered = [];
  const completeRound = {
    round: 7,
    role: "user",
    content: "本页交付的完整原始轮",
    contentKind: "raw",
    source: { blockId: "fixture:7", startOffset: 1, endOffset: 10, unit: "fixture", contentKind: "raw" },
  };
  const source = {
    async readThread() {
      return {
        sessionId: "target-session",
        snapshotId: "snapshot-a",
        sourceRevision: "source-a",
        dataSource: "fixture",
        rounds: [completeRound],
        truncated: true,
        continuationCursor: "next-read",
      };
    },
    async recallThread() {
      return {
        sessionId: "target-session",
        snapshotId: "snapshot-a",
        sourceRevision: "source-a",
        dataSource: "fixture",
        contentKind: "raw",
        rounds: [completeRound],
        truncated: true,
        nextStartRound: 8,
      };
    },
  };
  const tools = createThreadToolDefinitions({
    defineTool: definition => definition,
    source,
    ledger: {
      async registerRead(_exec, result) {
        registered.push(result);
        return { readReceiptId: `receipt-${registered.length}`, rounds: result.rounds.map(round => round.round), ledgerDurability: "fixture" };
      },
    },
  });
  const exec = makeSessionExec().exec;
  const read = await tools.find(tool => tool.name === "thread_read").execute({ session_id: "target-session" }, exec);
  const recall = await tools.find(tool => tool.name === "thread_recall").execute({ session_id: "target-session", recall_mode: "full" }, exec);
  assert.equal(read.readReceiptTracked, true);
  assert.equal("readReceiptId" in read, false);
  assert.equal(read.continuationCursor, "next-read");
  assert.deepEqual(read.receiptRounds, [7]);
  assert.equal(recall.readReceiptTracked, true);
  assert.equal("readReceiptId" in recall, false);
  assert.equal(recall.nextStartRound, 8);
  assert.deepEqual(recall.receiptRounds, [7]);
});

test("当前会话默认只交付用户与助手原文，巨大工具结果不会挤掉完整轮", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec, session } = makeRecallExec();
  session.events.splice(3, 0,
    { seq: 20, type: "tool/call", data: { turn: 1, name: "sandbox_exec", arguments: { command: "Get-Content huge.log" } } },
    { seq: 21, type: "tool/result", data: { turn: 1, content: "X".repeat(120_000) } },
  );
  const result = await source.recallThread({ recallMode: "manual", maxBytes: 16_000, maxTokens: 4_000 }, exec);
  assert.deepEqual(result.rounds.map(round => round.round), [1, 2]);
  assert.match(result.rounds[0].content, /第一轮用户原文/u);
  assert.match(result.rounds[0].content, /第一轮助手原文/u);
  assert.doesNotMatch(result.rounds[0].content, /工具结果|XXXXX/u);
  assert.equal(result.rounds[0].toolOutputsTrimmed, false);
});

test("显式读取工具事件时裁掉巨大结果并保留可见省略标记", async () => {
  const source = new CurrentSessionThreadSource();
  const { exec, session } = makeRecallExec();
  session.events.splice(3, 0,
    { seq: 20, type: "tool/call", data: { turn: 1, name: "sandbox_exec", arguments: { command: "Get-Content huge.log" } } },
    { seq: 21, type: "tool/result", data: { turn: 1, content: `HEAD-${"X".repeat(120_000)}-TAIL` } },
  );
  const result = await source.recallThread({ recallMode: "manual", roles: ["tool"], maxBytes: 20_000, maxTokens: 5_000 }, exec);
  assert.deepEqual(result.rounds.map(round => round.round), [1]);
  assert.equal(result.rounds[0].toolOutputsTrimmed, true);
  assert.equal(result.rounds[0].source.toolOutputsTrimmed, true);
  assert.match(result.rounds[0].content, /工具输出过长，已省略中间/u);
  assert.match(result.rounds[0].content, /HEAD-/u);
  assert.match(result.rounds[0].content, /-TAIL/u);
  assert.ok(result.rounds[0].content.length < 10_000);
});

test("thread_read 读取当前会话时走原生事件而不是 Memory Store", async () => {
  let memoryReads = 0;
  const source = new HybridThreadSource({
    currentSession: new CurrentSessionThreadSource(),
    memoryStore: { async readThread() { memoryReads += 1; throw new Error("不应调用 Memory Store"); } },
    officialSmall: {},
  });
  const { exec } = makeRecallExec();
  const result = await source.readThread({ sessionId: "current-session", ranges: [{ start: 2, end: 2 }] }, exec);
  assert.equal(memoryReads, 0);
  assert.deepEqual(result.rounds.map(round => round.round), [2]);
  assert.match(result.rounds[0].content, /第二轮用户原文/u);
});

test("Memory Store structuredContent 保留 cursor、nextStartRound 与 partial", async () => {
  const calls = [];
  const nested = nestedCursor("structured-generation", 2);
  const source = new MemoryStoreThreadSource({
    async callConversation(args) {
      calls.push(args);
      if (args.action === "read") {
        return {
          text: memoryReadPage({ sessionId: "wrong-text-session", round: 99 }),
          raw: {
            structuredContent: {
              conversationId: "structured-session",
              snapshotId: "structured-read-snapshot",
              sourceFingerprint: "structured-generation",
              roundCount: 3,
              rounds: [{
                round: 1,
                role: "user",
                content: "structured read body",
                partial: true,
                source: { blockId: "structured-block-1", startOffset: 0, endOffset: 20, unit: "utf8-byte", content_hash: "d".repeat(64) },
              }],
              nextParams: { continuationCursor: nested, nextStartRound: 2 },
            },
          },
        };
      }
      if (args.startRound === 3) {
        return {
          text: "",
          raw: {
            structuredContent: {
              conversationId: "remote-session",
              snapshotId: "structured-recall-snapshot",
              sourceFingerprint: "structured-recall-generation",
              roundCount: 3,
              rounds: [{ round: 3, role: "assistant", content: "continued raw" }],
            },
          },
        };
      }
      return {
        text: "",
        raw: {
          structuredContent: {
            conversationId: "remote-session",
            snapshotId: "structured-recall-snapshot",
            sourceFingerprint: "structured-recall-generation",
            roundCount: 3,
            rounds: [
              { round: 2, role: "user", content: "remote raw" },
              { round: 2, role: "system", content: "压缩摘要", contentKind: "summary" },
            ],
            nextParams: { nextStartRound: 3 },
          },
        },
      };
    },
  });
  const read = await source.readThread({ sessionId: "structured-session", maxBytes: 512, maxTokens: 100 });
  assert.equal(read.rounds[0].content, "structured read body");
  assert.equal(read.rounds[0].partial, true);
  assert.deepEqual(read.rounds[0].source, {
    blockId: "structured-block-1", startOffset: 0, endOffset: 20, unit: "utf8-byte", content_hash: "d".repeat(64), contentHash: "d".repeat(64),
  });
  assert.equal(read.nextStartRound, 2);
  assert.equal(read.truncated, true);
  assert.ok(read.continuationCursor);
  const firstRecall = await source.recallThread({ sessionId: "remote-session", recallMode: "full", dataChain: "codex" });
  assert.deepEqual(firstRecall.rounds.map(round => round.round), [2]);
  assert.equal(firstRecall.nextStartRound, 3);
  assert.equal(firstRecall.truncated, true);
  assert.ok(firstRecall.continuationCursor);
  const secondRecall = await source.recallThread({ sessionId: "remote-session", continuationCursor: firstRecall.continuationCursor });
  assert.deepEqual(secondRecall.rounds.map(round => round.round), [3]);
  assert.equal(calls.at(-1).dataChain, "codex");
  assert.equal(calls.at(-1).recallMode, "full");
  assert.equal(calls.at(-1).startRound, 3);
});

test("Memory Store thread_read 与 thread_recall 支持同一超大轮多片续读并校验片段版本", async () => {
  const hash = "e".repeat(64);
  const changedHash = "f".repeat(64);
  const firstNested = nestedCursor("fragment-generation", 7, 3);
  const firstContent = "第一片";
  const secondContent = "第二片";
  const firstEnd = Buffer.byteLength(firstContent, "utf8");
  const secondEnd = firstEnd + Buffer.byteLength(secondContent, "utf8");
  const page = (content, startOffset, endOffset, nextCursor, contentHash = hash) => ({
    text: "",
    raw: {
      structuredContent: {
        conversationId: "fragment-session",
        snapshotId: "fragment-snapshot",
        sourceFingerprint: "fragment-generation",
        roundCount: 7,
        rounds: [{
          round: 7,
          role: "assistant",
          content,
          partial: true,
          source: { blockId: "fragment-block-7", startOffset, endOffset, unit: "utf8-byte", contentHash },
        }],
        ...(nextCursor ? { nextParams: { continuationCursor: nextCursor } } : {}),
      },
    },
  });

  const readCalls = [];
  const readSource = new MemoryStoreThreadSource({
    async callConversation(args) {
      readCalls.push(args);
      return args.continuationCursor
        ? page(secondContent, firstEnd, secondEnd)
        : page(firstContent, 0, firstEnd, firstNested);
    },
  });
  const firstRead = await readSource.readThread({ sessionId: "fragment-session", maxBytes: 512, maxTokens: 128 });
  const readCursor = decodeCursor(firstRead.continuationCursor, "memory-store-read");
  assert.deepEqual(readCursor.fragment, {
    version: 1,
    round: 7,
    blockId: "fragment-block-7",
    byteOffset: firstEnd,
    contentHash: hash,
    sourceRevision: "fragment-generation",
  });
  const finalRead = await readSource.readThread({ sessionId: "fragment-session", continuationCursor: firstRead.continuationCursor });
  assert.equal(finalRead.rounds[0].source.startOffset, firstEnd);
  assert.equal(finalRead.rounds[0].source.endOffset, secondEnd);
  assert.equal(finalRead.continuationCursor, undefined);
  assert.equal(readCalls[1].continuationCursor, firstNested);

  const recallCalls = [];
  const recallSource = new MemoryStoreThreadSource({
    async callConversation(args) {
      recallCalls.push(args);
      return args.continuationCursor
        ? page(secondContent, firstEnd, secondEnd)
        : page(firstContent, 0, firstEnd, firstNested);
    },
  });
  const firstRecall = await recallSource.recallThread({ sessionId: "fragment-session", recallMode: "full", maxBytes: 512, maxTokens: 128 });
  const finalRecall = await recallSource.recallThread({ sessionId: "fragment-session", continuationCursor: firstRecall.continuationCursor });
  assert.equal(finalRecall.rounds[0].source.startOffset, firstEnd);
  assert.equal(finalRecall.rounds[0].source.endOffset, secondEnd);
  assert.equal(finalRecall.continuationCursor, undefined);
  assert.equal(recallCalls[1].continuationCursor, firstNested);

  const staleSource = new MemoryStoreThreadSource({
    async callConversation(args) {
      return args.continuationCursor
        ? page(secondContent, firstEnd, secondEnd, undefined, changedHash)
        : page(firstContent, 0, firstEnd, firstNested);
    },
  });
  const staleFirst = await staleSource.readThread({ sessionId: "fragment-session", maxBytes: 512, maxTokens: 128 });
  await assert.rejects(
    staleSource.readThread({ sessionId: "fragment-session", continuationCursor: staleFirst.continuationCursor }),
    /block、字节偏移或内容版本已经变化/u,
  );
});
