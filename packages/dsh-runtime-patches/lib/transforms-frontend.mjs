/**
 * Stage 11 前端展示补丁（Windsurf/Claude 侧）。
 *
 * 文件分区约定：每个并行窗口只写自己的分区，禁止跨区改写。
 *   - G1 区：活动轨迹（统一栅格、相邻同类分组、运行中思考视窗）
 *   - G2 区：文件差异卡（`dsh-client-ui-tool` 卡片内部结构）
 *   - G3 区：编辑上一条用户消息的外壳（铅笔、原地编辑器、分支提示）
 *   - G4 区：账户额度、上下文状态、模型菜单
 *
 * 本文件只做展示层改写，不改后端语义：分组、耗时、运行/失败状态全部取自
 * 真实事件字段（`root.callTime` / `root.time` / `root.isError` / `data.status`
 * / `data.startTime` / `data.finalNode.time`），缺字段时显示「耗时未知」并退回
 * 单项展示，不猜测、不补零。
 */

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label} 与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本`);
  }
  return source.replace(before, () => after);
}

/* ==================== G1 区：纯逻辑（可单测，注入后同名可用） ==================== */

/** 把毫秒格式化成中文时钟：`8秒` / `12分07秒` / `1时02分`。 */
export function formatActivityClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "耗时未知";
  const total = Math.floor(ms / 1e3);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}时${String(minutes).padStart(2, "0")}分`;
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

/**
 * 工具线名 → 组头展示名。
 * MCP 工具取服务器段（`mcp__sandbox__sandbox_exec` → `Sandbox`）；
 * 内置工具只映射确认存在的四个（read/write/edit/run_code），其余原样显示工具名，
 * 不为了好看而猜测中文动词。
 */
export function activityToolLabel(name) {
  if (typeof name !== "string" || name.trim() === "") return "工具";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (mcp !== null) {
    const server = mcp[1];
    return /^[a-z]+$/.test(server) ? `${server[0].toUpperCase()}${server.slice(1)}` : server;
  }
  const builtin = {
    read: "读取文件",
    write: "写入文件",
    edit: "修改文件",
    run_code: "运行代码",
  };
  return builtin[name] ?? name;
}

/**
 * 从一个 Chat 节点读出展示事实。
 * @param node - Chat 节点（`assistant-step` 或 `tool-call`）。
 * @param semanticKind - 由宿主 `chatSemanticKind(node)` 给出的结构类别。
 * @returns 活动节点的展示事实；非活动节点返回 undefined。
 */
export function activityNodeFacts(node, semanticKind) {
  if (node === undefined || node === null) return undefined;
  if (semanticKind !== "think" && semanticKind !== "code" && semanticKind !== "tool") return undefined;
  const time = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  if (semanticKind === "think") {
    const data = node.data ?? {};
    const running = data.status === "running";
    const blocks = Array.isArray(data.blocks) ? data.blocks : [];
    return {
      kind: "think",
      running,
      failed: data.status === "interrupted",
      startTime: time(data.startTime),
      endTime: running ? null : time(data.finalNode?.time ?? data.time),
      segments: blocks.filter((block) => block?.kind === "reasoning").length,
      toolName: undefined,
      modelLabel: typeof data.activityLabel === "string" && data.activityLabel !== "" ? data.activityLabel : undefined,
      turn: Number.isInteger(data.turn) ? data.turn : null,
      step: Number.isInteger(data.step) ? data.step : null,
    };
  }
  const root = node.data?.root;
  if (root === undefined || root === null) return undefined;
  const settled = typeof root === "object" && "kind" in root;
  return {
    kind: semanticKind,
    running: !settled,
    failed: settled && root.isError === true,
    startTime: settled ? time(root.callTime) : time(root.time),
    endTime: settled ? time(root.time) : null,
    segments: 1,
    toolName: settled ? root.call?.name ?? "" : root.name ?? "",
    modelLabel: typeof root.activityLabel === "string" && root.activityLabel !== "" ? root.activityLabel : undefined,
    turn: Number.isInteger(root.turn) ? root.turn : null,
    step: Number.isInteger(root.step) ? root.step : null,
  };
}

/** 只用真实 step 身份或实际时间重叠判断一组活动是否并行。 */
export function activityGroupIsParallel(facts) {
  if (!Array.isArray(facts) || facts.length < 2) return false;
  for (let left = 0; left < facts.length - 1; left += 1) {
    for (let right = left + 1; right < facts.length; right += 1) {
      const a = facts[left];
      const b = facts[right];
      if (Number.isInteger(a?.turn) && Number.isInteger(a?.step) && a.turn === b?.turn && a.step === b?.step) return true;
      if (Number.isFinite(a?.startTime) && Number.isFinite(a?.endTime) && Number.isFinite(b?.startTime) && Number.isFinite(b?.endTime) && Math.max(a.startTime, b.startTime) < Math.min(a.endTime, b.endTime)) return true;
    }
  }
  return false;
}

/**
 * 只合并「相邻同类且已结束」的活动节点。
 *
 * 断组条件：类别变化、非活动节点、运行中、失败/中断、模型语义标注变化。
 * 单个节点不包组，保持原样展示。
 * @param keys - 当前 `chat.order`。
 * @param readFacts - key → activityNodeFacts 的读取函数。
 * @returns 展示序列，元素是 `{type:"seat"}` 或 `{type:"group"}`。
 */
export function buildActivityFlowItems(keys, readFacts) {
  const items = [];
  let run = null;
  const flush = () => {
    if (run === null) return;
    if (run.keys.length < 2) {
      for (const key of run.keys) items.push({ type: "seat", key });
    } else {
      items.push({
        type: "group",
        id: `group:${run.kind}:${run.keys[0]}`,
        kind: run.kind,
        keys: run.keys,
        facts: run.facts,
        modelLabel: run.modelLabel,
      });
    }
    run = null;
  };
  for (const key of keys) {
    const facts = readFacts(key);
    if (facts === undefined || facts.running || facts.failed) {
      flush();
      items.push({ type: "seat", key });
      continue;
    }
    if (run !== null && (run.kind !== facts.kind || run.modelLabel !== facts.modelLabel)) flush();
    if (run === null) run = { kind: facts.kind, keys: [], facts: [], modelLabel: facts.modelLabel };
    run.keys.push(key);
    run.facts.push(facts);
  }
  flush();
  return items;
}

/**
 * 组头文案。标题来源可切换：后端给了 `activityLabel` 就是模型标注，
 * 否则退回「相邻同类」推断，组件不变。
 * @param group - buildActivityFlowItems 产出的 group 项。
 * @returns 组头展示模型。
 */
export function describeActivityGroup(group) {
  const facts = Array.isArray(group.facts) ? group.facts : [];
  const startTime = facts[0]?.startTime ?? null;
  const endTime = facts[facts.length - 1]?.endTime ?? null;
  const durationText = startTime === null || endTime === null ? "耗时未知" : formatActivityClock(endTime - startTime);
  if (typeof group.modelLabel === "string" && group.modelLabel !== "") {
    return {
      labelSource: "model",
      title: group.modelLabel,
      count: `${facts.length} 步`,
      durationText,
      parallel: activityGroupIsParallel(facts),
    };
  }
  if (group.kind === "think") {
    const segments = facts.reduce((sum, item) => sum + (item.segments > 0 ? item.segments : 1), 0);
    return { labelSource: "derived", title: "思考", count: `${segments} 项`, durationText, parallel: activityGroupIsParallel(facts) };
  }
  const labels = [];
  for (const item of facts) {
    const label = activityToolLabel(item.toolName);
    if (!labels.includes(label)) labels.push(label);
  }
  const single = labels.length === 1;
  const title = single
    ? labels[0]
    : labels.length === 2
      ? `使用 ${labels[0]} 与 ${labels[1]}`
      : `使用 ${labels[0]}、${labels[1]} 等 ${labels.length} 个工具`;
  return {
    labelSource: "derived",
    title,
    count: single ? `${facts.length} 次` : `${facts.length} 次调用`,
    durationText,
    parallel: activityGroupIsParallel(facts),
  };
}

const ACTIVITY_LOGIC_SOURCE = [
  formatActivityClock,
  activityToolLabel,
  activityNodeFacts,
  activityGroupIsParallel,
  buildActivityFlowItems,
  describeActivityGroup,
]
  .map((fn) => fn.toString().split("\n").map((line) => `\t\t${line}`).join("\n"))
  .join("\n");

/* ==================== G1 区：注入到对话 bundle 的样式与组件 ==================== */

/**
 * 活动轨迹样式。
 * 只复用 DSH 现有 design token（`--dsw-alias-*`），不引入 Codex 深色配色；
 * 渐隐色取真实容器背景 token，不硬编码 #fff。
 */
