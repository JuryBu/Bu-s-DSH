import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { compactionProviderTesting, MemoryRecordCompactionEngine } from "../src/compaction-provider.ts";
import { ContextGenerationError } from "../src/index.ts";
import { RecordCoverageError } from "../src/record-context-source.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeMessage(round: number) {
  return {
    id: `message-${round}`,
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: `第 ${round} 轮原始测试内容 ${"x".repeat(80)}` }],
  };
}

function makeSession(workspace: string, roundCount: number) {
  const events: any[] = [];
  const nodes: number[] = [];
  const surface = { nodes, replaceGeneration: 0 };
  const session = {
    id: `synthetic-context-session-${roundCount}`,
    header: { cwd: workspace },
    events,
    surface,
    requestContext() { return { contextWindow: 12_000 }; },
    requestHeader() {
      return {
        config: { provider: "fixture", model: "fixture-model", maxTokens: 200 },
        system: "隔离压缩事务测试",
        tools: [],
      };
    },
    deriveEventMessage(event: any) {
      return event?.type === "user/message" || event?.type === "assistant/message" ? event.data : null;
    },
    append(type: string, data: unknown, options: Record<string, any> = {}) {
      const event = { seq: events.length, type, data, ...options };
      events.push(event);
      const operation = options.surfaceOp;
      if (operation?.op === "append") nodes.push(event.seq);
      if (operation?.op === "replace") {
        const startIndex = nodes.indexOf(operation.start);
        const endIndex = nodes.indexOf(operation.end);
        assert.ok(startIndex >= 0 && endIndex >= startIndex);
        nodes.splice(startIndex, endIndex - startIndex + 1, event.seq);
        surface.replaceGeneration += 1;
      }
      return event;
    },
  };
  for (let round = 1; round <= roundCount; round += 1) {
    session.append("user/message", makeMessage(round), { surfaceOp: { op: "append" } });
  }
  session.append("turn/start", { turn: "turn-fixture" });
  return session;
}

function makeRecordResult(request: any) {
  const content = `## Phase 1：隔离事务（轮次 ${request.roundStart}-${request.roundEnd}）\n**关键决策：** 使用假 Record 验证官方提交链。`;
  return {
    sourceRevision: "fixture-record-r1",
    recordRoundCount: request.roundEnd,
    input: {
      contextGenerationId: request.contextGenerationId,
      sessionId: request.sessionId,
      shadowedSeqs: [...request.selectedSurfaceSeqs],
      records: [{
        kind: "record",
        recordId: "record:fixture",
        recordGenerationId: "fixture-record-r1",
        roundStart: request.roundStart,
        roundEnd: request.roundEnd,
        detail: "full",
        sourceSeqs: [...request.selectedSurfaceSeqs],
        content,
        contentSha256: sha256(content),
      }],
      rawRounds: [],
      tokenBudget: {
        contextWindow: request.contextWindow,
        stablePrefixTokens: 80,
        recentRawTokens: request.retainedRequestTokens,
        reservedResponseTokens: request.reservedResponseTokens,
      },
    },
  };
}

function installFixtureServices(ctx: Context): void {
  class FixtureTokenMeter extends Service {
    constructor() { super(ctx, "tokenMeter"); }
    measure(session: any) {
      return {
        totalTokens: session.surface.nodes.length * 100,
        nodes: session.surface.nodes.map((seq: number) => ({ seq, tokens: 100 })),
      };
    }
    estimateMessage() { return 80; }
  }
  class FixtureLlm extends Service {
    constructor() { super(ctx, "llm"); }
    async resolveModelInfo() { return { context: { contextWindow: 12_000 } }; }
  }
  class FixtureSessions extends Service {
    constructor() { super(ctx, "sessions"); }
    async flush() {}
  }
  class FixtureCommands extends Service {
    constructor() { super(ctx, "commands"); }
    register() { return () => {}; }
  }
  new FixtureTokenMeter();
  new FixtureLlm();
  new FixtureSessions();
  new FixtureCommands();
}

