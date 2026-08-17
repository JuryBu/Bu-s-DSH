import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContextGenerationError } from "../src/index.ts";
import { BrokerRecordContextSource, RecordCoverageError } from "../src/record-context-source.ts";

function request() {
  return {
    contextGenerationId: "context-generation-retry-test",
    sessionId: "session-retry-test",
    workspace: "C:\\workspace",
    selectedSurfaceSeqs: [1, 2, 3],
    roundStart: 1,
    roundEnd: 3,
    detailByRound: new Map([[1, "full"], [2, "summary"], [3, "brief"]] as const),
    contextWindow: 200_000,
    retainedRequestTokens: 2_000,
    reservedResponseTokens: 4_000,
    estimateStablePrefixTokens: (content: string) => Math.ceil(content.length / 4),
    signal: new AbortController().signal,
  };
}

const record = [
  "- 总轮次：3",
  "## Phase 1：重试验证（轮次 1-3）",
  "**关键决策：** DSH 只重试 Memory Store 明确标记为可重试的传输错误。",
].join("\n");

test("BPC 优先复用当前 DSH 已注册的 Memory Store 工具，并透传当前会话与 Agent", async () => {
  const agent = { id: "fixture-agent" };
  const signal = new AbortController().signal;
  let calls = 0;
  const source = new BrokerRecordContextSource({
    callTool: async (name, args, context) => {
      calls += 1;
      assert.equal(name, "record_manage");
      assert.equal(args.action, "read");
      assert.equal(context.sessionId, "session-retry-test");
      assert.equal(context.agent, agent);
      assert.equal(context.signal, signal);
      return {
        isError: false,
        value: null,
        content: [{ type: "text", text: record }],
      };
    },
  });

  const result = await source.build({ ...request(), agent, signal });

  assert.equal(calls, 1);
  assert.equal(result.recordRoundCount, 3);
});

test("Memory Store 把长 Record 外溢到系统临时文件时读取真实正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-record-spill-test-"));
  const spillDir = join(root, "temp");
  const spillPath = join(spillDir, "record_fixture.md");
  await mkdir(spillDir);
  await writeFile(spillPath, record, "utf8");

  try {
    const source = new BrokerRecordContextSource({
      callTool: async () => ({
        isError: false,
        content: [{
          type: "text",
          text: `📄 Record session-test (3行)\n已保存到临时文件: ${spillPath}\n请用 view_file 查看。`,
        }],
      }),
    });

    const result = await source.build(request());
    assert.equal(result.recordRoundCount, 3);
    assert.match(result.input.records[0]?.content ?? "", /重试验证/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("原生 Memory Store 工具失败时保留结构化错误原因", async () => {
  const source = new BrokerRecordContextSource({
    callTool: async () => ({
      isError: true,
      error: { message: "隔离 Memory Store 拒绝读取当前会话" },
      content: [],
    }),
  });

  await assert.rejects(source.build(request()), /隔离 Memory Store 拒绝读取当前会话/);
});

test("Memory Store 明确标记为可重试时，DSH 重连后复用同一读取流程", async () => {
  const source = new BrokerRecordContextSource({ transportAttempts: 3, retryBaseDelayMs: 1 });
  let attempts = 0;
  (source as any).call = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("网络瞬断\n🔁 可重试: 是");
    return record;
  };

  const result = await source.build(request());

  assert.equal(attempts, 2);
  assert.equal(result.recordRoundCount, 3);
  assert.equal(result.input.records.length, 1);
});

test("Memory Store 明确标记为不可重试时，DSH 不重复提交同一操作", async () => {
  const source = new BrokerRecordContextSource({ transportAttempts: 3, retryBaseDelayMs: 1 });
  let attempts = 0;
  (source as any).call = async () => {
    attempts += 1;
    throw new Error("DSH session not found\n🔁 可重试: 否");
  };

  await assert.rejects(source.build(request()), /DSH session not found/);
  assert.equal(attempts, 1);
});

test("Record 刷新返回失败 0 且无需创建任务时，不把成功结果误判成 BPC 失败", async () => {
  const source = new BrokerRecordContextSource();
  let calls = 0;
  (source as any).call = async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, "record_manage");
    calls += 1;
    if (calls === 1) return "❌ 未找到 Record";
    if (args.action === "update") return "✅ Record 已是最新，无需更新\n成功 1 · 失败 0";
    return record;
  };

  const result = await source.build(request());

  assert.equal(calls, 3);
  assert.equal(result.recordRoundCount, 3);
});

