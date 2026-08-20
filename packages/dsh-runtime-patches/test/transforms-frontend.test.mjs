import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ACTIVITY_TRACK_CSS,
  activityGroupIsParallel,
  activityNodeFacts,
  activityToolLabel,
  buildActivityFlowItems,
  describeActivityGroup,
  formatActivityClock,
  patchActivityTrackFrontendSource,
  patchWorkspaceConversationReferencesSource,
} from "../lib/transforms-frontend.mjs";
import { patchConversationUiSource } from "../lib/transforms.mjs";

const releaseRoot = process.env.DSH_RELEASE_ROOT;
const execFileAsync = promisify(execFile);

function thinkNode({ status = "settled", startTime = 1000, endTime = 6000, segments = 1 } = {}) {
  return {
    kind: "assistant-step",
    data: {
      status,
      startTime,
      time: endTime,
      blocks: Array.from({ length: segments }, (_, index) => ({ kind: "reasoning", text: `第${index + 1}段` })),
      ...(status === "settled" ? { finalNode: { time: endTime, seq: 9 } } : {}),
    },
  };
}

function toolNode({ name = "mcp__sandbox__sandbox_exec", callTime = 1000, time = 3000, settled = true, isError = false } = {}) {
  return {
    kind: "tool-call",
    data: {
      root: settled
        ? { kind: "tool-result", callId: "c1", call: { name }, callTime, time, isError, subCalls: [] }
        : { callId: "c1", name, argsRaw: "{}", time: callTime, subCalls: [] },
    },
  };
}

test("中文时钟按秒、分、时分级显示，缺时间显示耗时未知", () => {
  assert.equal(formatActivityClock(0), "0秒");
  assert.equal(formatActivityClock(8_400), "8秒");
  assert.equal(formatActivityClock(727_000), "12分07秒");
  assert.equal(formatActivityClock(3_720_000), "1时02分");
  assert.equal(formatActivityClock(Number.NaN), "耗时未知");
  assert.equal(formatActivityClock(-1), "耗时未知");
});

test("工具展示名只取 MCP 服务器段与确认存在的内置工具，其余原样保留", () => {
  assert.equal(activityToolLabel("mcp__sandbox__sandbox_exec"), "Sandbox");
  assert.equal(activityToolLabel("mcp__web-fetcher__web_fetch_page"), "web-fetcher");
  assert.equal(activityToolLabel("mcp__memory_store__memory_query"), "memory_store");
  assert.equal(activityToolLabel("read"), "读取文件");
  assert.equal(activityToolLabel("run_code"), "运行代码");
  assert.equal(activityToolLabel("some_future_tool"), "some_future_tool");
  assert.equal(activityToolLabel(""), "工具");
  assert.equal(activityToolLabel(undefined), "工具");
});

test("活动事实只来自真实事件字段，非活动节点不参与分组", () => {
  assert.equal(activityNodeFacts(undefined, "think"), undefined);
  assert.equal(activityNodeFacts({ kind: "user-message" }, undefined), undefined);
  assert.deepEqual(activityNodeFacts(thinkNode({ segments: 3 }), "think"), {
    kind: "think",
    running: false,
    failed: false,
    startTime: 1000,
    endTime: 6000,
    segments: 3,
    toolName: undefined,
    modelLabel: undefined,
    turn: null,
    step: null,
  });
  assert.equal(activityNodeFacts(thinkNode({ status: "running" }), "think").running, true);
  assert.equal(activityNodeFacts(thinkNode({ status: "running" }), "think").endTime, null);
  assert.equal(activityNodeFacts(thinkNode({ status: "interrupted" }), "think").failed, true);
  const settledTool = activityNodeFacts(toolNode(), "tool");
  assert.equal(settledTool.startTime, 1000);
  assert.equal(settledTool.endTime, 3000);
  assert.equal(settledTool.running, false);
  assert.equal(settledTool.toolName, "mcp__sandbox__sandbox_exec");
  const runningTool = activityNodeFacts(toolNode({ settled: false }), "tool");
  assert.equal(runningTool.running, true);
  assert.equal(runningTool.endTime, null);
  assert.equal(activityNodeFacts(toolNode({ isError: true }), "tool").failed, true);
  assert.equal(activityNodeFacts({ kind: "tool-call", data: {} }, "tool"), undefined);
});

