import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROCESS_COLLAPSE_DEFAULT_MODE,
  TURN_PROCESS_COLLAPSE_STYLE,
  buildTurnFlowItems,
  formatProcessDuration,
  moveFinalReplyProcessNodes,
  patchActivityTrackFrontendSource,
  patchTurnProcessCollapseSource,
  planTurnCollapse,
  readTurnPresentation,
  turnCollapseController,
  turnProcessClock,
} from "../lib/transforms-frontend.mjs";
import {
  patchContextMeterThresholdsSource,
  patchConversationActivityPresentationSource,
} from "../lib/transforms.mjs";

/**
 * 干净锚点基线（G6 只从这里取字符串锚点，禁止从已打补丁的候选反推）。
 * 缺失时跳过依赖 release 的用例，不让本机没装 DSH 的环境直接失败。
 */
const BASELINE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai";
const baselineAvailable = existsSync(BASELINE);

/** 供无基线时也能做语法自检的最小 post-G1 stub。 */
const CHATVIEW_STUB = [
  "\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {",
  "\t\t\tconst order = [];",
  "\t\t\tconst nodeStore = new Map();",
  "\t\t\tconst activityFlow = (0, react.useMemo)(() => buildActivityFlowItems(order, (nodeKey) => activityFactsOf(nodeStore, nodeKey)), [nodeStore, order]);",
  "\t\t\tconst loadOlderAnchored = () => {};",
  "\t\t\treturn [",
  "\t\t\t\t\t\t\tactivityFlow.map((item) => {",
  "\t\t\t\t\t\t\t\tconst seat = (nodeKey) => nodeKey;",
  "\t\t\t\t\t\t\t\treturn item.type === \"group\" ? (0, react_jsx_runtime.jsx)(ActivityGroup, {",
  "\t\t\t\t\t\t\t\t\tgroup: item,",
  "\t\t\t\t\t\t\t\t\tchildren: item.keys.map((nodeKey) => seat(nodeKey))",
  "\t\t\t\t\t\t\t\t}, item.id) : seat(item.key);",
  "\t\t\t\t\t\t\t}),",
  "\t\t\t];",
  "\t\t}",
].join("\n");

function conversationBaseline() {
  return readFileSync(path.join(BASELINE, "dsh-client-ui-conversation", "lib", "client.js"), "utf8");
}

