/**
 * 未来预留 2（窗口 G6）· 整轮工作过程折叠（`processCollapse`）。
 *
 * 规范依据 `plans_windsurf/frontend-spec.md` 10.2 / 10.2.1；数据契约由 Codex
 * 2026-08-16 18:18 选型、18:50 定形（`QUESTIONS.md` G6-2 / G7-2 / G7-3）：
 *
 *   const presentation = useProjection("turnPresentation")
 *   // { version:1, branchId, turns:[{ turnId, status, originKey?, nodeKeys[],
 *   //    interruptKeys?, finalReplyFrom?, processStartedAt?, processEndedAt? }] }
 *
 * ⛔ 只实现这一种形状。Codex 明确否掉「容错单对象 / 数组 / map 三形状 adapter」，
 * 读不出就整体 `off`，绝不做位置推断。
 *
 * 能力开关只在后端投影已注册时使用 `"backend"`。投影缺失、形状非法、运行中、
 * 中断或没有正文边界时，控制器仍会让该轮保持原样展开。
 *
 * 本模块只做展示层：折叠边界只信后端 `turnPresentation` 投影里的 `nodeKeys` 与
 * `finalReplyFrom`，从不看 DOM 顺序或文案；耗时只由 `processStartedAt` /
 * `processEndedAt` 得出，缺失显示「耗时未知」，绝不用前端当前时钟伪造已完成耗时；
 * 投影只读，不写回官方 session 事件。
 */

import { assertNotAlreadyPatched, replaceExactlyOnce } from "./replace-exactly.mjs";

/** 后端投影形状完整时启用；投影缺失或非法仍由控制器整体关闭。 */
export const PROCESS_COLLAPSE_DEFAULT_MODE = "backend";

/**
 * 把过程区毫秒数格式化成中文时钟：`8秒` / `31分02秒` / `1时02分`。
 * 与 G1 的 `formatActivityClock` 同一口径，但此处只服务于「已处理 X」折叠头，
 * 缺时/负值的兜底交给 `formatProcessDuration`，本函数只负责有效正值。
 */