test("只合并相邻同类且已结束的活动，运行中与失败必定断组", () => {
  const facts = new Map([
    ["t1", activityNodeFacts(toolNode(), "tool")],
    ["t2", activityNodeFacts(toolNode({ name: "read", callTime: 3100, time: 3400 }), "tool")],
    ["think1", activityNodeFacts(thinkNode({ startTime: 3500, endTime: 4000 }), "think")],
    ["think2", activityNodeFacts(thinkNode({ startTime: 4000, endTime: 4600 }), "think")],
    ["user", undefined],
    ["t3", activityNodeFacts(toolNode({ callTime: 5000, time: 5200 }), "tool")],
    ["t4", activityNodeFacts(toolNode({ isError: true, callTime: 5200, time: 5300 }), "tool")],
    ["t5", activityNodeFacts(toolNode({ settled: false, callTime: 5400 }), "tool")],
  ]);
  const items = buildActivityFlowItems([...facts.keys()], (key) => facts.get(key));
  assert.deepEqual(items.map((item) => (item.type === "group" ? `group:${item.kind}:${item.keys.join("+")}` : `seat:${item.key}`)), [
    "group:tool:t1+t2",
    "group:think:think1+think2",
    "seat:user",
    "seat:t3",
    "seat:t4",
    "seat:t5",
  ]);
});

test("单个活动不包组，模型语义标注变化也断组", () => {
  const single = buildActivityFlowItems(["only"], () => activityNodeFacts(toolNode(), "tool"));
  assert.deepEqual(single, [{ type: "seat", key: "only" }]);
  const labelled = {
    a: { ...activityNodeFacts(toolNode(), "tool"), modelLabel: "查找前端相关代码壳说明" },
    b: { ...activityNodeFacts(toolNode({ callTime: 3100, time: 3400 }), "tool"), modelLabel: "查找前端相关代码壳说明" },
    c: { ...activityNodeFacts(toolNode({ callTime: 3500, time: 3800 }), "tool"), modelLabel: "另一个标注" },
  };
  const items = buildActivityFlowItems(["a", "b", "c"], (key) => labelled[key]);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "group");
  assert.equal(items[0].modelLabel, "查找前端相关代码壳说明");
  assert.equal(items[1].type, "seat");
});

test("组头文案在模型标注与相邻同类推断之间切换，缺时间不补零", () => {
  const thinkGroup = {
    type: "group",
    kind: "think",
    keys: ["a", "b"],
    facts: [
      activityNodeFacts(thinkNode({ startTime: 1000, endTime: 6000, segments: 2 }), "think"),
      activityNodeFacts(thinkNode({ startTime: 6000, endTime: 13_000, segments: 1 }), "think"),
    ],
  };
  assert.deepEqual(describeActivityGroup(thinkGroup), {
    labelSource: "derived",
    title: "思考",
    count: "3 项",
    durationText: "12秒",
    parallel: false,
  });
  const mixed = {
    type: "group",
    kind: "tool",
    keys: ["a", "b"],
    facts: [
      activityNodeFacts(toolNode({ name: "mcp__sandbox__sandbox_exec", callTime: 0, time: 5000 }), "tool"),
      activityNodeFacts(toolNode({ name: "mcp__web-fetcher__web_fetch_page", callTime: 5000, time: 8000 }), "tool"),
    ],
  };
  assert.deepEqual(describeActivityGroup(mixed), {
    labelSource: "derived",
    title: "使用 Sandbox 与 web-fetcher",
    count: "2 次调用",
    durationText: "8秒",
    parallel: false,
  });
  const same = {
    type: "group",
    kind: "tool",
    keys: ["a", "b"],
    facts: [
      activityNodeFacts(toolNode({ name: "read", callTime: 0, time: 500 }), "tool"),
      activityNodeFacts(toolNode({ name: "read", callTime: 500, time: 900 }), "tool"),
    ],
  };
  assert.equal(describeActivityGroup(same).title, "读取文件");
  assert.equal(describeActivityGroup(same).count, "2 次");
  const unknownTime = {
    type: "group",
    kind: "tool",
    keys: ["a", "b"],
    facts: [
      { ...activityNodeFacts(toolNode(), "tool"), startTime: null },
      { ...activityNodeFacts(toolNode(), "tool"), endTime: null },
    ],
  };
  assert.equal(describeActivityGroup(unknownTime).durationText, "耗时未知");
  assert.deepEqual(describeActivityGroup({ ...mixed, modelLabel: "查找前端相关代码壳说明" }), {
    labelSource: "model",
    title: "查找前端相关代码壳说明",
    count: "2 步",
    durationText: "8秒",
    parallel: false,
  });
});

