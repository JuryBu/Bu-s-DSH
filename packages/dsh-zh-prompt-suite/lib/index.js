import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { PERSONA_ORDER, PERSONA_SECTION } from "@deepseek-ai/dsh-system-prompt";
import { loadRuleModules, renderRuleModules, watchRuleModules } from "./rules.js";
import { translateAssembly } from "./translations.js";

export const name = "zh-prompt-suite";
export const inject = ["systemPrompt", "llm"];
export const Config = z.object({
  dshHome: z.string().default(""),
  rulesDirectory: z.string().default(""),
  defaultRulesDirectory: z.string().default(""),
  watchRules: z.boolean().default(true),
  runtimeInstanceName: z.string().default(""),
  runtimeInstanceKind: z.string().default(""),
});

const BUILTIN_PERSONA = "你是在 DeepSeek Harness 中运行的智能体。当前工作目录是 {{cwd}}。";
const RUNTIME_IDENTITY_CONTEXT = "stardust:runtime-identity";
const RUNTIME_TIME_CONTEXT = "stardust:runtime-time";
const RUNTIME_STATUS_CONTEXT_NAMES = new Set(["sandbox:policy", "approval:policy"]);
const RUNTIME_CACHE_LIMIT = 128;
const RUNTIME_TIME_REFRESH_MS = 60_000;
const DEFAULT_RULES_MARKER = ".stardust-default-rules-v1";

async function installDefaultRules(rulesDirectory, defaultRulesDirectory) {
  const existing = await readdir(rulesDirectory);
  if (existing.includes(DEFAULT_RULES_MARKER)) return;
  const hasUserRules = existing.some(name => /^\d{2}-.+\.md$/u.test(name));
  if (hasUserRules) {
    await writeFile(join(rulesDirectory, DEFAULT_RULES_MARKER), "保留已有用户 Rules，未安装内置默认值。\n", { encoding: "utf8", flag: "wx" })
      .catch(error => { if (error?.code !== "EEXIST") throw error; });
    return;
  }
  const defaults = await readdir(defaultRulesDirectory).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const modules = defaults.filter(name => /^\d{2}-.+\.md$/u.test(name)).sort((left, right) => left.localeCompare(right, "en"));
  if (modules.length === 0) return;
  for (const name of modules) {
    const content = await readFile(join(defaultRulesDirectory, name), "utf8");
    await writeFile(join(rulesDirectory, name), content, { encoding: "utf8", flag: "wx" })
      .catch(error => { if (error?.code !== "EEXIST") throw error; });
  }
  await writeFile(join(rulesDirectory, DEFAULT_RULES_MARKER), "已安装 Stardust DSH 默认全局 Rules v1；后续启动不会覆盖用户修改。\n", { encoding: "utf8", flag: "wx" })
    .catch(error => { if (error?.code !== "EEXIST") throw error; });
}

function displayReasoningEffort(explicitEffort, model) {
  const explicit = String(explicitEffort ?? "").trim().toLowerCase();
  const tokens = explicit ? [explicit] : String(model ?? "").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  const effort = [...tokens].reverse().find(token => ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(token));
  return ({
    off: "关闭",
    none: "关闭",
    minimal: "极简",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
    ultra: "超高",
  })[effort] ?? "由提供方默认决定";
}

function displaySpeed(model) {
  const normalized = String(model ?? "").toLowerCase();
  return normalized.startsWith("fast::") || /(?:^|[-_])(fast|priority|lightning)(?:$|[-_])/u.test(normalized)
    ? "快速"
    : "标准";
}

function displayContextWindow(contextWindow) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return "尚未由模型目录确认";
  if (contextWindow >= 1_000_000 && contextWindow % 1_000_000 === 0) return `${contextWindow / 1_000_000}M Token`;
  if (contextWindow >= 1_000 && contextWindow % 1_000 === 0) return `${contextWindow / 1_000}K Token`;
  return `${contextWindow} Token`;
}

