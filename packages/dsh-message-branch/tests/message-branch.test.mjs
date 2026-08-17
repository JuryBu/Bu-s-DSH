import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BranchRecordStore,
  EXTERNAL_EFFECTS_WARNING,
  FILE_MANIFEST_MARKER,
  InternalReplayRegistry,
  MessageBranchService,
} from "../lib/testing.js";
import { apply, MESSAGE_BRANCH_SERVICE } from "../lib/index.js";
import {
  assertBranchError,
  FakeAgentRegistry,
  makeHarness,
  makeSourceAgent,
  sourceEvents,
  withPackageTemp,
} from "./helpers.mjs";

async function fixture(root, overrides = {}) {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const sourceAgent = overrides.sourceAgent ?? makeSourceAgent({ cwd: workspace });
  const registry = new FakeAgentRegistry(sourceAgent);
  const runMaintenance = sourceAgent.runMaintenance.bind(sourceAgent);
  let maintenanceRuns = 0;
  sourceAgent.runMaintenance = async callback => {
    maintenanceRuns += 1;
    if (maintenanceRuns > 1) await registry.beforeCommit?.();
    return runMaintenance(callback);
  };
  const store = new BranchRecordStore({ rootDir: path.join(root, "branch-store") });
  const replayRegistry = new InternalReplayRegistry();
  const emitted = [];
  const harness = makeHarness({ sourceAgent, registry, store, replayRegistry, emitted });
  const service = new MessageBranchService({ ...harness.options, ...overrides.options });
  return { workspace, sourceAgent, registry, store, replayRegistry, emitted, harness, service };
}

test("Cordis 插件入口注册独立消息分支服务并可安全卸载", async () => {
  await withPackageTemp("plugin-entry", async root => {
    const sourceAgent = makeSourceAgent({ cwd: root });
    const registry = new FakeAgentRegistry(sourceAgent);
    const provided = new Map();
    const routes = [];
    const workspace = { sessionIds: [sourceAgent.id], attached: [], async attachSession(id) { this.attached.push(id); this.sessionIds.push(id); } };
    const ctx = {
      agents: registry,
      agentPresets: {},
      webServer: { register(route) { routes.push(route); return () => {}; } },
      workspaceRegistry: { list: () => [workspace] },
      get: name => {
        if (name === "workspaceRegistry") throw new Error("workspaceRegistry 必须通过注入属性读取");
        return undefined;
      },
      emit: () => {},
      logger: { info: () => {}, warn: () => {} },
      provide(name, value) {
        provided.set(name, value);
        return () => provided.delete(name);
      },
    };
    const dispose = await apply(ctx, {
      storeDirectory: path.join(root, "branch-store"),
      snapshotStore: false,
      createUserMessage: ({ content, source }) => ({ id: "entry-edited", role: "user", content, source }),
      sessionIdFactory: () => "entry-child",
    });
    assert.equal(provided.get(MESSAGE_BRANCH_SERVICE) instanceof MessageBranchService, true);
    assert.equal((await provided.get(MESSAGE_BRANCH_SERVICE).availability(sourceAgent.id)).allowed, true);
    assert.deepEqual(routes.map(route => route.path), [
      "/message-branch/availability",
      "/message-branch/edit-and-resend",
    ]);
    const result = await provided.get(MESSAGE_BRANCH_SERVICE).editAndResend({
      operationId: "entry-workspace",
      sessionId: sourceAgent.id,
      expectedSourceMessageId: "user-1",
      draft: { text: "子分支应可见", images: [], files: [] },
    });
    assert.equal(result.childSessionId, sourceAgent.id);
    assert.deepEqual(workspace.attached, []);
    await dispose();
    assert.equal(provided.has(MESSAGE_BRANCH_SERVICE), false);
  });
});

test("空闲会话可用性返回文本、图片和既有文件草稿", async () => {
  await withPackageTemp("availability", async root => {
    const state = await fixture(root);
    const available = await state.service.availability(state.sourceAgent.id);
    assert.equal(available.allowed, true);
    assert.equal(available.sourceMessageId, "user-1");
    assert.equal(available.draft.text, "需要编辑的上一条真人消息");
    assert.deepEqual(available.draft.images, []);
    assert.deepEqual(available.draft.files, []);
  });
});

