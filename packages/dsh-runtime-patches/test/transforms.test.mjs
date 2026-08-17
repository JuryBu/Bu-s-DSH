import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import {
  mergeAdjacentReasoningBlocks,
  patchAccountUsageSettingsSource,
  patchAgentInstructionsSource,
  patchAgentModelSelectionPromptSource,
  patchAgentLoopActivityLabelSource,
  patchAgentPresetModuleResolutionSource,
  patchConversationActivityPresentationSource,
  patchConversationUiSource,
  patchCompactionIdleRegionSource,
  patchContextMeterThresholdsSource,
  patchHeadlessBundleSource,
  patchHeadlessShutdownSource,
  patchHostModelSelectionSource,
  patchJobsCompletionDeliverySource,
  patchJobsLocalTeardownSource,
  patchMcpClientMultimodalSource,
  patchModelSelectionUxSource,
  patchPiAiFastModelsSource,
  patchPiAiSimpleOptionsServiceTierSource,
  patchToolsReadImageSdkSource,
  patchSystemPromptSource,
  patchTimeContextSource,
  patchToolActivityPresentationSource,
  patchWindsurfSettingsSource,
} from "../lib/transforms.mjs";

const releaseRoot = process.env.DSH_RELEASE_ROOT;
const candidateRoot = process.env.DSH_CANDIDATE_ROOT;
const execFileAsync = promisify(execFile);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} 未出现在转换后的源码中`);
  const openingBrace = source.indexOf("{", start);
  assert.notEqual(openingBrace, -1, `${name} 缺少函数体`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return runInNewContext(`(${source.slice(start, index + 1)})`);
  }
  throw new Error(`${name} 函数体没有闭合`);
}

test("运行状态总标题改为中文且保留替代旧快照语义", () => {
  const fixture = "return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\\n\\n${body}`;";
  const result = patchSystemPromptSource(fixture);
  assert.match(result, /当前运行状态/);
  assert.match(result, /以本快照为准/);
});

test("基础压缩器增加指定范围的空闲事务提交入口", () => {
  const fixture = `const unrelated = "keep";\n+\tlegitimate\n\t}\n\t/** Bind the effective token meter and dynamically dispatched summarizer hook. */\n\tregionDependencies() {`;
  const result = patchCompactionIdleRegionSource(fixture);
  assert.match(result, /compactIdleRegion\(start, end, agent, signal, sourceCommandId\)/);
  assert.match(result, /agent\.runMaintenance/);
  assert.match(result, /stability: "selected-span"/);
  assert.match(result, /this\.ctx\.sessions\.flush/);
  assert.doesNotMatch(result, /\n\+\t \* Commit one already-selected range/);
  assert.match(result, /\n\+\tlegitimate\n/);
});

test("基础压缩器空闲事务插入点变化时停止构建", () => {
  assert.throws(() => patchCompactionIdleRegionSource("export const unrelated = true;"), /结构不一致/);
});