export const ACTIVITY_TRACK_CSS = [
  '[data-chat-flow]{--dsh-a-lead:18px;--dsh-a-time:56px;--dsh-a-gap:8px}',
  '[data-chat-flow] [data-tool-activity-duration],[data-chat-flow] [data-activity-duration]{min-width:var(--dsh-a-time);text-align:right;font-variant-numeric:tabular-nums}',
  '[data-chat-flow] [data-disclosure-row]>span:first-child,[data-chat-flow] [data-disclosure-row]>button:first-child{flex:none;min-width:var(--dsh-a-lead);justify-content:center}',
  '[data-chat-flow] [data-disclosure-row]{display:flex;align-items:center;min-width:0}',
  '[data-chat-flow] [data-disclosure-row]>span:nth-child(2){flex:0 0 auto;min-width:0;max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '[data-chat-flow] [data-disclosure-row]>span[aria-hidden="true"]{flex:none;align-self:center}',
  '[data-chat-flow] [data-state="error"] [data-disclosure-row]>span,[data-chat-flow] [data-state="error"] [data-disclosure-row]>button{color:var(--dsw-alias-state-error-primary)}',
  '[data-chat-flow] [data-state="error"] [data-disclosure-row]>span[aria-hidden="true"]{background:var(--dsw-alias-state-error-primary)}',
  '[data-variant="think"] [data-think-summary]{min-width:0;flex:1 1 auto}',
  '[data-chat-flow]>[data-chat-semantic-kind]+[data-chat-semantic-kind]{margin-top:-12px}',
  '[data-think-summary]>*{display:inline!important;margin:0!important;padding:0!important;border:0!important;font-size:inherit!important;font-weight:inherit!important;line-height:inherit!important}',
  '[data-think-summary] pre,[data-think-summary] code{white-space:pre!important;background:none!important;padding:0!important}',
  // G5 真实验收发现：主线把思考正文换成 Markdown 渲染后，容器仍留着上游纯文本时代的
  // `white-space:pre-wrap`，于是块标签之间的换行字符被当成可见换行渲染，两段之间实测 60px。
  // 规范 3.5 要求展开思考的段落间距 8px，所以对渲染出的块级内容改回 normal 并压紧段距。
  '[data-think-body]>*{white-space:normal}',
  '[data-think-body] p,[data-think-body] ul,[data-think-body] ol,[data-think-body] blockquote{margin:0 0 8px}',
  '[data-think-body] p:last-child,[data-think-body] ul:last-child,[data-think-body] ol:last-child{margin-bottom:0}',
  '[data-variant="think"] [data-think-body]{max-height:360px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable}',
  '[data-variant="think"] [data-activity-duration]{margin-left:auto!important}',
  '[data-chat-flow] [data-activity-duration],[data-chat-flow] [data-tool-activity-duration]{flex:none}',
  '[data-variant="think"][data-state="running"] [data-think-summary]{display:none}',
  '[data-variant="think"][data-state="running"] [data-disclosure-row]>span:nth-child(3){display:none}',
  '[data-variant="think"][data-state="running"] [data-disclosure-row]>span:nth-child(2){color:var(--dsw-static-deepseek-500)}',
  '[data-variant="think"][data-state="running"] [data-think-body]{position:relative;display:flex;flex-direction:column;justify-content:flex-end;max-height:252px;overflow-y:auto;overflow-x:hidden}',
  '[data-variant="think"][data-state="running"] [data-think-body]:before{content:"";position:absolute;inset:0 0 auto 0;height:62px;pointer-events:none;z-index:1;background:linear-gradient(180deg,var(--dsw-alias-bg-base) 8%,color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent) 56%,transparent 100%)}',
  '.dsh-a-group{display:flex;flex-direction:column;min-width:0}',
  '.dsh-a-ghead{display:grid;grid-template-columns:var(--dsh-a-lead) minmax(0,1fr) auto;align-items:center;column-gap:0;padding:2px 6px;margin-left:-6px;border-radius:6px}',
  '.dsh-a-ghead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-a-chev{position:relative;display:inline-block;width:var(--dsh-a-lead);height:24px;color:var(--dsw-alias-label-caption)}',
  '.dsh-a-chev:before{content:"";position:absolute;left:6px;top:9px;width:5px;height:5px;border-right:1.4px solid currentColor;border-bottom:1.4px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}',
  '.dsh-a-group[data-open] .dsh-a-chev:before{left:5px;top:8px;transform:rotate(45deg)}',
  '.dsh-a-gtitle{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}',
  '.dsh-a-gtitle b{font-weight:400}',
  '.dsh-a-ghead:hover .dsh-a-gtitle{color:var(--dsw-alias-label-primary)}',
  '.dsh-a-gcount{margin-left:6px;color:var(--dsw-alias-label-caption)}',
  '.dsh-a-gtag{margin-left:6px;padding:0 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font-size:11px}',
  '.dsh-a-gparallel{margin-left:6px;color:var(--dsw-static-deepseek-500);font-size:11px}',
  '.dsh-a-gmeta{min-width:var(--dsh-a-time);text-align:right;color:var(--dsw-alias-label-caption);font-size:12px;line-height:24px;font-variant-numeric:tabular-nums}',
  '.dsh-a-gbody{display:flex;flex-direction:column;gap:4px;margin:2px 0 4px 8px;padding-left:14px;border-left:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-a-gbody [data-variant="think"] [data-disclosure-row]>span:nth-child(2),.dsh-a-gbody [data-variant="think"] [data-disclosure-row]>span:nth-child(3){display:none}',
  '@media (prefers-reduced-motion:reduce){.dsh-a-chev:before{transition:none}}',
].join("");

const ACTIVITY_RUNTIME_SOURCE = `${ACTIVITY_LOGIC_SOURCE}
\t\tconst DSH_ACTIVITY_TRACK_CSS = ${JSON.stringify(ACTIVITY_TRACK_CSS)};
\t\tif (typeof document !== "undefined" && document.querySelector('style[data-dsh-frontend="activity-track"]') === null) {
\t\t\tconst tag = document.createElement("style");
\t\t\ttag.dataset.dshFrontend = "activity-track";
\t\t\ttag.textContent = DSH_ACTIVITY_TRACK_CSS;
\t\t\tdocument.head.appendChild(tag);
\t\t}
\t\t/** 读取一个 Chat 节点的活动事实；类别只取宿主的结构推导，不看文案。 */
\t\tfunction activityFactsOf(nodeStore, nodeKey) {
\t\t\tconst node = nodeStore.get(nodeKey);
\t\t\tif (node === void 0) return void 0;
\t\t\treturn activityNodeFacts(node, chatSemanticKind(node));
\t\t}
\t\t/** 相邻同类活动的折叠壳：默认折叠，展开后子项各自保留自己的时间与顺序。 */
\t\tfunction ActivityGroup({ group, children }) {
\t\t\tconst [open, setOpen] = (0, react.useState)(false);
\t\t\tconst described = (0, react.useMemo)(() => describeActivityGroup(group), [group]);
\t\t\tconst toggle = () => {
\t\t\t\tsetOpen((value) => !value);
\t\t\t};
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: "dsh-a-group",
\t\t\t\t"data-activity-group": group.kind,
\t\t\t\t"data-chat-semantic-kind": group.kind,
\t\t\t\t"data-activity-label-source": described.labelSource,
\t\t\t\t"data-open": open || void 0,
\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\tclassName: "dsh-a-ghead",
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
\t\t\t\t\t\tclassName: "dsh-a-chev",
\t\t\t\t\t\t"aria-hidden": true
\t\t\t\t\t}), (0, react_jsx_runtime.jsxs)("span", {
\t\t\t\t\t\tclassName: "dsh-a-gtitle",
\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("b", { children: described.title }), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: "dsh-a-gcount",
\t\t\t\t\t\t\tchildren: described.count
\t\t\t\t\t\t}), described.labelSource === "model" ? (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: "dsh-a-gtag",
\t\t\t\t\t\t\tchildren: "模型标注"
\t\t\t\t\t\t}) : null, described.parallel ? (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: "dsh-a-gparallel",
\t\t\t\t\t\t\tchildren: "并行"
\t\t\t\t\t\t}) : null]
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: "dsh-a-gmeta",
\t\t\t\t\t\tchildren: described.durationText
\t\t\t\t\t})]
\t\t\t\t}), open ? (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tclassName: "dsh-a-gbody",
\t\t\t\t\tchildren
\t\t\t\t}) : null]
\t\t\t});
\t\t}
`;

/**
 * 对话界面前端展示补丁（G1）。
 *
 * 必须在 `patchConversationActivityPresentationSource` 之后执行：本函数复用主线
 * 注入的 `chatSemanticKind`，并依赖主线已把思考摘要容器改成 `<div>`。
 * 依赖主线补丁产出的锚点只有 `title: "思考",`（中文化）与 `thinkBody` 容器行，
 * 其余锚点全部取自干净基线 0.1.0-rc.6-oauth。
 * @param source - 已由主线补丁处理过的 `dsh-client-ui-conversation/lib/client.js`。
 * @returns 追加了活动轨迹展示的源码。
 */