function runtimeTimeZone() {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || "本机时区";
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${name}（UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}）`;
}

function runtimeLocalTime() {
  const now = new Date(Date.now());
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

function latestTurnIdentity(session) {
  if (!Array.isArray(session?.events)) return { identity: "none", turn: undefined };
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.type !== "turn/start") continue;
    return {
      identity: `${index}:${String(event.data?.turn ?? event.id ?? "unknown")}`,
      turn: event.data?.turn,
    };
  }
  return { identity: "none", turn: undefined };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function resolveRuntimeInstance(config) {
  if (config.runtimeInstanceName || config.runtimeInstanceKind) {
    return {
      name: config.runtimeInstanceName || "未命名运行实例",
      kind: config.runtimeInstanceKind || "未标注实例类型",
    };
  }
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 7; depth += 1) {
    const manifestPath = join(directory, "stardust", "candidate-manifest.json");
    try {
      const manifest = await readJson(manifestPath);
      const releaseRoot = resolve(directory);
      let activeRoot;
      if (process.env.LOCALAPPDATA) {
        const currentPath = join(process.env.LOCALAPPDATA, "DeepSeekHarness", "app", "current.json");
        const current = await readJson(currentPath).catch(() => undefined);
        if (current?.releasePath) activeRoot = resolve(current.releasePath);
      }
      return {
        name: String(manifest.candidateName ?? manifest.version ?? directory),
        kind: activeRoot === releaseRoot ? "当前生产发行版" : "隔离候选或未激活发行版",
      };
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { name: "开发源码工作区", kind: "开发实例" };
}

function runtimeIdentityKey(assembly, context, runtimeInstance, turn) {
  const agent = context?.agent;
  const provider = String(assembly.variables.provider ?? agent?.options?.provider ?? "").trim();
  const model = String(assembly.variables.model ?? agent?.options?.model ?? "").trim();
  const requestContext = agent?.session?.requestContext?.();
  return JSON.stringify({
    sessionId: agent?.session?.id,
    turnIdentity: turn.identity,
    provider,
    model,
    reasoningEffort: assembly.variables.reasoning_effort ?? "",
    requestProvider: requestContext?.provider,
    requestModel: requestContext?.model,
    requestContextWindow: requestContext?.contextWindow,
    generation: agent?.contextGenerationId,
    runtimeInstance,
  });
}

function runtimeStatusKey(contexts) {
  return JSON.stringify(
    contexts
      .filter((context) => RUNTIME_STATUS_CONTEXT_NAMES.has(context.name))
      .map((context) => [context.name, context.text])
      .sort(([leftName, leftText], [rightName, rightText]) => leftName.localeCompare(rightName, "en") || leftText.localeCompare(rightText, "en")),
  );
}

function withoutStaleRuntimeContexts(contexts, { injectRuntimeStatus, injectRuntimeTime }) {
  return contexts.filter((context) => context.name !== RUNTIME_IDENTITY_CONTEXT
    && (injectRuntimeTime || context.name !== RUNTIME_TIME_CONTEXT)
    && (injectRuntimeStatus || !RUNTIME_STATUS_CONTEXT_NAMES.has(context.name)));
}

function shouldInjectRuntimeTime(cached, turn, now) {
  return !cached
    || cached.turnIdentity !== turn.identity
    || now < cached.lastRuntimeTimeAt
    || now - cached.lastRuntimeTimeAt >= RUNTIME_TIME_REFRESH_MS;
}

function rememberRuntimeInjection(cache, sessionId, value) {
  cache.delete(sessionId);
  cache.set(sessionId, value);
  if (cache.size > RUNTIME_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

async function runtimeIdentityContext(ctx, assembly, context, runtimeInstance, turn) {
  const agent = context?.agent;
  if (!agent?.session?.id) return "";
  const provider = String(assembly.variables.provider ?? agent.options?.provider ?? "").trim();
  const model = String(assembly.variables.model ?? agent.options?.model ?? "").trim();
  let modelInfo;
  if (provider && model) {
    try {
      modelInfo = await ctx.llm.resolveModelInfo(provider, model, context?.signal);
    } catch (error) {
      ctx.logger?.warn?.("DSH 动态模型状态无法读取模型目录：%o", error);
    }
  }
  const requestContext = agent.session.requestContext?.();
  const matchingContextWindow = requestContext?.provider === provider && requestContext?.model === model
    ? requestContext.contextWindow
    : undefined;
  const contextWindow = modelInfo?.context?.contextWindow ?? matchingContextWindow;
  const modelDisplayName = modelInfo?.name ?? model;
  const modelDefaultEffort = modelInfo?.stardustVariantEffort ?? modelInfo?.reasoning?.defaultEffort;
  const generation = agent.contextGenerationId;
  return [
    "【当前对话与模型】这些值由 DSH 运行时为当前真人消息轮次提供，不要从标题、历史消息或文件路径猜测。",
    `当前运行实例：${runtimeInstance.kind} / ${runtimeInstance.name}`,
    `本机时区：${runtimeTimeZone()}`,
    `当前 DSH 对话编号：${agent.session.id}`,
    ...(turn.turn === undefined ? [] : [`当前真人消息轮次：${turn.turn}`]),
    `当前模型：${provider || "未知提供方"} / ${model || "未知模型"}`,
    `当前推理强度：${displayReasoningEffort(assembly.variables.reasoning_effort ?? modelDefaultEffort, modelDisplayName)}`,
    `当前速度：${displaySpeed(model)}`,
    `当前上下文窗口：${displayContextWindow(contextWindow)}`,
    ...(generation === undefined ? [] : [`当前上下文重建代次：${generation}`]),
  ].join("\n");
}

function runtimeTimeContext() {
  return `本机时间：${runtimeLocalTime()}`;
}

export async function apply(ctx, config = {}) {
  const dshHome = resolveDshHome(config.dshHome || undefined);
  const rulesDirectory = config.rulesDirectory || join(dshHome, "rules");
  const defaultRulesDirectory = config.defaultRulesDirectory || fileURLToPath(new URL("../defaults/", import.meta.url));
  await mkdir(rulesDirectory, { recursive: true });
  await installDefaultRules(rulesDirectory, defaultRulesDirectory);
  const runtimeInstance = await resolveRuntimeInstance(config);
  const runtimeInjectionCache = new Map();
  let renderedRules = renderRuleModules(await loadRuleModules(rulesDirectory));

  const reload = async () => {
    const next = renderRuleModules(await loadRuleModules(rulesDirectory));
    if (next === renderedRules) return;
    renderedRules = next;
    ctx.emit("system-prompt/change");
  };

  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: () => [BUILTIN_PERSONA, renderedRules].filter(Boolean).join("\n\n"),
  }), "zh-prompt-suite.persona");
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembly = await next();
    const session = context?.agent?.session;
    const turn = latestTurnIdentity(session);
    const identityKey = runtimeIdentityKey(assembly, context, runtimeInstance, turn);
    const statusKey = runtimeStatusKey(assembly.contexts);
    const sessionId = String(session?.id ?? "");
    const cached = sessionId ? runtimeInjectionCache.get(sessionId) : undefined;
    const now = Date.now();
    const injectRuntimeIdentity = cached?.identityKey !== identityKey;
    const isNewHumanTurn = cached?.turnIdentity !== turn.identity;
    const injectRuntimeStatus = !cached || isNewHumanTurn || cached.statusKey !== statusKey;
    const injectRuntimeTime = Boolean(sessionId) && shouldInjectRuntimeTime(cached, turn, now);
    const runtimeIdentity = injectRuntimeIdentity
      ? await runtimeIdentityContext(ctx, assembly, context, runtimeInstance, turn)
      : "";
    if (sessionId) rememberRuntimeInjection(runtimeInjectionCache, sessionId, {
      identityKey,
      statusKey,
      turnIdentity: turn.identity,
      lastRuntimeTimeAt: injectRuntimeTime ? now : cached?.lastRuntimeTimeAt,
    });
    const contexts = withoutStaleRuntimeContexts(assembly.contexts, { injectRuntimeStatus, injectRuntimeTime });
    const runtimeContexts = [
      ...(runtimeIdentity ? [{ name: RUNTIME_IDENTITY_CONTEXT, text: runtimeIdentity }] : []),
      ...(injectRuntimeTime ? [{ name: RUNTIME_TIME_CONTEXT, text: runtimeTimeContext() }] : []),
    ];
    const withRuntimeIdentity = runtimeContexts.length > 0
      ? {
          ...assembly,
          contexts: [...contexts, ...runtimeContexts],
        }
      : contexts === assembly.contexts
        ? assembly
        : { ...assembly, contexts };
    return translateAssembly(withRuntimeIdentity);
  });
  if (config.watchRules !== false) ctx.effect(() => watchRuleModules(
    rulesDirectory,
    () => reload().catch((error) => ctx.logger.warn("DSH 中文全局规则刷新失败：%o", error)),
    (error) => ctx.logger.warn("DSH 中文全局规则监听失败：%o", error),
  ), "zh-prompt-suite.rules-watcher");
}

export { loadRuleModules, renderRuleModules, translateAssembly };
