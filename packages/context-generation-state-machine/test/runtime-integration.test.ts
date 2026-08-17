import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordContextTesting } from "../src/record-context-source.ts";
import {
  CONTEXT_RUNTIME_STATE_VERSION,
  ContextPauseRecoveryService,
  ContextRuntimeStateStore,
} from "../src/runtime-state.ts";

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-context-runtime-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("durable pause and prepared generation survive a store reconstruction", async () => {
  await withTemporaryDirectory(async directory => {
    const first = new ContextRuntimeStateStore(directory);
    await first.save({
      version: CONTEXT_RUNTIME_STATE_VERSION,
      sessionId: "session-runtime-test",
      paused: true,
      pauseReason: "hard build failed",
      prepared: {
        selectionKey: "selection-1",
        generationId: "generation-1",
        start: 2,
        end: 19,
        inputSha256: "a".repeat(64),
        sourceRevision: "b".repeat(64),
        createdAt: 100,
      },
      updatedAt: 101,
    });
    const restarted = new ContextRuntimeStateStore(directory);
    const state = await restarted.load("session-runtime-test");
    assert.equal(state.paused, true);
    assert.equal(state.pauseReason, "hard build failed");
    assert.equal(state.prepared?.generationId, "generation-1");
  });
});

test("runtime state rejects a file copied under another session identity", async () => {
  await withTemporaryDirectory(async directory => {
    const store = new ContextRuntimeStateStore(directory);
    await store.save({
      version: CONTEXT_RUNTIME_STATE_VERSION,
      sessionId: "session-a",
      paused: false,
      updatedAt: 1,
    });
    const files = await import("node:fs/promises").then(module => module.readdir(directory));
    const source = join(directory, files[0]!);
    const copied = JSON.parse(await readFile(source, "utf8"));
    copied.sessionId = "session-b";
    await writeFile(source, JSON.stringify(copied), "utf8");
    await assert.rejects(store.load("session-a"), /another session/);
  });
});

test("explicit recovery records its reason and preserves the hard failure", async () => {
  await withTemporaryDirectory(async directory => {
    const states = new ContextRuntimeStateStore(directory);
    await states.save({
      version: CONTEXT_RUNTIME_STATE_VERSION,
      sessionId: "session-recovery-test",
      paused: true,
      pauseReason: "hard compaction timed out",
      lastHardFailure: {
        reason: "hard compaction timed out",
        failedAt: 100,
      },
      publishedGenerationId: "generation-known-good",
      updatedAt: 101,
    });
    const recovery = new ContextPauseRecoveryService(states);
    await assert.rejects(recovery.resume("session-recovery-test", "  "), /Explicit recovery reason/);

    const resumed = await recovery.resume("session-recovery-test", "用户确认保留现场后继续会话");
    assert.equal(resumed.paused, false);
    assert.equal(resumed.pauseReason, undefined);
    assert.equal(resumed.publishedGenerationId, "generation-known-good");
    assert.equal(resumed.lastHardFailure?.reason, "hard compaction timed out");
    assert.equal(resumed.lastRecovery?.reason, "用户确认保留现场后继续会话");
    assert.equal(resumed.lastRecovery?.failure.failedAt, 100);
    assert.ok((resumed.lastRecovery?.recoveredAt ?? 0) >= 101);

    const restarted = new ContextPauseRecoveryService(new ContextRuntimeStateStore(directory));
    const audited = await restarted.inspect("session-recovery-test");
    assert.equal(audited.lastHardFailure?.reason, "hard compaction timed out");
    assert.equal(audited.lastRecovery?.reason, "用户确认保留现场后继续会话");
    await assert.rejects(restarted.resume("session-recovery-test", "重复恢复"), /not paused/);
  });
});

test("Record phase projection keeps only overlapping phases and applies detail levels deterministically", () => {
  const text = `📄 Record session-test:\n\n- 总轮次：12\n\n## Phase 1：早期设计（轮次 1-4）\n**用户操作**：讨论架构\n**AI执行**：读取源码并搜索\n**关键决策**：保留官方模式\n**产出文件**：无\n\n## Phase 2：实现（轮次 5-9）\n**用户操作**：开始实现\n**AI执行**：修改多个模块\n**关键决策**：使用官方事务\n**验证**：定向测试通过\n\n## Phase 3：收尾（轮次 10-12）\n**用户操作**：总验收\n**AI执行**：切换生产\n**风险**：保留回滚`;
  assert.equal(recordContextTesting.parseRoundCount(text), 12);
  const phases = recordContextTesting.parsePhases(text);
  assert.equal(phases.length, 3);
  const selected = phases.filter(phase => phase.roundEnd >= 5 && phase.roundStart <= 9);
  assert.deepEqual(selected.map(phase => phase.id), [2]);
  const summary = recordContextTesting.renderPhase(selected[0]!, "summary");
  assert.match(summary, /用户操作/);
  assert.match(summary, /关键决策/);
  assert.match(summary, /验证/);
  assert.doesNotMatch(summary, /AI执行/);
  assert.equal(recordContextTesting.renderPhase(selected[0]!, "brief"), "## Phase 2：实现（轮次 5-9）");
});