export function patchActivityTrackFrontendSource(source) {
  let result = source;
  result = replaceExactlyOnce(
    result,
    `\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {`,
    `${ACTIVITY_RUNTIME_SOURCE}\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {`,
    "活动轨迹分组运行时",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst loadOlderAnchored = () => {`,
    `\t\t\tconst activityFlow = (0, react.useMemo)(() => buildActivityFlowItems(order, (nodeKey) => activityFactsOf(nodeStore, nodeKey)), [nodeStore, order]);
\t\t\tconst loadOlderAnchored = () => {`,
    "活动轨迹分组投影",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\torder.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
\t\t\t\t\t\t\t\tnodeKey,
\t\t\t\t\t\t\t\tuseSession,
\t\t\t\t\t\t\t\tselectedCallId,
\t\t\t\t\t\t\t\tcwd,
\t\t\t\t\t\t\t\topenFile,
\t\t\t\t\t\t\t\tinspectCall,
\t\t\t\t\t\t\t\tforkAt,
\t\t\t\t\t\t\t\tloadImage,
\t\t\t\t\t\t\t\tfileMentions,
\t\t\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\t\t\tt
\t\t\t\t\t\t\t}, nodeKey)),`,
    `\t\t\t\t\t\t\tactivityFlow.map((item) => {
\t\t\t\t\t\t\t\tconst seat = (nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
\t\t\t\t\t\t\t\t\tnodeKey,
\t\t\t\t\t\t\t\t\tuseSession,
\t\t\t\t\t\t\t\t\tselectedCallId,
\t\t\t\t\t\t\t\t\tcwd,
\t\t\t\t\t\t\t\t\topenFile,
\t\t\t\t\t\t\t\t\tinspectCall,
\t\t\t\t\t\t\t\t\tforkAt,
\t\t\t\t\t\t\t\t\tloadImage,
\t\t\t\t\t\t\t\t\tfileMentions,
\t\t\t\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\t\t\t\tt
\t\t\t\t\t\t\t\t}, nodeKey);
\t\t\t\t\t\t\t\treturn item.type === "group" ? (0, react_jsx_runtime.jsx)(ActivityGroup, {
\t\t\t\t\t\t\t\t\tgroup: item,
\t\t\t\t\t\t\t\t\tchildren: item.keys.map((nodeKey) => seat(nodeKey))
\t\t\t\t\t\t\t\t}, item.id) : seat(item.key);
\t\t\t\t\t\t\t}),`,
    "活动轨迹分组渲染",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\tref: summaryRef,
\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.summary,`,
    `\t\t\t\t\t\tref: summaryRef,
\t\t\t\t\t\t"data-think-summary": true,
\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.summary,`,
    "思考折叠摘要标记",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.thinkBody,`,
    `\t\t\t\t\t\t"data-think-body": true,
\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.thinkBody,`,
    "思考正文视窗标记",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\ttitle: "思考",`,
    `\t\t\t\t\ttitle: running ? "正在思考" : "思考",`,
    "运行中思考标题",
  );
  result = replaceExactlyOnce(
    result,
    `\t\tfunction ReasoningRow({ text, running, showDuration, startTime, endTime, codeLabels, mentions, t }) {
\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);`,
    `\t\tfunction ReasoningRow({ text, running, showDuration, startTime, endTime, codeLabels, mentions, t }) {
\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);
\t\t\t/**
\t\t\t * 运行中的收起意图（主人 2026-08-16 决定）。
\t\t\t * null = 没表态，按「运行中默认展开视窗」处理；false/true = 用户在运行中手动点过箭头，听用户的。
\t\t\t * 状态一旦从 running 翻到结束，意图作废并强制折叠（spec 4.2 结束自动收起）。
\t\t\t */
\t\t\tconst [thinkRunningIntent, setThinkRunningIntent] = (0, react.useState)(null);
\t\t\tconst thinkWasRunning = (0, react.useRef)(running);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tif (thinkWasRunning.current === running) return;
\t\t\t\tthinkWasRunning.current = running;
\t\t\t\tsetThinkRunningIntent(null);
\t\t\t\tif (!running) setExpanded(false);
\t\t\t}, [running]);
\t\t\tconst thinkOpen = running ? thinkRunningIntent ?? true : expanded;`,
    "运行中思考收起意图",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\topen: expanded,
\t\t\t\t\texpandable: true,
\t\t\t\t\texpandOnRowClick: true,
\t\t\t\t\tonToggle: () => {
\t\t\t\t\t\tsetExpanded((value) => !value);
\t\t\t\t\t},`,
    `\t\t\t\t\topen: thinkOpen,
\t\t\t\t\tkeepContentWhenOpen: running,
\t\t\t\t\texpandable: true,
\t\t\t\t\texpandOnRowClick: true,
\t\t\t\t\tonToggle: () => {
\t\t\t\t\t\tif (running) {
\t\t\t\t\t\t\tsetThinkRunningIntent((value) => !(value ?? true));
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tsetExpanded((value) => !value);
\t\t\t\t\t},`,
    "运行中思考自动开窗",
  );
  return result;
}

/* ==================== G6 区：选中文本批注输入 ==================== */

const SELECTION_ANNOTATION_CSS = [
  ".dsh-selection-popover{position:fixed;z-index:2147483000;display:flex;gap:4px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);color:var(--dsw-alias-label-primary);font:13px/1.2 inherit}",
  ".dsh-selection-popover button{border:0;border-radius:8px;padding:6px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}",
  ".dsh-selection-popover button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsh-selection-note{position:fixed;z-index:2147483001;width:min(360px,calc(100vw - 32px));padding:14px;border-radius:18px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);color:var(--dsw-alias-label-primary);font:13px/1.4 inherit}",
  ".dsh-selection-note-preview{max-height:104px;overflow:auto;margin-bottom:10px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
  ".dsh-selection-note-preview strong{display:block;margin-bottom:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500}",
  ".dsh-selection-note textarea{box-sizing:border-box;width:100%;min-height:96px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:10px 12px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;outline:none}",
  ".dsh-selection-note textarea:focus{border-color:var(--dsw-static-deepseek-500);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-static-deepseek-500) 16%,transparent)}",
  ".dsh-selection-note-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px}",
  ".dsh-selection-note-actions button{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:6px 13px;background:transparent;color:inherit;font:inherit;cursor:pointer}",
  ".dsh-selection-note-actions button[data-danger]{margin-right:auto;color:#d92d20;border-color:color-mix(in srgb,#d92d20 28%,transparent);background:color-mix(in srgb,#d92d20 7%,transparent)}",
  ".dsh-selection-note-actions button[data-primary]{border-color:var(--dsw-static-deepseek-500);background:var(--dsw-static-deepseek-500);color:white}",
  ".dsh-selection-anchor{position:absolute;z-index:2147482999;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:#0a84ff;color:#fff;font:700 13px/1 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;box-shadow:0 4px 12px rgba(10,132,255,.34);cursor:pointer;user-select:none}",
  ".dsh-selection-highlight{position:absolute;z-index:2147482998;border-radius:4px;background:rgba(10,132,255,.16);pointer-events:none}",
  ".dsh-selection-anchor[data-dsh-annotation-tone=\"edit\"]{background:#7c3aed;box-shadow:0 4px 12px rgba(124,58,237,.32)}",
  ".dsh-selection-highlight[data-dsh-annotation-tone=\"edit\"]{background:rgba(124,58,237,.16)}",
  ".dsh-annotation-composer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 10px 8px;min-height:30px}",
  ".dsh-annotation-composer-edit{margin:0 10px 6px}",
  ".dsh-annotation-chip,.dsh-annotation-history-chip{display:inline-flex;align-items:center;gap:6px;min-height:30px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 10px;background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:13px/1.2 inherit;box-shadow:0 2px 10px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);cursor:pointer}",
  ".dsh-annotation-chip::before,.dsh-annotation-history-chip::before{content:\"\";width:16px;height:16px;opacity:.82;background:currentColor;-webkit-mask:url('data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2016%2016%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Cpath%20fill%3D%22%23000%22%20fill-rule%3D%22evenodd%22%20d%3D%22M3.2%202.4A2.2%202.2%200%200%200%201%204.6v4.6a2.2%202.2%200%200%200%202.2%202.2h1.1v2.05c0%20.45.54.68.86.36l2.41-2.41h5.23A2.2%202.2%200%200%200%2015%209.2V4.6a2.2%202.2%200%200%200-2.2-2.2H3.2Zm0%201.2h9.6a1%201%200%200%201%201%201v4.6a1%201%200%200%201-1%201H7.07l-1.57%201.57V10.2H3.2a1%201%200%200%201-1-1V4.6a1%201%200%200%201%201-1Z%22/%3E%3C/svg%3E') center/contain no-repeat;mask:url('data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2016%2016%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Cpath%20fill%3D%22%23000%22%20fill-rule%3D%22evenodd%22%20d%3D%22M3.2%202.4A2.2%202.2%200%200%200%201%204.6v4.6a2.2%202.2%200%200%200%202.2%202.2h1.1v2.05c0%20.45.54.68.86.36l2.41-2.41h5.23A2.2%202.2%200%200%200%2015%209.2V4.6a2.2%202.2%200%200%200-2.2-2.2H3.2Zm0%201.2h9.6a1%201%200%200%201%201%201v4.6a1%201%200%200%201-1%201H7.07l-1.57%201.57V10.2H3.2a1%201%200%200%201-1-1V4.6a1%201%200%200%201%201-1Z%22/%3E%3C/svg%3E') center/contain no-repeat}",
  ".dsh-annotation-chip button{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:-4px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:16px/1 inherit;cursor:pointer}",
  ".dsh-annotation-chip button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
  ".dsh-annotation-preview{position:fixed;z-index:2147483002;width:min(420px,calc(100vw - 32px));max-height:min(520px,calc(100vh - 32px));overflow:auto;padding:14px;border-radius:18px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);color:var(--dsw-alias-label-primary);font:13px/1.45 inherit}",
  ".dsh-annotation-preview-item+.dsh-annotation-preview-item{margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}",
  ".dsh-annotation-preview-label{margin-bottom:4px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
  ".dsh-annotation-preview-text{white-space:pre-wrap;color:var(--dsw-alias-label-primary)}",
  ".dsh-annotation-preview-comment{white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}",
].join("");