test("旧版分支记录保持可读，单个真正损坏的旁支记录不会阻塞其它消息", async () => {
  await withPackageTemp("legacy-and-corrupt-sidecars", async root => {
    const store = new BranchRecordStore({ rootDir: path.join(root, "branch-store") });
    await mkdir(store.rootDir, { recursive: true });
    const legacy = {
      schemaVersion: 1,
      operationId: "legacy-operation",
      state: "created",
      parentSessionId: "legacy-parent",
      sourceMessageId: "legacy-source",
      sourceEventSeq: 4,
      sourceTurn: 1,
      branchPointSeq: 3,
      participantIds: [],
      attachments: { images: [], files: [] },
      externalEffects: "preserved",
      requestDigest: "sha256:legacy",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:01.000Z",
      childSessionId: "legacy-child",
      editedMessageId: "legacy-edited",
    };
    const legacyRaw = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(store.pathFor(legacy.operationId), legacyRaw, "utf8");
    const corruptPath = path.join(store.rootDir, "unrelated-corrupt.json");
    await writeFile(corruptPath, "{", "utf8");
    const warnings = [];
    assert.equal(
      (await store.findByEditedMessageId("legacy-edited", { onInvalid: error => warnings.push(error) }))?.operationId,
      legacy.operationId,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "branch_store_corrupt");
    assert.equal(await readFile(store.pathFor(legacy.operationId), "utf8"), legacyRaw);
    assert.equal(await readFile(corruptPath, "utf8"), "{");
    await assert.rejects(store.list(), assertBranchError(assert, "branch_store_corrupt"));
  });
});

test("可能属于目标消息的损坏记录会保留原文件并阻止重发", async () => {
  await withPackageTemp("target-corrupt-sidecar", async root => {
    const state = await fixture(root);
    const corruptPath = state.store.pathFor("unknown-target-operation");
    await mkdir(state.store.rootDir, { recursive: true });
    await writeFile(corruptPath, "{", "utf8");
    const available = await state.service.availability(state.sourceAgent.id);
    assert.equal(available.allowed, false);
    assert.equal(available.reason, "branch_store_conflict");
    assert.equal(await readFile(corruptPath, "utf8"), "{");
  });
});

test("改名或篡改 operationId 的目标记录不会被接受", async () => {
  await withPackageTemp("renamed-target-sidecar", async root => {
    const state = await fixture(root);
    await mkdir(state.store.rootDir, { recursive: true });
    const record = {
      schemaVersion: 1,
      operationId: "renamed-operation",
      state: "created",
      parentSessionId: state.sourceAgent.id,
      sourceMessageId: "user-1",
      sourceEventSeq: 4,
      sourceTurn: 1,
      branchPointSeq: 3,
      participantIds: [],
      attachments: { images: [], files: [{ name: "must-not-disappear.txt" }] },
      externalEffects: "preserved",
      requestDigest: "sha256:renamed",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:01.000Z",
      childSessionId: "renamed-child",
      editedMessageId: "user-1",
    };
    const renamedPath = path.join(state.store.rootDir, "renamed.json");
    await writeFile(renamedPath, JSON.stringify(record), "utf8");
    const available = await state.service.availability(state.sourceAgent.id);
    assert.equal(available.allowed, false);
    assert.equal(available.reason, "branch_store_conflict");
    assert.equal(await readFile(renamedPath, "utf8"), JSON.stringify(record));
  });
});

test("sidecar 文件系统读取错误不会被伪装成可忽略的损坏记录", async () => {
  await withPackageTemp("sidecar-io-error", async root => {
    const rootDir = path.join(root, "branch-store");
    await mkdir(rootDir, { recursive: true });
    await writeFile(path.join(rootDir, `${"a".repeat(64)}.json`), "{}", "utf8");
    const accessError = Object.assign(new Error("fixture access denied"), { code: "EACCES" });
    const store = new BranchRecordStore({
      rootDir,
      readFileImpl: async () => { throw accessError; },
    });
    await assert.rejects(store.list({ skipInvalid: true }), error => error === accessError);
  });
});

