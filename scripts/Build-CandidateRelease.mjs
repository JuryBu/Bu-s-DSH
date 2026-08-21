import { cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchAccountUsageSettingsSource,
  patchAgentInstructionsSource,
  patchAgentModelSelectionPromptSource,
  patchAgentLoopActivityLabelSource,
  patchAgentPresetModuleResolutionSource,
  patchConversationUiSource,
  patchDeepSeekLlmSource,
  patchCompactionIdleRegionSource,
  patchClientRuntimeSource,
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
  patchThemeUiSource,
  patchWindsurfSettingsSource,
  patchWorkspaceConversationReferencesSource,
} from "../packages/dsh-runtime-patches/lib/transforms.mjs";
import { transformStandardPreset } from "../packages/dsh-main-preset/lib/transform.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidatesRoot = resolve(workspaceRoot, "release", "candidates");
const defaultSource = join(
  process.env.LOCALAPPDATA || "",
  "DeepSeekHarness",
  "app",
  "releases",
  "0.1.0-rc.6-oauth",
);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`无法识别的参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少值`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const source = resolve(values.get("source") || process.env.DSH_SOURCE_RELEASE || defaultSource);
  const outputName = values.get("name") || `0.1.0-rc.6-stardust-candidate-${Date.now()}`;
  if (isAbsolute(outputName) || outputName.includes("/") || outputName.includes("\\")) {
    throw new Error("--name 只能是候选版本目录名，不能传绝对路径或子目录");
  }
  return { source, output: resolve(candidatesRoot, outputName) };
}

function assertChildPath(parent, child, label) {
  const relativePath = relative(parent, child);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error(`${label} 必须位于 ${parent} 内部`);
  }
}

