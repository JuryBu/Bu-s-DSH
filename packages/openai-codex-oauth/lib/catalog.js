import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openAICodexCredentialStore, openAICodexProviderId } from "./store.js";

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CLIENT_VERSION = "0.146.0";
const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local");

export const openAICodexCatalogPath = process.env.DSH_OPENAI_CODEX_MODELS_PATH
  ?? join(localAppData, "DeepSeekHarness", "state", "openai-codex-models.json");

function accountHash(accountId) {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
}

function normalizeServiceTiers(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    if (typeof entry.id !== "string" || entry.id.length === 0) return [];
    return [{
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
      description: typeof entry.description === "string" ? entry.description : "",
    }];
  });
}

function normalizeReasoning(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return entry.length > 0 ? [entry] : [];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    return typeof entry.effort === "string" && entry.effort.length > 0 ? [entry.effort] : [];
  });
}

function normalizeRemoteModel(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (typeof value.slug !== "string" || value.slug.length === 0) return undefined;
  const contextWindow = Number.isSafeInteger(value.context_window) && value.context_window > 0
    ? value.context_window
    : undefined;
  return {
    slug: value.slug,
    displayName: typeof value.display_name === "string" && value.display_name.length > 0
      ? value.display_name
      : value.slug,
    reasoningEfforts: [...new Set(normalizeReasoning(value.supported_reasoning_levels))],
    serviceTiers: normalizeServiceTiers(value.service_tiers),
    additionalSpeedTiers: [...new Set(stringArray(value.additional_speed_tiers))],
    inputModalities: [...new Set(stringArray(value.input_modalities).filter((entry) => entry === "text" || entry === "image"))],
    visibility: typeof value.visibility === "string" ? value.visibility : "list",
    supportedInApi: value.supported_in_api !== false,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function normalizeCachedModel(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (typeof value.slug !== "string" || value.slug.length === 0) return undefined;
  const contextWindow = Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0
    ? value.contextWindow
    : undefined;
  return {
    slug: value.slug,
    displayName: typeof value.displayName === "string" && value.displayName.length > 0
      ? value.displayName
      : value.slug,
    reasoningEfforts: [...new Set(stringArray(value.reasoningEfforts))],
    serviceTiers: normalizeServiceTiers(value.serviceTiers),
    additionalSpeedTiers: [...new Set(stringArray(value.additionalSpeedTiers))],
    inputModalities: [...new Set(stringArray(value.inputModalities).filter((entry) => entry === "text" || entry === "image"))],
    visibility: typeof value.visibility === "string" ? value.visibility : "list",
    supportedInApi: value.supportedInApi !== false,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function normalizeModelsResponse(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(value.models)) {
    throw new Error("OpenAI Codex 模型目录响应缺少 models 数组");
  }
  const models = value.models.map(normalizeRemoteModel).filter(Boolean);
  if (models.length === 0) throw new Error("OpenAI Codex 模型目录没有可用条目");
  return models;
}

function validateCache(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (value.version !== CACHE_VERSION || typeof value.accountHash !== "string") return undefined;
  if (!Number.isFinite(value.fetchedAt) || !Array.isArray(value.models)) return undefined;
  const models = value.models.map(normalizeCachedModel).filter(Boolean);
  if (models.length === 0) return undefined;
  return {
    version: CACHE_VERSION,
    accountHash: value.accountHash,
    fetchedAt: value.fetchedAt,
    etag: typeof value.etag === "string" ? value.etag : undefined,
    models,
  };
}

async function readCache(filename) {
  try {
    return validateCache(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeCache(filename, document) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await writeFileAtomic(filename, `${JSON.stringify(document)}\n`, { mode: 0o600, dirMode: 0o700 });
}

async function resolveDefaultAuth() {
  const models = createModels({ credentials: openAICodexCredentialStore });
  models.setProvider(openaiCodexProvider());
  const resolution = await models.getAuth(openAICodexProviderId);
  if (typeof resolution?.auth?.apiKey !== "string" || resolution.auth.apiKey.length === 0) return undefined;
  const credential = await openAICodexCredentialStore.read(openAICodexProviderId);
  if (credential?.type !== "oauth" || typeof credential.accountId !== "string" || credential.accountId.length === 0) return undefined;
  return { accessToken: resolution.auth.apiKey, accountId: credential.accountId };
}

export function createOpenAICodexCatalogClient(options = {}) {
  const filename = options.filename ?? openAICodexCatalogPath;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolveAuth = options.resolveAuth ?? resolveDefaultAuth;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientVersion = options.clientVersion ?? process.env.DSH_OPENAI_CODEX_CLIENT_VERSION ?? DEFAULT_CLIENT_VERSION;
  let memory;
  let loading;

  async function load({ force = false, signal } = {}) {
    if (loading !== undefined) return loading;
    loading = (async () => {
      memory ??= await readCache(filename);
      const auth = await resolveAuth();
      if (auth === undefined) {
        return {
          models: memory?.models ?? [],
          source: memory === undefined ? "none" : "cache-no-auth",
          fetchedAt: memory?.fetchedAt,
        };
      }
      const currentAccountHash = accountHash(auth.accountId);
      const sameAccount = memory?.accountHash === currentAccountHash;
      if (!force && sameAccount && now() - memory.fetchedAt < ttlMs) {
        return { models: memory.models, source: "cache-fresh", fetchedAt: memory.fetchedAt };
      }
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        originator: "deepseek-harness",
        "user-agent": `DeepSeekHarness/${clientVersion}`,
      };
      if (sameAccount && memory.etag) headers["if-none-match"] = memory.etag;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      try {
        const response = await fetchImpl(
          `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`,
          { method: "GET", headers, signal: requestSignal },
        );
        if (response.status === 304 && sameAccount && memory !== undefined) {
          memory = { ...memory, fetchedAt: now() };
          await writeCache(filename, memory);
          return { models: memory.models, source: "network-not-modified", fetchedAt: memory.fetchedAt };
        }
        if (!response.ok) throw new Error(`OpenAI Codex 模型目录请求失败：HTTP ${response.status}`);
        const models = normalizeModelsResponse(await response.json());
        memory = {
          version: CACHE_VERSION,
          accountHash: currentAccountHash,
          fetchedAt: now(),
          etag: response.headers.get("etag") ?? undefined,
          models,
        };
        await writeCache(filename, memory);
        return { models: memory.models, source: "network", fetchedAt: memory.fetchedAt };
      } catch (error) {
        if (memory !== undefined) {
          return {
            models: memory.models,
            source: "cache-stale",
            fetchedAt: memory.fetchedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return {
          models: [],
          source: "none",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  return { load };
}

const defaultClient = createOpenAICodexCatalogClient();

export function loadOpenAICodexCatalog(options) {
  return defaultClient.load(options);
}

export function mergeOpenAICodexCatalogModels(baseModels, catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    return baseModels.map((model) => ({
      ...model,
      stardustReasoningEfforts: undefined,
      stardustServiceTiers: [],
      stardustCatalogSource: catalog?.source ?? "pi-static",
    }));
  }
  const byId = new Map(baseModels.map((model) => [model.id, model]));
  const fallback = byId.get("gpt-5.4") ?? baseModels[0];
  if (fallback === undefined) return [];
  return catalog.models.flatMap((entry) => {
    if (entry.visibility !== "list" || !entry.supportedInApi) return [];
    const base = byId.get(entry.slug) ?? fallback;
    const input = entry.inputModalities.length > 0 ? entry.inputModalities : [...base.input];
    return [{
      ...base,
      id: entry.slug,
      name: entry.displayName,
      input,
      reasoning: entry.reasoningEfforts.length > 0,
      thinkingLevelMap: Object.fromEntries([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ].map((level) => [level, entry.reasoningEfforts.includes(level) ? level : null])),
      contextWindow: entry.contextWindow ?? base.contextWindow,
      stardustReasoningEfforts: [...entry.reasoningEfforts],
      stardustServiceTiers: entry.serviceTiers.map((tier) => ({ ...tier })),
      stardustCatalogSource: catalog.source,
      stardustCatalogFetchedAt: catalog.fetchedAt,
    }];
  });
}