test("真实 rc.6 基础压缩器转换后保持语法有效", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`;
  const source = await readFile(path, "utf8");
  const result = patchCompactionIdleRegionSource(source);
  assert.match(result, /compactIdleRegion\(start, end, agent, signal, sourceCommandId\)/);
  const syntaxRoot = await mkdtemp(join(tmpdir(), "dsh-compaction-basic-"));
  try {
    const syntaxPath = join(syntaxRoot, "index.mjs");
    await writeFile(syntaxPath, result, "utf8");
    await execFileAsync(process.execPath, ["--check", syntaxPath]);
  } finally {
    await rm(syntaxRoot, { recursive: true, force: true });
  }
});

test("时间上下文在真人新轮立即注入，长轮次至多每分钟刷新一次", () => {
  const fixture = `\tconst refreshIntervalMs = config.refreshIntervalMs;
\tvalidateRefreshInterval(refreshIntervalMs);
\t\tif (refreshIntervalMs !== void 0 && refreshIntervalMs > 0) {
\t\t\tconst lastInjection = latestInjectionTime(agent);
\t\t\tif (lastInjection !== void 0 && now >= lastInjection && now - lastInjection < refreshIntervalMs) return decision;
\t\t}`;
  const result = patchTimeContextSource(fixture);
  assert.match(result, /Math\.max\(60_000, configuredRefreshIntervalMs \?\? 0\)/);
  assert.match(result, /if \(step > 1\)/);
  assert.doesNotMatch(result, /refreshIntervalMs !== void 0/);
});

test("同一步工具调用持久化统一语义标题", () => {
  const fixture = `\t\t\tsource: sections.length === 0 ? {
\t\t\t\tkind: "plugin",
\t\t\t\tplugin: SOURCE
\t\t\t} : {
/** Append a started call and return the event seq that its result must cite. */
function appendToolCall(session, turn, step, block) {
	return session.append("tool/call", {
		turn,
		step,
		callId: block.id,
		name: block.name,
		arguments: block.arguments
	}).seq;
}
					for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });
			const toolCalls = message.content.filter((block) => block.type === "tool-call");`;
  const result = patchAgentLoopActivityLabelSource(fixture);
  assert.match(result, /function activityLabelFromMessage/);
  assert.match(result, /activityLabel: block\.activityLabel/);
  assert.match(result, /map\(\(block\) => activityLabel === void 0/);
  assert.match(result, /form: "cleared"/);
  assert.match(result, /surfaceOp: \{ op: "replace"/);
  const activityLabelFromMessage = extractFunction(result, "activityLabelFromMessage");
  assert.equal(activityLabelFromMessage({ content: [
    { type: "reasoning", text: "内部思考标题" },
    { type: "text", text: "我先检查三条真实链路" },
    { type: "tool-call", id: "call-1" },
  ] }), "我先检查三条真实链路");
});

test("真实 rc.6 时间插件可被唯一转换并保持语法有效", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-time-context/lib/index.js`;
  const source = await readFile(path, "utf8");
  const result = patchTimeContextSource(source);
  assert.match(result, /configuredRefreshIntervalMs/);
  assert.match(result, /if \(step > 1\)/);
  const syntaxRoot = await mkdtemp(join(tmpdir(), "dsh-time-context-"));
  try {
    const syntaxPath = join(syntaxRoot, "index.mjs");
    await writeFile(syntaxPath, result, "utf8");
    await execFileAsync(process.execPath, ["--check", syntaxPath]);
  } finally {
    await rm(syntaxRoot, { recursive: true, force: true });
  }
});

test("Agent Preset 裸包始终从当前 DSH 安装包解析", () => {
  const fixture = "const base = harnessBase.get(this.config);";
  assert.equal(
    patchAgentPresetModuleResolutionSource(fixture),
    "const base = import.meta.url;",
  );
});

test("Agent Preset 上游解析结构变化时停止构建", () => {
  assert.throws(
    () => patchAgentPresetModuleResolutionSource("const base = profileBase;"),
    /结构不一致/,
  );
});