const SELECTION_ANNOTATION_RUNTIME_SOURCE = `
		const DSH_SELECTION_ANNOTATION_CSS = ${JSON.stringify(SELECTION_ANNOTATION_CSS)};
		if (typeof document !== "undefined" && document.querySelector('style[data-dsh-frontend="selection-annotation"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.dshFrontend = "selection-annotation";
			tag.textContent = DSH_SELECTION_ANNOTATION_CSS;
			document.head.appendChild(tag);
		}
		if (typeof window !== "undefined" && window.__DSH_SELECTION_ANNOTATION_INSTALLED__ !== true) {
			window.__DSH_SELECTION_ANNOTATION_INSTALLED__ = true;
			let selectionPopover = null;
			let selectionNote = null;
			let annotationPreview = null;
			let selectedText = "";
			let selectedRect = null;
			let selectedRange = null;
			let selectedSourceKey = null;
			let selectedSourceKind = null;
			let nextAnnotationId = 1;
			let pendingAnnotations = [];
			let selectionMarkerRecords = [];
			let editSelectionMarkerRecords = [];
			let editAnnotationSignature = null;
			let draftMarkerSignature = null;
			let markerUpdateQueued = false;
			let pendingSubmitSignature = null;
			let activeAnnotationSessionId = null;
			const DSH_ANNOTATION_STORAGE_PREFIX = "__dsh_selection_annotations:";
			const DSH_LEGACY_ANNOTATION_STORAGE_KEY = DSH_ANNOTATION_STORAGE_PREFIX + location.pathname + location.search;
			function dshCurrentSessionId() {
				try {
					const parsed = JSON.parse(localStorage.getItem("dsh.sessions.current") ?? "{}");
					if (typeof parsed?.sessionId === "string" && parsed.sessionId.trim() !== "") return parsed.sessionId.trim();
				} catch {}
				const selectedRow = document.querySelector('.YDXeBa_sessionRow[aria-selected="true"], .YDXeBa_sessionRow.YDXeBa_selected');
				const label = selectedRow?.textContent?.trim();
				if (typeof label === "string" && label !== "") return "row:" + label;
				return "url:" + location.pathname + location.search;
			}
			function dshAnnotationStorageKey(sessionId = activeAnnotationSessionId ?? dshCurrentSessionId()) {
				return DSH_ANNOTATION_STORAGE_PREFIX + encodeURIComponent(sessionId);
			}
			function dshCssEscape(value) {
				if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
				return String(value).replace(/["\\\\]/g, "\\$&");
			}
			function dshNormalizeStoredAnnotations(raw) {
				try {
					const parsed = JSON.parse(raw);
					if (!Array.isArray(parsed)) return [];
					return parsed.filter((item) => typeof item?.text === "string").map((item) => ({
						id: Number.isSafeInteger(item.id) ? item.id : nextAnnotationId++,
						text: item.text,
						annotation: typeof item.annotation === "string" ? item.annotation : "",
						sourceKey: typeof item.sourceKey === "string" && item.sourceKey !== "" ? item.sourceKey : null,
						sourceKind: typeof item.sourceKind === "string" && item.sourceKind !== "" ? item.sourceKind : null
					}));
				} catch {
					return [];
				}
			}
			function dshHideSelectionUi() {
				selectionPopover?.remove();
				selectionPopover = null;
				selectionNote?.remove();
				selectionNote = null;
			}
			function dshHideAnnotationPreview() {
				annotationPreview?.remove();
				annotationPreview = null;
			}
			function dshSelectionEditable(target) {
				return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable === true || target?.closest?.("[contenteditable=true]") !== null;
			}
			function dshVisibleTextarea() {
				return Array.from(document.querySelectorAll("textarea")).reverse().find((textarea) => textarea.disabled !== true && textarea.getClientRects().length > 0 && textarea.closest(".dsh-selection-note") === null && textarea.closest("[data-dsh-edit-shell]") === null) ?? null;
			}
			function dshTextareaIsEdit(textarea) {
				return textarea?.closest?.("[data-dsh-edit-shell]") !== null;
			}
			function dshVisibleEditTextarea() {
				return Array.from(document.querySelectorAll("[data-dsh-edit-shell] textarea")).reverse().find((textarea) => textarea.disabled !== true && textarea.getClientRects().length > 0 && textarea.closest(".dsh-selection-note") === null) ?? null;
			}
			function dshSetTextareaValue(textarea, value) {
				const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
				if (setter !== undefined) setter.call(textarea, value);
				else textarea.value = value;
				textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
				textarea.dispatchEvent(new Event("change", { bubbles: true }));
				textarea.focus();
			}
			function dshLoadAnnotations() {
				const sessionId = activeAnnotationSessionId ?? dshCurrentSessionId();
				activeAnnotationSessionId = sessionId;
				const key = dshAnnotationStorageKey(sessionId);
				try {
					let value = sessionStorage.getItem(key);
					if (value === null) {
						const legacy = sessionStorage.getItem(DSH_LEGACY_ANNOTATION_STORAGE_KEY);
						const legacyItems = legacy === null ? [] : dshNormalizeStoredAnnotations(legacy);
						if (legacyItems.length > 0 && legacyItems.some((item) => dshFindRangeForAnnotation(item) !== null)) {
							pendingAnnotations = legacyItems;
							dshRenumberAnnotations();
							dshPersistAnnotations();
							sessionStorage.removeItem(DSH_LEGACY_ANNOTATION_STORAGE_KEY);
							return;
						}
						pendingAnnotations = [];
						dshRenumberAnnotations();
						return;
					}
					pendingAnnotations = dshNormalizeStoredAnnotations(value);
					dshRenumberAnnotations();
				} catch {
					pendingAnnotations = [];
				}
			}
			function dshPersistAnnotations() {
				try {
					const key = dshAnnotationStorageKey();
					if (pendingAnnotations.length === 0) {
						sessionStorage.removeItem(key);
						sessionStorage.removeItem(DSH_LEGACY_ANNOTATION_STORAGE_KEY);
					}
					else sessionStorage.setItem(key, JSON.stringify(pendingAnnotations));
				} catch {}
			}
			function dshSyncAnnotationSession() {
				const nextSessionId = dshCurrentSessionId();
				if (activeAnnotationSessionId === null) {
					activeAnnotationSessionId = nextSessionId;
					dshLoadAnnotations();
					return false;
				}
				if (nextSessionId === activeAnnotationSessionId) return false;
				dshPersistAnnotations();
				activeAnnotationSessionId = nextSessionId;
				pendingAnnotations = [];
				pendingSubmitSignature = null;
				dshClearSelectionMarkers();
				dshHideAnnotationPreview();
				dshHideSelectionUi();
				dshLoadAnnotations();
				return true;
			}
			function dshClearSelectionMarkers() {
				for (const record of selectionMarkerRecords) {
					record.highlight?.remove();
					record.anchor?.remove();
				}
				selectionMarkerRecords = [];
				draftMarkerSignature = null;
			}
			function dshClearEditSelectionMarkers() {
				for (const record of editSelectionMarkerRecords) {
					record.highlight?.remove();
					record.anchor?.remove();
				}
				editSelectionMarkerRecords = [];
				editAnnotationSignature = null;
			}
			function dshRenumberAnnotations() {
				pendingAnnotations.forEach((item, index) => {
					item.id = index + 1;
				});
				nextAnnotationId = pendingAnnotations.length + 1;
				for (const record of selectionMarkerRecords) {
					const index = pendingAnnotations.indexOf(record.item);
					if (index < 0) continue;
					const label = String(index + 1);
					record.item.id = index + 1;
					record.anchor.textContent = label;
					record.anchor.setAttribute("aria-label", "查看注释 " + label);
				}
			}
			function dshRemoveAnnotationById(id) {
				pendingAnnotations = pendingAnnotations.filter((item) => item.id !== id);
				const keptRecords = [];
				for (const record of selectionMarkerRecords) {
					if (record.item?.id === id) {
						record.highlight?.remove();
						record.anchor?.remove();
					}
					else {
						keptRecords.push(record);
					}
				}
				selectionMarkerRecords = keptRecords;
				dshRenumberAnnotations();
				dshPersistAnnotations();
				dshRenderComposerChip();
				dshHideAnnotationPreview();
			}
			function dshAnnotationPayload(annotations = pendingAnnotations) {
				return annotations.map((item) => {
					const payload = { text: item.text };
					if (typeof item.annotation === "string" && item.annotation.trim() !== "") payload.annotation = item.annotation.trim();
					return payload;
				});
			}
			function dshAnnotationBlock(annotations = pendingAnnotations) {
				return "\\n<response-annotations>\\n" + JSON.stringify(dshAnnotationPayload(annotations), null, 2) + "\\n</response-annotations>\\n";
			}
			function dshAnnotationSignature(annotations = pendingAnnotations) {
				return JSON.stringify(dshAnnotationPayload(annotations));
			}
			function dshAnnotationMarkerSignature(annotations = pendingAnnotations) {
				return JSON.stringify(annotations.map((item) => ({
					text: item.text,
					annotation: typeof item.annotation === "string" ? item.annotation.trim() : "",
					sourceKey: typeof item.sourceKey === "string" ? item.sourceKey : "",
					sourceKind: typeof item.sourceKind === "string" ? item.sourceKind : ""
				})));
			}
			function dshFindComposerCard(textarea) {
				const editCard = textarea?.closest?.("[data-dsh-edit-card]") ?? null;
				if (editCard !== null) return editCard;
				let node = textarea?.parentElement ?? null;
				let fallback = textarea?.parentElement ?? null;
				for (let index = 0; index < 8 && node !== null; index += 1, node = node.parentElement) {
					const rect = node.getBoundingClientRect();
					if (node.closest?.("[data-dsh-edit-shell]") !== null) continue;
					if (dshFindSubmitButton(node) !== null && node.querySelector?.("textarea") !== null) return node;
					if (rect.width >= 480 && rect.height >= 72 && rect.bottom > window.innerHeight - 360) return node;
					fallback = node;
				}
				return fallback;
			}
			function dshButtonVisible(button) {
				const rect = button.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			}
			function dshButtonLooksLikeSend(button) {
				const label = ((button.getAttribute("aria-label") ?? "") + " " + (button.getAttribute("title") ?? "") + " " + (button.textContent ?? "")).toLowerCase();
				if (/发送|send|submit|提交|重新发送/.test(label)) return true;
				if (/文件|附件|命令|录音|语音|麦克风|模型|access|取消|保存|清除|copy|复制/.test(label)) return false;
				const rect = button.getBoundingClientRect();
				return button.querySelector("svg") !== null && rect.width <= 72 && rect.height <= 72;
			}
			function dshFindSubmitButton(root = document) {
				for (const selector of ['button[data-dsh-edit-send]', 'button[aria-label="发送消息"]', 'button[aria-label="Send message"]', 'button[aria-label="重新发送"]', 'button[type="submit"]']) {
					const button = root.querySelector?.(selector);
					if (button instanceof HTMLButtonElement && dshButtonVisible(button)) return button;
				}
				const buttons = Array.from(root.querySelectorAll?.("button") ?? []).filter((button) => button instanceof HTMLButtonElement && dshButtonVisible(button) && dshButtonLooksLikeSend(button));
				buttons.sort((left, right) => {
					const leftRect = left.getBoundingClientRect();
					const rightRect = right.getBoundingClientRect();
					return rightRect.right + rightRect.bottom * 0.01 - (leftRect.right + leftRect.bottom * 0.01);
				});
				return buttons[0] ?? null;
			}
			function dshSyncAnnotationSubmitState() {
				dshSyncAnnotationSession();
				const textarea = dshVisibleTextarea();
				const card = dshFindComposerCard(textarea);
				const button = card === null ? null : dshFindSubmitButton(card);
				if (!(button instanceof HTMLButtonElement)) return;
				if (pendingAnnotations.length > 0) {
					button.disabled = false;
					button.removeAttribute("disabled");
					button.setAttribute("aria-disabled", "false");
					button.dataset.dshAnnotationEnabled = "true";
					return;
				}
				if (button.dataset.dshAnnotationEnabled === "true") {
					delete button.dataset.dshAnnotationEnabled;
					if ((textarea?.value ?? "").trim() === "") button.disabled = true;
				}
			}
			function dshFindDirectChild(parent, child) {
				let node = child;
				while (node !== null && node.parentElement !== parent) node = node.parentElement;
				return node;
			}
			function dshRenderAnnotationPreview(anchor, annotations) {
				dshHideAnnotationPreview();
				if (!Array.isArray(annotations) || annotations.length === 0) return;
				const panel = document.createElement("div");
				panel.className = "dsh-annotation-preview";
				annotations.forEach((item, index) => {
					const row = document.createElement("div");
					row.className = "dsh-annotation-preview-item";
					const selectedLabel = document.createElement("div");
					selectedLabel.className = "dsh-annotation-preview-label";
					selectedLabel.textContent = (index + 1) + ". 所选文本：";
					const selectedValue = document.createElement("div");
					selectedValue.className = "dsh-annotation-preview-text";
					selectedValue.textContent = item.text;
					row.append(selectedLabel, selectedValue);
					if (typeof item.annotation === "string" && item.annotation.trim() !== "") {
						const commentLabel = document.createElement("div");
						commentLabel.className = "dsh-annotation-preview-label";
						commentLabel.textContent = "用户评论：";
						const commentValue = document.createElement("div");
						commentValue.className = "dsh-annotation-preview-comment";
						commentValue.textContent = item.annotation.trim();
						row.append(commentLabel, commentValue);
					}
					panel.appendChild(row);
				});
				document.body.appendChild(panel);
				const rect = anchor.getBoundingClientRect();
				const left = Math.min(Math.max(12, rect.left), window.innerWidth - panel.offsetWidth - 12);
				const top = rect.top + rect.height + panel.offsetHeight + 12 <= window.innerHeight ? rect.top + rect.height + 8 : Math.max(12, rect.top - panel.offsetHeight - 8);
				panel.style.left = left + "px";
				panel.style.top = top + "px";
				annotationPreview = panel;
			}
			function dshRenderComposerChip() {
				dshSyncAnnotationSession();
				const textarea = dshVisibleTextarea();
				const oldChip = document.querySelector('.dsh-annotation-composer[data-dsh-annotation-target="main"]');
				if (pendingAnnotations.length === 0 || textarea === null) {
					oldChip?.remove();
					dshSyncAnnotationSubmitState();
					return false;
				}
				const card = dshFindComposerCard(textarea);
				if (card === null) return false;
				const signature = dshAnnotationSignature();
				if (oldChip !== null && oldChip.parentElement === card && oldChip.dataset.dshAnnotationSignature === signature) {
					dshRenderSelectionMarkers();
					dshSyncAnnotationSubmitState();
					return true;
				}
				const scroll = textarea.closest("div");
				const chipRow = oldChip ?? document.createElement("div");
				chipRow.className = "dsh-annotation-composer";
				chipRow.dataset.dshAnnotationTarget = "main";
				chipRow.dataset.dshAnnotationCount = String(pendingAnnotations.length);
				chipRow.dataset.dshAnnotationSignature = signature;
				chipRow.textContent = "";
				const chip = document.createElement("span");
				chip.className = "dsh-annotation-chip";
				chip.tabIndex = 0;
				chip.textContent = pendingAnnotations.length + " 条注释";
				const showChipPreview = (event) => {
					event.stopPropagation();
					dshRenderAnnotationPreview(chip, pendingAnnotations);
				};
				chip.addEventListener("click", showChipPreview);
				chip.addEventListener("mouseenter", showChipPreview);
				const clear = document.createElement("button");
				clear.type = "button";
				clear.setAttribute("aria-label", "清除注释");
				clear.textContent = "×";
				clear.addEventListener("click", (event) => {
					event.stopPropagation();
					pendingAnnotations = [];
					dshPersistAnnotations();
					dshClearSelectionMarkers();
					dshRenderComposerChip();
					dshHideAnnotationPreview();
				});
				chip.appendChild(clear);
				chipRow.appendChild(chip);
				const editScroll = card.querySelector?.("[data-dsh-edit-scroll]") ?? null;
				const directChild = dshFindDirectChild(card, editScroll ?? scroll ?? textarea);
				if (oldChip === null || oldChip.parentElement !== card || oldChip.nextElementSibling !== (editScroll ?? directChild)) card.insertBefore(chipRow, editScroll ?? directChild ?? card.firstChild);
				dshRenderSelectionMarkers();
				dshSyncAnnotationSubmitState();
				return true;
			}
			function dshRenderEditAnnotationChip() {
				const textarea = dshVisibleEditTextarea();
				const oldChip = document.querySelector('.dsh-annotation-composer[data-dsh-annotation-target="edit"]');
				if (textarea === null) {
					oldChip?.remove();
					dshClearEditSelectionMarkers();
					return false;
				}
				const parsed = dshParseAnnotationBlock(textarea.value ?? "");
				if (parsed === null) {
					oldChip?.remove();
					dshClearEditSelectionMarkers();
					return false;
				}
				const card = textarea.closest("[data-dsh-edit-card]");
				const editScroll = card?.querySelector?.("[data-dsh-edit-scroll]") ?? null;
				if (card === null) return false;
				for (const view of card.querySelectorAll('[data-dsh-edit-mirror], div[aria-hidden="true"]')) {
					if ((view.textContent ?? "").includes("<response-annotations>")) view.textContent = parsed.visibleText + "\\n";
				}
				const signature = dshAnnotationSignature(parsed.annotations);
				if (oldChip !== null && oldChip.parentElement === card && oldChip.dataset.dshAnnotationSignature === signature) {
					dshRenderEditSelectionMarkers(parsed.annotations);
					return true;
				}
				const chipRow = oldChip ?? document.createElement("div");
				chipRow.className = "dsh-annotation-composer dsh-annotation-composer-edit";
				chipRow.dataset.dshAnnotationTarget = "edit";
				chipRow.dataset.dshAnnotationSignature = signature;
				chipRow.textContent = "";
				const chip = document.createElement("span");
				chip.className = "dsh-annotation-chip";
				chip.tabIndex = 0;
				chip.textContent = parsed.annotations.length + " 条注释";
				const showChipPreview = (event) => {
					event.stopPropagation();
					dshRenderAnnotationPreview(chip, parsed.annotations);
				};
				chip.addEventListener("click", showChipPreview);
				chip.addEventListener("mouseenter", showChipPreview);
				const clear = document.createElement("button");
				clear.type = "button";
				clear.setAttribute("aria-label", "清除这条消息的注释");
				clear.textContent = "×";
				clear.addEventListener("click", (event) => {
					event.stopPropagation();
					dshSetTextareaValue(textarea, parsed.visibleText);
					oldChip?.remove();
					dshClearEditSelectionMarkers();
					dshHideAnnotationPreview();
				});
				chip.appendChild(clear);
				chipRow.appendChild(chip);
				card.insertBefore(chipRow, editScroll ?? card.firstChild);
				dshRenderEditSelectionMarkers(parsed.annotations);
				return true;
			}
			function dshRangeElement(range) {
				const ancestor = range?.commonAncestorContainer ?? null;
				if (ancestor === null) return null;
				return ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
			}
			function dshRangePointVisible(range, x, y) {
				if (range === null || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
				const element = dshRangeElement(range);
				if (element === null) return false;
				const top = document.elementsFromPoint(x, y).find((node) => node.closest?.(".dsh-selection-highlight,.dsh-selection-anchor") === null);
				return top !== undefined && (top === element || element.contains(top) || top.contains(element));
			}
			function dshRangeRectVisible(range, rect) {
				if (range === null) return true;
				if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight) return false;
				const left = Math.min(Math.max(rect.left + 2, 1), window.innerWidth - 1);
				const midX = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
				const right = Math.min(Math.max(rect.right - 2, 1), window.innerWidth - 1);
				const midY = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
				return [[left, midY], [midX, midY], [right, midY]].some(([x, y]) => dshRangePointVisible(range, x, y));
			}
			function dshRangeRect(range, fallbackRect = null) {
				try {
					if (range !== null) {
						const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0 && dshRangeRectVisible(range, rect));
						if (rects.length > 0) {
							const left = Math.min(...rects.map((rect) => rect.left));
							const top = Math.min(...rects.map((rect) => rect.top));
							const right = Math.max(...rects.map((rect) => rect.right));
							const bottom = Math.max(...rects.map((rect) => rect.bottom));
							return { left, top, right, bottom, width: right - left, height: bottom - top };
						}
						const rect = range.getBoundingClientRect();
						if (rect.width > 0 && rect.height > 0 && dshRangeRectVisible(range, rect)) return rect;
						return null;
					}
				} catch {}
				return fallbackRect;
			}
			function dshUpdateSelectionMarker(record) {
				const rect = dshRangeRect(record.range, record.fallbackRect);
				if (rect === null || rect.width <= 0 || rect.height <= 0) {
					record.highlight.style.display = "none";
					record.anchor.style.display = "none";
					return;
				}
				record.highlight.style.display = "";
				record.anchor.style.display = "";
				record.highlight.style.left = Math.max(0, window.scrollX + rect.left) + "px";
				record.highlight.style.top = Math.max(0, window.scrollY + rect.top) + "px";
				record.highlight.style.width = Math.max(1, rect.width) + "px";
				record.highlight.style.height = Math.max(1, rect.height) + "px";
				record.anchor.style.left = Math.min(window.scrollX + rect.right + 6, window.scrollX + window.innerWidth - 36) + "px";
				record.anchor.style.top = Math.max(window.scrollY + rect.top - 8, window.scrollY + 8) + "px";
			}
			function dshUpdateSelectionMarkers() {
				for (const record of selectionMarkerRecords) dshUpdateSelectionMarker(record);
				for (const record of editSelectionMarkerRecords) dshUpdateSelectionMarker(record);
			}
			function dshQueueSelectionMarkerUpdate() {
				if (markerUpdateQueued) return;
				markerUpdateQueued = true;
				window.requestAnimationFrame(() => {
					markerUpdateQueued = false;
					dshUpdateSelectionMarkers();
				});
			}
			function dshCreateSelectionAnchor(item, range, fallbackRect, tone = "draft") {
				if (range === null && fallbackRect === null) return;
				const highlight = document.createElement("div");
				highlight.className = "dsh-selection-highlight";
				if (tone !== "draft") highlight.dataset.dshAnnotationTone = tone;
				const anchor = document.createElement("button");
				anchor.type = "button";
				anchor.className = "dsh-selection-anchor";
				anchor.textContent = String(item.id);
				anchor.setAttribute("aria-label", "查看注释 " + item.id);
				if (tone !== "draft") anchor.dataset.dshAnnotationTone = tone;
				anchor.addEventListener("click", (event) => {
					event.stopPropagation();
					const anchorRect = anchor.getBoundingClientRect();
					if (tone === "edit") dshOpenEditSelectionNote(anchorRect, item);
					else dshOpenSelectionNote(anchorRect, item);
				});
				const record = { item, range, fallbackRect, highlight, anchor };
				dshUpdateSelectionMarker(record);
				document.body.append(highlight, anchor);
				if (tone === "edit") editSelectionMarkerRecords.push(record);
				else selectionMarkerRecords.push(record);
			}
			function dshFindRangeForText(text, rootOverride = null) {
				const flow = rootOverride ?? document.querySelector("[data-chat-flow]");
				if (flow === null || typeof text !== "string" || text.trim() === "") return null;
				const needle = text.trim().replace(/\s+/g, " ");
				const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT, {
					acceptNode(node) {
						const parent = node.parentElement;
						if (parent === null) return NodeFilter.FILTER_REJECT;
						if (parent.closest(".dsh-selection-popover,.dsh-selection-note,.dsh-annotation-preview,.dsh-annotation-composer,.dsh-annotation-history-chip,[data-dsh-edit-shell],textarea,input,button") !== null) return NodeFilter.FILTER_REJECT;
						if ((node.textContent ?? "").trim() === "") return NodeFilter.FILTER_REJECT;
						return NodeFilter.FILTER_ACCEPT;
					}
				});
				let node = walker.nextNode();
				while (node !== null) {
					const raw = node.textContent ?? "";
					const compact = raw.replace(/\s+/g, " ");
					const index = compact.indexOf(needle);
					if (index >= 0) {
						const prefix = compact.slice(0, index);
						const suffix = compact.slice(0, index + needle.length);
						const start = Math.min(raw.length, prefix.length);
						const end = Math.min(raw.length, Math.max(start + 1, suffix.length));
						const range = document.createRange();
						range.setStart(node, start);
						range.setEnd(node, end);
						return range;
					}
					node = walker.nextNode();
				}
				return null;
			}
			function dshFindRangeForAnnotation(item) {
				const flow = document.querySelector("[data-chat-flow]");
				if (flow === null || item === null || typeof item?.text !== "string") return null;
				let root = flow;
				if (typeof item.sourceKey === "string" && item.sourceKey !== "") {
					const escaped = dshCssEscape(item.sourceKey);
					root = flow.querySelector('[data-chat-flow-key="' + escaped + '"]') ?? flow.querySelector('[data-chat-anchor-key="' + escaped + '"]') ?? flow;
				}
				return dshFindRangeForText(item.text, root);
			}
			function dshRenderSelectionMarkers() {
				const signature = dshAnnotationMarkerSignature();
				if (signature === draftMarkerSignature && selectionMarkerRecords.length === pendingAnnotations.length) {
					dshQueueSelectionMarkerUpdate();
					return;
				}
				dshClearSelectionMarkers();
				draftMarkerSignature = signature;
				pendingAnnotations.forEach((item, index) => {
					item.id = index + 1;
					const range = dshFindRangeForAnnotation(item);
					if (range === null) return;
					dshCreateSelectionAnchor(item, range, null, "draft");
				});
			}
			function dshRenderEditSelectionMarkers(annotations) {
				const signature = dshAnnotationSignature(annotations);
				if (signature === editAnnotationSignature) return;
				dshClearEditSelectionMarkers();
				editAnnotationSignature = signature;
				annotations.forEach((item, index) => {
					const range = dshFindRangeForAnnotation(item);
					if (range === null) return;
					dshCreateSelectionAnchor({ ...item, id: index + 1 }, range, null, "edit");
				});
			}
			function dshSetEditAnnotations(textarea, visibleText, annotations) {
				const body = (visibleText ?? "").trim();
				const nextValue = annotations.length === 0 ? body : body + (body.endsWith("\\n") || body === "" ? "" : "\\n") + dshAnnotationBlock(annotations);
				editAnnotationSignature = null;
				dshSetTextareaValue(textarea, nextValue);
				window.setTimeout(dshRenderEditAnnotationChip, 0);
			}
			function dshOpenEditSelectionNote(rect, existingItem) {
				const editTextarea = dshVisibleEditTextarea();
				const parsed = dshParseAnnotationBlock(editTextarea?.value ?? "");
				const index = Math.max(0, Number(existingItem?.id ?? 1) - 1);
				const current = parsed?.annotations?.[index] ?? null;
				if (editTextarea === null || parsed === null || current === null) return;
				selectionPopover?.remove();
				selectionPopover = null;
				selectionNote?.remove();
				dshHideAnnotationPreview();
				const note = document.createElement("div");
				note.className = "dsh-selection-note";
				const preview = document.createElement("div");
				preview.className = "dsh-selection-note-preview";
				const label = document.createElement("strong");
				label.textContent = "所选文本：";
				const previewText = document.createElement("span");
				previewText.textContent = current.text;
				preview.append(label, previewText);
				const textarea = document.createElement("textarea");
				textarea.placeholder = "添加可选评论...";
				textarea.value = current.annotation ?? "";
				const actions = document.createElement("div");
				actions.className = "dsh-selection-note-actions";
				const remove = document.createElement("button");
				remove.type = "button";
				remove.dataset.danger = "true";
				remove.textContent = "删除";
				const cancel = document.createElement("button");
				cancel.type = "button";
				cancel.textContent = "取消";
				const save = document.createElement("button");
				save.type = "button";
				save.dataset.primary = "true";
				save.textContent = "保存";
				const readLatest = () => {
					const latest = dshParseAnnotationBlock(editTextarea.value ?? "");
					const latestItem = latest?.annotations?.[index] ?? null;
					return latest === null || latestItem === null ? null : latest;
				};
				remove.addEventListener("click", () => {
					const latest = readLatest();
					if (latest === null) return;
					const annotations = latest.annotations.filter((_, itemIndex) => itemIndex !== index);
					dshSetEditAnnotations(editTextarea, latest.visibleText, annotations);
					dshHideSelectionUi();
				});
				cancel.addEventListener("click", dshHideSelectionUi);
				const commit = () => {
					const latest = readLatest();
					if (latest === null) return;
					const annotations = latest.annotations.map((item, itemIndex) => itemIndex === index ? { ...item, annotation: textarea.value.trim() } : item);
					dshSetEditAnnotations(editTextarea, latest.visibleText, annotations);
					dshHideSelectionUi();
				};
				save.addEventListener("click", commit);
				textarea.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
					event.preventDefault();
					commit();
				});
				actions.append(remove, cancel, save);
				note.append(preview, textarea, actions);
				document.body.appendChild(note);
				selectionNote = note;
				dshPlaceFloating(note, rect);
				textarea.focus();
			}
			function dshAddPendingAnnotation(comment) {
				const item = {
					id: nextAnnotationId++,
					text: selectedText,
					annotation: typeof comment === "string" ? comment.trim() : "",
					sourceKey: selectedSourceKey,
					sourceKind: selectedSourceKind
				};
				pendingAnnotations.push(item);
				dshRenumberAnnotations();
				dshPersistAnnotations();
				draftMarkerSignature = null;
				const fallbackRange = selectedRange?.cloneRange?.() ?? dshFindRangeForAnnotation(item);
				dshCreateSelectionAnchor(item, fallbackRange, selectedRect);
				dshRenderSelectionMarkers();
				dshRenderComposerChip();
			}
			function dshPrepareTextareaForSubmit(textarea) {
				if (textarea?.closest?.(".dsh-selection-note") !== null) return false;
				if (dshTextareaIsEdit(textarea)) return false;
				if (pendingAnnotations.length === 0 || textarea === null || textarea.dataset.dshAnnotationPrepared === "true") return false;
				const originalValue = textarea.value;
				const block = dshAnnotationBlock();
				const submitSignature = dshAnnotationSignature();
				const spacer = originalValue === "" || originalValue.endsWith("\\n") ? "" : "\\n";
				const preparedValue = originalValue + spacer + block;
				pendingSubmitSignature = submitSignature;
				textarea.dataset.dshAnnotationPrepared = "true";
				dshSetTextareaValue(textarea, preparedValue);
				window.setTimeout(() => {
					if (textarea.value === preparedValue) {
						dshSetTextareaValue(textarea, originalValue);
						if (pendingSubmitSignature === submitSignature) pendingSubmitSignature = null;
					}
					delete textarea.dataset.dshAnnotationPrepared;
				}, 350);
				window.setTimeout(() => {
					if (textarea.value === "") {
						pendingAnnotations = [];
						pendingSubmitSignature = null;
						dshPersistAnnotations();
						dshClearSelectionMarkers();
						dshRenderComposerChip();
						dshHideAnnotationPreview();
					}
				}, 900);
				return true;
			}
			function dshParseAnnotationBlock(rawText) {
				if (typeof rawText !== "string") return null;
				const match = rawText.match(/<response-annotations>\\s*([\\s\\S]*?)\\s*<\\/response-annotations>/);
				if (match === null) return null;
				try {
					const parsed = JSON.parse(match[1]);
					if (!Array.isArray(parsed)) return null;
					const annotations = parsed.filter((item) => typeof item?.text === "string").map((item) => ({
						text: item.text,
						annotation: typeof item.annotation === "string" ? item.annotation : ""
					}));
					if (annotations.length === 0) return null;
					return { annotations, visibleText: rawText.replace(match[0], "").trim() };
				} catch {
					return null;
				}
			}
			function dshDecorateHistoryAnnotations() {
				const flow = document.querySelector("[data-chat-flow]");
				if (flow === null) return;
				const elements = Array.from(flow.querySelectorAll("*")).filter((element) => {
					if (element.closest("[data-dsh-edit-shell]") !== null) return false;
					if (element.closest(".dsh-annotation-preview,.dsh-annotation-composer,.dsh-annotation-history-chip") !== null) return false;
					const text = element.textContent ?? "";
					if (!text.includes("<response-annotations>")) return false;
					return !Array.from(element.children).some((child) => (child.textContent ?? "").includes("<response-annotations>"));
				});
				for (const element of elements) {
					if (element.dataset.dshAnnotationHistory === "true") continue;
					const parsed = dshParseAnnotationBlock(element.textContent ?? "");
					if (parsed === null) continue;
					element.dataset.dshAnnotationHistory = "true";
					element.textContent = parsed.visibleText;
					const chip = document.createElement("span");
					chip.className = "dsh-annotation-history-chip";
					chip.tabIndex = 0;
					chip.textContent = parsed.annotations.length + " 条注释";
					chip.addEventListener("click", (event) => {
						event.stopPropagation();
						dshRenderAnnotationPreview(chip, parsed.annotations);
					});
					element.insertAdjacentElement("beforebegin", chip);
					if (pendingSubmitSignature !== null && dshAnnotationSignature(parsed.annotations) === pendingSubmitSignature) {
						pendingAnnotations = [];
						pendingSubmitSignature = null;
						dshPersistAnnotations();
						dshClearSelectionMarkers();
						dshRenderComposerChip();
						dshHideAnnotationPreview();
					}
				}
			}
			function dshPlaceFloating(element, rect) {
				const left = Math.min(Math.max(12, rect.left + rect.width / 2 - element.offsetWidth / 2), window.innerWidth - element.offsetWidth - 12);
				const top = Math.max(12, rect.top - element.offsetHeight - 10);
				element.style.left = left + "px";
				element.style.top = top + "px";
			}
			function dshOpenSelectionNote(rect, existingItem = null) {
				selectionPopover?.remove();
				selectionPopover = null;
				selectionNote?.remove();
				dshHideAnnotationPreview();
				const note = document.createElement("div");
				note.className = "dsh-selection-note";
				const preview = document.createElement("div");
				preview.className = "dsh-selection-note-preview";
				const label = document.createElement("strong");
				label.textContent = "所选文本：";
				const previewText = document.createElement("span");
				previewText.textContent = existingItem?.text ?? selectedText;
				preview.append(label, previewText);
				const textarea = document.createElement("textarea");
				textarea.placeholder = "添加可选评论...";
				textarea.value = existingItem?.annotation ?? "";
				const actions = document.createElement("div");
				actions.className = "dsh-selection-note-actions";
				const cancel = document.createElement("button");
				cancel.type = "button";
				cancel.textContent = "取消";
				const remove = document.createElement("button");
				remove.type = "button";
				remove.dataset.danger = "true";
				remove.textContent = "删除";
				const save = document.createElement("button");
				save.type = "button";
				save.dataset.primary = "true";
				save.textContent = "保存";
				cancel.addEventListener("click", dshHideSelectionUi);
				remove.addEventListener("click", () => {
					if (existingItem === null) return;
					dshRemoveAnnotationById(existingItem.id);
					dshHideSelectionUi();
				});
				const commit = () => {
					const comment = textarea.value.trim();
					if (existingItem !== null) {
						const current = pendingAnnotations.find((item) => item.id === existingItem.id);
						if (current !== undefined) current.annotation = comment;
						dshPersistAnnotations();
						dshRenderComposerChip();
					}
					else {
						dshAddPendingAnnotation(comment);
					}
					dshHideSelectionUi();
				};
				save.addEventListener("click", commit);
				textarea.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
					event.preventDefault();
					commit();
				});
				if (existingItem !== null) actions.append(remove);
				actions.append(cancel, save);
				note.append(preview, textarea, actions);
				document.body.appendChild(note);
				selectionNote = note;
				dshPlaceFloating(note, rect);
				textarea.focus();
			}
			function dshShowSelectionPopover(event) {
				window.setTimeout(() => {
					if (event.target?.closest?.(".dsh-selection-popover,.dsh-selection-note,.dsh-annotation-chip,.dsh-annotation-preview,.dsh-selection-anchor") !== null) return;
					if (dshSelectionEditable(event.target)) return;
					const selection = window.getSelection?.();
					const text = selection?.toString?.().trim() ?? "";
					if (text.length < 1 || selection.rangeCount < 1) {
						dshHideSelectionUi();
						selectedText = "";
						selectedRect = null;
						selectedRange = null;
						selectedSourceKey = null;
						selectedSourceKind = null;
						return;
					}
					const ancestor = selection.getRangeAt(0).commonAncestorContainer;
					const element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
					if (element?.closest?.("[data-chat-flow]") === null) return;
					const sourceNode = element.closest("[data-chat-flow-key],[data-chat-anchor-key]");
					selectedSourceKey = sourceNode?.getAttribute("data-chat-flow-key") ?? sourceNode?.getAttribute("data-chat-anchor-key") ?? null;
					selectedSourceKind = sourceNode?.getAttribute("data-chat-flow-kind") ?? null;
					selectedText = text.length > 3000 ? text.slice(0, 3000) : text;
					const rect = selection.getRangeAt(0).getBoundingClientRect();
					if (rect.width <= 0 || rect.height <= 0) return;
					selectedRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
					selectedRange = selection.getRangeAt(0).cloneRange();
					selectionPopover?.remove();
					selectionPopover = document.createElement("div");
					selectionPopover.className = "dsh-selection-popover";
					const copy = document.createElement("button");
					copy.type = "button";
					copy.textContent = "复制";
					const annotate = document.createElement("button");
					annotate.type = "button";
					annotate.textContent = "添加注释";
					for (const button of [copy, annotate]) {
						button.addEventListener("pointerdown", (event) => {
							event.preventDefault();
							event.stopPropagation();
						});
					}
					copy.addEventListener("click", () => {
						navigator.clipboard?.writeText(selectedText);
						dshHideSelectionUi();
					});
					annotate.addEventListener("click", (event) => {
						event.preventDefault();
						event.stopPropagation();
						dshOpenSelectionNote(rect);
					});
					selectionPopover.append(copy, annotate);
					document.body.appendChild(selectionPopover);
					dshPlaceFloating(selectionPopover, rect);
				}, 0);
			}
			dshLoadAnnotations();
			window.setTimeout(dshRenderComposerChip, 50);
			window.setTimeout(dshRenderEditAnnotationChip, 50);
			window.setTimeout(dshDecorateHistoryAnnotations, 50);
			document.addEventListener("mouseup", dshShowSelectionPopover, true);
			document.addEventListener("keyup", (event) => {
				if (event.key === "Escape") dshHideSelectionUi();
				else dshShowSelectionPopover(event);
			}, true);
			document.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
				if (!(event.target instanceof HTMLTextAreaElement)) return;
				if (event.target.closest(".dsh-selection-note") !== null) return;
				dshPrepareTextareaForSubmit(event.target);
			}, true);
			document.addEventListener("pointerdown", (event) => {
				const button = event.target?.closest?.("button");
				if (button === null) return;
				const textarea = dshVisibleTextarea();
				const card = dshFindComposerCard(textarea);
				if (button !== dshFindSubmitButton(card ?? document)) return;
				dshPrepareTextareaForSubmit(textarea);
			}, true);
			document.addEventListener("click", (event) => {
				const button = event.target?.closest?.("button");
				if (button === null) return;
				const textarea = dshVisibleTextarea();
				const card = dshFindComposerCard(textarea);
				if (button !== dshFindSubmitButton(card ?? document)) return;
				dshPrepareTextareaForSubmit(textarea);
			}, true);
			document.addEventListener("click", (event) => {
				if (event.target?.closest?.(".dsh-annotation-preview,.dsh-annotation-chip,.dsh-annotation-history-chip,.dsh-selection-anchor") !== null) return;
				dshHideAnnotationPreview();
			}, true);
			document.addEventListener("mousedown", (event) => {
				if (event.target?.closest?.(".dsh-selection-popover,.dsh-selection-note") !== null) return;
				dshHideSelectionUi();
			}, true);
			window.addEventListener("scroll", () => {
				dshHideSelectionUi();
				dshQueueSelectionMarkerUpdate();
			}, true);
			window.addEventListener("resize", dshQueueSelectionMarkerUpdate);
			window.visualViewport?.addEventListener("scroll", dshQueueSelectionMarkerUpdate);
			window.visualViewport?.addEventListener("resize", dshQueueSelectionMarkerUpdate);
			new MutationObserver(() => {
				dshRenderComposerChip();
				dshRenderEditAnnotationChip();
				dshDecorateHistoryAnnotations();
				dshSyncAnnotationSubmitState();
				dshQueueSelectionMarkerUpdate();
			}).observe(document.body, { childList: true, subtree: true, characterData: true });
		}
`;