test("运行中、待处理、无真人消息和过期编辑器均被拒绝", async t => {
  await t.test("运行中", async () => withPackageTemp("busy", async root => {
    const state = await fixture(root);
    state.sourceAgent.status = "running";
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-busy", sessionId: state.sourceAgent.id, expectedSourceMessageId: "user-1", draft: { text: "x" } }),
      assertBranchError(assert, "session_running"),
    );
  }));
  await t.test("待处理输入", async () => withPackageTemp("pending", async root => {
    const state = await fixture(root);
    state.sourceAgent.inbox.hasPending = true;
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-pending", sessionId: state.sourceAgent.id, expectedSourceMessageId: "user-1", draft: { text: "x" } }),
      assertBranchError(assert, "pending_input"),
    );
  }));
  await t.test("无真人消息", async () => withPackageTemp("no-human", async root => {
    const sourceAgent = makeSourceAgent({ cwd: root, events: sourceEvents().filter(event => event.type !== "user/message" || event.data.source.kind !== "user") });
    const state = await fixture(root, { sourceAgent });
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-no-human", sessionId: state.sourceAgent.id, expectedSourceMessageId: "missing", draft: { text: "x" } }),
      assertBranchError(assert, "no_real_user_message"),
    );
  }));
  await t.test("不存在的消息 ID", async () => withPackageTemp("stale", async root => {
    const state = await fixture(root);
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-stale", sessionId: state.sourceAgent.id, expectedSourceMessageId: "missing-user", draft: { text: "x" } }),
      assertBranchError(assert, "stale_source_message"),
    );
  }));
});

test("文本、图片和文件一次重发，创建分支且明确保留外部副作用", async () => {
  await withPackageTemp("success", async root => {
    const state = await fixture(root, {
      options: {
        attachments: {
          validated: [],
          saved: [],
          async validateImage(input) {
            this.validated.push(input);
          },
          async saveImage(input) {
            const attachment = { attachmentId: "image-1", mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name };
            this.saved.push(attachment);
            return attachment;
          },
        },
      },
    });
    const sourceBefore = structuredClone(state.sourceAgent.session.events);
    const filePath = path.join(state.workspace, "notes.txt");
    await writeFile(filePath, "branch fixture", "utf8");
    const lifecycle = [];
    state.replayRegistry.register({
      id: "fixture.internal-state",
      capture: async context => {
        lifecycle.push(["capture", context.branchPointSeq]);
        return { value: 42 };
      },
      restore: async context => {
        lifecycle.push(["restore", context.snapshot.value, context.branchPointSeq]);
        context.childCtx.restoredValue = context.snapshot.value;
      },
    });
    const request = {
      operationId: "op-success",
      sessionId: state.sourceAgent.id,
      expectedSourceMessageId: "user-1",
      draft: {
        text: "编辑后的正文",
        images: [{ dataBase64: Buffer.from([1, 2, 3]).toString("base64"), mediaType: "image/png", name: "tiny.png" }],
        files: [{ name: "notes.txt", workspacePath: filePath, mediaType: "text/plain" }],
      },
    };
    const result = await state.service.editAndResend(request);
    assert.equal(result.state, "created");
    assert.equal(result.externalEffects, "preserved");
    assert.equal(result.idempotent, false);
    assert.deepEqual(state.sourceAgent.session.events.slice(0, sourceBefore.length), sourceBefore);
    assert.equal(state.registry.created.length, 0);
    assert.equal(result.childSessionId, state.sourceAgent.id);
    assert.equal(state.sourceAgent.ctx.restoredValue, 42);
    assert.deepEqual(lifecycle, [["capture", 3], ["restore", 42, 3]]);
    assert.deepEqual(state.harness.workspace.attached, []);
    const editedEvent = state.sourceAgent.session.events.find(event => event.type === "user/message" && event.data.id === result.editedMessageId);
    assert.deepEqual(editedEvent.surfaceOp, { op: "replace", start: 4, end: 7 });
    assert.deepEqual(editedEvent.sourceEventSeqs, [4, 7]);
    assert.equal(editedEvent.data.source.kind, "user");
    assert.equal(editedEvent.data.content[0].text, "编辑后的正文");
    assert.equal(editedEvent.data.content[1].type, "image");
    assert.ok(editedEvent.data.content[2].text.startsWith(FILE_MANIFEST_MARKER));
    assert.match(editedEvent.data.content[2].text, /notes\.txt/);
    assert.deepEqual(state.emitted.map(record => record.state), ["preparing", "created"]);
    const sidecarPath = state.store.pathFor("op-success");
    const rawSidecar = await readFile(sidecarPath, "utf8");
    assert.doesNotMatch(rawSidecar, /编辑后的正文/);
    assert.doesNotMatch(rawSidecar, new RegExp(request.draft.images[0].dataBase64));
    assert.equal(JSON.parse(rawSidecar).externalEffects, "preserved");
    const replay = await state.service.editAndResend(request);
    assert.equal(replay.idempotent, true);
    assert.equal(state.sourceAgent.session.events.filter(event => event.type === "user/message" && event.data.id === result.editedMessageId).length, 1);
  });
});