function assertSyntaxOk(name, source) {
  const dir = path.join(tmpdir(), "dsh-frontend-turn-collapse");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  writeFileSync(file, source, "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

/** 一轮的最小合法投影行；测试各分支时只覆盖需要改动的字段。 */
function settledTurn(overrides) {
  return {
    turnId: "t1",
    status: "settled",
    nodeKeys: ["n1", "n2", "n3"],
    finalReplyFrom: "n3",
    processStartedAt: 1_000,
    processEndedAt: 43_000,
    ...overrides,
  };
}

/* ==================== 能力开关默认 off ==================== */

test("能力开关使用 backend，但无合法投影时控制器仍关闭", () => {
  assert.equal(PROCESS_COLLAPSE_DEFAULT_MODE, "backend");
  assert.equal(turnCollapseController(undefined, PROCESS_COLLAPSE_DEFAULT_MODE).enabled, false);
});

/* ==================== 唯一形状校验（只实现一种形状，读不出即 off） ==================== */

test("readTurnPresentation 只认唯一合法形状，其余一律 null", () => {
  const ok = readTurnPresentation({ version: 1, branchId: "b1", turns: [] });
  assert.deepEqual(ok, { version: 1, branchId: "b1", turns: [] });

  assert.equal(readTurnPresentation(undefined), null);
  assert.equal(readTurnPresentation(null), null);
  assert.equal(readTurnPresentation([{ turnId: "t1" }]), null, "数组形状被否掉");
  assert.equal(readTurnPresentation("turnPresentation"), null);
  assert.equal(readTurnPresentation({ version: 2, branchId: "b1", turns: [] }), null, "version 必须为 1");
  assert.equal(readTurnPresentation({ version: 1, branchId: "", turns: [] }), null, "branchId 非空");
  assert.equal(readTurnPresentation({ version: 1, turns: [] }), null, "缺 branchId");
  assert.equal(readTurnPresentation({ version: 1, branchId: "b1" }), null, "缺 turns");
  assert.equal(readTurnPresentation({ version: 1, branchId: "b1", turns: { t1: {} } }), null, "map 形状被否掉");
});

/* ==================== 约束 7：耗时只由过程区时间得出，缺失显示「耗时未知」 ==================== */

test("formatProcessDuration 只由过程区时间得出，缺失/非法显示「耗时未知」", () => {
  assert.equal(formatProcessDuration(1_000, 43_000), "已处理 42秒");
  assert.equal(formatProcessDuration(0, 1_862_000), "已处理 31分02秒");
  assert.equal(formatProcessDuration(0, 3_720_000), "已处理 1时02分");
  assert.equal(formatProcessDuration(undefined, 43_000), "耗时未知", "缺开始时间");
  assert.equal(formatProcessDuration(1_000, undefined), "耗时未知", "缺结束时间");
  assert.equal(formatProcessDuration(43_000, 1_000), "耗时未知", "结束早于开始不倒推");
  assert.equal(formatProcessDuration(Number.NaN, 1), "耗时未知");
  assert.equal(formatProcessDuration("1000", "2000"), "耗时未知", "字符串时间不接受");
});

test("turnProcessClock 与 spec 2.1 中文时钟同口径", () => {
  assert.equal(turnProcessClock(8_000), "8秒");
  assert.equal(turnProcessClock(62_000), "1分02秒");
  assert.equal(turnProcessClock(3_600_000), "1时00分");
});

/* ==================== 约束 3：四条件 AND；约束 4：切分点 ==================== */

test("四条件全满足才折叠，且按 finalReplyFrom 切分过程区/正文区", () => {
  const plan = planTurnCollapse(settledTurn());
  assert.equal(plan.collapsible, true);
  assert.equal(plan.reason, "collapsible");
  assert.deepEqual(plan.processKeys, ["n1", "n2"], "finalReplyFrom 之前是过程区");
  assert.deepEqual(plan.replyKeys, ["n3"], "finalReplyFrom 及之后是正文区");
  assert.equal(plan.durationText, "已处理 42秒");
});

test("约束3：status 非 settled（缺该条件）→ 展开", () => {
  const plan = planTurnCollapse(settledTurn({ status: "running" }));
  assert.equal(plan.collapsible, false);
});

test("约束3：nodeKeys 为空（缺该条件）→ 展开", () => {
  const plan = planTurnCollapse(settledTurn({ nodeKeys: [], finalReplyFrom: "n3" }));
  assert.equal(plan.collapsible, false);
  assert.equal(plan.reason, "empty-node-keys");
  assert.deepEqual(plan.replyKeys, []);
});

test("约束3：finalReplyFrom 缺失（缺该条件）→ 展开且全部作正文", () => {
  const plan = planTurnCollapse(settledTurn({ finalReplyFrom: undefined }));
  assert.equal(plan.collapsible, false);
  assert.equal(plan.reason, "no-final-reply");
  assert.deepEqual(plan.replyKeys, ["n1", "n2", "n3"]);
});

test("约束3/6：finalReplyFrom 不在 nodeKeys（缺该条件）→ 展开，不做近似恢复", () => {
  const plan = planTurnCollapse(settledTurn({ finalReplyFrom: "n9" }));
  assert.equal(plan.collapsible, false);
  assert.equal(plan.reason, "final-reply-not-in-turn");
  assert.deepEqual(plan.processKeys, []);
  assert.deepEqual(plan.replyKeys, ["n1", "n2", "n3"]);
});

test("约束4边界：finalReplyFrom 就是首个节点 → 无过程可收，不折叠", () => {
  const plan = planTurnCollapse(settledTurn({ finalReplyFrom: "n1" }));
  assert.equal(plan.collapsible, false);
  assert.equal(plan.reason, "no-process");
  assert.deepEqual(plan.replyKeys, ["n1", "n2", "n3"]);
});

/* ==================== 约束 5：running / interrupted 一律展开 ==================== */

test("约束5：running 一律展开，全部节点作正文", () => {
  const plan = planTurnCollapse(settledTurn({ status: "running" }));
  assert.equal(plan.collapsible, false);
  assert.equal(plan.reason, "running");
  assert.deepEqual(plan.replyKeys, ["n1", "n2", "n3"]);
});

test("约束5：interrupted 一律展开，让中止原因保持可见", () => {
  const plan = planTurnCollapse(settledTurn({ status: "interrupted" }));
  assert.equal(plan.collapsible, false);
  assert.equal(plan.reason, "interrupted");
  assert.deepEqual(plan.replyKeys, ["n1", "n2", "n3"]);
});

/* ==================== 约束 6：字段缺失 / 节点编号不一致 → 展开 ==================== */

test("约束6：nodeKeys 有重复（编号不一致）→ 展开", () => {
  const plan = planTurnCollapse(settledTurn({ nodeKeys: ["n1", "n1", "n3"] }));
  assert.equal(plan.collapsible, false);
  assert.equal(plan.reason, "inconsistent-node-keys");
  assert.deepEqual(plan.replyKeys, [], "不一致时不冒充可展开列表");
});

test("约束6：nodeKeys 含非串/空串（编号不一致）→ 展开", () => {
  assert.equal(planTurnCollapse(settledTurn({ nodeKeys: ["n1", 2, "n3"] })).reason, "inconsistent-node-keys");
  assert.equal(planTurnCollapse(settledTurn({ nodeKeys: ["n1", "", "n3"] })).reason, "inconsistent-node-keys");
});

test("约束6：非法轮 / 缺 turnId / 非法 status → 展开", () => {
  assert.equal(planTurnCollapse(null).reason, "invalid-turn");
  assert.equal(planTurnCollapse([]).reason, "invalid-turn");
  assert.equal(planTurnCollapse(settledTurn({ turnId: "" })).reason, "no-turn-id");
  assert.equal(planTurnCollapse(settledTurn({ status: "done" })).reason, "invalid-status");
});

test("约束7：时间缺失但其余满足时仍可折叠，只是耗时未知", () => {
  const plan = planTurnCollapse(settledTurn({ processStartedAt: undefined, processEndedAt: undefined }));
  assert.equal(plan.collapsible, true);
  assert.equal(plan.durationText, "耗时未知");
});

/* ==================== 约束 1 / 8 / 2：控制器覆盖全部历史轮、branchId+turnId 键、只查 nodeKeys ==================== */

test("控制器：mode 非 backend 时整体禁用（默认 off）", () => {
  const controller = turnCollapseController({ version: 1, branchId: "b1", turns: [settledTurn()] }, "off");
  assert.equal(controller.enabled, false);
  assert.deepEqual(controller.plans, []);
});

test("控制器：mode=backend 但投影读不出时整体禁用", () => {
  assert.equal(turnCollapseController(undefined, "backend").enabled, false);
  assert.equal(turnCollapseController({ version: 2, branchId: "b1", turns: [] }, "backend").enabled, false);
  assert.equal(turnCollapseController([settledTurn()], "backend").enabled, false);
});

test("约束1：控制器覆盖当前分支全部历史轮，逐轮独立计划", () => {
  const controller = turnCollapseController(
    {
      version: 1,
      branchId: "b7",
      turns: [
        settledTurn({ turnId: "t1" }),
        settledTurn({ turnId: "t2", status: "running" }),
        settledTurn({ turnId: "t3", finalReplyFrom: "n2" }),
      ],
    },
    "backend",
  );
  assert.equal(controller.enabled, true);
  assert.equal(controller.plans.length, 3, "全部历史轮都在，不只当前轮");
  assert.equal(controller.byTurn.get("t1").collapsible, true);
  assert.equal(controller.byTurn.get("t2").collapsible, false, "running 轮不折叠");
  assert.deepEqual(controller.byTurn.get("t3").processKeys, ["n1"]);
});

test("约束8：折叠状态 key = branchId + turnId，分支变化后自然重置", () => {
  const b7 = turnCollapseController({ version: 1, branchId: "b7", turns: [settledTurn({ turnId: "t1" })] }, "backend");
  const b8 = turnCollapseController({ version: 1, branchId: "b8", turns: [settledTurn({ turnId: "t1" })] }, "backend");
  assert.equal(b7.collapseKey("t1"), "b7:t1");
  assert.equal(b8.collapseKey("t1"), "b8:t1");
  assert.notEqual(b7.collapseKey("t1"), b8.collapseKey("t1"), "同 turnId 在不同分支下 key 不同");
});

test("约束2/9：计划只读 nodeKeys 且不改动输入投影（不写回、不猜位置）", () => {
  const turn = settledTurn();
  const frozen = JSON.stringify(turn);
  planTurnCollapse(turn);
  assert.equal(JSON.stringify(turn), frozen, "planTurnCollapse 不修改输入");
  const projection = { version: 1, branchId: "b1", turns: [settledTurn()] };
  const snapshot = JSON.stringify(projection);
  turnCollapseController(projection, "backend");
  assert.equal(JSON.stringify(projection), snapshot, "控制器只读投影，不写回");
});

test("轮级流保留过程区内部的 G1 活动分组，并让正文保持展开", () => {
  const controller = turnCollapseController({
    version: 1,
    branchId: "b1",
    turns: [settledTurn({ nodeKeys: ["p1", "p2", "reply"], finalReplyFrom: "reply" })],
  }, "backend");
  const activityGroup = { type: "group", id: "g1", kind: "tool", keys: ["p1", "p2"], facts: [] };
  const result = buildTurnFlowItems(
    ["user", "p1", "p2", "reply", "tail"],
    [{ type: "seat", key: "user" }, activityGroup, { type: "seat", key: "reply" }, { type: "seat", key: "tail" }],
    controller,
  );
  assert.deepEqual(result.map(item => item.type), ["seat", "turn", "seat"]);
  assert.equal(result[1].processItems[0], activityGroup);
  assert.deepEqual(result[1].replyItems, [{ type: "seat", key: "reply" }]);
});

test("运行中真人消息既保留原始展开顺序，也提供折叠态固定副本", () => {
  const controller = turnCollapseController({
    version: 1,
    branchId: "b1",
    turns: [settledTurn({
      nodeKeys: ["p1", "interrupt", "reply"],
      interruptKeys: ["interrupt"],
      finalReplyFrom: "reply",
    })],
  }, "backend");
  const result = buildTurnFlowItems(
    ["p1", "interrupt", "reply"],
    [
      { type: "seat", key: "p1" },
      { type: "seat", key: "interrupt" },
      { type: "seat", key: "reply" },
    ],
    controller,
  );
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].processItems.map(item => item.key), ["p1", "interrupt"]);
  assert.deepEqual(result[0].interruptItems, [{ type: "seat", key: "interrupt" }]);
  assert.deepEqual(result[0].replyItems, [{ type: "seat", key: "reply" }]);
});