async function withEngine(
  roundCount: number,
  recordContextSource: { build(request: any): Promise<any> },
  run: (engine: MemoryRecordCompactionEngine, agent: any, session: any) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dsh-compaction-provider-"));
  const previousHome = process.env.DSH_HOME;
  const previousStore = process.env.DSH_CONTEXT_STORE_ROOT;
  const previousLedger = process.env.DSH_THREAD_LEDGER_ROOT;
  process.env.DSH_HOME = join(root, "dsh-home");
  process.env.DSH_CONTEXT_STORE_ROOT = join(root, "context-store");
  process.env.DSH_THREAD_LEDGER_ROOT = join(root, "thread-ledger");
  const ctx = new Context();
  const basePrototype = Object.getPrototypeOf(MemoryRecordCompactionEngine.prototype) as Record<string, any>;
  const originalCompactIdleRegion = basePrototype.compactIdleRegion;
  let engine: MemoryRecordCompactionEngine | undefined;
  try {
    installFixtureServices(ctx);
    const baseCompactRegion = basePrototype.compactRegion;
    basePrototype.compactIdleRegion = function compactIdleRegion(
      start: number,
      end: number,
      agent: any,
      signal: AbortSignal,
    ) {
      return agent.runMaintenance(() => baseCompactRegion.call(this, start, end, agent, signal));
    };
    const session = makeSession(root, roundCount);
    const agent = {
      session,
      contextGenerationId: `session:${session.id}:runtime`,
      options: { provider: "fixture", model: "fixture-model" },
      async runMaintenance(callback: (signal: AbortSignal) => Promise<unknown>) {
        return callback(new AbortController().signal);
      },
      async whenIdle() {},
    };
    engine = new MemoryRecordCompactionEngine(ctx, { auto: false, recordContextSource });
    await run(engine, agent, session);
  } finally {
    if (originalCompactIdleRegion === undefined) delete basePrototype.compactIdleRegion;
    else basePrototype.compactIdleRegion = originalCompactIdleRegion;
    await ctx.fiber.dispose().catch(() => undefined);
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousStore === undefined) delete process.env.DSH_CONTEXT_STORE_ROOT;
    else process.env.DSH_CONTEXT_STORE_ROOT = previousStore;
    if (previousLedger === undefined) delete process.env.DSH_THREAD_LEDGER_ROOT;
    else process.env.DSH_THREAD_LEDGER_ROOT = previousLedger;
    await rm(root, { recursive: true, force: true });
  }
}

