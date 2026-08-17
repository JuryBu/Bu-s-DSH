import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BranchRecordStore,
  InternalReplayRegistry,
  MessageBranchService,
  TurnSnapshotStore,
} from "../lib/testing.js";
import {
  FakeAgentRegistry,
  makeEvent,
  makeHarness,
  makeMessage,
  makeSourceAgent,
  withPackageTemp,
} from "./helpers.mjs";

test("任意历史消息使用发送前持久快照，并保留后来文件冲突", async () => {
  await withPackageTemp("historical-snapshot", async root => {
    const workspace = path.join(root, "workspace");
    const changedPath = path.join(workspace, "changed.txt");
    const missingPath = path.join(workspace, "missing.txt");
    const createdAfterSnapshotPath = path.join(workspace, "created-after-snapshot.txt");
    await mkdir(workspace, { recursive: true });
    await Promise.all([
      writeFile(changedPath, "分支点内容", "utf8"),
      writeFile(missingPath, "应从快照恢复", "utf8"),
      writeFile(createdAfterSnapshotPath, "随后会删除", "utf8"),
    ]);

    const events = [
      makeEvent(0, "turn/start", { turn: 1 }),
      makeEvent(1, "user/message", makeMessage("user-0", "第一条消息"), { surfaceOp: "append" }),
      makeEvent(2, "tool/result", {
        meta: {
          diffs: [
            { path: changedPath, oldText: "旧", newText: "分支点内容" },
            { path: missingPath, oldText: null, newText: "应从快照恢复" },
            { path: createdAfterSnapshotPath, oldText: "随后会删除", newText: null },
          ],
        },
      }),
      makeEvent(3, "turn/end", { turn: 1, reason: { kind: "completed" } }),
      makeEvent(4, "turn/start", { turn: 2 }),
    ];
    await unlink(createdAfterSnapshotPath);
    const sourceAgent = makeSourceAgent({ cwd: workspace, events });
    const registry = new FakeAgentRegistry(sourceAgent);
    const store = new BranchRecordStore({ rootDir: path.join(root, "branch-store") });
    const snapshotStore = new TurnSnapshotStore({ rootDir: path.join(root, "turn-snapshots") });
    const replayRegistry = new InternalReplayRegistry();
    let internalValue = 12;
    replayRegistry.register({
      id: "fixture.internal",
      capture: async () => ({ value: internalValue }),
      restore: async ({ childCtx, snapshot }) => {
        childCtx.restoredValue = snapshot.value;
      },
    });
    const harness = makeHarness({ sourceAgent, registry, store, replayRegistry, emitted: [] });
    const service = new MessageBranchService({ ...harness.options, snapshotStore });
    const targetMessage = makeMessage("user-1", "历史目标消息");
    await service.captureIncomingMessages({
      agent: sourceAgent,
      messages: [targetMessage],
      turn: 2,
      signal: new AbortController().signal,
    });

    internalValue = 99;
    sourceAgent.session.events.push(makeEvent(5, "user/message", targetMessage, { surfaceOp: "append" }));
    sourceAgent.session.events.push(makeEvent(6, "turn/end", { turn: 2, reason: { kind: "completed" } }));
    sourceAgent.session.events.push(makeEvent(7, "turn/start", { turn: 3 }));
    sourceAgent.session.events.push(makeEvent(8, "user/message", makeMessage("user-2", "后来消息"), { surfaceOp: "append" }));
    sourceAgent.session.events.push(makeEvent(9, "turn/end", { turn: 3, reason: { kind: "completed" } }));
    await writeFile(changedPath, "后来内容", "utf8");
    await unlink(missingPath);
    await writeFile(createdAfterSnapshotPath, "后来新建的内容", "utf8");
    const eventsBeforeResend = structuredClone(sourceAgent.session.events);

    const result = await service.editAndResend({
      operationId: "op-historical",
      sessionId: sourceAgent.id,
      expectedSourceMessageId: "user-1",
      sourceEventSeq: 5,
      draft: { text: "修改后的历史消息", images: [], files: [] },
    });

    assert.equal(result.state, "created");
    assert.equal(result.fileRestoration.restored.length, 1);
    assert.equal(result.fileRestoration.conflicts.length, 2);
    assert.equal(await readFile(changedPath, "utf8"), "后来内容");
    assert.equal(await readFile(missingPath, "utf8"), "应从快照恢复");
    assert.equal(await readFile(createdAfterSnapshotPath, "utf8"), "后来新建的内容");
    assert.deepEqual(result.fileRestoration.conflicts.find((conflict) => conflict.path === createdAfterSnapshotPath), {
      path: createdAfterSnapshotPath,
      reason: "file_created_after_snapshot",
    });
    assert.equal(result.childSessionId, sourceAgent.id);
    assert.equal(registry.created.length, 0);
    assert.deepEqual(sourceAgent.session.events.slice(0, eventsBeforeResend.length), eventsBeforeResend);
    assert.equal(sourceAgent.ctx.restoredValue, 12);
    const replacement = sourceAgent.session.events.find(event => event.type === "user/message" && event.data?.id === result.editedMessageId);
    assert.equal(replacement.surfaceOp.op, "replace");
    assert.deepEqual(replacement.sourceEventSeqs, [5, 8]);
    assert.equal(replacement.data.content[0].text, "修改后的历史消息");
    assert.deepEqual(sourceAgent.session.surface.nodes, [1, replacement.seq]);
    const savedSnapshot = await snapshotStore.read(sourceAgent.id, "user-1");
    assert.equal(savedSnapshot.agentOptions.fixture, true);
    assert.equal(savedSnapshot.participants[0].snapshot.value, 12);
  });
});

test("快照缺失时历史消息仍可查看但拒绝猜状态分支", async () => {
  await withPackageTemp("missing-snapshot", async root => {
    const sourceAgent = makeSourceAgent({ cwd: root });
    const registry = new FakeAgentRegistry(sourceAgent);
    const store = new BranchRecordStore({ rootDir: path.join(root, "branch-store") });
    const snapshotStore = new TurnSnapshotStore({ rootDir: path.join(root, "turn-snapshots") });
    const harness = makeHarness({ sourceAgent, registry, store, emitted: [] });
    const service = new MessageBranchService({ ...harness.options, snapshotStore });
    assert.deepEqual(await service.availability(sourceAgent.id, { messageId: "user-0", sourceEventSeq: 1 }), {
      allowed: false,
      reason: "snapshot_missing",
    });
    await assert.rejects(
      service.editAndResend({
        operationId: "op-missing-snapshot",
        sessionId: sourceAgent.id,
        expectedSourceMessageId: "user-0",
        sourceEventSeq: 1,
        draft: { text: "不能猜", images: [], files: [] },
      }),
      error => error?.code === "snapshot_missing",
    );
  });
});