test("Agent Preset 新会话默认主力模式且保留持久标准模式选择", () => {
  const fixture = [
    "const base = harnessBase.get(this.config);",
    "var AgentPresets = class extends Service {",
    "  constructor(ctx, config) {",
    "    this.config = config;",
    "    this.settings = settingsCtx.settings.register(settingsNamespace(SETTINGS_NAMESPACE), AgentPresetSettingsSchema, { base: { default: config.default } });",
    "  }",
    "  get defaultId() {",
    "    return this.settings?.get().default ?? this.config.default;",
    "  }",
    "  async list() { return await discoverPresets(this.resolvedRoots); }",
    "  async resolve(id) { const wanted = id ?? this.defaultId; return wanted === \"standard\" ? wanted : wanted; }",
    "};",
  ].join("\n");
  const result = patchAgentPresetModuleResolutionSource(fixture);
  assert.match(result, /const base = import\.meta\.url;/);
  assert.match(result, /this\.config = \{ \.\.\.config, default: config\.default === \"standard\" \? \"stardust-main\" : config\.default \};/);
  assert.match(result, /base: \{ default: this\.config\.default \}/);
  assert.match(result, /return this\.settings\?\.get\(\)\.default \?\? this\.config\.default;/);
  assert.match(result, /return await discoverPresets\(this\.resolvedRoots\)/);
  assert.match(result, /wanted === \"standard\"/);
  assert.doesNotMatch(result, /base: \{ default: config\.default \}/);
});

test("Jobs 完成通知在 owner 忙碌或额度耗尽时延迟到可安全唤醒的时机", () => {
  const source = `const spentWakes = /* @__PURE__ */ new WeakMap();
\tif (delivery === "wakeup") ctx.on("agent/inbox/claimed", ({ agent, message }) => {
\t\tif (message.source.kind === "user") spentWakes.delete(agent);
\t});
\tconst outputLimits = /* @__PURE__ */ new WeakMap();
\tctx.jobs.onJobDone((snapshot, owner) => {
\t\tif (snapshot.reported || owner === void 0) return;
\t\tconst message = createUserMessage({
\t\t\tcontent: [{
\t\t\t\ttype: "text",
\t\t\t\ttext: fitCompletionNotice(snapshot)
\t\t\t}],
\t\t\tsource: {
\t\t\t\tkind: "plugin",
\t\t\t\tplugin: "tool-jobs",
\t\t\t\tform: "notice",
\t\t\t\tsummary: completionSummary(snapshot)
\t\t\t}
\t\t});
\t\tconst spent = spentWakes.get(owner) ?? 0;
\t\tif (delivery === "wakeup" && owner.status === "idle" && spent < wakeBudget) {
\t\t\tspentWakes.set(owner, spent + 1);
\t\t\towner.followup(message);
\t\t\treturn;
\t\t}
\t\towner.inject(message);
\t});`;
  const result = patchJobsCompletionDeliverySource(source);
  assert.match(result, /deferredCompletions/);
  assert.match(result, /agent\/status/);
  assert.match(result, /flushDeferredCompletions/);
  assert.doesNotMatch(result, /owner\.inject\(message\);/);
  assert.throws(() => patchJobsCompletionDeliverySource("const unrelated = true;"), /结构不一致/);
});

test("Jobs 本地注册表在关闭时有界等待不合作的取消", () => {
  const source = `const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10;
var LocalJobRegistry = class extends JobRegistry {
\tstatic Config = z.object({ maxConcurrentJobsPerOwner: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER) });
\t/** Schemastery-defaulted active-job limit. */
\tmaxConcurrentJobsPerOwner;
\tconstructor(ctx, config) {
\t\tsuper(ctx);
\t\tthis.maxConcurrentJobsPerOwner = config.maxConcurrentJobsPerOwner;
\t\tthis.selfCtx = ctx;
\t}
\t/** Cancel, await terminal records, and drop every job owned by one exact agent lifecycle. */
\tasync disposeOwned(owner) {
\t\tconst owned = [];
\t\tawait Promise.all(owned.map((job) => job.settled));
\t}
\tasync disposeAll() {
\t\tconst all = [];
\t\tawait Promise.all(all.map((job) => job.settled));
\t}
};`;
  const result = patchJobsLocalTeardownSource(source);
  assert.match(result, /teardownCancelTimeoutMs/);
  assert.match(result, /awaitTeardownSettlement/);
  assert.match(result, /record forced failed so teardown can continue/);
  assert.doesNotMatch(result, /owned\.map\(\(job\) => job\.settled\)/);
  assert.throws(() => patchJobsLocalTeardownSource("const unrelated = true;"), /结构不一致/);
});

test("Windsurf 设置卡同时暴露浏览器授权和 API Key", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`;
  const source = await readFile(path, "utf8");
  const result = patchWindsurfSettingsSource(source);
  assert.match(result, /Windsurf \/ Devin 订阅/);
  assert.match(result, /windsurfRequest\("login", "POST"/);
  assert.match(result, /windsurfRequest\("api-key", "POST"/);
  assert.match(result, /authenticationMode: "manual_api_key"/);
  assert.match(result, /WindsurfAuthCard/);
});

test("Windsurf 设置页结构变化时停止构建", () => {
  assert.throws(() => patchWindsurfSettingsSource("const unrelated = true;"), /结构不一致/);
});

test("账户使用面板只显示可靠余额或连接状态", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`;
  const source = await readFile(path, "utf8");
  const result = patchAccountUsageSettingsSource(patchWindsurfSettingsSource(source));
  assert.match(result, /data-account-usage-panel/);
  assert.match(result, /DeepSeek API/);
  assert.match(result, /window\.remainingPercent/);
  assert.match(result, /额外用量余额/);
  assert.match(result, /本次接口未返回可用数据/);
  assert.match(result, /\/account-usage\//);
  assert.match(result, /AccountUsagePanel/);
  // 缺字段只能是「未知」，不能落到 0%；百分比一律由 remainingPercent 现算。
  assert.match(result, /accountUsagePercentText/);
  assert.doesNotMatch(result, /剩余\s*\d+%/);
});

test("账户使用面板结构变化时停止构建", () => {
  assert.throws(() => patchAccountUsageSettingsSource("const unrelated = true;"), /结构不一致/);
});

test("真实模型选择界面归并模型、推理强度、速度与上下文窗口，且不再伪造 Default", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js`;
  const source = await readFile(path, "utf8");
  const result = patchModelSelectionUxSource(source);
  assert.match(result, /stardustFacetGroups/);
  assert.match(result, /menu\.speed/);
  assert.match(result, /menu\.context/);
  assert.match(result, /stardustFamilyContexts/);
  assert.match(result, /encodedParameters/);
  assert.match(result, /正在切换模型/);
  assert.doesNotMatch(result, /effort\.providerDefault/);
  assert.doesNotMatch(result, /children: state\.groups\.map/);
  assert.doesNotMatch(result, /setOpen\(true\);\s*reload\(\);/);
  assert.match(result, /const previous = this\.store\.getSnapshot\(\);/);
  assert.match(result, /s\.current = \{\s*provider: selection\.provider/);
  assert.match(result, /s\.routable = false;\s*s\.status = "selecting"/);
  assert.match(result, /const \[draftSelection, setDraftSelection\]/);
  assert.match(result, /onClick: \(\) => submit\(draftSelection\)/);
  assert.match(result, /children: busy \? "应用中…" : "应用"/);
});

test("模型选择界面结构变化时停止构建", () => {
  assert.throws(() => patchModelSelectionUxSource("const unrelated = true;"), /结构不一致/);
});

test("真实对话界面渲染思考 Markdown、持续时间与稳定语义属性", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`;
  const source = await readFile(path, "utf8");
  const result = patchConversationUiSource(source);
  assert.match(result, /data-chat-semantic-kind/);
  assert.match(result, /function ActivityDuration/);
  assert.match(result, /data-activity-duration/);
  assert.match(result, /showReasoningDuration = presentationBlocks\.length === 1/);
  assert.match(result, /showDuration \? \(0, react_jsx_runtime\.jsx\)\(ActivityDuration/);
  assert.match(result, /"data-chat-semantic-kind": "think"/);
  assert.match(result, /title: "思考"/);
  assert.match(result, /function mergeAdjacentReasoningBlocks/);
  assert.match(result, /const presentationBlocks = mergeAdjacentReasoningBlocks\(blocks\)/);
  assert.match(result, /text: summary,[\s\S]*?streaming: running,[\s\S]*?fileMentions: mentions/);
  assert.match(result, /jsx\)\("div", \{[\s\S]*?ref: summaryRef,[\s\S]*?MarkdownText/);
  assert.match(result, /children: \(0, react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.MarkdownText/);
  assert.doesNotMatch(result, /cleanReasoningSummary/);
  assert.match(result, /startTime: context\.start\?\.event\.time/);
  assert.match(result, /activityLabel: match\.event\.data\.activityLabel/);
  assert.match(result, /activityLabel: previous\.activityLabel/);
  assert.match(result, /activityLabel: block\.activityLabel/);
  assert.match(result, /source\.form === "cleared"/);
  assert.match(result, /source: o\.source/);
  assert.match(result, /"data-reference-source": chip\.source/);
  assert.match(result, /chip\.source === "conversation"/);
  assert.match(result, /data-conversation-chip-icon/);
  const syntaxRoot = await mkdtemp(join(tmpdir(), "dsh-reasoning-ui-"));
  try {
    const syntaxPath = join(syntaxRoot, "client.mjs");
    await writeFile(syntaxPath, result, "utf8");
    await execFileAsync(process.execPath, ["--check", syntaxPath]);
  } finally {
    await rm(syntaxRoot, { recursive: true, force: true });
  }
});

test("对话展示结构变化时停止 Markdown 与计时补丁", () => {
  assert.throws(() => patchConversationActivityPresentationSource("const unrelated = true;"), /结构不一致/);
});

test("仅合并真正相邻的思考块并保留所有展示边界", () => {
  const blocks = [
    { kind: "reasoning", text: "**第一段**" },
    { kind: "reasoning", text: "第二段 $x^2$" },
    { kind: "tool-call", callId: "call-1", name: "read", argsRaw: "{}" },
    { kind: "reasoning", text: "工具后" },
    { kind: "user-status", text: "状态边界" },
    { kind: "reasoning", text: "状态后" },
    { kind: "text", text: "最终消息" },
    { kind: "reasoning", text: "末段一" },
    { kind: "reasoning", text: "末段二" },
  ];
  const groups = mergeAdjacentReasoningBlocks(blocks);
  assert.deepEqual(groups.map(({ block, startIndex, endIndex }) => ({
    kind: block.kind,
    text: block.text,
    startIndex,
    endIndex,
  })), [
    { kind: "reasoning", text: "**第一段**\n\n第二段 $x^2$", startIndex: 0, endIndex: 1 },
    { kind: "tool-call", text: undefined, startIndex: 2, endIndex: 2 },
    { kind: "reasoning", text: "工具后", startIndex: 3, endIndex: 3 },
    { kind: "user-status", text: "状态边界", startIndex: 4, endIndex: 4 },
    { kind: "reasoning", text: "状态后", startIndex: 5, endIndex: 5 },
    { kind: "text", text: "最终消息", startIndex: 6, endIndex: 6 },
    { kind: "reasoning", text: "末段一\n\n末段二", startIndex: 7, endIndex: 8 },
  ]);
  assert.equal(blocks[0].text, "**第一段**");
  assert.equal(blocks[1].text, "第二段 $x^2$");
});

test("真实工具界面为运行中和已完成调用展示持续时间", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js`;
  const source = await readFile(path, "utf8");
  const result = patchToolActivityPresentationSource(source);
  assert.match(result, /function ToolActivityDuration/);
  assert.match(result, /data-tool-activity-duration/);
  assert.match(result, /block\.callTime/);
  assert.match(result, /durationUnknown \? "耗时未知"/);
  assert.match(result, /formatToolDuration/);
  assert.match(result, /gridTemplateColumns: "minmax\(0, 1fr\) auto"/);
  assert.match(result, /gridColumn: "1 \/ -1"/);
  assert.doesNotMatch(result, /position: "absolute", top: 4, right: 8/);
});

test("工具展示结构变化时停止计时补丁", () => {
  assert.throws(() => patchToolActivityPresentationSource("const unrelated = true;"), /结构不一致/);
});

test("真实模型切换后端只对不支持图片的模型扫描历史，并异步保存默认值", { skip: !releaseRoot }, async () => {
  for (const relative of ["lib/index.js", "lib/types/api-proxy.js"]) {
    const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-host-apiproxy/${relative}`;
    const source = await readFile(path, "utf8");
    const result = patchHostModelSelectionSource(source);
    assert.ok(result.indexOf("resolveModelInfo(resolved.provider, resolved.model)") < result.indexOf("session.deriveMessages()"));
    assert.match(
      result,
      /acceptsImages|info\.inputModalities !== void 0 && !info\.inputModalities\.includes\("image"\)/,
    );
    assert.match(result, /requestContext/);
    assert.match(result, /const durable = agent\.session\.requestContext/);
    assert.match(result, /durable\?\.provider \?\? logged\?\.provider/);
    assert.match(result, /reasoningEffort: selected\.reasoningEffort/);
    assert.match(result, /previousContext\.reasoningEffort !== requestContext\.reasoningEffort/);
    assert.match(result, /contextWindow: info\.context\.contextWindow/);
    assert.doesNotMatch(result, /contextWindow: info\.contextWindow/);
    assert.match(result, /session\.append\((?:"request\/context"|'request\/context'), requestContext\)/);
    assert.match(result, /void Promise\.resolve\(defaults\.saveDefaultModelSelection/);
    assert.doesNotMatch(result, /await defaults\.saveDefaultModelSelection/);
    assert.match(result, /pendingSelection/);
    assert.match(result, /selectionState\.pending/);
    assert.match(result, /await selectionState\.pending/);
  }
});

test("模型切换后端结构变化时停止构建", () => {
  assert.throws(() => patchHostModelSelectionSource("const unrelated = true;"), /结构不一致/);
});

test("真实 Agent 组装暴露当前模型思考强度变量", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-agent/lib/index.js`;
  const source = await readFile(path, "utf8");
  const result = patchAgentModelSelectionPromptSource(source);
  assert.match(result, /reasoning_effort: selected\.reasoningEffort \?\? ""/);
  assert.ok(result.indexOf("_assembly.variables =") < result.indexOf("const assembled = await next()"));
});

test("Agent 模型变量结构变化时停止构建", () => {
  assert.throws(() => patchAgentModelSelectionPromptSource("const unrelated = true;"), /结构不一致/);
});

test("真实 0.1.0-rc.6 工作区规则源码可被完整且唯一地转换", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js`;
  const source = await readFile(path, "utf8");
  const result = patchAgentInstructionsSource(source);
  assert.match(result, /DSH_IGNORE_MARKER/);
  assert.match(result, /工作区规则已更新/);
  assert.match(result, /工作区规则预算/);
  assert.doesNotMatch(result, /The following workspace instructions/);
});

test("上游结构变化时拒绝产生半转换文件", () => {
  assert.throws(() => patchAgentInstructionsSource("const unrelated = true;"), /结构不一致/);
});

test("真实 MCP client 把图片变成附件、把音频和资源保存为 artifact", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`;
  const source = await readFile(path, "utf8");
  const result = patchMcpClientMultimodalSource(source);
  assert.match(result, /ctx\.root\.tools\.register\(definition\)/);
  assert.doesNotMatch(result, /ctx\.tools\.register\(definition\)/);
  assert.match(result, /prepareMcpContent/);
  assert.match(result, /type: "image", attachment: block\.attachment/);
  assert.match(result, /mcp-artifacts/);
  assert.doesNotMatch(result, /content discarded/);
});

test("MCP client 上游结构变化时停止多媒体补丁", () => {
  assert.throws(() => patchMcpClientMultimodalSource("const unrelated = true;"), /结构不一致/);
});

test("真实 pi-ai 适配器按账号目录暴露推理档位与受支持的 Fast 模型", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`;
  const source = await readFile(path, "utf8");
  const result = patchPiAiFastModelsSource(source);
  assert.match(result, /FAST_MODEL_PREFIX/);
  assert.match(result, /loadOpenAICodexCatalog/);
  assert.match(result, /createWindsurfPiProvider/);
  assert.match(result, /provider === "windsurf"/);
  assert.match(result, /refreshDynamicModels/);
  assert.match(result, /stardustReasoningEfforts/);
  assert.match(result, /stardustVariantEffort/);
  assert.match(result, /supportsFastModel/);
  assert.match(result, /name: `\$\{entry\.name\} · Fast`/);
  assert.match(result, /serviceTier: "priority"/);
  assert.match(result, /replayModelMatches/);
  assert.match(result, /source\.model\.startsWith\("fast::"\)/);
  assert.match(result, /requestOptionsForModel/);
  assert.match(result, /isVisionTool/);
  assert.match(result, /tool\?\.name === "read_image"/);
  assert.match(result, /tool\?\.name === "view_image"/);
  assert.match(result, /tool\?\.name === "inspect_image"/);
  assert.match(result, /const requestOptions = requestOptionsForModel\(options, model\)/);
  assert.match(result, /toPiContext\(requestOptions\)/);
  assert.match(result, /event\.error\.usage !== void 0/);
  assert.doesNotMatch(result, /async resolveModel\(provider, model, signal\)[\s\S]*?await refreshDynamicModels\(snapshot, provider, signal\)/);
 });

test("真实候选 pi-ai request 选项按模型输入能力过滤视觉工具", { skip: !candidateRoot }, async () => {
  const path = join(candidateRoot, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");
  const source = await readFile(path, "utf8");
  const requestOptionsForModel = extractFunction(source, "requestOptionsForModel");
  const definitions = [
    { name: "read_image", inputModalities: ["image"] },
    { name: "view_image" },
    { name: "inspect_image", requiresVision: true },
    { name: "read_file" },
  ];
  const options = {
    system: "系统头",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: definitions,
  };
  const textResult = requestOptionsForModel(options, { id: "GLM-5.2", input: ["text"] });
  assert.deepEqual(textResult.tools.map((tool) => tool.name), ["read_file"]);
  assert.match(textResult.system, /视觉工具未向本次请求暴露/);
  const visionResult = requestOptionsForModel(options, { id: "vision-model", input: ["text", "image"] });
  assert.equal(visionResult, options);
  assert.deepEqual(visionResult.tools, definitions);
});

test("Fast 重放只接受同提供方的 fast 别名与基础模型，不放宽其它模型", () => {
  const replayModelMatches = (state, source) => state.model === source.model
    || source.provider === "openai-codex"
      && source.model.startsWith("fast::")
      && state.model === source.model.slice("fast::".length);
  assert.equal(replayModelMatches(
    { model: "gpt-5.6-sol" },
    { provider: "openai-codex", model: "fast::gpt-5.6-sol" },
  ), true);
  assert.equal(replayModelMatches(
    { model: "gpt-5.6-sol" },
    { provider: "openai-codex", model: "gpt-5.6-sol" },
  ), true);
  assert.equal(replayModelMatches(
    { model: "gpt-5.6-terra" },
    { provider: "openai-codex", model: "fast::gpt-5.6-sol" },
  ), false);
  assert.equal(replayModelMatches(
    { model: "gpt-5.6-sol" },
    { provider: "windsurf", model: "fast::gpt-5.6-sol" },
  ), false);
});

test("pi-ai 上游结构变化时停止 Fast 模型补丁", () => {
  assert.throws(() => patchPiAiFastModelsSource("const unrelated = true;"), /结构不一致/);
});

test("Code Mode SDK 不暴露无法编码为 JSON 的 read_image", () => {
  const fixture = '.filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {';
  const result = patchToolsReadImageSdkSource(fixture);
  assert.match(result, /definition\.name !== "read_image"/);
  assert.throws(() => patchToolsReadImageSdkSource("const unrelated = true;"), /结构不一致/);
});

test("真实 pi-ai 简化流会把 Fast service tier 转给完整流", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js`;
  const source = await readFile(path, "utf8");
  const result = patchPiAiSimpleOptionsServiceTierSource(source);
  assert.match(result, /serviceTier: options\?\.serviceTier/);
});

test("pi-ai 简化流结构变化时停止 Fast 转发补丁", () => {
  assert.throws(() => patchPiAiSimpleOptionsServiceTierSource("export const unrelated = true;"), /结构不一致/);
});

test("Headless 在请求进程退出前等待本轮 Agent 完整关闭", () => {
  const fixture = `const internals = {
\tstdout: process.stdout,
\tstderr: process.stderr
};
const { agent } = await agents.create({
\tsetup: true
});
const outcome = summarize(agent.session.events, firstSeq);
\tio.stdout.write(outcome.text + "\\n");
const io = {
\t\tstdout: internals.stdout,
\t\tstderr: internals.stderr,
\t\texit
\t};`;
  const result = patchHeadlessShutdownSource(fixture);
  assert.match(result, /const \{ agent, dispose \}/);
  assert.match(result, /await dispose\(\);\n\s*io\.stdout\.write/);
  assert.match(result, /forceExit: \(code\) => process\.exit\(code\)/);
  assert.match(result, /setTimeout\(\(\) => internals\.forceExit\(code\), 6e3\)/);
  assert.match(result, /fallback\.unref\(\)/);
});

test("真实 Headless runner 可插入有序关闭且结构变化时停止构建", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-headless/lib/index.js`;
  const source = await readFile(path, "utf8");
  const result = patchHeadlessShutdownSource(source);
  assert.match(result, /const \{ agent, dispose \} = await agents\.create/);
  assert.match(result, /await dispose\(\);\n\s*io\.stdout\.write/);
  assert.match(result, /internals\.forceExit\(code\)/);
  assert.throws(() => patchHeadlessShutdownSource("const unrelated = true;"), /结构不一致/);
});

test("Headless 只停用无界面用途的额外标题模型请求", () => {
  const fixture = "- id: hmr\n  disabled: true\n";
  const result = patchHeadlessBundleSource(fixture);
  assert.match(result, /id: session-title-llm\n\s+disabled: true/);
  assert.match(result, /仍保留 session-title 服务生成的本地首句回退标题/);
});

test("真实 Headless 组合可停用额外标题请求", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml`;
  const source = await readFile(path, "utf8");
  const result = patchHeadlessBundleSource(source);
  assert.match(result, /id: session-title-llm\n\s+disabled: true/);
  assert.throws(() => patchHeadlessBundleSource("- id: unrelated\n"), /结构不一致/);
});

test("真实上下文圆环面板显示 68/90 双阈值与近期原文目标", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`;
  const source = await readFile(path, "utf8");
  const result = patchContextMeterThresholdsSource(source);
  assert.match(result, /BPC_THRESHOLD_PERCENT = 68/);
  assert.match(result, /HARD_COMPACTION_THRESHOLD_PERCENT = 90/);
  assert.match(result, /RECENT_RAW_TARGET_PERCENT = 16/);
  assert.match(result, /BPC 预压缩阈值/);
  assert.match(result, /近期原文保留目标/);
  assert.match(result, /后台预压缩区间/);
  assert.match(result, /estimatedTokens/);
  assert.match(result, /contextOccupancy\(pressure, breakdown\)/);
});

test("上下文圆环面板上游结构变化时停止构建", () => {
  assert.throws(() => patchContextMeterThresholdsSource("export const unrelated = true;"), /结构不一致/);
});