async function assertDirectory(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} 不存在或不是目录：${path}`);
}

async function assertAbsent(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (info) throw new Error(`${label} 已存在，拒绝覆盖：${path}`);
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex").toUpperCase();
}

async function rewriteFile(path, transform) {
  const beforeHash = await sha256(path);
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next === source) throw new Error(`候选转换没有产生变化：${path}`);
  await writeFile(path, next, "utf8");
  return { path, beforeHash, afterHash: await sha256(path) };
}

async function copyPackage(source, destination) {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (entry) => basename(entry) !== "node_modules",
  });
}

async function overlayPackage(source, destination) {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: false,
    force: true,
    filter: (entry) => basename(entry) !== "node_modules",
  });
}

async function copyCompiledTypeScriptPackage(source, destination) {
  await copyPackage(source, destination);
  const sourceDirectory = join(source, "src");
  const outputDirectory = join(destination, "lib");
  await mkdir(outputDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const sourcePath = join(sourceDirectory, entry.name);
    const outputPath = join(outputDirectory, entry.name.replace(/\.ts$/u, ".js"));
    const compiled = stripTypeScriptTypes(await readFile(sourcePath, "utf8"), {
      mode: "transform",
      sourceMap: false,
    }).replace(/(["']\.\.?\/[^"']+)\.ts(["'])/gu, "$1.js$2");
    await writeFile(outputPath, compiled, "utf8");
  }
  const packagePath = join(destination, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.exports = Object.fromEntries(Object.entries(packageJson.exports).map(([key, value]) => [
    key,
    String(value).replace(/^\.\/src\/(.+)\.ts$/u, "./lib/$1.js"),
  ]));
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function addWindsurfRuntimeDependencies(staging) {
  const packagePath = join(staging, "package.json");
  const lockPath = join(staging, "package-lock.json");
  const workspaceLockPath = join(workspaceRoot, "package-lock.json");
  const before = [
    { path: packagePath, beforeHash: await sha256(packagePath) },
    { path: lockPath, beforeHash: await sha256(lockPath) },
  ];
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@deepseek-harness/dsh-account-usage": "0.0.0-candidate",
    "@deepseek-harness/experimental-windsurf-provider": "0.0.0-candidate",
    "@stardust/dsh-message-branch": "0.0.0-candidate",
    "@stardust/dsh-turn-presentation": "0.0.0-candidate",
    "opencode-windsurf-auth": "0.3.2",
  };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const workspaceLock = JSON.parse(await readFile(workspaceLockPath, "utf8"));
  lock.packages[""].dependencies = {
    ...lock.packages[""].dependencies,
    "@deepseek-harness/dsh-account-usage": "0.0.0-candidate",
    "@deepseek-harness/experimental-windsurf-provider": "0.0.0-candidate",
    "@stardust/dsh-message-branch": "0.0.0-candidate",
    "@stardust/dsh-turn-presentation": "0.0.0-candidate",
    "opencode-windsurf-auth": "0.3.2",
  };
  lock.packages["node_modules/@deepseek-harness/dsh-account-usage"] = {
    version: "0.0.0-candidate",
    license: "UNLICENSED",
    peerDependencies: {
      "@deepseek-harness/experimental-windsurf-provider": "0.0.0-candidate",
      "@stardust/dsh-openai-codex-oauth": "0.1.0",
    },
  };
  lock.packages["node_modules/@deepseek-harness/experimental-windsurf-provider"] = {
    version: "0.0.0-candidate",
    license: "UNLICENSED",
    dependencies: { "opencode-windsurf-auth": "0.3.2" },
    peerDependencies: { "@earendil-works/pi-ai": "0.82.1" },
  };
  lock.packages["node_modules/@stardust/dsh-message-branch"] = {
    version: "0.0.0-candidate",
    license: "UNLICENSED",
    peerDependencies: {
      "@deepseek-ai/dsh-agent": "^0.1.0-rc.6",
      "@deepseek-ai/dsh-agent-presets": "^0.1.0-rc.6",
      "@deepseek-ai/dsh-llm": "^0.1.0-rc.6",
      "@deepseek-ai/dsh-session": "^0.1.0-rc.6",
    },
  };
  lock.packages["node_modules/@stardust/dsh-turn-presentation"] = {
    version: "0.0.0-candidate",
    license: "UNLICENSED",
    dependencies: { zod: "^4.4.3" },
    peerDependencies: {
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-session-projection": "^0.1.0-rc.6",
    },
  };
  for (const dependency of ["opencode-windsurf-auth", "xdg-basedir"]) {
    lock.packages[`node_modules/${dependency}`] = workspaceLock.packages[`node_modules/${dependency}`];
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return Promise.all(before.map(async (entry) => ({ ...entry, afterHash: await sha256(entry.path) })));
}

function addWindsurfWebDependency(source) {
  const packageJson = JSON.parse(source);
  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@deepseek-harness/dsh-account-usage": "0.0.0-candidate",
    "@deepseek-harness/experimental-windsurf-provider": "0.0.0-candidate",
    "@stardust/dsh-message-branch": "0.0.0-candidate",
  };
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function addWindsurfWebPlugin(source) {
  const needle = `    - id: openai-codex-oauth
      name: '@stardust/dsh-openai-codex-oauth'
      inject: [webServer]
`;
  const replacement = `${needle}
    # Independent Windsurf/Devin subscription login. It never reads the
    # Windsurf desktop client's login files and stores its own key with DPAPI.
    - id: windsurf-auth
      name: '@deepseek-harness/experimental-windsurf-provider'
      inject: [webServer]

    # Read-only account status. DeepSeek uses its official balance endpoint;
    # subscription OAuth providers expose connection status only.
    - id: account-usage
      name: '@deepseek-harness/dsh-account-usage'
      inject: [webServer]

    # Edit and resend the latest real user message by creating a child branch.
    # Harness-internal state may replay; external side effects are preserved.
    - id: message-branch
      name: '@stardust/dsh-message-branch'
      inject: [webServer, agents, agentPresets]
      config:
        storeDirectory: !!js dshHomePath('message-branches')
