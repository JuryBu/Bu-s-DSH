import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BranchRecordStore,
  extractDraftFromMessage,
  FILE_MANIFEST_MARKER,
  findLastRealUserMessage,
  findRealUserMessage,
  locateBranchPoint,
  normalizeDraftShape,
  normalizeDraftOrder,
  normalizeFileDescriptor,
  normalizeModelSelection,
} from "../lib/testing.js";
import { assertBranchError, sourceEvents, withPackageTemp } from "./helpers.mjs";

test("默认选择最后一条，也能按 ID 选择任意历史真人消息", () => {
  const events = sourceEvents();
  const selected = findLastRealUserMessage(events);
  assert.equal(selected.data.id, "user-1");
  const point = locateBranchPoint(events, selected);
  assert.equal(point.sourceTurn, 2);
  assert.equal(point.branchPointSeq, 3);
  assert.deepEqual(point.seed, events.slice(0, 3));
  const historical = findRealUserMessage(events, { messageId: "user-0", sourceEventSeq: 1 });
  assert.equal(historical.data.id, "user-0");
  const historicalPoint = locateBranchPoint(events, historical);
  assert.equal(historicalPoint.branchPointSeq, 0);
  assert.deepEqual(historicalPoint.seed, []);
});

test("草稿与文件附件边界拒绝空消息和工作区外路径", async () => {
  assert.throws(() => normalizeDraftShape({ text: "", images: [], files: [] }), assertBranchError(assert, "empty_draft"));
  assert.deepEqual(normalizeDraftShape({
    text: "正文",
    images: [{ attachment: { attachmentId: "img", mediaType: "image/png", bytes: 1, width: 1, height: 1 } }],
    files: [{ name: "a.txt", attachmentRef: "host-file:a" }],
    order: [{ type: "image", index: 0 }, { type: "file", index: 0 }, { type: "text" }],
  }).order, [{ type: "image", index: 0 }, { type: "file", index: 0 }, { type: "text" }]);
  assert.deepEqual(normalizeDraftOrder([{ type: "text" }], { hasText: true, imageCount: 1, fileCount: 1 }), [
    { type: "text" },
    { type: "image", index: 0 },
    { type: "file", index: 0 },
  ]);
  assert.throws(
    () => normalizeDraftShape({ text: "x", images: [], files: [], order: [{ type: "image", index: 0 }] }),
    assertBranchError(assert, "invalid_request"),
  );
  await withPackageTemp("contract-files", async root => {
    const workspace = path.join(root, "workspace");
    const inside = path.join(workspace, "inside.txt");
    const outside = path.join(root, "outside.txt");
    await mkdir(workspace, { recursive: true });
    await Promise.all([writeFile(inside, "inside", "utf8"), writeFile(outside, "outside", "utf8")]);
    assert.equal(normalizeFileDescriptor({ name: "inside.txt", workspacePath: inside }, workspace).workspacePath, inside);
    assert.throws(
      () => normalizeFileDescriptor({ name: "outside.txt", workspacePath: outside }, workspace),
      assertBranchError(assert, "attachment_outside_workspace"),
    );
  });
});

test("从历史消息提取草稿时保留文字、图片和普通文件清单顺序", () => {
  const draft = extractDraftFromMessage({
    content: [
      { type: "image", attachment: { attachmentId: "img-1", mediaType: "image/png", bytes: 1, width: 1, height: 1 } },
      { type: "text", text: "原文" },
      { type: "text", text: `${FILE_MANIFEST_MARKER}\n- a.txt` },
    ],
  }, [{ name: "a.txt", attachmentRef: "host-file:a" }]);
  assert.deepEqual(draft.order, [
    { type: "image", index: 0 },
    { type: "text" },
    { type: "file", index: 0 },
  ]);
  assert.equal(draft.text, "原文");
  assert.equal(draft.images[0].attachment.attachmentId, "img-1");
  assert.equal(draft.files[0].name, "a.txt");
});

test("发送时模型选择要求完整且非空", () => {
  assert.deepEqual(normalizeModelSelection({ provider: "openai", model: "gpt-5.6", reasoningEffort: "high" }), {
    provider: "openai",
    model: "gpt-5.6",
    reasoningEffort: "high",
  });
  assert.equal(normalizeModelSelection(undefined), undefined);
  assert.throws(() => normalizeModelSelection({ provider: "", model: "gpt-5.6" }), assertBranchError(assert, "invalid_request"));
  assert.throws(() => normalizeModelSelection({ provider: "openai", model: "" }), assertBranchError(assert, "invalid_request"));
  assert.throws(() => normalizeModelSelection({ provider: "openai", model: "gpt-5.6", reasoningEffort: "" }), assertBranchError(assert, "invalid_request"));
});

test("sidecar 只允许 preparing 到 created/failed 的原子状态迁移", async () => {
  await withPackageTemp("store-transitions", async root => {
    const store = new BranchRecordStore({ rootDir: root });
    const preparing = {
      schemaVersion: 2,
      operationId: "op-state",
      state: "preparing",
      parentSessionId: "parent",
      sourceMessageId: "source",
      sourceEventSeq: 4,
      sourceTurn: 1,
      branchPointSeq: 3,
      participantIds: [],
      attachments: { images: [], files: [] },
      externalEffects: "preserved",
      requestDigest: "sha256:fixture",
      createdAt: "2026-08-16T05:30:00.000Z",
      updatedAt: "2026-08-16T05:30:00.000Z",
    };
    await store.save(preparing);
    await assert.rejects(
      store.save({ ...preparing, state: "created", requestDigest: "sha256:changed", childSessionId: "child", editedMessageId: "edited" }),
      assertBranchError(assert, "operation_conflict"),
    );
    const created = { ...preparing, state: "created", childSessionId: "child", editedMessageId: "edited", updatedAt: "2026-08-16T05:30:01.000Z" };
    await store.save(created);
    await assert.rejects(
      store.save({ ...created, state: "failed", failure: { code: "late", message: "late" } }),
      assertBranchError(assert, "invalid_state_transition"),
    );
  });
});