test("当前分页缺少该轮任一节点时不做半截折叠", () => {
  const activityFlow = [{ type: "seat", key: "p1" }];
  const controller = turnCollapseController({ version: 1, branchId: "b1", turns: [settledTurn()] }, "backend");
  assert.equal(buildTurnFlowItems(["p1"], activityFlow, controller), activityFlow);
});

test("最终正文节点里的真实 think 子节点移入过程区，并可无损放回", () => {
  const replyRoot = {};
  const processRoot = {
    appendChild(node) {
      node.parentNode = this;
      this.child = node;
    },
  };
  const sourceParent = {
    insertBefore(placeholder, node) {
      placeholder.parentNode = this;
      this.placeholder = placeholder;
      node.parentNode = this;
    },
    replaceChild(node, placeholder) {
      assert.equal(placeholder, this.placeholder);
      placeholder.parentNode = null;
      node.parentNode = this;
      this.restored = node;
    },
  };
  const node = {
    parentNode: sourceParent,
    ownerDocument: { createComment: () => ({ parentNode: null }) },
    closest: selector => selector === "[data-dsh-turn-reply]" ? replyRoot : null,
  };
  replyRoot.querySelectorAll = selector => selector === '[data-chat-semantic-kind="think"]' ? [node] : [];

  const restore = moveFinalReplyProcessNodes(replyRoot, processRoot);
  assert.equal(processRoot.child, node);
  restore();
  assert.equal(sourceParent.restored, node);
});