test("文件选择器上传的普通文件写入工作区附件目录并进入新分支", async () => {
  await withPackageTemp("inline-file-upload", async root => {
    const state = await fixture(root);
    const result = await state.service.editAndResend({
      operationId: "inline-file-operation",
      sessionId: state.sourceAgent.id,
      expectedSourceMessageId: "user-1",
      draft: {
        text: "带普通文件",
        images: [],
        files: [{ name: "notes.txt", mediaType: "text/plain", dataBase64: Buffer.from("hello file", "utf8").toString("base64") }],
        order: [{ type: "text" }, { type: "file", index: 0 }],
      },
    });
    const record = await state.store.read(result.operationId);
    assert.equal(record.attachments.files.length, 1);
    assert.equal(await readFile(record.attachments.files[0].workspacePath, "utf8"), "hello file");
  });
});

test("编辑重发使用当前 composer 模型，并把选择纳入幂等摘要", async () => {
  await withPackageTemp("composer-model-selection", async root => {
    const state = await fixture(root);
    const request = {
      operationId: "op-composer-model",
      sessionId: state.sourceAgent.id,
      expectedSourceMessageId: "user-1",
      modelSelection: { provider: "openai", model: "gpt-5.6", reasoningEffort: "high" },
      draft: { text: "按当前编辑器模型重发", images: [], files: [] },
    };
    await state.service.editAndResend(request);
    const assembled = await state.sourceAgent.ctx.waterfall(
      "system-prompt/assemble",
      { variables: { provider: "legacy", model: "legacy-model", reasoning_effort: "legacy" } },
      {},
      async () => ({ variables: { provider: "legacy", model: "legacy-model", reasoning_effort: "legacy" } }),
    );
    assert.deepEqual(assembled.variables, { provider: "openai", model: "gpt-5.6", reasoning_effort: "legacy" });
    const routed = await state.sourceAgent.ctx.waterfall(
      "agent/request",
      {},
      {},
      async () => ({ provider: "legacy", model: "legacy-model", reasoningEffort: "legacy", preserved: true }),
    );
    assert.deepEqual(routed, { provider: "openai", model: "gpt-5.6", reasoningEffort: "high", preserved: true });
    const record = await state.store.read(request.operationId);
    assert.deepEqual(record.modelSelection, request.modelSelection);
    await assert.rejects(
      state.service.editAndResend({ ...request, modelSelection: { provider: "openai", model: "gpt-5.6", reasoningEffort: "medium" } }),
      assertBranchError(assert, "operation_conflict"),
    );
  });
});

test("显式 draft.order 决定编辑后消息中文字、图片和普通文件清单顺序", async () => {
  await withPackageTemp("ordered-draft", async root => {
    const state = await fixture(root, {
      options: {
        attachments: {
          async validateImage() {},
          async saveImage(input) {
            return { attachmentId: "ordered-image", mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name };
          },
        },
      },
    });
    const filePath = path.join(state.workspace, "ordered.txt");
    await writeFile(filePath, "ordered file", "utf8");
    const result = await state.service.editAndResend({
      operationId: "op-ordered",
      sessionId: state.sourceAgent.id,
      expectedSourceMessageId: "user-1",
      draft: {
        text: "按显式顺序重发",
        images: [{ dataBase64: Buffer.from([9, 8, 7]).toString("base64"), mediaType: "image/png", name: "ordered.png" }],
        files: [{ name: "ordered.txt", workspacePath: filePath, mediaType: "text/plain" }],
        order: [{ type: "file", index: 0 }, { type: "image", index: 0 }, { type: "text" }],
      },
    });
    const editedEvent = state.sourceAgent.session.events.find(event => event.type === "user/message" && event.data.id === result.editedMessageId);
    assert.ok(editedEvent.data.content[0].text.startsWith(FILE_MANIFEST_MARKER));
    assert.match(editedEvent.data.content[0].text, /ordered\.txt/);
    assert.equal(editedEvent.data.content[1].attachment.attachmentId, "ordered-image");
    assert.equal(editedEvent.data.content[2].text, "按显式顺序重发");
    const record = await state.store.read("op-ordered");
    assert.equal(record.attachments.files[0].name, "ordered.txt");
    assert.equal(record.attachments.images[0].attachmentId, "ordered-image");
  });
});

