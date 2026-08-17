import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidatesRoot = resolve(workspaceRoot, "release", "candidates");

function parseArguments(argv) {
  const candidateIndex = argv.indexOf("--candidate");
  if (candidateIndex < 0 || !argv[candidateIndex + 1]) throw new Error("必须传 --candidate <候选目录名>");
  const name = argv[candidateIndex + 1];
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    throw new Error("--candidate 只能是 release/candidates 下的目录名");
  }
  return resolve(candidatesRoot, name);
}

function assertChildPath(parent, child) {
  const relativePath = relative(parent, child);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`候选目录必须位于 ${parent} 内部`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex").toUpperCase();
}

async function assertHash(path, expected, label) {
  const actual = await sha256(path);
  if (actual !== expected) throw new Error(`${label} 哈希不一致：${path}\n期望 ${expected}\n实际 ${actual}`);
}

async function verifyCandidate(candidate) {
  assertChildPath(candidatesRoot, candidate);
  const candidateInfo = await stat(candidate).catch(() => undefined);
  if (!candidateInfo?.isDirectory()) throw new Error(`候选目录不存在：${candidate}`);
  for (const forbidden of [".dsh", "state", "logs", "backups"]) {
    if (await stat(join(candidate, forbidden)).catch(() => undefined)) {
      throw new Error(`候选目录不应包含私有运行目录：${forbidden}`);
    }
  }

  const manifestPath = join(candidate, "stardust", "candidate-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error(`不支持的候选清单版本：${manifest.schemaVersion}`);
  if (manifest.candidateName !== basename(candidate)) throw new Error("候选目录名与清单不一致");
  if (manifest.productionActivated !== false) throw new Error("候选清单错误地声称已经激活生产");
  if (manifest.experimentalFeaturesEnabled !== true) throw new Error("Stage 6 候选必须显式登记上下文 Provider 已启用");

  const source = resolve(manifest.sourceRelease);
  for (const file of manifest.changedFiles) {
    await assertHash(join(source, file.path), file.beforeSha256, "基础 release 文件");
    await assertHash(join(candidate, file.path), file.afterSha256, "候选修改文件");
  }
  for (const file of manifest.generatedFiles) {
    await assertHash(join(candidate, file.path), file.sha256, "候选生成文件");
  }
  const syntaxTargets = [...new Set([
    ...manifest.changedFiles.map(file => file.path),
    ...manifest.generatedFiles.map(file => file.path),
  ].filter(file => /\.(?:c|m)?js$/u.test(file)))].sort();
  for (const relativePath of syntaxTargets) {
    const checked = spawnSync(process.execPath, ["--check", join(candidate, relativePath)], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (checked.status !== 0) {
      throw new Error(`候选 JavaScript 语法检查失败：${relativePath}\n${checked.stderr || checked.stdout}`);
    }
  }
  for (const relativePath of [
    "node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml",
    "node_modules/@deepseek-ai/dsh/config/agent-presets/standard/preset.yml",
  ]) {
    const sourceHash = await sha256(join(source, relativePath));
    const candidateHash = await sha256(join(candidate, relativePath));
    if (sourceHash !== candidateHash) throw new Error(`官方标准模式被候选改写：${relativePath}`);
  }

  const customAgentPath = join(candidate, "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets", "stardust-main", "agent.cordis.yml");
  const customAgent = await readFile(customAgentPath, "utf8");
  if (!customAgent.includes("mode: both")
    || !customAgent.includes("@stardust/dsh-zh-prompt-suite")
    || !customAgent.includes("@stardust/dsh-thread-tools")
    || !customAgent.includes("@stardust/dsh-tool-apply-patch")
    || !customAgent.includes("@dsh-experimental/context-generation-state-machine/compaction-provider")
    || customAgent.includes("name: '@deepseek-ai/dsh-compaction-basic'")
    || customAgent.includes("@deepseek-ai/dsh-mcp-client")
    || !customAgent.includes("persistLedgerEvents: false")) {
    throw new Error("主力模式缺少 both、中文提示插件、apply_patch、安全线程工具，或仍在会话层重复挂载 MCP");
  }

  const basePatchPath = join(candidate, "node_modules", "@deepseek-ai", "dsh-base", "cordis.patch.yml");
  const basePatch = await readFile(basePatchPath, "utf8");
  const expectedMcpServers = ["sandbox", "memory-store", "web-fetcher", "exa", "sequential-thinking"];
  if (basePatch.includes("name: '@deepseek-ai/dsh-mcp-client'")
    || expectedMcpServers.some((serverName) => basePatch.includes(`serverName: ${serverName}`))) {
    throw new Error("候选基础包不应重复挂载由 Web profile 管理的共享 MCP 客户端");
  }

  const presetRuntimePaths = [
    join(candidate, "node_modules", "@deepseek-ai", "dsh-agent-presets", "lib", "index.js"),
    join(candidate, "node_modules", "@deepseek-ai", "dsh-agent-presets", "lib", "invariant.js"),
    join(candidate, "node_modules", "@deepseek-ai", "dsh-agent-presets", "lib", "types", "mount.js"),
  ];
  const mcpClientPath = join(candidate, "node_modules", "@deepseek-ai", "dsh-mcp-client", "lib", "index.js");
  const mcpClient = await readFile(mcpClientPath, "utf8");
  if (!mcpClient.includes("prepareMcpContent")
    || !mcpClient.includes('type: "image", attachment: block.attachment')
    || !mcpClient.includes("mcp-artifacts")
    || !mcpClient.includes("ctx.root.tools.register(definition)")
    || mcpClient.includes("ctx.tools.register(definition)")
    || mcpClient.includes("content discarded")) {
    throw new Error("MCP client 尚未注册到宿主根工具表，或未实现图片附件与音频/资源 artifact 保留");
  }
  const piAiAdapterPath = join(candidate, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");
  const piAiAdapter = await readFile(piAiAdapterPath, "utf8");
  if (!piAiAdapter.includes("FAST_MODEL_PREFIX")
    || !piAiAdapter.includes("loadOpenAICodexCatalog")
    || !piAiAdapter.includes("createWindsurfPiProvider")
    || !piAiAdapter.includes('provider === "windsurf"')
    || !piAiAdapter.includes("refreshDynamicModels")
    || !piAiAdapter.includes("supportsFastModel")
    || !piAiAdapter.includes("stardustReasoningEfforts")
    || !piAiAdapter.includes('serviceTier: "priority"')
    || !piAiAdapter.includes("· Fast")) {
    throw new Error("OpenAI Codex 动态能力目录、Fast 过滤或 priority 请求接线缺失");
  }
  const resolveModelSection = piAiAdapter.slice(
    piAiAdapter.indexOf("async resolveModel(provider, model"),
    piAiAdapter.indexOf("async *stream(options)"),
  );
  if (resolveModelSection.includes("refreshDynamicModels")) {
    throw new Error("模型切换仍会在 resolveModel 阶段重复联网刷新目录");
  }
  const modelSelectionUiPath = join(candidate, "node_modules", "@deepseek-ai", "dsh-client-ui-model-selection", "lib", "client.js");
  const modelSelectionUi = await readFile(modelSelectionUiPath, "utf8");
  if (!modelSelectionUi.includes("stardustFacetGroups")
    || !modelSelectionUi.includes('"menu.speed": "速度"')
    || !modelSelectionUi.includes("正在切换模型…")
    || modelSelectionUi.includes("effort.providerDefault")
    || modelSelectionUi.includes("setOpen(true);\n\t\t\t\treload();")) {
    throw new Error("模型选择界面尚未完成模型、推理强度、速度三层归并，或仍伪造 Default/重复刷新");
  }
  for (const relativePath of ["lib/index.js", "lib/types/api-proxy.js"]) {
    const hostApiProxy = await readFile(join(candidate, "node_modules", "@deepseek-ai", "dsh-host-apiproxy", relativePath), "utf8");
    const selectModelSection = hostApiProxy.slice(hostApiProxy.indexOf("async selectModel(request)"), hostApiProxy.indexOf("async rename(request)"));
    if (!selectModelSection.includes("void Promise.resolve(defaults.saveDefaultModelSelection")
      || selectModelSection.indexOf("resolveModelInfo(resolved.provider, resolved.model)") > selectModelSection.indexOf("session.deriveMessages()")) {
      throw new Error(`模型切换后端 ${relativePath} 仍会无条件扫描长会话或同步等待默认值写盘`);
    }
  }
  const contextMeterPath = join(
    candidate,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-conversation",
    "lib",
    "client.js",
  );
  const headlessRunnerPath = join(candidate, "node_modules", "@deepseek-ai", "dsh-headless", "lib", "index.js");
  const headlessRunner = await readFile(headlessRunnerPath, "utf8");
  if (!headlessRunner.includes("const { agent, dispose } = await agents.create")
    || !headlessRunner.includes("await dispose();\n\tio.stdout.write")
    || !headlessRunner.includes("setTimeout(() => internals.forceExit(code), 6e3)")
    || !headlessRunner.includes("fallback.unref()")) {
    throw new Error("Headless runner 尚未在退出前等待 Agent 完整关闭");
  }
  const headlessBundlePath = join(candidate, "node_modules", "@deepseek-ai", "dsh-headless", "cordis.patch.yml");
  const headlessBundle = await readFile(headlessBundlePath, "utf8");
  if (!headlessBundle.includes("- id: session-title-llm\n  disabled: true")) {
    throw new Error("Headless 组合尚未停用无界面用途的额外标题模型请求");
  }
  const contextMeter = await readFile(contextMeterPath, "utf8");
  if (!contextMeter.includes("BPC_THRESHOLD_PERCENT = 68")
    || !contextMeter.includes("HARD_COMPACTION_THRESHOLD_PERCENT = 90")
    || !contextMeter.includes("RECENT_RAW_TARGET_PERCENT = 16")
    || !contextMeter.includes("BPC 预压缩阈值")
    || !contextMeter.includes("近期原文保留目标")
    || !contextMeter.includes("后台预压缩区间")) {
    throw new Error("真实上下文用量弹窗尚未展示双压缩阈值与近期原文目标");
  }
  if (!contextMeter.includes("data-chat-semantic-kind")
    || !contextMeter.includes("function ActivityDuration")
    || !contextMeter.includes("data-activity-duration")
    || !contextMeter.includes('title: "思考"')
    || !contextMeter.includes("mergeAdjacentReasoningBlocks")
    || !contextMeter.includes("_deepseek_ai_dsh_client_ui_primitives.MarkdownText")) {
    throw new Error("对话界面尚未修复思考 Markdown/KaTeX、持续时间或稳定展示语义");
  }
  const toolUi = await readFile(join(candidate, "node_modules", "@deepseek-ai", "dsh-client-ui-tool", "lib", "client.js"), "utf8");
  if (!toolUi.includes("function ToolActivityDuration")
    || !toolUi.includes("data-tool-activity-duration")
    || !toolUi.includes("block.callTime")
    || !toolUi.includes("formatToolDuration")) {
    throw new Error("工具调用界面尚未展示运行中与已完成持续时间");
  }
  const jobsTool = await readFile(join(candidate, "node_modules", "@deepseek-ai", "dsh-tool-jobs", "lib", "index.js"), "utf8");
  if (!jobsTool.includes("deferredCompletions")
    || !jobsTool.includes("flushDeferredCompletions")
    || !jobsTool.includes('ctx.on("agent/status"')
    || jobsTool.includes("owner.inject(message);")) {
    throw new Error("Jobs 完成通知仍会在忙碌或唤醒额度耗尽时静默注入，而非可靠延迟投递");
  }
  const jobsLocal = await readFile(join(candidate, "node_modules", "@deepseek-ai", "dsh-jobs-local", "lib", "index.js"), "utf8");
  if (!jobsLocal.includes("teardownCancelTimeoutMs")
    || !jobsLocal.includes("awaitTeardownSettlement")
    || !jobsLocal.includes("record forced failed so teardown can continue")) {
    throw new Error("Jobs 本地注册表缺少非合作取消的有界关闭保护");
  }
  const candidatePackage = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
  if (candidatePackage.dependencies?.["@deepseek-harness/experimental-windsurf-provider"] !== "0.0.0-candidate"
    || candidatePackage.dependencies?.["opencode-windsurf-auth"] !== "0.3.2") {
    throw new Error("候选版根依赖未登记 Windsurf Provider 或真实协议包");
  }
  const webAppPackage = JSON.parse(await readFile(join(candidate, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"), "utf8"));
  const webAppPatch = await readFile(join(candidate, "node_modules", "@deepseek-ai", "dsh-web-app", "cordis.patch.yml"), "utf8");
  if (webAppPackage.dependencies?.["@deepseek-harness/experimental-windsurf-provider"] !== "0.0.0-candidate"
    || !webAppPatch.includes("- id: windsurf-auth")
    || !webAppPatch.includes("name: '@deepseek-harness/experimental-windsurf-provider'")) {
    throw new Error("DSH Web 组合没有加载 Windsurf 独立授权插件");
  }
  const settingsModelsUiPath = join(candidate, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models", "lib", "client.js");
  const settingsModelsUi = await readFile(settingsModelsUiPath, "utf8");
  if (!settingsModelsUi.includes("Windsurf / Devin 订阅")
    || !settingsModelsUi.includes('windsurfRequest("login", "POST"')
    || !settingsModelsUi.includes('windsurfRequest("api-key", "POST"')
    || !settingsModelsUi.includes('authenticationMode: "manual_api_key"')
    || !settingsModelsUi.includes("WindsurfAuthCard")) {
    throw new Error("模型设置页没有完整暴露 Windsurf 浏览器授权、API Key 与认证方式切换");
  }
  const windsurfPackageRoot = join(candidate, "node_modules", "@deepseek-harness", "experimental-windsurf-provider");
  const windsurfPlugin = await import(pathToFileURL(join(windsurfPackageRoot, "src", "plugin.js")));
  const windsurfPiProviderModule = await import(pathToFileURL(join(windsurfPackageRoot, "src", "pi-provider.js")));
  if (windsurfPlugin.name !== "windsurf-auth"
    || typeof windsurfPlugin.apply !== "function"
    || windsurfPiProviderModule.createWindsurfPiProvider().id !== "windsurf") {
    throw new Error("Windsurf Provider 没有导出有效的 Cordis 插件或 Pi Provider");
  }
  const windsurfUpstream = await import(pathToFileURL(join(windsurfPackageRoot, "src", "upstream.js")));
  const upstream = await windsurfUpstream.loadWindsurfUpstream();
  if (typeof upstream.streamChatEvents !== "function"
    || typeof upstream.getCachedUserJwt !== "function"
    || typeof upstream.registerUser !== "function") {
    throw new Error("Windsurf Provider 没有接到真实云流、JWT 与 RegisterUser 实现");
  }
  const codexCatalogPath = join(candidate, "node_modules", "@stardust", "dsh-openai-codex-oauth", "lib", "catalog.js");
  const codexCatalog = await readFile(codexCatalogPath, "utf8");
  if (!codexCatalog.includes("backend-api/codex/models?client_version=")
    || !codexCatalog.includes("chatgpt-account-id")
    || !codexCatalog.includes("if-none-match")
    || !codexCatalog.includes("serviceTiers")
    || !codexCatalog.includes("stardustReasoningEfforts")) {
    throw new Error("OpenAI Codex 动态模型目录缺少账号、ETag 或能力映射");
  }
  const piAiSimpleOptionsPath = join(candidate, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "simple-options.js");
  const piAiSimpleOptions = await readFile(piAiSimpleOptionsPath, "utf8");
  if (!piAiSimpleOptions.includes("serviceTier: options?.serviceTier")) {
    throw new Error("pi-ai streamSimple 仍会丢失 Fast service tier");
  }
  for (const path of presetRuntimePaths) {
    const sourceText = await readFile(path, "utf8");
    if (!sourceText.includes("const base = import.meta.url;")
      || sourceText.includes("const base = harnessBase.get(this.config);")) {
      throw new Error(`Agent Preset 仍会从用户 profile 解析裸包：${path}`);
    }
  }
  const releaseRequire = createRequire(pathToFileURL(presetRuntimePaths[0]));
  for (const packageName of [
    "@stardust/dsh-zh-prompt-suite",
    "@stardust/dsh-thread-tools",
    "@stardust/dsh-tool-apply-patch",
    "@stardust/dsh-message-branch",
    "@stardust/dsh-turn-presentation",
  ]) {
    const resolvedPath = releaseRequire.resolve(packageName);
    const relativeResolvedPath = relative(candidate, resolvedPath);
    if (relativeResolvedPath === ".."
      || relativeResolvedPath.startsWith(`..${sep}`)
      || isAbsolute(relativeResolvedPath)) {
      throw new Error(`Agent Preset 插件解析越过候选 release：${packageName} -> ${resolvedPath}`);
    }
  }
  const messageBranchEntry = join(candidate, "node_modules", "@stardust", "dsh-message-branch", "lib", "index.js");
  const messageBranch = await import(pathToFileURL(messageBranchEntry));
  if (messageBranch.name !== "stardust-message-branch"
    || typeof messageBranch.apply !== "function"
    || typeof messageBranch.createMessageBranchRoutes !== "function") {
    throw new Error("消息修改重发插件没有导出有效的 Cordis 与本地 HTTP 入口");
  }
  const messageBranchWebAppPatch = await readFile(join(candidate, "node_modules", "@deepseek-ai", "dsh-web-app", "cordis.patch.yml"), "utf8");
  if (!messageBranchWebAppPatch.includes("name: '@stardust/dsh-message-branch'")
    || !messageBranchWebAppPatch.includes("dshHomePath('message-branches')")) {
    throw new Error("Web App 没有挂载消息修改重发插件或独立 sidecar 目录");
  }
  const turnPresentationEntry = join(candidate, "node_modules", "@stardust", "dsh-turn-presentation", "lib", "index.js");
  const turnPresentation = await import(pathToFileURL(turnPresentationEntry));
  if (turnPresentation.name !== "stardust-turn-presentation"
    || typeof turnPresentation.apply !== "function"
    || turnPresentation.turnPresentationProjectionDefinition?.key !== "turnPresentation") {
    throw new Error("轮级展示投影插件没有导出有效的 Cordis 入口与 turnPresentation 定义");
  }
  const promptSuiteEntry = join(candidate, "node_modules", "@stardust", "dsh-zh-prompt-suite", "lib", "index.js");
  const promptSuiteSource = await readFile(promptSuiteEntry, "utf8");
  const promptSuite = await import(pathToFileURL(promptSuiteEntry));
  if (promptSuite.name !== "zh-prompt-suite" || typeof promptSuite.apply !== "function") {
    throw new Error("中文提示插件没有导出有效的 Cordis apply 入口");
  }
  if (promptSuiteSource.includes("{{model}} 驱动")
    || !promptSuiteSource.includes("stardust:runtime-identity")
    || !promptSuiteSource.includes("当前 DSH 对话编号")) {
    throw new Error("中文提示插件没有把稳定人格与每步动态会话/模型状态正确分离");
  }
  const defaultPersonaPath = join(candidate, "node_modules", "@stardust", "dsh-zh-prompt-suite", "defaults", "00-persona.md");
  const defaultPersona = await readFile(defaultPersonaPath, "utf8");
  if (!defaultPersona.includes("你是可爱的猫娘助手") || !defaultPersona.includes("颜文字是默认基线")) {
    throw new Error("候选没有携带首次启动需要安装的中文猫娘人格 Rules");
  }

  const applyPatchEntry = join(candidate, "node_modules", "@stardust", "dsh-tool-apply-patch", "lib", "index.js");
  const applyPatch = await import(pathToFileURL(applyPatchEntry));
  if (applyPatch.name !== "stardust-apply-patch"
    || typeof applyPatch.apply !== "function"
    || typeof applyPatch.parsePatch !== "function") {
    throw new Error("apply_patch 插件没有导出有效的 Cordis apply 或补丁解析入口");
  }
  let registeredApplyPatch;
  const disposeApplyPatch = await applyPatch.apply({
    systemPrompt: { section() {} },
    on() { return () => {}; },
    tools: {
      guard() { return () => {}; },
      register(tool) {
        registeredApplyPatch = tool;
        return () => {};
      },
    },
  });
  if (registeredApplyPatch?.name !== "apply_patch") {
    throw new Error("apply_patch 插件无法通过候选内 DSH Schema 校验并注册");
  }
  await disposeApplyPatch();

  const threadToolsEntry = join(candidate, "node_modules", "@stardust", "dsh-thread-tools", "lib", "index.js");
  const threadTools = await import(pathToFileURL(threadToolsEntry));
  const threadToolsSource = await readFile(threadToolsEntry, "utf8");
  const sidecarAdapterPath = join(candidate, "node_modules", "@stardust", "dsh-thread-tools", "lib", "sidecar-adapter.js");
  const sidecarLedgerPath = join(candidate, "node_modules", "@stardust", "dsh-thread-tools", "lib", "sidecar-ledger.js");
  if (threadTools.name !== "stardust-thread-tools"
    || typeof threadTools.apply !== "function"
    || typeof threadTools.SidecarThreadLedgerAdapter !== "function"
    || typeof threadTools.SidecarThreadLedger !== "function"
    || !threadToolsSource.includes("new SidecarThreadLedgerAdapter")
    || threadToolsSource.includes("new ThreadEventLedger({")
    || !(await stat(sidecarAdapterPath)).isFile()
    || !(await stat(sidecarLedgerPath)).isFile()) {
    throw new Error("线程工具插件没有导出有效的 Cordis apply 入口");
  }
  const threadDefinitions = threadTools.createThreadToolDefinitions({
    defineTool: definition => definition,
    source: {},
    ledger: {},
  });
  const expectedThreadTools = [
    "thread_list",
    "thread_search",
    "thread_read",
    "thread_recall",
    "thread_confirm",
    "thread_protect",
    "thread_release_protection",
  ];
  if (JSON.stringify(threadDefinitions.map(tool => tool.name)) !== JSON.stringify(expectedThreadTools)) {
    throw new Error("线程工具目录与候选约定不一致");
  }

  const windsurfProviderEntry = join(
    candidate,
    "node_modules",
    "@deepseek-harness",
    "experimental-windsurf-provider",
    "src",
    "index.js",
  );
  const windsurfProvider = await import(pathToFileURL(windsurfProviderEntry));
  if (typeof windsurfProvider.ExperimentalFeatureGate !== "function"
    || typeof windsurfProvider.createExperimentalWindsurfDevinProvider !== "function") {
    throw new Error("Windsurf Provider 候选缺少门禁或 Provider 工厂");
  }
  const windsurfGateStatus = new windsurfProvider.ExperimentalFeatureGate().getStatus();
  if (windsurfGateStatus.enabled !== false || windsurfGateStatus.reason !== "experimental_disabled") {
    throw new Error("Windsurf Provider 候选没有保持默认关闭");
  }

  const contextCandidateEntry = join(
    candidate,
    "node_modules",
    "@dsh-experimental",
    "context-generation-state-machine",
    "lib",
    "dsh-plugin.js",
  );
  const contextCandidate = await import(pathToFileURL(contextCandidateEntry));
  if (contextCandidate.name !== "memory-context-candidate" || typeof contextCandidate.apply !== "function") {
    throw new Error("上下文候选插件没有导出有效的 Cordis apply 入口");
  }
  let contextServiceProvided = false;
  await contextCandidate.apply({
    provide: () => {
      contextServiceProvided = true;
    },
  });
  if (contextServiceProvided) throw new Error("上下文候选插件在默认配置下被意外启用");

  const contextProviderEntry = join(
    candidate,
    "node_modules",
    "@dsh-experimental",
    "context-generation-state-machine",
    "lib",
    "compaction-provider.js",
  );
  const contextProvider = await import(pathToFileURL(contextProviderEntry));
  if (typeof contextProvider.MemoryRecordCompactionEngine !== "function"
    || contextProvider.default !== contextProvider.MemoryRecordCompactionEngine) {
    throw new Error("主力上下文 Provider 没有导出可加载的 CompactionEngine");
  }
  const contextProviderSource = await readFile(contextProviderEntry, "utf8");
  if (!contextProviderSource.includes("const BPC_RATIO = 0.68")
    || !contextProviderSource.includes("const HARD_RATIO = 0.9")
    || !contextProviderSource.includes("super.compactRegion")
    || !contextProviderSource.includes("Memory Store Record")
    || !contextProviderSource.includes('name: "context-recover"')
    || !contextProviderSource.includes("原失败证据仍保留")) {
    throw new Error("主力上下文 Provider 缺少双阈值、官方事务、Record 重建或暂停恢复接线");
  }

  return {
    ok: true,
    candidate,
    manifestPath,
    verifiedChangedFiles: manifest.changedFiles.length,
    verifiedGeneratedFiles: manifest.generatedFiles.length,
    officialStandardPresetUnchanged: true,
    experimentalFeaturesEnabled: true,
    contextCandidateDefaultDisabled: true,
    contextProviderEnabledInCustomPreset: true,
    contextMeterThresholdsVisible: true,
    presetPackagesResolveFromCandidate: true,
    threadTools: expectedThreadTools,
    sharedMcpServers: expectedMcpServers,
    sharedMcpPlacement: "web-profile-preflight",
    windsurfAuthPluginLoaded: true,
    windsurfSettingsCardVisible: true,
    legacyWindsurfLibraryGateDisabled: true,
  };
}

const candidate = parseArguments(process.argv.slice(2));
verifyCandidate(candidate).then(
  (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
  (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  },
);