test("Record 刷新可从 JSON 文本提取 taskId，并继续轮询到完整 Record", async () => {
  const source = new BrokerRecordContextSource({ refreshTimeoutMs: 1_000 });
  let calls = 0;
  (source as any).call = async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, "record_manage");
    calls += 1;
    if (calls === 1) return "❌ 未找到 Record";
    if (args.action === "update") return '{"taskId":"record-scheduler-json-test","status":"Running","失败":0}';
    if (args.action === "read" && calls === 3) return "❌ 未找到 Record";
    if (args.action === "task_status") {
      return "✅ Record source discovery 完整且没有需要更新的候选，任务以持久 no-op 成功结束";
    }
    return record;
  };

  const result = await source.build(request());

  assert.equal(result.recordRoundCount, 3);
  assert.ok(calls >= 5);
});

test("刷新任务已成功但 Record 只覆盖完整历史时立即返回覆盖边界", async () => {
  const source = new BrokerRecordContextSource({ refreshTimeoutMs: 60_000 });
  const partialRecord = [
    "- 总轮次：2",
    "## Phase 1：已完成轮次（轮次 1-2）",
    "**关键决策：** 第 3 轮仍在运行，必须保留原文。",
  ].join("\n");
  let calls = 0;
  (source as any).call = async (_name: string, args: Record<string, unknown>) => {
    calls += 1;
    if (calls === 1) return partialRecord;
    if (args.action === "update") return '{"taskId":"record-scheduler-partial","status":"Running"}';
    if (args.action === "read") return partialRecord;
    if (args.action === "task_status") {
      return [
        "📋 Record scheduler 任务：Succeeded",
        "🆔 taskId: record-scheduler-partial",
        "📦 Record: 0/1 成功，失败 0，未决 0",
        "🧩 Unit: materialized=0 eligible=0 running=0 done=0 failed=0",
      ].join("\n");
    }
    throw new Error("unexpected call");
  };

  await assert.rejects(source.build(request()), (error: unknown) => {
    assert.ok(error instanceof RecordCoverageError);
    assert.equal(error.availableRoundEnd, 2);
    assert.equal(error.requestedRoundEnd, 3);
    return true;
  });
  assert.equal(calls, 5);
});

test("Record 超预算时逐级降档，且手动保护 Phase 保持 full", async () => {
  const source = new BrokerRecordContextSource();
  const observedMeasurements: number[] = [];
  (source as any).call = async () => [
    "- 总轮次：2",
    "## Phase 1：可降档（轮次 1）",
    "**关键决策**：PHASE_ONE_SUMMARY_MARKER",
    "PHASE_ONE_FULL_ONLY",
    "## Phase 2：手动保护（轮次 2）",
    "**关键决策**：PROTECTED_SUMMARY_MARKER",
    "PROTECTED_FULL_ONLY",
  ].join("\n");

  const result = await source.build({
    ...request(),
    selectedSurfaceSeqs: [1, 2],
    roundStart: 1,
    roundEnd: 2,
    detailByRound: new Map([[1, "full"], [2, "summary"]] as const),
    protectedRoundIds: [2],
    contextWindow: 20,
    retainedRequestTokens: 0,
    reservedResponseTokens: 0,
    estimateStablePrefixTokens: (content: string) => {
      const measured = content.includes("PHASE_ONE_FULL_ONLY")
        ? 120
        : content.includes("PHASE_ONE_SUMMARY_MARKER")
          ? 40
          : 10;
      observedMeasurements.push(measured);
      return measured;
    },
  });

  const content = result.input.records[0]!.content;
  assert.deepEqual(observedMeasurements, [120, 40, 10]);
  assert.equal(result.input.tokenBudget.stablePrefixTokens, 10);
  assert.match(content, /## Phase 1：可降档/);
  assert.doesNotMatch(content, /PHASE_ONE_SUMMARY_MARKER|PHASE_ONE_FULL_ONLY/);
  assert.match(content, /PROTECTED_SUMMARY_MARKER|PROTECTED_FULL_ONLY/);
});

test("只有手动保护内容仍超预算时，Record 拒绝伪造可发布候选", async () => {
  const source = new BrokerRecordContextSource();
  (source as any).call = async () => [
    "- 总轮次：1",
    "## Phase 1：手动保护（轮次 1）",
    "**关键决策**：PROTECTED_ONLY_MARKER",
  ].join("\n");

  await assert.rejects(source.build({
    ...request(),
    selectedSurfaceSeqs: [1],
    roundStart: 1,
    roundEnd: 1,
    detailByRound: new Map([[1, "brief"]] as const),
    protectedRoundIds: [1],
    contextWindow: 20,
    retainedRequestTokens: 0,
    reservedResponseTokens: 0,
    estimateStablePrefixTokens: () => 21,
  }), (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, "BUDGET_EXCEEDED");
    return true;
  });
});