export function patchSelectionAnnotationSource(source) {
  return replaceExactlyOnce(
    source,
    `\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {`,
    `${SELECTION_ANNOTATION_RUNTIME_SOURCE}\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {`,
    "选中文本批注运行时",
  );
}

/** 为工作区 bundle 增加复制会话 ID 与带稳定 sessionId 的 @对话引用。 */
export function patchWorkspaceConversationReferencesSource(source) {
  let result = source;
  result = replaceExactlyOnce(result,
    `\t\t\tconst showStatus = statuses[0].state !== "done" || row.completed;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);\n\t\t\tconst sessionMenuItems = [`,
    `\t\t\tconst showStatus = statuses[0].state !== "done" || row.completed;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);\n\t\t\tconst [copyIdStatus, setCopyIdStatus] = (0, react.useState)("idle");\n\t\t\tconst sessionMenuItems = [`, "复制会话 ID 状态");
  result = replaceExactlyOnce(result,
    `\t\t\t\t{\n\t\t\t\t\tid: "archive",`,
    `\t\t\t\t{\n\t\t\t\t\tid: "copy-session-id",\n\t\t\t\t\tlabel: copyIdStatus === "copied" ? "已复制对话 ID" : copyIdStatus === "failed" ? "复制失败，请重试" : "复制对话 ID",\n\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, {})\n\t\t\t\t},\n\t\t\t\t{\n\t\t\t\t\tid: "archive",`, "复制会话 ID 菜单项");
  result = replaceExactlyOnce(result,
    `\t\t\t\t\t\t\t\t\tif (id === "fork") onFork(node.id);\n\t\t\t\t\t\t\t\t\tif (id === "archive") onArchive(node.id);`,
    `\t\t\t\t\t\t\t\t\tif (id === "fork") onFork(node.id);\n\t\t\t\t\t\t\t\t\tif (id === "copy-session-id") {\n\t\t\t\t\t\t\t\t\t\tconst write = navigator.clipboard?.writeText(node.id);\n\t\t\t\t\t\t\t\t\t\tif (write === void 0) setCopyIdStatus("failed");\n\t\t\t\t\t\t\t\t\t\telse write.then(() => setCopyIdStatus("copied"), () => setCopyIdStatus("failed"));\n\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\tif (id === "archive") onArchive(node.id);`, "复制会话 ID 动作");
  result = replaceExactlyOnce(result, `\t\t\t"slots",\n\t\t\t"sessions",`, `\t\t\t"slots",\n\t\t\t"inputTriggers",\n\t\t\t"sessions",`, "输入触发服务依赖");
  result = replaceExactlyOnce(result,
    `\t\t\t}), "ui-workspace: dictionaries");\n\t\t\tconst searchSessions = async (query, signal) => {`,
    `\t\t\t}), "ui-workspace: dictionaries");\n\t\t\tconst conversationLabels = new Map();\n\t\t\tconst conversationRows = (query) => {\n\t\t\t\tconst normalized = query.trim().toLocaleLowerCase();\n\t\t\t\tconst { byId } = ctx.sessions.list.getSnapshot();\n\t\t\t\treturn Object.values(byId).filter((item) => {\n\t\t\t\t\tconst title = item.displayTitle ?? item.title ?? item.id;\n\t\t\t\t\treturn normalized === "" || title.toLocaleLowerCase().includes(normalized) || item.id.toLocaleLowerCase().includes(normalized);\n\t\t\t\t}).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map((item) => {\n\t\t\t\t\tconst title = item.displayTitle ?? item.title ?? item.id;\n\t\t\t\t\tconversationLabels.set(item.id, title);\n\t\t\t\t\treturn { name: title, description: item.cwd ?? "无工作区", hint: item.id, sessionId: item.id };\n\t\t\t\t});\n\t\t\t};\n\t\t\tconst conversationTitle = (sessionId) => {\n\t\t\t\tconst item = ctx.sessions.list.getSnapshot().byId[sessionId];\n\t\t\t\treturn item?.displayTitle ?? item?.title ?? conversationLabels.get(sessionId) ?? sessionId;\n\t\t\t};\n\t\t\tconst conversationSource = {\n\t\t\t\ttrigger: "@", name: "对话", order: -10,\n\t\t\t\tcandidates(_session, { query }) { return Promise.resolve(conversationRows(query)); },\n\t\t\t\tonPick({ candidate }) {\n\t\t\t\t\tconst sessionId = candidate.sessionId;\n\t\t\t\t\tif (typeof sessionId !== "string" || sessionId === "") return void 0;\n\t\t\t\t\treturn { insert: { source: "conversation", ref: sessionId, label: candidate.name, clipboardText: \`@\${candidate.name} [\${sessionId}]\` } };\n\t\t\t\t},\n\t\t\t\tcodec: {\n\t\t\t\t\tclipboardText: (sessionId) => \`@\${conversationTitle(sessionId)} [\${sessionId}]\`,\n\t\t\t\tserialize: (sessionId) => Promise.resolve(\`<conversation-reference title=\${JSON.stringify(conversationTitle(sessionId))} conversationId=\${JSON.stringify(sessionId)} />\`)\n\t\t\t\t}\n\t\t\t};\n\t\t\tconst inputTriggers = ctx.get("inputTriggers");\n\t\t\tctx.effect(() => inputTriggers.registerSource(conversationSource), "ui-workspace: @conversation source");\n\t\t\tconst searchSessions = async (query, signal) => {`, "对话引用输入源");
  return result;
}