test("并行标志只认同一真实 step 或时间区间重叠", () => {
  assert.equal(activityGroupIsParallel([{ turn: 2, step: 3 }, { turn: 2, step: 3 }]), true);
  assert.equal(activityGroupIsParallel([{ startTime: 1000, endTime: 4000 }, { startTime: 2000, endTime: 5000 }]), true);
  assert.equal(activityGroupIsParallel([{ startTime: 1000, endTime: 2000 }, { startTime: 2000, endTime: 3000 }]), false);
  assert.equal(activityGroupIsParallel([{ startTime: null, endTime: null }, { startTime: null, endTime: null }]), false);
});

test("工作区补丁增加复制 ID 与稳定 conversationId 的 @对话引用", { skip: !releaseRoot }, async () => {
  const source = await readFile(`${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`, "utf8");
  const result = patchWorkspaceConversationReferencesSource(source);
  assert.match(result, /已复制对话 ID/);
  assert.match(result, /navigator\.clipboard\?\.writeText\(node\.id\)/);
  assert.match(result, /name: "对话"/);
  assert.match(result, /source: "conversation", ref: sessionId/);
  assert.match(result, /conversationId=\$\{JSON\.stringify\(sessionId\)\}/);
  assert.match(result, /hint: item\.id, sessionId: item\.id/);
  const syntaxRoot = await mkdtemp(join(tmpdir(), "dsh-workspace-reference-"));
  try {
    const syntaxPath = join(syntaxRoot, "client.mjs");
    await writeFile(syntaxPath, result, "utf8");
    await execFileAsync(process.execPath, ["--check", syntaxPath]);
  } finally {
    await rm(syntaxRoot, { recursive: true, force: true });
  }
});

