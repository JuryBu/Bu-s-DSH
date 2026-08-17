import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EDIT_RESEND_SHELL_STYLE,
  dshEditExternalEffects,
  dshEditIntakeFiles,
  dshEditSendState,
  patchEditResendShellSource,
} from "../lib/transforms-frontend.mjs";
import { dshEditOperationIdFor, dshEditSourceSeqState, dshEditTextFingerprint } from "../lib/frontend/edit-resend-shell.mjs";
import {
  dshEditCurrentModelSelection,
  dshEditDraftFromContent,
  dshEditLargeTextMode,
  dshEditSubmitOrder,
} from "../lib/frontend/edit-resend-shell.mjs";
import { patchClientRuntimeSource, patchConversationUiSource } from "../lib/transforms.mjs";

/**
 * 批次 D（窗口 G3）：编辑上一条用户消息的外壳。
 *
 * 分三类断言：纯逻辑分支、对干净基线的锚点应用、整链叠加后的产物结构。
 */
const BASELINE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai";
const baselineAvailable = existsSync(BASELINE);

function baselineSource(pkg) {
  return readFileSync(path.join(BASELINE, pkg, "lib", "client.js"), "utf8");
}

function assertSyntaxOk(name, source) {
  const dir = path.join(tmpdir(), "dsh-frontend-batch-d");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  writeFileSync(file, source, "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

test("发送状态：后端能力缺失时永远禁用，且原因是 backend", () => {
  assert.deepEqual(dshEditSendState({ backendReady: false, text: "改过了", originalText: "原文", addedCount: 0 }), {
    disabled: true,
    reason: "backend",
  });
  // 后端缺失优先于「空」「未修改」，因为它是唯一无法靠用户输入解除的原因。
  assert.equal(dshEditSendState({ backendReady: false, text: "", originalText: "", addedCount: 0 }).reason, "backend");
});

test("发送状态：空内容与未修改分别禁用，改了字或加了图就放开", () => {
  assert.equal(dshEditSendState({ backendReady: true, text: "   ", originalText: "原文", addedCount: 0 }).reason, "empty");
  assert.equal(dshEditSendState({ backendReady: true, text: " 原文 ", originalText: "原文", addedCount: 0 }).disabled, false, "首尾空白也是有效编辑");
  assert.deepEqual(dshEditSendState({ backendReady: true, text: "原文", originalText: "原文", addedCount: 1 }), {
    disabled: false,
    reason: null,
  });
  assert.deepEqual(dshEditSendState({ backendReady: true, text: "改过了", originalText: "原文", addedCount: 0 }), {
    disabled: false,
    reason: null,
  });
  // 只有附件、没有文本也允许发送（普通输入框同样允许纯图片消息）。
  assert.equal(dshEditSendState({ backendReady: true, text: "", originalText: "原文", addedCount: 2 }).disabled, false);
  assert.equal(dshEditSendState({ backendReady: true, text: "原文", originalText: "原文", addedCount: 0, selectionChanged: true }).disabled, false, "只切模型或推理强度也允许从历史状态重发");
  assert.equal(dshEditSendState({ backendReady: true, text: "原文", originalText: "原文", addedCount: 0, selectionChanged: false }).reason, "unchanged");
});

test("编辑重发：稳定消息编号、同草稿 operationId 与发送中锁都不能被绕过", () => {
  assert.deepEqual(dshEditSourceSeqState(12), { allowed: true, value: 12, reason: null });
  assert.deepEqual(dshEditSourceSeqState(Number.NaN), {
    allowed: false,
    value: undefined,
    reason: "这条历史消息没有稳定编号，无法安全编辑重发",
  });
  assert.equal(dshEditSendState({ backendReady: true, sourceSeqReady: false, text: "改过", originalText: "原文" }).reason, "source_seq");
  assert.equal(dshEditSendState({ backendReady: true, sending: true, text: "改过", originalText: "原文" }).reason, "sending");
  const cache = new Map();
  let created = 0;
  const createId = () => `op-${++created}`;
  const draft = { sessionId: "s-1", nodeKey: "n-1", seq: 12, text: "  保留空白  ", keptImageIndexes: [0], addedImageKeys: ["added:1"] };
  assert.equal(dshEditOperationIdFor(cache, draft, createId), "op-1");
  assert.equal(dshEditOperationIdFor(cache, { ...draft }, createId), "op-1");
  assert.equal(dshEditOperationIdFor(cache, { ...draft, text: "  改过  " }, createId), "op-2");
  assert.equal(dshEditOperationIdFor(cache, { ...draft, sessionId: "s-2" }, createId), "op-3");
  assert.equal(dshEditOperationIdFor(cache, { ...draft, modelSelection: { provider: "openai", model: "gpt-5.6" } }, createId), "op-4");
  assert.equal(dshEditOperationIdFor(cache, { ...draft, modelSelection: { provider: "openai", model: "gpt-5.6", reasoningEffort: "high" } }, createId), "op-5");
});

test("编辑重发：当前模型选择、原始块顺序和 106K 大文本路径都有纯函数保护", () => {
  const selected = { provider: "openai", model: "gpt-5.6", reasoningEffort: "max", __speed: "fast" };
  const sessions = {
    scope: sessionId => ({
      get: name => name === "modelDirectories"
        ? { directoryFor: id => ({ store: { getSnapshot: () => ({ sessionId, id, current: selected }) } }) }
        : undefined,
    }),
  };
  assert.deepEqual(dshEditCurrentModelSelection(sessions, "session-1"), {
    provider: "openai",
    model: "gpt-5.6",
    reasoningEffort: "max",
  });
  assert.equal(dshEditCurrentModelSelection({ scope: () => { throw new Error("missing"); } }, "session-1"), undefined);

  const draft = dshEditDraftFromContent([
    { type: "image", attachment: { attachmentId: "img-1", mediaType: "image/png", bytes: 1, width: 1, height: 1 } },
    { type: "text", text: "原文" },
    { type: "text", text: "【附件清单｜message-branch:v1】\n- foo.txt" },
  ], {
    files: [{ name: "foo.txt", attachmentRef: "host-file:foo" }],
  });
  assert.equal(draft.text, "原文");
  assert.deepEqual(draft.order, [
    { type: "image", index: 0 },
    { type: "text" },
    { type: "file", index: 0 },
  ]);
  assert.deepEqual(dshEditSubmitOrder(draft.order, [0], 1, 1, "改后"), [
    { type: "image", index: 0 },
    { type: "text" },
    { type: "file", index: 0 },
    { type: "image", index: 1 },
  ]);
  assert.equal(dshEditLargeTextMode("x".repeat(49 * 1024)), false);
  assert.equal(dshEditLargeTextMode("x".repeat(106 * 1024)), true);
  const cache = new Map();
  const largeDraft = { sessionId: "s", nodeKey: "n", seq: 1, text: "x".repeat(106 * 1024), order: [{ type: "text" }] };
  assert.equal(dshEditTextFingerprint(largeDraft.text), dshEditTextFingerprint(largeDraft.text));
  assert.notEqual(dshEditTextFingerprint(largeDraft.text), dshEditTextFingerprint(largeDraft.text + "y"));
  assert.equal(dshEditOperationIdFor(cache, largeDraft, () => "op-large"), "op-large");
  assert.equal(dshEditOperationIdFor(cache, { ...largeDraft }, () => "op-other"), "op-large");
  assert.ok([...cache.keys()][0].length < 512, "幂等缓存键不能保留整篇 106K 正文");
});

test("附件筛选：一个文件入口同时接收图片与普通文件", () => {
  const files = [
    { name: "a.png", type: "image/png", size: 10 },
    { name: "b.txt", type: "text/plain", size: 10 },
    { name: "big.png", type: "image/png", size: 9e9 },
  ];
  const outcome = dshEditIntakeFiles(files, undefined);
  assert.deepEqual(outcome.accepted.map((file) => file.name), ["a.png", "b.txt", "big.png"]);
  assert.deepEqual(outcome.rejected, []);
});

test("附件筛选：有真实 imageLimits 时按白名单与字节上限判定", () => {
  const limits = { mediaTypes: ["image/png"], maxImageBytes: 100 };
  const outcome = dshEditIntakeFiles([
    { name: "ok.png", type: "image/png", size: 100 },
    { name: "toobig.png", type: "image/png", size: 101 },
    { name: "nope.webp", type: "image/webp", size: 10 },
    { name: "", type: "image/png", size: 1 },
  ], limits);
  assert.deepEqual(outcome.accepted.map((file) => file.name), ["ok.png", ""]);
  assert.deepEqual(outcome.rejected, [
    { name: "toobig.png", reason: "size" },
    { name: "nope.webp", reason: "type" },
  ]);
  assert.deepEqual(dshEditIntakeFiles(undefined, limits), { accepted: [], rejected: [] });
});

test("外部副作用清单：后端没给就是空数组，前端不编条目", () => {
  assert.deepEqual(dshEditExternalEffects(undefined), []);
  assert.deepEqual(dshEditExternalEffects("Sandbox"), []);
  assert.deepEqual(dshEditExternalEffects([
    "Sandbox 已执行 3 条命令",
    "   ",
    { label: "远端提交", detail: "origin/main 已推送" },
    { detail: "缺 label 的条目要丢掉" },
    { label: "" },
  ]), [
    { label: "Sandbox 已执行 3 条命令" },
    { label: "远端提交", detail: "origin/main 已推送" },
  ]);
});

test("样式只用现有 token，不引入新配色变量", () => {
  const declared = [...EDIT_RESEND_SHELL_STYLE.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
  // 允许两类：`--dsw-*` 是 design token；`--dsh-composer-*` 是上游布局变量（主输入框自己在用）。
  // 其余一律视为自造，尤其不允许新增配色变量——批次 B 的三个 diff 语义变量是规范特批的例外，不属本批次。
  const upstreamLayout = new Set(["--dsh-composer-text-max-height"]);
  for (const name of new Set(declared)) {
    assert.ok(
      name.startsWith("--dsw-") || upstreamLayout.has(name),
      `编辑重发样式只能复用 DSH 现有 token 与上游布局变量，发现 ${name}`,
    );
  }
  // 编辑态高亮与提示行都在本模块命名空间内，避免与 G1/G2/G4 撞名。
  assert.ok(EDIT_RESEND_SHELL_STYLE.includes("[data-dsh-edit-card]"));
  assert.ok(EDIT_RESEND_SHELL_STYLE.includes(".dsh-er-"));
});

test("对干净基线单独应用：三处锚点命中，产物可解析", { skip: !baselineAvailable }, () => {
  const baseline = baselineSource("dsh-client-ui-conversation");
  const patched = patchEditResendShellSource(baseline);
  assert.ok(patched.length > baseline.length);
  for (const marker of [
    "function DshEditResendShell(",
    "function DshEditPencil(",
    "function DshEditChip(",
    "function dshEnsureMessageActionHoverStyle(",
    "const DSH_EDIT_BUS = ",
  ]) {
    assert.equal(patched.split(marker).length - 1, 1, `${marker} 应恰好定义一次`);
  }
  assertSyntaxOk("conversation-d-only", patched);
});

test("对干净基线单独应用：真实契约都接上了，没有伪造状态", { skip: !baselineAvailable }, () => {
  const baseline = baselineSource("dsh-client-ui-conversation");
  const patched = patchEditResendShellSource(baseline);
  // 能力探测只认后端注入的 editResend.submit，绝不自己拼 forkAt + 塞草稿：
  // 基线自己在助手尾部就调了 forkAt，所以断言调用次数未增加，而不是断言不存在。
  assert.ok(patched.includes('const backendReady = typeof editResend?.submit === "function";'));
  assert.equal(
    patched.split("forkAt(").length,
    baseline.split("forkAt(").length,
    "编辑重发外壳不得自行调用 forkAt 伪造分支",
  );
  // 模型与模式是主输入框那份真实控件：模型走 renderSlot 绑定，模式走 /permission 执行器。
  assert.ok(patched.includes('face.renderSlot("conversation.input.model", { locked: false })'));
  assert.ok(patched.includes("command: face.command"));
  assert.ok(patched.includes("DSH_EDIT_BUS.publishFace(sessionId, dshEditFace)"));
  assert.ok(patched.includes('"data-dsh-edit-file-button": true'));
  assert.ok(patched.includes('type: "file"'));
  // 分支提示是常驻文案，副作用清单只有后端给了才渲染。
  assert.ok(patched.includes("发送后将从这条消息之前的状态创建新分支"));
  assert.ok(patched.includes("dshEditExternalEffects(editResend?.externalEffects)"));
  // 铅笔挂在既有复制图标那一行的 extraActions 上，没有另造一行操作区。
  assert.ok(patched.includes("extraActions: (0, react_jsx_runtime.jsx)(DshEditPencil, {"));
  // ＋ 是命令菜单，编辑器里不接主草稿通道，所以显式禁用而不是装作能用。
  assert.ok(patched.includes('"data-dsh-edit-commands": true,\n\t\t\t\t\t\t\t\t\t\tchildren') || patched.includes('"data-dsh-edit-commands": true'));
  assert.ok(patched.includes("DSH_EDIT_BUS.subscribe(sessionId, listener)"));
  assert.ok(patched.includes("result.childSessionId === sessionId"));
  assert.ok(patched.includes("sessions.binding?.(sessionId)?.session"));
  assert.ok(patched.includes("await current.resync()"));
  assert.ok(patched.includes("operationId: payload.operationId"));
  assert.ok(patched.includes("currentModelSelection,"));
  assert.ok(patched.includes("payload.modelSelection === void 0 ? currentModelSelection() : payload.modelSelection"));
  assert.ok(patched.includes("const DSH_EDIT_RESEND_CLIENTS = new WeakMap()"));
  assert.ok(patched.includes("if (cached !== void 0) return cached"));
  assert.ok(patched.includes("const availabilityCache = new Map()"));
  assert.ok(patched.includes("availabilityCache.get(cacheKey) === pending"));
  assert.ok(patched.includes("onPointerEnter: retryAvailability"));
  assert.ok(patched.includes("有历史分支记录无法读取，原文件已保留"));
  assert.ok(patched.includes("new IntersectionObserver"));
  assert.ok(patched.includes("滚动到这条消息后会自动检查能否安全编辑重发"));
  assert.ok(patched.includes("order: payload.order"));
  assert.ok(patched.includes("data-dsh-edit-order"));
  assert.ok(patched.includes("editResend\n\t\t\t\t\t}),"));
  assert.ok(!patched.includes('"data-dsh-edit-file-upload": "disabled"'));
  assert.equal(patched.includes("text: text.trim()"), false, "提交必须保留文本首尾空白");
});

test("整链叠加：批次 A + C + D 同时在 conversation 里，产物可解析", { skip: !baselineAvailable }, () => {
  const patched = patchConversationUiSource(baselineSource("dsh-client-ui-conversation"));
  for (const marker of [
    "function ActivityGroup({ group, children }) {",
    "function StardustCompactionStatus(",
    "function DshEditResendShell(",
  ]) {
    assert.equal(patched.split(marker).length - 1, 1, `${marker} 应恰好定义一次`);
  }
  assert.ok(patched.includes('"data-dsh-edit-shell": true'));
  assert.ok(patched.includes("const editReplacementRanges = "));
  assert.ok(patched.includes('event.data.source.kind === "user"'));
  assert.ok(patched.includes("range.start <= anchorSeq && anchorSeq <= range.end"));
  assertSyntaxOk("conversation-acd", patched);
});

test("客户端运行时：会话快照暴露原始事件供同会话编辑投影使用", { skip: !baselineAvailable }, () => {
  const baseline = baselineSource("dsh-client-runtime");
  const patched = patchClientRuntimeSource(baseline);
  assert.ok(patched.includes("sessionId: this.sessionId,\n\t\t\t\t\tevents: this.events,\n\t\t\t\t\tviews: this.conversation,"));
  assertSyntaxOk("client-runtime-edit-surface", patched);
});

test("整链叠加：重复执行必须抛错，不静默注入两份编辑器", { skip: !baselineAvailable }, () => {
  const patched = patchConversationUiSource(baselineSource("dsh-client-ui-conversation"));
  assert.throws(() => patchEditResendShellSource(patched), /编辑重发外壳 已存在/);
});

test("样式命名空间不泄漏到其它 bundle", { skip: !baselineAvailable }, () => {
  const conversation = patchConversationUiSource(baselineSource("dsh-client-ui-conversation"));
  assert.ok(conversation.includes(".dsh-er-"), "编辑重发样式应在会话页");
  for (const pkg of ["dsh-client-ui-tool", "dsh-client-ui-settings-models"]) {
    assert.ok(!baselineSource(pkg).includes(".dsh-er-"), `${pkg} 不应含编辑重发样式`);
  }
});