`;
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error("dsh-web-app 的 OAuth 插件插入点与 rc.6 基线不一致");
  }
  return source.replace(needle, replacement);
}

async function buildCandidate({ source, output }) {
  await mkdir(candidatesRoot, { recursive: true });
  assertChildPath(candidatesRoot, output, "候选版本");
  await assertDirectory(source, "基础 release");
  await assertAbsent(output, "候选版本");
  const sourceRealPath = await realpath(source);
  if (sourceRealPath === output) throw new Error("候选版本不能覆盖基础 release");

  const staging = `${output}.staging-${process.pid}`;
  assertChildPath(candidatesRoot, staging, "候选暂存目录");
  await assertAbsent(staging, "候选暂存目录");
  await cp(sourceRealPath, staging, { recursive: true, errorOnExist: true, force: false });

  const systemPromptPath = join(staging, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js");
  const agentLoopPath = join(staging, "node_modules", "@deepseek-ai", "dsh-agent-loop", "lib", "index.js");
  const timeContextPath = join(staging, "node_modules", "@deepseek-ai", "dsh-time-context", "lib", "index.js");
  const agentInstructionsPath = join(staging, "node_modules", "@deepseek-ai", "dsh-agent-instructions", "lib", "index.js");
  const agentRuntimePath = join(staging, "node_modules", "@deepseek-ai", "dsh-agent", "lib", "index.js");
  const mcpClientPath = join(staging, "node_modules", "@deepseek-ai", "dsh-mcp-client", "lib", "index.js");
  const piAiAdapterPath = join(staging, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");
  const deepSeekAdapterPath = join(staging, "node_modules", "@deepseek-ai", "dsh-llm-deepseek", "lib", "index.js");
  const piAiSimpleOptionsPath = join(staging, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "simple-options.js");
  const toolsRuntimePath = join(staging, "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js");
  const compactionBasicPath = join(staging, "node_modules", "@deepseek-ai", "dsh-compaction-basic", "lib", "index.js");
  const webAppPackagePath = join(staging, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json");
  const webAppPatchPath = join(staging, "node_modules", "@deepseek-ai", "dsh-web-app", "cordis.patch.yml");
  const settingsModelsUiPath = join(staging, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models", "lib", "client.js");
  const modelSelectionUiPath = join(staging, "node_modules", "@deepseek-ai", "dsh-client-ui-model-selection", "lib", "client.js");
  const conversationUiPath = join(staging, "node_modules", "@deepseek-ai", "dsh-client-ui-conversation", "lib", "client.js");
  const themeUiPath = join(staging, "node_modules", "@deepseek-ai", "dsh-client-ui-theme", "lib", "client.js");
  const clientRuntimePath = join(staging, "node_modules", "@deepseek-ai", "dsh-client-runtime", "lib", "client.js");
  const workspaceUiPath = join(staging, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js");
  const toolUiPath = join(staging, "node_modules", "@deepseek-ai", "dsh-client-ui-tool", "lib", "client.js");
  const jobsToolPath = join(staging, "node_modules", "@deepseek-ai", "dsh-tool-jobs", "lib", "index.js");
  const jobsLocalPath = join(staging, "node_modules", "@deepseek-ai", "dsh-jobs-local", "lib", "index.js");
  const hostApiProxyPaths = [
    join(staging, "node_modules", "@deepseek-ai", "dsh-host-apiproxy", "lib", "index.js"),
    join(staging, "node_modules", "@deepseek-ai", "dsh-host-apiproxy", "lib", "types", "api-proxy.js"),
  ];
  const headlessRunnerPath = join(staging, "node_modules", "@deepseek-ai", "dsh-headless", "lib", "index.js");
  const headlessBundlePath = join(staging, "node_modules", "@deepseek-ai", "dsh-headless", "cordis.patch.yml");
  const agentPresetRuntimePaths = [
    join(staging, "node_modules", "@deepseek-ai", "dsh-agent-presets", "lib", "index.js"),
    join(staging, "node_modules", "@deepseek-ai", "dsh-agent-presets", "lib", "invariant.js"),
    join(staging, "node_modules", "@deepseek-ai", "dsh-agent-presets", "lib", "types", "mount.js"),
  ];
  const standardPresetRoot = join(staging, "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets", "standard");
  const customPresetRoot = join(staging, "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets", "stardust-main");
  const promptSuiteRoot = join(staging, "node_modules", "@stardust", "dsh-zh-prompt-suite");
  const threadToolsRoot = join(staging, "node_modules", "@stardust", "dsh-thread-tools");
  const applyPatchRoot = join(staging, "node_modules", "@stardust", "dsh-tool-apply-patch");
  const oauthPackageRoot = join(staging, "node_modules", "@stardust", "dsh-openai-codex-oauth");
  const windsurfProviderRoot = join(
    staging,
    "node_modules",
    "@deepseek-harness",
    "experimental-windsurf-provider",
  );
  const accountUsageRoot = join(
    staging,
    "node_modules",
    "@deepseek-harness",
    "dsh-account-usage",
  );
  const messageBranchRoot = join(
    staging,
    "node_modules",
    "@stardust",
    "dsh-message-branch",
  );
  const turnPresentationRoot = join(
    staging,
    "node_modules",
    "@stardust",
    "dsh-turn-presentation",
  );
  const windsurfUpstreamRoot = join(staging, "node_modules", "opencode-windsurf-auth");
  const xdgBasedirRoot = join(staging, "node_modules", "xdg-basedir");
  const contextCandidateRoot = join(
    staging,
    "node_modules",
    "@dsh-experimental",
    "context-generation-state-machine",
  );
  const rulesTemplateRoot = join(staging, "stardust", "rules-template");
  const packagedRulesRoot = join(promptSuiteRoot, "defaults");

  await Promise.all([
    assertDirectory(dirname(systemPromptPath), "系统提示词插件"),
    assertDirectory(dirname(agentLoopPath), "Agent Loop 运行时"),
    assertDirectory(dirname(timeContextPath), "时间上下文插件"),
    assertDirectory(dirname(agentInstructionsPath), "工作区规则插件"),
    assertDirectory(dirname(agentRuntimePath), "Agent 模型选择运行时"),
    assertDirectory(dirname(mcpClientPath), "MCP 客户端插件"),
    assertDirectory(dirname(piAiAdapterPath), "pi-ai 模型适配器"),
    assertDirectory(dirname(deepSeekAdapterPath), "DeepSeek 文本模型适配器"),
    assertDirectory(dirname(toolsRuntimePath), "工具注册运行时"),
    assertDirectory(dirname(compactionBasicPath), "官方基础压缩器"),
    assertDirectory(dirname(webAppPatchPath), "Web App 组合包"),
    assertDirectory(dirname(workspaceUiPath), "工作区会话列表界面"),
    assertDirectory(dirname(settingsModelsUiPath), "模型设置界面"),
    assertDirectory(dirname(modelSelectionUiPath), "模型选择界面"),
    assertDirectory(dirname(conversationUiPath), "对话上下文状态面板"),
    assertDirectory(dirname(themeUiPath), "主题外观界面"),
    assertDirectory(dirname(clientRuntimePath), "客户端会话运行时"),
    assertDirectory(dirname(toolUiPath), "工具调用界面"),
    assertDirectory(dirname(jobsToolPath), "Jobs 完成投递工具"),
    assertDirectory(dirname(jobsLocalPath), "Jobs 本地注册表"),
    ...hostApiProxyPaths.map((path) => assertDirectory(dirname(path), "模型选择后端")),
    assertDirectory(dirname(headlessRunnerPath), "Headless runner"),
    assertDirectory(dirname(headlessBundlePath), "Headless 组合包"),
    ...agentPresetRuntimePaths.map((path) => assertDirectory(dirname(path), "Agent Preset 运行时")),
    assertDirectory(standardPresetRoot, "官方标准模式"),
    assertDirectory(oauthPackageRoot, "OpenAI OAuth 插件"),
  ]);
  await Promise.all([
    assertAbsent(customPresetRoot, "主力模式目录"),
    assertAbsent(promptSuiteRoot, "中文提示插件目录"),
    assertAbsent(threadToolsRoot, "线程工具插件目录"),
    assertAbsent(applyPatchRoot, "apply_patch 插件目录"),
    assertAbsent(windsurfProviderRoot, "Windsurf Provider 候选目录"),
    assertAbsent(accountUsageRoot, "账户使用情况插件目录"),
    assertAbsent(messageBranchRoot, "消息修改重发插件目录"),
    assertAbsent(turnPresentationRoot, "轮级展示投影插件目录"),
    assertAbsent(windsurfUpstreamRoot, "Windsurf 上游协议包"),
    assertAbsent(xdgBasedirRoot, "Windsurf 上游路径依赖"),
    assertAbsent(contextCandidateRoot, "上下文候选插件目录"),
  ]);

  const changedFiles = [];
  const addedFiles = [];
  changedFiles.push(await rewriteFile(systemPromptPath, patchSystemPromptSource));
  changedFiles.push(await rewriteFile(agentLoopPath, patchAgentLoopActivityLabelSource));
  changedFiles.push(await rewriteFile(timeContextPath, patchTimeContextSource));
  changedFiles.push(await rewriteFile(agentInstructionsPath, patchAgentInstructionsSource));
  changedFiles.push(await rewriteFile(agentRuntimePath, patchAgentModelSelectionPromptSource));
  changedFiles.push(await rewriteFile(mcpClientPath, patchMcpClientMultimodalSource));
  changedFiles.push(await rewriteFile(piAiAdapterPath, patchPiAiFastModelsSource));
  changedFiles.push(await rewriteFile(deepSeekAdapterPath, patchDeepSeekLlmSource));
  changedFiles.push(await rewriteFile(piAiSimpleOptionsPath, patchPiAiSimpleOptionsServiceTierSource));
  changedFiles.push(await rewriteFile(toolsRuntimePath, patchToolsReadImageSdkSource));
  changedFiles.push(await rewriteFile(compactionBasicPath, patchCompactionIdleRegionSource));
  changedFiles.push(await rewriteFile(webAppPackagePath, addWindsurfWebDependency));
  changedFiles.push(await rewriteFile(webAppPatchPath, addWindsurfWebPlugin));
  changedFiles.push(await rewriteFile(
    settingsModelsUiPath,
    (source) => patchAccountUsageSettingsSource(patchWindsurfSettingsSource(source)),
  ));
  changedFiles.push(await rewriteFile(modelSelectionUiPath, patchModelSelectionUxSource));
  changedFiles.push(await rewriteFile(conversationUiPath, patchConversationUiSource));
  changedFiles.push(await rewriteFile(themeUiPath, patchThemeUiSource));
  changedFiles.push(await rewriteFile(clientRuntimePath, patchClientRuntimeSource));
  changedFiles.push(await rewriteFile(workspaceUiPath, patchWorkspaceConversationReferencesSource));
  changedFiles.push(await rewriteFile(toolUiPath, patchToolActivityPresentationSource));
  changedFiles.push(await rewriteFile(jobsToolPath, patchJobsCompletionDeliverySource));
  changedFiles.push(await rewriteFile(jobsLocalPath, patchJobsLocalTeardownSource));
  for (const path of hostApiProxyPaths) {
    changedFiles.push(await rewriteFile(path, patchHostModelSelectionSource));
  }
  changedFiles.push(await rewriteFile(headlessRunnerPath, patchHeadlessShutdownSource));
  changedFiles.push(await rewriteFile(headlessBundlePath, patchHeadlessBundleSource));
  for (const path of agentPresetRuntimePaths) {
    changedFiles.push(await rewriteFile(path, patchAgentPresetModuleResolutionSource));
  }

  await copyPackage(join(workspaceRoot, "packages", "dsh-zh-prompt-suite"), promptSuiteRoot);
  await cp(join(workspaceRoot, "docs", "rules-samples", "dsh-global"), packagedRulesRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await copyPackage(join(workspaceRoot, "packages", "dsh-thread-tools"), threadToolsRoot);
  await copyPackage(join(workspaceRoot, "packages", "dsh-tool-apply-patch"), applyPatchRoot);
  await copyPackage(
    join(workspaceRoot, "packages", "experimental-windsurf-provider"),
    windsurfProviderRoot,
  );
  await copyPackage(join(workspaceRoot, "packages", "dsh-account-usage"), accountUsageRoot);
  await copyPackage(join(workspaceRoot, "packages", "dsh-message-branch"), messageBranchRoot);
  await copyPackage(join(workspaceRoot, "packages", "dsh-turn-presentation"), turnPresentationRoot);
  await copyPackage(join(workspaceRoot, "node_modules", "opencode-windsurf-auth"), windsurfUpstreamRoot);
  await copyPackage(join(workspaceRoot, "node_modules", "xdg-basedir"), xdgBasedirRoot);
  changedFiles.push(...await addWindsurfRuntimeDependencies(staging));
  await copyCompiledTypeScriptPackage(
    join(workspaceRoot, "packages", "context-generation-state-machine"),
    contextCandidateRoot,
  );
  const oauthTrackedFiles = ["package.json", "package-lock.json", "lib/catalog.js", "test/oauth.test.mjs"];
  const oauthBefore = new Map();
  for (const relativePath of oauthTrackedFiles) {
    const path = join(oauthPackageRoot, relativePath);
    const info = await stat(path).catch(() => undefined);
    oauthBefore.set(relativePath, info?.isFile() ? await sha256(path) : undefined);
  }
  await overlayPackage(join(workspaceRoot, "packages", "openai-codex-oauth"), oauthPackageRoot);
  for (const relativePath of oauthTrackedFiles) {
    const path = join(oauthPackageRoot, relativePath);
    const afterHash = await sha256(path);
    const beforeHash = oauthBefore.get(relativePath);
    if (beforeHash === undefined) {
      addedFiles.push({ path: relative(staging, path).replaceAll("\\", "/"), sha256: afterHash });
    } else if (afterHash !== beforeHash) {
      changedFiles.push({ path, beforeHash, afterHash });
    }
  }
  await mkdir(customPresetRoot, { recursive: true });
  const standardAgentPath = join(standardPresetRoot, "agent.cordis.yml");
  const customAgentPath = join(customPresetRoot, "agent.cordis.yml");
  await writeFile(customAgentPath, transformStandardPreset(await readFile(standardAgentPath, "utf8")), "utf8");
  await cp(join(workspaceRoot, "packages", "dsh-main-preset", "preset.yml"), join(customPresetRoot, "preset.yml"), {
    errorOnExist: true,
    force: false,
  });
  await cp(join(workspaceRoot, "docs", "rules-samples", "dsh-global"), rulesTemplateRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const manifest = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    sourceRelease: sourceRealPath,
    sourcePackageHash: await sha256(join(sourceRealPath, "package.json")),
    candidateName: basename(output),
    productionActivated: false,
    experimentalFeaturesEnabled: true,
    additions: [
      "@stardust/dsh-zh-prompt-suite",
      "@stardust/dsh-thread-tools（当前会话原生原文恢复优先；跨会话、跨宿主和深层恢复使用 Memory Store；回执和保护写入独立 sidecar 哈希链，绝不写回官方会话）",
      "@stardust/dsh-tool-apply-patch（主力模式替代旧 edit，官方模式不变）",
      "Sandbox、Memory Store、web-fetcher、Exa 与结构化思考 MCP（宿主只挂载一次；本机 broker 不可用时不阻塞启动）",
      "@deepseek-harness/experimental-windsurf-provider（独立浏览器 OAuth 或 API Key、DPAPI 加密、真实模型目录与云端流协议）",
      "@dsh-experimental/context-generation-state-machine（主力模式启用 68% 后台预压缩、90% 官方事务硬压缩；官方标准模式不变）",
      "workspace OpenAI OAuth package source refresh",
      "Agent Preset 裸包从当前安装 release 解析",
      "MCP 图片按模型能力转为耐久附件；音频和资源完整保存为带哈希 artifact",
      "OpenAI Codex 模型目录按账号动态刷新推理档位、视觉能力和 Fast 支持，并向 pi-ai 发送 priority service tier",
      "Windsurf 设置卡（浏览器授权、API Key、认证方式切换与退出登录）",
      "账户使用情况（DeepSeek 官方余额；ChatGPT/Windsurf 显示当前登录态实际返回的额度并明确内部接口边界，缺失字段不伪造）",
      "@stardust/dsh-message-branch（只在空闲时编辑上一条真人消息并创建子分支；Harness 内部状态可回放，外部副作用明确保留）",
      "@stardust/dsh-turn-presentation（从官方事件只读生成整轮过程/正文边界与耗时投影）",
      "stardust-main agent preset",
      "stardust/rules-template",
    ],
    changedFiles: changedFiles.map((item) => ({
      path: relative(staging, item.path).replaceAll("\\", "/"),
      beforeSha256: item.beforeHash,
      afterSha256: item.afterHash,
    })),
    generatedFiles: [
      ...addedFiles,
      ...[customAgentPath, join(customPresetRoot, "preset.yml")].map((path) => ({
        path: relative(staging, path).replaceAll("\\", "/"),
        sha256: null,
      })),
    ],
  };
  for (const file of manifest.generatedFiles) file.sha256 = await sha256(join(staging, file.path));
  await mkdir(join(staging, "stardust"), { recursive: true });
  await writeFile(join(staging, "stardust", "candidate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(staging, output);
  return { output, manifestPath: join(output, "stardust", "candidate-manifest.json") };
}

const argumentsValue = parseArguments(process.argv.slice(2));
buildCandidate(argumentsValue).then(
  (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`),
  (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  },
);