export function turnProcessClock(ms) {
  const total = Math.floor(ms / 1e3);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}时${String(minutes).padStart(2, "0")}分`;
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

/**
 * 折叠头的耗时文案。只统计过程区（`processStartedAt` → `processEndedAt`），
 * 不含最终正文生成；两者任一缺失、非有限数或结束早于开始时显示「耗时未知」，
 * 绝不用 `Date.now()` 之类前端时钟凑一个已完成耗时。
 * @param startedAt - 过程区开始的机器本地 epoch 毫秒。
 * @param endedAt - 过程区结束的机器本地 epoch 毫秒。
 */
export function formatProcessDuration(startedAt, endedAt) {
  if (typeof startedAt !== "number" || typeof endedAt !== "number") return "耗时未知";
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return "耗时未知";
  return `已处理 ${turnProcessClock(endedAt - startedAt)}`;
}

/**
 * 校验并读出唯一合法形状；任何字段不符一律返回 null（整体 off，不做容错恢复）。
 * @param projection - `useProjection("turnPresentation")` 的原始返回。
 * @returns 规范化后的 `{ version, branchId, turns }`，或形状不符时 null。
 */
export function readTurnPresentation(projection) {
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) return null;
  if (projection.version !== 1) return null;
  if (typeof projection.branchId !== "string" || projection.branchId === "") return null;
  if (!Array.isArray(projection.turns)) return null;
  return { version: 1, branchId: projection.branchId, turns: projection.turns };
}

/**
 * 计算单轮的折叠计划。归属只查后端给的 `nodeKeys`，从不猜位置。
 *
 * 启用折叠是四条件 AND：`status === "settled"` 且 `nodeKeys` 一致非空 且
 * `finalReplyFrom` 是 string 且 `finalReplyFrom` ∈ `nodeKeys`；缺一即整轮展开。
 * `running` / `interrupted` 一律展开。`finalReplyFrom` 之前是过程区（可收），
 * 它及之后是正文区（保持展开）；`finalReplyFrom` 就是首个节点时无过程可收，也不折叠。
 * @param turn - 投影里的一轮。
 * @returns `{ turnId, status, collapsible, processKeys, interruptKeys, replyKeys, durationText, reason }`。
 */
export function planTurnCollapse(turn) {
  if (turn === null || typeof turn !== "object" || Array.isArray(turn)) {
    return { turnId: void 0, status: void 0, collapsible: false, processKeys: [], interruptKeys: [], replyKeys: [], durationText: "耗时未知", reason: "invalid-turn" };
  }
  const turnId = typeof turn.turnId === "string" && turn.turnId !== "" ? turn.turnId : void 0;
  const status = turn.status === "running" || turn.status === "settled" || turn.status === "interrupted" ? turn.status : void 0;
  const originKey = typeof turn.originKey === "string" && turn.originKey !== "" ? turn.originKey : void 0;
  const rawKeys = Array.isArray(turn.nodeKeys) ? turn.nodeKeys : null;
  let consistent = rawKeys !== null;
  const nodeKeys = [];
  if (rawKeys !== null) {
    const seen = new Set();
    for (const key of rawKeys) {
      if (typeof key !== "string" || key === "" || seen.has(key)) { consistent = false; break; }
      seen.add(key);
      nodeKeys.push(key);
    }
  }
  const durationText = formatProcessDuration(turn.processStartedAt, turn.processEndedAt);
  const rawInterruptKeys = turn.interruptKeys === void 0 ? [] : turn.interruptKeys;
  const interruptKeys = [];
  const interruptSeen = new Set();
  if (!Array.isArray(rawInterruptKeys)) consistent = false;
  else for (const key of rawInterruptKeys) {
    if (typeof key !== "string" || key === "" || interruptSeen.has(key) || !nodeKeys.includes(key)) { consistent = false; break; }
    interruptSeen.add(key);
    interruptKeys.push(key);
  }
  const expanded = (reason) => ({ turnId, status, originKey, collapsible: false, processKeys: [], interruptKeys: [], replyKeys: consistent ? nodeKeys.slice() : [], durationText, reason });
  if (turnId === void 0) return expanded("no-turn-id");
  if (status === void 0) return expanded("invalid-status");
  if (status !== "settled") return expanded(status);
  if (!consistent) return expanded("inconsistent-node-keys");
  if (nodeKeys.length === 0) return expanded("empty-node-keys");
  const finalReplyFrom = turn.finalReplyFrom;
  if (typeof finalReplyFrom !== "string" || finalReplyFrom === "") return expanded("no-final-reply");
  const index = nodeKeys.indexOf(finalReplyFrom);
  if (index < 0) return expanded("final-reply-not-in-turn");
  const processKeys = nodeKeys.slice(0, index);
  const replyKeys = nodeKeys.slice(index);
  if (interruptKeys.some(key => !processKeys.includes(key))) return expanded("interrupt-outside-process");
  if (processKeys.length === 0) return { turnId, status, originKey, collapsible: false, processKeys: [], interruptKeys: [], replyKeys, durationText, reason: "no-process" };
  return { turnId, status, originKey, collapsible: true, processKeys, interruptKeys, replyKeys, durationText, reason: "collapsible" };
}

/**
 * 折叠控制器。`mode !== "backend"` 或投影读不出时整体禁用（不折叠）。
 * `turns` 覆盖当前分支全部历史轮；折叠状态 key 用 `branchId + turnId`——
 * 编辑重发 / 分叉后 `branchId` 与 `turnId` 都换新，折叠态自然重置。
 * @param projection - `useProjection("turnPresentation")` 的原始返回。
 * @param mode - 能力开关，只有 `"backend"` 才启用。
 */
export function turnCollapseController(projection, mode) {
  if (mode !== "backend") return { enabled: false, branchId: void 0, plans: [], byTurn: new Map(), collapseKey: (turnId) => `off:${turnId}` };
  const view = readTurnPresentation(projection);
  if (view === null) return { enabled: false, branchId: void 0, plans: [], byTurn: new Map(), collapseKey: (turnId) => `off:${turnId}` };
  const plans = view.turns.map(planTurnCollapse);
  const byTurn = new Map();
  for (const plan of plans) if (plan.turnId !== void 0 && !byTurn.has(plan.turnId)) byTurn.set(plan.turnId, plan);
  return {
    enabled: true,
    branchId: view.branchId,
    plans,
    byTurn,
    collapseKey: (turnId) => `${view.branchId}:${turnId}`,
  };
}

/**
 * 把 G1 的活动分组与轮级折叠合成一个渲染序列。
 * 投影缺失、节点交叉归属或当前分页没有完整加载该轮时保持原 activityFlow。
 */
export function buildTurnFlowItems(order, activityFlow, controller) {
  if (!controller?.enabled || !Array.isArray(order) || !Array.isArray(activityFlow)) return activityFlow;
  const orderSet = new Set(order);
  const ownerByKey = new Map();
  const plans = [];
  const originPlanByKey = new Map();
  const anchoredPlans = new Set();
  for (const plan of controller.plans ?? []) {
    if (plan?.collapsible !== true) continue;
    const keys = [...plan.processKeys, ...plan.replyKeys];
    if (keys.length === 0 || keys.some(key => !orderSet.has(key))) continue;
    for (const key of keys) {
      if (ownerByKey.has(key)) return activityFlow;
      ownerByKey.set(key, plan);
    }
    plans.push(plan);
    if (typeof plan.originKey === "string" && plan.originKey !== "" && orderSet.has(plan.originKey) && !keys.includes(plan.originKey)) {
      if (originPlanByKey.has(plan.originKey)) return activityFlow;
      originPlanByKey.set(plan.originKey, plan);
      anchoredPlans.add(plan);
    }
  }
  if (plans.length === 0) return activityFlow;

  const activityByKey = new Map();
  for (const item of activityFlow) {
    if (item?.type === "group" && Array.isArray(item.keys)) {
      for (const key of item.keys) activityByKey.set(key, item);
    } else if (item?.type === "seat" && typeof item.key === "string") {
      activityByKey.set(item.key, item);
    }
  }
  const nestedItems = (keys) => {
    const selected = new Set(keys);
    const emittedGroups = new Set();
    const items = [];
    for (const key of keys) {
      const activity = activityByKey.get(key);
      if (activity?.type === "group" && activity.keys.every(candidate => selected.has(candidate))) {
        if (!emittedGroups.has(activity.id)) {
          emittedGroups.add(activity.id);
          items.push(activity);
        }
      } else {
        items.push({ type: "seat", key });
      }
    }
    return items;
  };
  const turnItemByPlan = new Map(plans.map(plan => [plan, {
    type: "turn",
    id: `turn:${plan.turnId}`,
    plan,
    processItems: nestedItems(plan.processKeys),
    interruptItems: nestedItems(plan.interruptKeys),
    replyItems: nestedItems(plan.replyKeys),
  }]));
  const emittedTurns = new Set();
  const emittedGroups = new Set();
  const result = [];
  for (const key of order) {
    const plan = ownerByKey.get(key);
    if (plan !== undefined) {
      if (anchoredPlans.has(plan)) continue;
      if (!emittedTurns.has(plan)) {
        emittedTurns.add(plan);
        result.push(turnItemByPlan.get(plan));
      }
      continue;
    }
    const activity = activityByKey.get(key);
    if (activity?.type === "group" && activity.keys.every(candidate => !ownerByKey.has(candidate))) {
      if (!emittedGroups.has(activity.id)) {
        emittedGroups.add(activity.id);
        result.push(activity);
      }
    } else {
      result.push({ type: "seat", key });
    }
    const anchoredPlan = originPlanByKey.get(key);
    if (anchoredPlan !== undefined && !emittedTurns.has(anchoredPlan)) {
      emittedTurns.add(anchoredPlan);
      result.push(turnItemByPlan.get(anchoredPlan));
    }
  }
  return result;
}

export function moveFinalReplyProcessNodes(replyRoot, processRoot) {
  if (replyRoot === null || processRoot === null) return () => {};
  const nodes = [...replyRoot.querySelectorAll('[data-chat-semantic-kind="think"]')]
    .filter(node => node.closest?.("[data-dsh-turn-reply]") === replyRoot);
  const moved = [];
  for (const node of nodes) {
    const parent = node.parentNode;
    const ownerDocument = node.ownerDocument;
    if (parent === null || ownerDocument === null) continue;
    const placeholder = ownerDocument.createComment("dsh-turn-process-think");
    parent.insertBefore(placeholder, node);
    processRoot.appendChild(node);
    moved.push({ node, placeholder });
  }
  return () => {
    for (let index = moved.length - 1; index >= 0; index -= 1) {
      const { node, placeholder } = moved[index];
      if (placeholder.parentNode !== null) placeholder.parentNode.replaceChild(node, placeholder);
    }
  };
}

/**
 * 折叠头与过程/正文分区的样式。命名空间 `dsh-tc-`（turn collapse），
 * 只复用 DSH 现有 design token，不引 Codex 深色配色；静态预览页复用同一份文本。
 * 折叠头组件挂载时把这份样式作为组件内 `<style>` 注入（与 G4 上下文卡同一惯例），
 * 未挂载时不污染 `document.head`。
 */
export const TURN_PROCESS_COLLAPSE_STYLE = `
.dsh-tc-turn{max-width:var(--dsh-chat-content-width,860px);min-width:0}
.dsh-tc-bar{display:inline-flex;align-items:center;gap:6px;padding:2px 6px;margin-left:-6px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-caption);font-size:13px;line-height:22px;font-variant-numeric:tabular-nums;cursor:pointer}
.dsh-tc-bar:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-tc-chev{position:relative;display:inline-block;width:14px;height:22px;color:var(--dsw-alias-label-caption)}
.dsh-tc-chev:before{content:"";position:absolute;left:4px;top:8px;width:5px;height:5px;border-right:1.4px solid currentColor;border-bottom:1.4px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}
.dsh-tc-turn[data-open] .dsh-tc-chev:before{left:3px;top:7px;transform:rotate(45deg)}
.dsh-tc-barlabel{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-tc-process{display:flex;flex-direction:column;gap:4px;margin:6px 0 0}
.dsh-tc-process[hidden]{display:none}
.dsh-tc-interrupts{display:flex;flex-direction:column;gap:4px;margin:6px 0 0}
.dsh-tc-interrupts:empty{display:none}
.dsh-tc-process-tail:empty{display:none}
.dsh-tc-rule{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:8px 0 14px}
.dsh-tc-reply{min-width:0}
@media (prefers-reduced-motion:reduce){.dsh-tc-chev:before{transition:none}}
`;

const TURN_COLLAPSE_LOGIC_SOURCE = [
  turnProcessClock,
  formatProcessDuration,
  readTurnPresentation,
  planTurnCollapse,
  turnCollapseController,
  buildTurnFlowItems,
  moveFinalReplyProcessNodes,
]
  .map((fn) => fn.toString().split("\n").map((line) => `\t\t${line}`).join("\n"))
  .join("\n");

/**
 * 注入到对话 bundle 的运行时：纯逻辑（同名可用）+ 能力开关 + 折叠头组件。
 *
 * `DshTurnProcessCollapse` 接收单轮的 `plan` 与 flow item 渲染器，过程区默认折叠、
 * 点击展开，正文区始终展开。`patchTurnProcessCollapseSource` 将它接入 `ChatView`
 * 的轮级 flow，并由 `useProjection("turnPresentation")` 提供唯一后端投影。
 */
const TURN_COLLAPSE_RUNTIME_SOURCE = `${TURN_COLLAPSE_LOGIC_SOURCE}
\t\tconst DSH_PROCESS_COLLAPSE_MODE = ${JSON.stringify(PROCESS_COLLAPSE_DEFAULT_MODE)};
\t\tconst DSH_TURN_COLLAPSE_STYLE = ${JSON.stringify(TURN_PROCESS_COLLAPSE_STYLE)};
\t\tfunction DshTurnProcessCollapse({ plan, processItems, interruptItems, replyItems, renderItem }) {
\t\t\tconst [open, setOpen] = (0, react.useState)(false);
\t\t\tconst processTailRef = (0, react.useRef)(null);
\t\t\tconst replyRef = (0, react.useRef)(null);
\t\t\tconst toggle = () => {
\t\t\t\tsetOpen((value) => !value);
\t\t\t};
\t\t\tconst processFlow = Array.isArray(processItems) ? processItems : [];
\t\t\tconst interruptFlow = Array.isArray(interruptItems) ? interruptItems : [];
\t\t\tconst replyFlow = Array.isArray(replyItems) ? replyItems : [];
\t\t\t(0, react.useLayoutEffect)(() => moveFinalReplyProcessNodes(replyRef.current, processTailRef.current), [plan.turnId, replyFlow]);
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: "dsh-tc-turn",
\t\t\t\t"data-dsh-turn-collapse": plan.turnId,
\t\t\t\t"data-open": open || void 0,
\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("style", { children: DSH_TURN_COLLAPSE_STYLE }), (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\tclassName: "dsh-tc-bar",
\t\t\t\t\trole: "button",
\t\t\t\t\ttabIndex: 0,
\t\t\t\t\t"aria-expanded": open,
\t\t\t\t\tonClick: toggle,
\t\t\t\t\tonKeyDown: (event) => {
\t\t\t\t\t\tif (event.key !== "Enter" && event.key !== " ") return;
\t\t\t\t\t\tevent.preventDefault();
\t\t\t\t\t\ttoggle();
\t\t\t\t\t},
\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: "dsh-tc-chev",
\t\t\t\t\t\t"aria-hidden": true
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: "dsh-tc-barlabel",
\t\t\t\t\t\tchildren: plan.durationText
\t\t\t\t\t})]
\t\t\t\t}), (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\tclassName: "dsh-tc-process",
\t\t\t\t\t"data-dsh-turn-process": true,
\t\t\t\t\thidden: !open,
\t\t\t\t\tchildren: [...(open ? processFlow.map((item) => renderItem(item)) : []), (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tref: processTailRef,
\t\t\t\t\t\tclassName: "dsh-tc-process-tail",
\t\t\t\t\t\t"data-dsh-turn-process-tail": true
\t\t\t\t\t}, "final-reply-process")]
\t\t\t\t}), !open && interruptFlow.length > 0 ? (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tclassName: "dsh-tc-interrupts",
\t\t\t\t\t"data-dsh-turn-interrupts": true,
\t\t\t\t\tchildren: interruptFlow.map((item) => renderItem(item))
\t\t\t\t}) : null, (0, react_jsx_runtime.jsx)("hr", {
\t\t\t\t\tclassName: "dsh-tc-rule"
\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tref: replyRef,
\t\t\t\t\tclassName: "dsh-tc-reply",
\t\t\t\t\t"data-dsh-turn-reply": true,
\t\t\t\t\tchildren: replyFlow.map((item) => renderItem(item))
\t\t\t\t})]
\t\t\t});
\t\t}
`;

/**
 * 对话界面前端展示补丁（G6）· 注入整轮过程折叠的组件与能力开关。
 *
 * 只在干净基线 `0.1.0-rc.6-oauth` 唯一的 `ChatView` 签名前插入自包含运行时，
 * 增加 `useProjection`、基于投影的 `turnFlow` 与 turn item 渲染分支。没有合法
 * `turnPresentation` 时 `buildTurnFlowItems` 直接返回原 `activityFlow`。
 * @param source - 已由内层补丁处理过的 `dsh-client-ui-conversation/lib/client.js`。
 * @returns 追加了整轮过程折叠组件与能力开关的源码。
 */
export function patchTurnProcessCollapseSource(source) {
  assertNotAlreadyPatched(source, "function DshTurnProcessCollapse(", "整轮过程折叠运行时");
  let result = replaceExactlyOnce(
    source,
    `\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {`,
    `${TURN_COLLAPSE_RUNTIME_SOURCE}\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, useProjection, t }) {`,
    "整轮过程折叠运行时",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst activityFlow = (0, react.useMemo)(() => buildActivityFlowItems(order, (nodeKey) => activityFactsOf(nodeStore, nodeKey)), [nodeStore, order]);
\t\t\tconst loadOlderAnchored = () => {`,
    `\t\t\tconst activityFlow = (0, react.useMemo)(() => buildActivityFlowItems(order, (nodeKey) => activityFactsOf(nodeStore, nodeKey)), [nodeStore, order]);
\t\t\tconst turnPresentation = useProjection("turnPresentation");
\t\t\tconst turnCollapse = (0, react.useMemo)(() => turnCollapseController(turnPresentation, DSH_PROCESS_COLLAPSE_MODE), [turnPresentation]);
\t\t\tconst turnFlow = (0, react.useMemo)(() => buildTurnFlowItems(order, activityFlow, turnCollapse), [activityFlow, order, turnCollapse]);
\t\t\tconst loadOlderAnchored = () => {`,
    "整轮过程折叠投影读取",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\tactivityFlow.map((item) => {`,
    `\t\t\t\t\t\t\tturnFlow.map((item) => {`,
    "整轮过程折叠流入口",
  );
  return replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\t\treturn item.type === "group" ? (0, react_jsx_runtime.jsx)(ActivityGroup, {
\t\t\t\t\t\t\t\t\tgroup: item,
\t\t\t\t\t\t\t\t\tchildren: item.keys.map((nodeKey) => seat(nodeKey))
\t\t\t\t\t\t\t\t}, item.id) : seat(item.key);`,
    `\t\t\t\t\t\t\t\tconst renderFlowItem = (flowItem) => flowItem.type === "group" ? (0, react_jsx_runtime.jsx)(ActivityGroup, {
\t\t\t\t\t\t\t\t\tgroup: flowItem,
\t\t\t\t\t\t\t\t\tchildren: flowItem.keys.map((nodeKey) => seat(nodeKey))
\t\t\t\t\t\t\t\t}, flowItem.id) : seat(flowItem.key);
\t\t\t\t\t\t\t\tif (item.type === "turn") return (0, react_jsx_runtime.jsx)(DshTurnProcessCollapse, {
\t\t\t\t\t\t\t\t\tplan: item.plan,
\t\t\t\t\t\t\t\t\tprocessItems: item.processItems,
\t\t\t\t\t\t\t\t\tinterruptItems: item.interruptItems,
\t\t\t\t\t\t\t\t\treplyItems: item.replyItems,
\t\t\t\t\t\t\t\t\trenderItem: renderFlowItem
\t\t\t\t\t\t\t\t}, turnCollapse.collapseKey(item.plan.turnId));
\t\t\t\t\t\t\t\treturn renderFlowItem(item);`,
    "整轮过程折叠流渲染",
  );
}