/* ==================== G3 区：编辑上一条用户消息（批次 D） ==================== */

/**
 * 实现体在 `lib/frontend/edit-resend-shell.mjs`，本区只做薄再导出（与 G4 同一惯例）。
 *
 * - `patchEditResendShellSource`：`dsh-client-ui-conversation` 的铅笔入口与编辑态卡片，
 *   由 `transforms.mjs` 的 `patchConversationUiSource` 在最外层组合；三处锚点（InputBar 签名、
 *   `const permissions = useProjection("permissions");`、`UserMessageNodeView` 整体）全部取自
 *   干净基线 0.1.0-rc.6-oauth，与 G1/G4 的锚点不重叠。
 * - 纯逻辑（`dshEditSendState` / `dshEditIntakeFiles` / `dshEditExternalEffects`）同时导出供单测。
 */
export {
  EDIT_RESEND_SHELL_STYLE,
  dshEditExternalEffects,
  dshEditIntakeFiles,
  dshEditSendState,
  patchEditResendShellSource,
} from "./frontend/edit-resend-shell.mjs";

/* ==================== G4 区：账户额度 / 上下文状态 / 模型菜单 ==================== */

/**
 * G4 的实现体放在 `lib/frontend/` 下各自的模块里，本区只做薄再导出。
 *
 * 这样做的唯一原因是三个窗口并行：G1/G2/G4 都要写本文件，实现体分模块后
 * 本区永远只有几行，合并冲突面最小；模块内部的锚点仍然只取自干净基线。
 *
 * - `patchAccountUsageSettingsSource`：设置页账户使用情况面板（`dsh-client-ui-settings-models`）。
 *   `transforms.mjs` 保留同名委托，`Build-CandidateRelease.mjs` 的导入不变。
 * - `patchContextStatusCardSource`：上下文状态卡（`dsh-client-ui-conversation`），
 *   由 `transforms.mjs` 的 `patchConversationUiSource` 组合；锚点与主线的
 *   `patchContextMeterThresholdsSource` 不重叠，顺序可交换。
 * - 模型能力菜单不需要新的补丁函数：视觉全部在
 *   `packages/dsh-model-selection-view/lib/browser-source.js` 里，仍由主线既有的
 *   `patchModelSelectionUxSource` 注入。
 */