test("活动轨迹样式只使用 DSH design token，不硬编码白底与 Codex 配色", () => {
  assert.match(ACTIVITY_TRACK_CSS, /var\(--dsw-alias-bg-base\)/);
  assert.match(ACTIVITY_TRACK_CSS, /max-height:252px/);
  assert.doesNotMatch(ACTIVITY_TRACK_CSS, /#fff|#ffffff/i);
  assert.doesNotMatch(ACTIVITY_TRACK_CSS, /Cambria/);
});

test("G5：所有活动行都补回 flex 行布局，标题分类永不竖排换行", () => {
  // 上游 DisclosureRow 的 CSS 是空 stub，行容器不是 flex：
  // `.title{flex:none}` 失效 → 中文标题按字断行成竖排（主人在 768 深色图上发现）；
  // `.summary{overflow:hidden}` 在行内元素上失效 → 长路径折行而不是省略号；
  // `.sep{width:2px;height:2px}` 在行内元素上失效 → 分隔点消失只留 16px 空隙。
  // 因此这三条必须覆盖整个 [data-chat-flow]，不能只覆盖 [data-variant="think"]。
  assert.match(ACTIVITY_TRACK_CSS, /\[data-chat-flow\] \[data-disclosure-row\]\{display:flex;align-items:center/);
  assert.match(
    ACTIVITY_TRACK_CSS,
    /\[data-chat-flow\] \[data-disclosure-row\]>span:nth-child\(2\)\{flex:0 0 auto;[^}]*white-space:nowrap;[^}]*text-overflow:ellipsis\}/,
  );
  assert.match(ACTIVITY_TRACK_CSS, /\[data-disclosure-row\]>span\[aria-hidden="true"\]\{flex:none;align-self:center\}/);
  // 标题不允许 flex-shrink：否则长摘要会把「思考」压成「思..」。
  assert.doesNotMatch(ACTIVITY_TRACK_CSS, /span:nth-child\(2\)\{flex:0 1 auto/);
  // 错误行整行红（spec 3.4）：基线只把摘要标红，标题与图标仍是灰的。
  assert.match(ACTIVITY_TRACK_CSS, /\[data-state="error"\] \[data-disclosure-row\]>span[^{]*\{color:var\(--dsw-alias-state-error-primary\)\}/);
});

test("活动轨迹补丁在结构不符时立即停止", () => {
  assert.throws(() => patchActivityTrackFrontendSource("const unrelated = true;"), /结构不一致/);
});

test("真实对话界面获得轮级过程折叠、相邻同类分组、运行中思考视窗与统一计时列", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`;
  const source = await readFile(path, "utf8");
  const result = patchConversationUiSource(source);
  assert.match(result, /function buildActivityFlowItems/);
  assert.match(result, /function describeActivityGroup/);
  assert.match(result, /function ActivityGroup\(\{ group, children \}\)/);
  assert.match(result, /const activityFlow = \(0, react\.useMemo\)/);
  assert.match(result, /function readTurnPresentation\(projection\)/);
  assert.match(result, /function buildTurnFlowItems\(order, activityFlow, controller\)/);
  assert.match(result, /const turnPresentation = useProjection\("turnPresentation"\)/);
  assert.match(result, /turnFlow\.map\(\(item\) =>/);
  assert.doesNotMatch(result, /order\.map\(\(nodeKey\) => \(0, react_jsx_runtime\.jsx\)\(ChatNodeSeat/);
  assert.match(result, /"data-think-summary": true/);
  assert.match(result, /"data-think-body": true/);
  assert.match(result, /title: running \? "正在思考" : "思考"/);
  // G5：运行中默认开窗，但用户点过箭头就听用户的；结束时意图作废并强制折叠。
  assert.match(result, /open: thinkOpen,/);
  assert.match(result, /const thinkOpen = running \? thinkRunningIntent \?\? true : expanded;/);
  assert.match(result, /setThinkRunningIntent\(\(value\) => !\(value \?\? true\)\);/);
  assert.match(result, /setThinkRunningIntent\(null\);\n\t\t\t\tif \(!running\) setExpanded\(false\);/);
  assert.match(result, /keepContentWhenOpen: running/);
  assert.match(result, /data-dsh-frontend="activity-track"/);
  assert.match(result, /data-chat-semantic-kind/);
  const syntaxRoot = await mkdtemp(join(tmpdir(), "dsh-activity-track-"));
  try {
    const syntaxPath = join(syntaxRoot, "client.mjs");
    await writeFile(syntaxPath, result, "utf8");
    await execFileAsync(process.execPath, ["--check", syntaxPath]);
  } finally {
    await rm(syntaxRoot, { recursive: true, force: true });
  }
});

test("选中文本注释草稿按会话分桶，并能从原消息重建蓝色编号", async () => {
  const source = await readFile(new URL("../lib/transforms-frontend.mjs", import.meta.url), "utf8");
  assert.match(source, /function dshCurrentSessionId\(\)/);
  assert.match(source, /localStorage\.getItem\("dsh\.sessions\.current"\)/);
  assert.match(source, /DSH_ANNOTATION_STORAGE_PREFIX \+ encodeURIComponent\(sessionId\)/);
  assert.doesNotMatch(source, /const DSH_ANNOTATION_STORAGE_KEY = "__dsh_selection_annotations:" \+ location\.pathname/);
  assert.match(source, /sourceKey: selectedSourceKey/);
  assert.match(source, /sourceNode\?\.getAttribute\("data-chat-flow-key"\)/);
  assert.match(source, /function dshFindRangeForAnnotation\(item\)/);
  assert.match(source, /function dshRenderSelectionMarkers\(\)/);
  assert.match(source, /dshRenderSelectionMarkers\(\);\n\s*dshSyncAnnotationSubmitState\(\);/);
});
