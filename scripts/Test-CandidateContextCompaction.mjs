import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(argv) {
  const candidateIndex = argv.indexOf("--candidate");
  if (candidateIndex < 0 || !argv[candidateIndex + 1]) throw new Error("必须传 --candidate <候选目录名>");
  return argv[candidateIndex + 1];
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeMessage(round) {
  return {
    id: `message-${round}`,
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: `第 ${round} 轮原始测试内容 ${"x".repeat(80)}` }],
  };
}

function makeSession(workspace) {
  const events = [];
  const nodes = [];
  const surface = { nodes, replaceGeneration: 0 };
  const session = {
    id: "synthetic-context-session",
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
    deriveEventMessage(event) {
      return event?.type === "user/message" || event?.type === "assistant/message" ? event.data : null;
    },
    append(type, data, options = {}) {
      const event = { seq: events.length, type, data, ...options };
      events.push(event);
      const operation = options.surfaceOp;
      if (operation?.op === "append") nodes.push(event.seq);
      if (operation?.op === "replace") {
        const startIndex = nodes.indexOf(operation.start);
        const endIndex = nodes.indexOf(operation.end);
        assert.ok(startIndex >= 0 && endIndex >= startIndex, "替换范围必须仍在表层");
        nodes.splice(startIndex, endIndex - startIndex + 1, event.seq);
        surface.replaceGeneration += 1;
      }
      return event;
    },
  };
  for (let round = 1; round <= 80; round += 1) {
    session.append("user/message", makeMessage(round), { surfaceOp: { op: "append" } });
  }
  session.append("turn/start", { turn: "turn-fixture" });
  return session;
}

const candidateName = parseArguments(process.argv.slice(2));
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const candidateRoot = path.join(workspaceRoot, "release", "candidates", candidateName);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "dsh-candidate-context-"));
let rootContext;
process.env.DSH_HOME = path.join(temporaryRoot, "dsh-home");
process.env.DSH_CONTEXT_STORE_ROOT = path.join(temporaryRoot, "context-store");
process.env.DSH_THREAD_LEDGER_ROOT = path.join(temporaryRoot, "thread-ledger");