export { patchAccountUsageSettingsSource } from "./frontend/account-usage-panel.mjs";
export { CONTEXT_STATUS_CARD_STYLE, patchContextStatusCardSource } from "./frontend/context-status-card.mjs";
export { ACCOUNT_USAGE_PANEL_STYLE } from "../../dsh-account-usage/lib/settings-panel-source.js";

/* ==================== G6 区：整轮工作过程折叠（未来预留 2） ==================== */

/**
 * 实现体在 `lib/frontend/turn-process-collapse.mjs`，本区只做薄再导出（与 G3/G4 同一惯例）。
 *
 * - `patchTurnProcessCollapseSource`：在 `dsh-client-ui-conversation` 的 `ChatView` 签名前
 *   注入折叠头组件 + 投影读取纯逻辑 + 能力开关 `DSH_PROCESS_COLLAPSE_MODE`（恒 `"off"`），
 *   由 `transforms.mjs` 的 `patchConversationUiSource` 在最外层组合；锚点取自干净基线
 *   0.1.0-rc.6-oauth，不改 `ChatView` 签名、不改 G1 的活动流渲染，与 G1/G3/G4 互不重叠。
 * - 纯逻辑与样式常量同时导出，供单测逐条覆盖规范 10.2.1 的九条约束、以及静态预览复用。
 *
 * 唯一数据形状是 `useProjection("turnPresentation")`（Codex 形态 B，`QUESTIONS.md` G6-2/G7），
 * 只实现这一种形状；真实投影未接入统一候选，候选里能力开关恒 `off`、组件不挂载，
 * 真实 renderer 上的折叠必须标为未验证。
 */