test("hard compaction keeps a source-unavailable failed round in the raw tail", async () => {
  const requestedRoundEnds: number[] = [];
  await withEngine(120, {
    async build(request) {
      requestedRoundEnds.push(request.roundEnd);
      if (requestedRoundEnds.length === 1) {
        throw new RecordCoverageError(request.roundEnd - 1, request.roundEnd);
      }
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    const result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
    assert.ok(result !== null);
    assert.equal(requestedRoundEnds.length, 2);
    assert.equal(requestedRoundEnds[1], requestedRoundEnds[0]! - 1);
    assert.ok(session.surface.nodes.includes(requestedRoundEnds[0]! - 1));
    assert.notEqual(agent.contextGenerationId, `session:${session.id}:runtime`);
  });
});

test("BPC keeps its snapshot while raw tail grows and atomically applies as soon as the agent becomes idle", async () => {
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>(resolve => { releaseBuild = resolve; });
  let buildStarted!: () => void;
  const started = new Promise<void>(resolve => { buildStarted = resolve; });
  let buildSignal: AbortSignal | undefined;
  await withEngine(90, {
    async build(request) {
      buildSignal = request.signal;
      buildStarted();
      await buildGate;
      request.signal.throwIfAborted();
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    const signal = new AbortController().signal;
    assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
    await started;
    const background = (engine as any).inFlight.get(session.id).promise as Promise<unknown>;
    session.append("user/message", makeMessage(91), { surfaceOp: { op: "append" } });
    session.append("user/message", makeMessage(92), { surfaceOp: { op: "append" } });
    assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
    assert.equal(buildSignal?.aborted, false);
    releaseBuild();
    await background;
    const scheduled = (engine as any).scheduledApplies.get(session.id);
    assert.ok(scheduled !== undefined);
    await scheduled.promise;
    assert.equal(session.surface.nodes.length, 23);
    assert.deepEqual(session.events.slice(-4).map((event: any) => event.type), [
      "compaction/start",
      "compaction/summary",
      "user/message",
      "compaction/end",
    ]);
    assert.ok(session.surface.nodes.includes(91));
    assert.ok(session.surface.nodes.includes(92));
    assert.notEqual(agent.contextGenerationId, `session:${session.id}:runtime`);
    assert.equal((await engine.inspectRecovery(session.id)).prepared, undefined);
    assert.equal((await engine.inspectRecovery(session.id)).compactionActivity, undefined);
    assert.ok(Number.isFinite((await engine.inspectRecovery(session.id)).lastPublishedAt));
  });
});

test("a prepared BPC stays invisible while the agent is busy and publishes without another human turn after idle", async () => {
  let releaseIdle!: () => void;
  const idleGate = new Promise<void>(resolve => { releaseIdle = resolve; });
  let idleWaitStarted!: () => void;
  const idleWait = new Promise<void>(resolve => { idleWaitStarted = resolve; });
  await withEngine(90, {
    async build(request) {
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    agent.whenIdle = async () => {
      idleWaitStarted();
      await idleGate;
    };
    const signal = new AbortController().signal;
    assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
    const background = (engine as any).inFlight.get(session.id).promise as Promise<unknown>;
    await background;
    await idleWait;
    assert.equal(session.surface.nodes.length, 90);
    assert.equal((await engine.inspectRecovery(session.id)).compactionActivity?.phase, "prepared");
    const scheduled = (engine as any).scheduledApplies.get(session.id);
    assert.ok(scheduled !== undefined);
    releaseIdle();
    await scheduled.promise;
    assert.equal(session.surface.nodes.length, 21);
    assert.equal((await engine.inspectRecovery(session.id)).prepared, undefined);
  });
});

test("hard compaction retries unchanged failures and succeeds on the third attempt", async () => {
  let attempts = 0;
  await withEngine(115, {
    async build(request) {
      attempts += 1;
      if (attempts < 3) throw new Error(`fixture hard failure ${attempts}`);
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    const result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
    assert.ok(result !== null);
    assert.equal(attempts, 3);
    assert.equal((await engine.inspectRecovery(session.id)).paused, false);
  });
});

test("cancelling hard compaction clears its activity without durably pausing the session", async () => {
  let buildStarted!: () => void;
  const started = new Promise<void>(resolve => { buildStarted = resolve; });
  await withEngine(115, {
    async build(request) {
      buildStarted();
      await new Promise<void>((resolve, reject) => {
        if (request.signal.aborted) {
          reject(request.signal.reason);
          return;
        }
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    await (engine as any).runtimeStates.update(session.id, (state: any) => ({
      ...state,
      compactionActivity: { trigger: "hard", phase: "building", startedAt: 10 },
    }));
    const controller = new AbortController();
    const pending = engine.compactIfNeeded(agent, "pressure", controller.signal);
    await started;
    controller.abort(new Error("fixture user cancellation"));
    await assert.rejects(pending, /fixture user cancellation/);
    const state = await engine.inspectRecovery(session.id);
    assert.equal(state.paused, false);
    assert.equal(state.compactionActivity, undefined);
  });
});

test("hard compaction treats an official non-shrinking summary as a retryable post-commit budget failure", async () => {
  await withEngine(115, {
    async build(request) {
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    const basePrototype = Object.getPrototypeOf(MemoryRecordCompactionEngine.prototype) as Record<string, any>;
    const originalCompactIfNeeded = basePrototype.compactIfNeeded;
    let attempts = 0;
    basePrototype.compactIfNeeded = async () => {
      attempts += 1;
      if (attempts === 1) {
        session.surface.replaceGeneration += 1;
        agent.contextGenerationId = "fixture-own-committed-generation";
        (engine as any).noteHardAttemptPublication(agent, agent.contextGenerationId);
        throw new Error("summary is not smaller than the shadowed content (2619 estimated framed tokens >= 2619)");
      }
      return { retried: true };
    };
    try {
      const result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
      assert.ok(result !== null);
      assert.equal(attempts, 1);
      assert.ok(session.surface.replaceGeneration >= 2);
      assert.equal((await engine.inspectRecovery(session.id)).paused, false);
    } finally {
      basePrototype.compactIfNeeded = originalCompactIfNeeded;
    }
  });
});

test("hard compaction rejects an external replacement even when both generation markers change", async () => {
  await withEngine(115, {
    async build(request) {
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    const basePrototype = Object.getPrototypeOf(MemoryRecordCompactionEngine.prototype) as Record<string, any>;
    const originalCompactIfNeeded = basePrototype.compactIfNeeded;
    basePrototype.compactIfNeeded = async () => {
      session.surface.replaceGeneration += 1;
      agent.contextGenerationId = "fixture-external-generation";
      throw new ContextGenerationError("fixture external replacement", "BUDGET_EXCEEDED");
    };
    try {
      await assert.rejects(
        engine.compactIfNeeded(agent, "pressure", new AbortController().signal),
        (error: any) => error instanceof ContextGenerationError && error.code === "STALE_PARENT",
      );
      assert.equal((await engine.inspectRecovery(session.id)).paused, false);
    } finally {
      basePrototype.compactIfNeeded = originalCompactIfNeeded;
    }
  });
});

test("clearing an old prepared pointer does not erase a newer building activity", async () => {
  await withEngine(1, {
    async build(request) {
      return makeRecordResult(request);
    },
  }, async (engine, _agent, session) => {
    await (engine as any).runtimeStates.update(session.id, (state: any) => ({
      ...state,
      prepared: {
        selectionKey: "old-selection",
        generationId: "old-generation",
        start: 0,
        end: 0,
        inputSha256: "old-input",
        sourceRevision: "old-source",
        createdAt: 10,
      },
      compactionActivity: { trigger: "bpc", phase: "building", startedAt: 20 },
    }));
    await (engine as any).clearPrepared(session.id);
    const state = await engine.inspectRecovery(session.id);
    assert.equal(state.prepared, undefined);
    assert.deepEqual(state.compactionActivity, { trigger: "bpc", phase: "building", startedAt: 20 });
  });
});

test("discarding a stale prepared pointer also clears its stale activity", async () => {
  await withEngine(90, {
    async build(request) {
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    agent.whenIdle = async () => new Promise<void>(() => undefined);
    const signal = new AbortController().signal;
    await engine.compactIfNeeded(agent, "pressure", signal);
    const background = (engine as any).inFlight.get(session.id).promise as Promise<unknown>;
    await background;
    assert.equal((await engine.inspectRecovery(session.id)).compactionActivity?.phase, "prepared");
    session.surface.nodes.splice(1);
    assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
    const state = await engine.inspectRecovery(session.id);
    assert.equal(state.prepared, undefined);
    assert.equal(state.compactionActivity, undefined);
  });
});

test("hard compaction pauses only after all safe retries fail", async () => {
  let attempts = 0;
  await withEngine(115, {
    async build() {
      attempts += 1;
      throw new Error(`fixture permanent failure ${attempts}`);
    },
  }, async (engine, agent, session) => {
    await (engine as any).runtimeStates.update(session.id, (state: any) => ({
      ...state,
      compactionActivity: { trigger: "bpc", phase: "building", startedAt: 10 },
    }));
    await assert.rejects(engine.compactIfNeeded(agent, "pressure", new AbortController().signal), /fixture permanent failure 3/);
    assert.equal(attempts, 3);
    const state = await engine.inspectRecovery(session.id);
    assert.equal(state.paused, true);
    assert.match(state.pauseReason ?? "", /fixture permanent failure 3/);
    assert.equal(state.compactionActivity, undefined, "硬压缩最终失败后不能继续显示后台预压缩仍在构建");
  });
});

test("applying a prepared BPC rechecks pressure and immediately enters hard compaction when the tail crossed 90 percent", async () => {
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>(resolve => { releaseBuild = resolve; });
  let buildStarted!: () => void;
  const started = new Promise<void>(resolve => { buildStarted = resolve; });
  let releaseIdle!: () => void;
  const idleGate = new Promise<void>(resolve => { releaseIdle = resolve; });
  let builds = 0;
  await withEngine(90, {
    async build(request) {
      builds += 1;
      if (builds === 1) {
        buildStarted();
        await buildGate;
      }
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    agent.whenIdle = async () => idleGate;
    const signal = new AbortController().signal;
    assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
    await started;
    const background = (engine as any).inFlight.get(session.id).promise as Promise<unknown>;
    releaseBuild();
    await background;
    for (let round = 91; round <= 200; round += 1) {
      session.append("user/message", makeMessage(round), { surfaceOp: { op: "append" } });
    }
    const result = await engine.compactIfNeeded(agent, "pressure", signal);
    assert.ok(result !== null);
    assert.equal(builds, 2);
    assert.ok(session.surface.nodes.length < 108);
    assert.equal((await engine.inspectRecovery(session.id)).paused, false);
    releaseIdle();
  });
});

test("a prepared BPC respects its retry gate instead of reapplying every request", async () => {
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>(resolve => { releaseBuild = resolve; });
  let buildStarted!: () => void;
  const started = new Promise<void>(resolve => { buildStarted = resolve; });
  await withEngine(90, {
    async build(request) {
      buildStarted();
      await buildGate;
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    agent.whenIdle = async () => new Promise<void>(() => undefined);
    const signal = new AbortController().signal;
    await engine.compactIfNeeded(agent, "pressure", signal);
    await started;
    const background = (engine as any).inFlight.get(session.id).promise as Promise<unknown>;
    releaseBuild();
    await background;
    const beforeGeneration = session.surface.replaceGeneration;
    await (engine as any).runtimeStates.update(session.id, (state: any) => ({
      ...state,
      nextBpcRetryAt: Date.now() + 60_000,
    }));
    assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
    assert.equal(session.surface.replaceGeneration, beforeGeneration);
    assert.ok((await engine.inspectRecovery(session.id)).prepared !== undefined);
  });
});

test("private generation publish failure pauses the session without pointing the agent at an unpublished generation", async () => {
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>(resolve => { releaseBuild = resolve; });
  let buildStarted!: () => void;
  const started = new Promise<void>(resolve => { buildStarted = resolve; });
  await withEngine(90, {
    async build(request) {
      buildStarted();
      await buildGate;
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    agent.whenIdle = async () => new Promise<void>(() => undefined);
    const signal = new AbortController().signal;
    const originalGeneration = agent.contextGenerationId;
    await engine.compactIfNeeded(agent, "pressure", signal);
    await started;
    const background = (engine as any).inFlight.get(session.id).promise as Promise<unknown>;
    releaseBuild();
    await background;
    const store = (engine as any).store(session.id);
    store.publishAtomically = async () => { throw new Error("fixture private publish failure"); };
    await assert.rejects(
      engine.compactIfNeeded(agent, "pressure", signal),
      /fixture private publish failure/,
    );
    const state = await engine.inspectRecovery(session.id);
    assert.equal(state.paused, true);
    assert.equal(state.needsReconcile, true);
    assert.ok(state.prepared !== undefined);
    assert.match(state.pauseReason ?? "", /私有上下文发布失败/);
    assert.equal(state.compactionActivity?.phase, "applying");
    assert.equal(agent.contextGenerationId, originalGeneration);
  });
});

test("provider output maxima are bounded to a context-proportional request reserve", () => {
  assert.equal(compactionProviderTesting.effectiveReservedResponseTokens(200_000, 131_000), 16_000);
  assert.equal(compactionProviderTesting.effectiveReservedResponseTokens(1_000_000, 131_000), 80_000);
  assert.equal(compactionProviderTesting.effectiveReservedResponseTokens(12_000, 200), 200);
});

test("paired raw tails move the cut forward instead of overflowing the recent-raw budget", () => {
  const session = {
    surface: { nodes: [0, 1, 2, 3], replaceGeneration: 0 },
    events: [
      { seq: 0, type: "user/message" },
      { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "tool-call" }] } } },
      { seq: 2, type: "tool/result" },
      { seq: 3, type: "user/message" },
    ],
  };
  const measurement = {
    totalTokens: 201_040,
    nodes: [
      { seq: 0, tokens: 20 },
      { seq: 1, tokens: 20 },
      { seq: 2, tokens: 170_000 },
      { seq: 3, tokens: 31_000 },
    ],
  };

  assert.deepEqual(
    compactionProviderTesting.selectHeadRange(session, measurement, 32_000, 175_808),
    { start: 0, end: 2 },
  );
});

test("hard compaction lowers the recent-raw target after Record budget exhaustion", async () => {
  let attempts = 0;
  const retainedRequestTokens: number[] = [];
  let releaseBpc!: () => void;
  const bpcGate = new Promise<void>(resolve => { releaseBpc = resolve; });
  await withEngine(90, {
    async build(request) {
      attempts += 1;
      retainedRequestTokens.push(request.retainedRequestTokens);
      if (attempts === 1) await bpcGate;
      if (request.retainedRequestTokens > 1_000) {
        throw new ContextGenerationError("fixture Record projection cannot fit", "BUDGET_EXCEEDED");
      }
      return makeRecordResult(request);
    },
  }, async (engine, agent, session) => {
    const signal = new AbortController().signal;
    assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
    const background = (engine as any).inFlight.get(session.id).promise as Promise<unknown>;
    releaseBpc();
    await assert.rejects(background, (error: unknown) => (
      error instanceof ContextGenerationError && error.code === "BUDGET_EXCEEDED"
    ));
    for (let round = 91; round <= 115; round += 1) {
      session.append("user/message", makeMessage(round), { surfaceOp: { op: "append" } });
    }

    const result = await engine.compactIfNeeded(agent, "pressure", signal);
    assert.ok(result !== null);
    assert.deepEqual(retainedRequestTokens, [2_000, 2_000, 1_000]);
    assert.equal(attempts, 3);
    assert.equal((await engine.inspectRecovery(session.id)).paused, false);
  });
});

test("hard compaction pauses only after retrying Record budget exhaustion down to the minimum safe raw tail", async () => {
  const retainedRequestTokens: number[] = [];
  await withEngine(115, {
    async build(request) {
      retainedRequestTokens.push(request.retainedRequestTokens);
      throw new ContextGenerationError("fixture irreducible Record projection", "BUDGET_EXCEEDED");
    },
  }, async (engine, agent, session) => {
    await assert.rejects(engine.compactIfNeeded(agent, "pressure", new AbortController().signal), (error: unknown) => (
      error instanceof ContextGenerationError && error.code === "BUDGET_EXCEEDED"
    ));
    assert.deepEqual(retainedRequestTokens, [2_000, 1_000, 100]);
    assert.equal((await engine.inspectRecovery(session.id)).paused, true);
  });
});