test("旧调用未提供模型选择时保持源 Agent 创建选项", async () => {
  await withPackageTemp("legacy-model-selection", async root => {
    const state = await fixture(root);
    await state.service.editAndResend({
      operationId: "op-legacy-model",
      sessionId: state.sourceAgent.id,
      expectedSourceMessageId: "user-1",
      draft: { text: "旧客户端请求", images: [], files: [] },
    });
    assert.deepEqual(state.sourceAgent.options, { fixture: true });
  });
});

test("发布前竞态或内部状态恢复失败时不发布半成品分支", async t => {
  await t.test("commit 前出现待处理输入", async () => withPackageTemp("commit-race", async root => {
    const state = await fixture(root);
    state.registry.beforeCommit = () => {
      state.sourceAgent.inbox.hasPending = true;
    };
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-race", sessionId: state.sourceAgent.id, expectedSourceMessageId: "user-1", draft: { text: "竞态" } }),
      assertBranchError(assert, "pending_input"),
    );
    assert.equal(state.registry.created.length, 0);
    assert.equal(state.registry.get("session-child-1"), undefined);
    assert.equal((await state.store.read("op-race")).state, "failed");
  }));
  await t.test("commit 前同 ID 消息的序号或内容变化", async () => withPackageTemp("commit-message-changed", async root => {
    const state = await fixture(root);
    state.registry.beforeCommit = () => {
      const target = state.sourceAgent.session.events.find(event => event.type === "user/message" && event.data?.id === "user-1");
      target.data.content[0].text = "同一个 ID，但内容已被其它恢复路径替换";
    };
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-message-changed", sessionId: state.sourceAgent.id, expectedSourceMessageId: "user-1", sourceEventSeq: 4, draft: { text: "竞态" } }),
      assertBranchError(assert, "stale_source_message"),
    );
    assert.equal(state.registry.created.length, 0);
    assert.equal(state.registry.get("session-child-1"), undefined);
    assert.equal((await state.store.read("op-message-changed")).state, "failed");
  }));
  await t.test("读取历史快照期间目标消息变化", async () => withPackageTemp("snapshot-message-changed", async root => {
    const state = await fixture(root);
    state.replayRegistry.register({
      id: "fixture.mutate-source-during-snapshot",
      capture: async () => {
        const target = state.sourceAgent.session.events.find(event => event.type === "user/message" && event.data?.id === "user-1");
        target.data.content[0].text = "快照读取过程中被其它恢复路径替换";
        return { captured: true };
      },
      restore: async () => {},
    });
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-snapshot-message-changed", sessionId: state.sourceAgent.id, expectedSourceMessageId: "user-1", sourceEventSeq: 4, draft: { text: "竞态" } }),
      assertBranchError(assert, "stale_source_message"),
    );
    assert.equal(state.registry.created.length, 0);
    assert.equal((await state.store.read("op-snapshot-message-changed")).state, "failed");
  }));
  await t.test("内部参与者恢复失败", async () => withPackageTemp("restore-failure", async root => {
    const state = await fixture(root);
    state.replayRegistry.register({
      id: "fixture.fail",
      capture: async () => ({ captured: true }),
      restore: async () => {
        throw new Error("restore exploded");
      },
    });
    await assert.rejects(
      state.service.editAndResend({ operationId: "op-restore-fail", sessionId: state.sourceAgent.id, expectedSourceMessageId: "user-1", draft: { text: "恢复失败" } }),
      /restore exploded/,
    );
    assert.equal(state.registry.created.length, 0);
    const saved = await state.store.read("op-restore-fail");
    assert.equal(saved.state, "failed");
    assert.equal(saved.failure.code, "internal");
  }));
});