export {
  PROCESS_COLLAPSE_DEFAULT_MODE,
  TURN_PROCESS_COLLAPSE_STYLE,
  buildTurnFlowItems,
  formatProcessDuration,
  moveFinalReplyProcessNodes,
  patchTurnProcessCollapseSource,
  planTurnCollapse,
  readTurnPresentation,
  turnCollapseController,
  turnProcessClock,
} from "./frontend/turn-process-collapse.mjs";

/* ==================== Plan 15：磨砂外观 / 右侧工作区外壳 ==================== */

export {
  DSH_AP_COPY,
  DSH_AP_DEFAULTS,
  DSH_AP_LIMITS,
  DSH_APPEARANCE_MARKER,
  DSH_APPEARANCE_RUNTIME_SOURCE,
  DSH_APPEARANCE_STYLE,
  patchAppearanceThemeSource,
} from "./frontend/appearance-shell.mjs";

export {
  DSH_BROWSER_CONSOLE_ERRORS_EVENT,
  DSH_EMBEDDED_BROWSER_BOUNDS_EVENT,
  DSH_EMBEDDED_BROWSER_MESSAGE_TYPE,
  DSH_WORKSPACE_LOCAL_KEY,
  DSH_WORKSPACE_SHELL_STYLE,
  patchWorkspaceShellSource,
} from "./frontend/workspace-panel.mjs";