/* ==================== 样式与注入 ==================== */

test("样式用 dsh-tc- 命名空间且不画伪进度条", () => {
  assert.match(TURN_PROCESS_COLLAPSE_STYLE, /\.dsh-tc-turn\{/u);
  assert.match(TURN_PROCESS_COLLAPSE_STYLE, /\.dsh-tc-bar\{/u);
  assert.match(TURN_PROCESS_COLLAPSE_STYLE, /\.dsh-tc-chev\{/u);
  assert.match(TURN_PROCESS_COLLAPSE_STYLE, /\.dsh-tc-rule\{/u);
  assert.match(TURN_PROCESS_COLLAPSE_STYLE, /\.dsh-tc-process\[hidden\]\{display:none\}/u);
  assert.match(TURN_PROCESS_COLLAPSE_STYLE, /prefers-reduced-motion:reduce\)\{\.dsh-tc-chev/u);
  assert.doesNotMatch(TURN_PROCESS_COLLAPSE_STYLE, /width:var\(--dsh-tc-pct|progress/u);
});

test("注入的折叠头运行时语法可解析（无基线也能自检）", () => {
  const patched = patchTurnProcessCollapseSource(CHATVIEW_STUB);
  assert.equal(patched.split("function DshTurnProcessCollapse(").length - 1, 1);
  assert.ok(patched.includes('const DSH_PROCESS_COLLAPSE_MODE = "backend";'));
  assert.ok(patched.includes('useProjection("turnPresentation")'));
  assert.ok(patched.includes('data-chat-semantic-kind="think"'));
  assert.ok(patched.includes("data-dsh-turn-interrupts"));
  assert.ok(patched.includes("interruptItems: item.interruptItems"));
  assert.ok(patched.includes("useLayoutEffect"));
  assertSyntaxOk("chatview-stub-injected", patched);
});

test("补丁拒绝重复注入", () => {
  const patched = patchTurnProcessCollapseSource(CHATVIEW_STUB);
  assert.throws(() => patchTurnProcessCollapseSource(patched), /拒绝重复注入/u);
});

test("整轮过程折叠补丁在干净基线上唯一命中并产出可解析源码", { skip: !baselineAvailable }, () => {
  const source = conversationBaseline();
  const prepared = patchActivityTrackFrontendSource(
    patchConversationActivityPresentationSource(patchContextMeterThresholdsSource(source)),
  );
  const patched = patchTurnProcessCollapseSource(prepared);
  assert.ok(patched.length > prepared.length);
  assert.equal(patched.split("function DshTurnProcessCollapse(").length - 1, 1);
  assert.equal(patched.split("function ChatView({ useSession").length - 1, 1, "ChatView 签名未被重复或破坏");
  assertSyntaxOk("conversation-turn-collapse", patched);
});

test("整链 patchConversationUiSource 叠加后 G1/G3/G4/G6 标志齐全且语法有效", { skip: !baselineAvailable }, async () => {
  const { patchConversationUiSource } = await import("../lib/transforms.mjs");
  const source = conversationBaseline();
  const patched = patchConversationUiSource(source);
  assert.equal(patched.split("function DshTurnProcessCollapse(").length - 1, 1, "G6 组件恰好一次");
  assert.equal(patched.split("function ActivityGroup(").length - 1, 1, "G1 分组仍在");
  assert.equal(patched.split("function StardustCompactionStatus(").length - 1, 1, "G4 压缩状态仍在");
  assert.ok(patched.includes('const DSH_PROCESS_COLLAPSE_MODE = "backend";'));
  assert.ok(patched.includes('useProjection("turnPresentation")'));
  assert.ok(patched.includes("turnFlow.map((item) =>"));
  assertSyntaxOk("conversation-full-chain", patched);
  assert.throws(() => patchConversationUiSource(patched), /拒绝重复注入|停止修改候选版本/u);
});