try {
  const providerModule = await import(pathToFileURL(path.join(
    candidateRoot,
    "node_modules",
    "@dsh-experimental",
    "context-generation-state-machine",
    "lib",
    "compaction-provider.js",
  )).href);
  const threadModule = await import(pathToFileURL(path.join(
    candidateRoot,
    "node_modules",
    "@stardust",
    "dsh-thread-tools",
    "lib",
    "index.js",
  )).href);
  const cordisModule = await import(pathToFileURL(path.join(
    candidateRoot,
    "node_modules",
    "@deepseek-ai",
    "cordis",
    "lib",
    "index.js",
  )).href);
  const session = makeSession(temporaryRoot);
  const runtimeGeneration = `session:${session.id}:runtime`;
  const ledger = await threadModule.SidecarThreadLedger.open({
    rootDir: process.env.DSH_THREAD_LEDGER_ROOT,
    ownerSessionId: session.id,
    targetSessionId: session.id,
    contextGenerationId: runtimeGeneration,
    sourceRevision: "fixture-source-r1",
  });
  await ledger.initialize({ operationId: "fixture-initialize" });
  await ledger.registerReceipt({
    operationId: "fixture-read",
    readReceiptId: "fixture-receipt",
    snapshotId: "fixture-snapshot",
    dataSource: "fixture",
    rounds: [5, 10, 70, 71],
  });
  await ledger.confirmReceipt({
    operationId: "fixture-confirm",
    readReceiptId: "fixture-receipt",
    rounds: [5, 10, 70, 71],
    orderedRounds: [71, 70, 10, 5],
    confirmedAtOwnerRound: 79,
  });
  await ledger.protect({
    operationId: "fixture-protect",
    protectionId: "fixture-protection",
    ranges: [{ start: 20, end: 21 }],
  });

  let capturedRequest;
  const recordContextSource = {
    async build(request) {
      capturedRequest = request;
      const content = "## Phase 1：隔离事务（轮次 1-80）\n**关键决策：** 使用假 Record 验证官方提交链。";
      return {
        sourceRevision: "fixture-record-r1",
        recordRoundCount: 80,
        protectedProjectionContent: "## Phase protected（轮次 20-21）\n受保护测试内容",
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
            stablePrefixTokens: 0,
            recentRawTokens: request.retainedRequestTokens,
            reservedResponseTokens: request.reservedResponseTokens,
          },
        },
      };
    },
  };
  rootContext = new cordisModule.Context();
  class FixtureTokenMeter extends cordisModule.Service {
    constructor(ctx) { super(ctx, "tokenMeter"); }
    measure(current) {
      return {
        totalTokens: current.surface.nodes.length * 100,
        nodes: current.surface.nodes.map(seq => ({ seq, tokens: 100 })),
      };
    }
    estimateMessage() { return 80; }
  }
  class FixtureLlm extends cordisModule.Service {
    constructor(ctx) { super(ctx, "llm"); }
    async resolveModelInfo() { return { context: { contextWindow: 12_000 } }; }
  }
  class FixtureSessions extends cordisModule.Service {
    constructor(ctx) { super(ctx, "sessions"); }
    async flush() {}
  }
  class FixtureCommands extends cordisModule.Service {
    constructor(ctx) { super(ctx, "commands"); }
    register() { return () => {}; }
  }
  new FixtureTokenMeter(rootContext);
  new FixtureLlm(rootContext);
  new FixtureSessions(rootContext);
  new FixtureCommands(rootContext);
  const agent = {
    session,
    contextGenerationId: runtimeGeneration,
    options: { provider: "fixture", model: "fixture-model" },
    async runMaintenance(callback) { return callback(new AbortController().signal); },
  };
  const engine = new providerModule.MemoryRecordCompactionEngine(rootContext, { auto: false, recordContextSource });
  const firstSurface = session.surface.nodes[0];
  const lastSurface = session.surface.nodes.at(-1);
  const result = await engine.compactRegion(firstSurface, lastSurface, agent, new AbortController().signal);

  assert.equal(result.shadowedSeqs.length, 80);
  assert.equal(session.surface.nodes.length, 1);
  assert.deepEqual(capturedRequest.protectedRoundIds, [20, 21]);
  assert.equal(capturedRequest.detailByRound.get(20), "full");
  assert.equal(capturedRequest.detailByRound.get(21), "full");
  assert.ok(capturedRequest.detailByRound.get(71) === "full");
  assert.ok(agent.contextGenerationId.startsWith("context-"));
  assert.notEqual(agent.contextGenerationId, runtimeGeneration);
  assert.deepEqual(session.events.slice(-4).map(event => event.type), [
    "compaction/start",
    "compaction/summary",
    "user/message",
    "compaction/end",
  ]);
  const replacement = session.events.at(-2);
  assert.equal(replacement.surfaceOp.op, "replace");
  assert.ok(JSON.stringify(replacement.data).includes("dsh-memory-context"));

  const runtimeFiles = await readdir(path.join(process.env.DSH_CONTEXT_STORE_ROOT, "runtime-state"));
  assert.equal(runtimeFiles.length, 1);
  const runtimeState = JSON.parse(await readFile(path.join(process.env.DSH_CONTEXT_STORE_ROOT, "runtime-state", runtimeFiles[0]), "utf8"));
  assert.equal(runtimeState.publishedGenerationId, agent.contextGenerationId);
  assert.equal(runtimeState.heatState.targetRoundCount, 30);
  assert.equal(runtimeState.heatState.rounds.length, 80);
  assert.equal((await threadModule.SidecarThreadLedger.open({
    rootDir: process.env.DSH_THREAD_LEDGER_ROOT,
    ownerSessionId: session.id,
    targetSessionId: session.id,
    contextGenerationId: agent.contextGenerationId,
    sourceRevision: "probe",
  })).inspect().binding.contextGenerationId, runtimeGeneration);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    candidate: candidateName,
    officialTransaction: session.events.slice(-4).map(event => event.type),
    shadowedRounds: result.shadowedSeqs.length,
    protectedRounds: capturedRequest.protectedRoundIds,
    contextGenerationRotated: true,
    runtimeHeatRounds: runtimeState.heatState.rounds.length,
    temporaryRoot,
  }, null, 2)}\n`);
} finally {
  await rootContext?.fiber.dispose().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
