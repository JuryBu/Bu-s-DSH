import { randomUUID } from "node:crypto";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { readWindsurfCredential, windsurfApiKeyAuth } from "./runtime.js";
import { loadWindsurfUpstream } from "./upstream.js";
import { isWindsurfImageAttachmentModel } from "./capabilities.js";

const PROVIDER_ID = "windsurf";
const DEFAULT_HOST = "https://server.codeium.com";
const CATALOG_TTL_MS = 5 * 60_000;
export const WINDSURF_SAFE_MAX_OUTPUT_TOKENS = 8_192;

const familyMetadata = [
  ["claude-5-fable", 1_000_000, 128_000],
  ["claude-fable-5", 1_000_000, 128_000],
  ["claude-opus-5", 1_000_000, 128_000],
  ["claude-opus-4-8", 200_000, 128_000],
  ["claude-opus-4-7", 1_000_000, 128_000],
  ["claude-opus-4-6", 200_000, 128_000],
  ["MODEL_CLAUDE_4_5_OPUS", 200_000, 128_000],
  ["claude-sonnet-5", 200_000, 64_000],
  ["claude-sonnet-4-6", 200_000, 64_000],
  ["glm-5-2", 200_000, 131_000],
  ["kimi-k3", 1_000_000, 128_000],
  ["kimi-k2-7", 256_000, 256_000],
  ["kimi-k2-6", 256_000, 256_000],
  ["MODEL_GOOGLE_GEMINI_3_0_FLASH", 1_048_576, 128_000],
  ["gemini-3-7-flash", 1_048_576, 128_000],
  ["gemini-3-6-flash", 1_048_576, 128_000],
  ["gemini-3-5-flash", 1_048_576, 128_000],
  ["gemini-3-1-pro", 1_000_000, 128_000],
  ["MODEL_GOOGLE_GEMINI_2_5_PRO", 1_048_576, 128_000],
  ["grok-4-6", 500_000, 128_000],
  ["grok-4-5", 500_000, 128_000],
  ["swe-1-7-lightning", 202_752, 128_000],
  ["swe-1-7", 262_000, 128_000],
  ["swe-1-6", 200_000, 128_000],
  ["deepseek-v4-flash", 1_048_576, 128_000],
  ["deepseek-v4-pro", 1_048_576, 128_000],
  ["gpt-5-3-codex", 400_000, 128_000],
  ["gpt-5-4-mini", 400_000, 128_000],
  ["gpt-5-5", 272_000, 128_000],
  ["gpt-5-4", 272_000, 128_000],
  ["MODEL_GPT_5_2", 384_000, 128_000]
];

export function normalizeWindsurfMaxOutputTokens(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return WINDSURF_SAFE_MAX_OUTPUT_TOKENS;
  return Math.min(value, WINDSURF_SAFE_MAX_OUTPUT_TOKENS);
}

const directCascadeUnsupportedFamilies = [
  "gpt-5-6-sol",
  "gpt-5-6-terra",
  "gpt-5-6-luna"
];

const fallbackModels = [
  ["claude-5-fable-high", "Claude Fable 5 High"],
  ["claude-opus-5-high", "Claude Opus 5 High"],
  ["claude-opus-4-8-high", "Claude Opus 4.8 High"],
  ["claude-opus-4-7-high", "Claude Opus 4.7 High"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-opus-4-6-1m", "Claude Opus 4.6 1M"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking"],
  ["claude-opus-4-6-thinking-1m", "Claude Opus 4.6 Thinking 1M"],
  ["MODEL_CLAUDE_4_5_OPUS", "Claude Opus 4.5"],
  ["MODEL_CLAUDE_4_5_OPUS_THINKING", "Claude Opus 4.5 Thinking"],
  ["MODEL_CLAUDE_4_SONNET", "Claude Sonnet 4"],
  ["MODEL_CLAUDE_4_SONNET_THINKING", "Claude Sonnet 4 Thinking"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["glm-5-2-max", "GLM-5.2 Max"],
  ["kimi-k2-7-max", "Kimi K2.7 Max"],
  ["gemini-3-1-pro-high", "Gemini 3.1 Pro High"],
  ["MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH", "Gemini 3 Flash High"],
  ["MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM", "Gemini 3 Flash Medium"],
  ["MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW", "Gemini 3 Flash Low"],
  ["MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL", "Gemini 3 Flash Minimal"],
  ["gemini-3-6-flash-high", "Gemini 3.6 Flash High"],
  ["MODEL_GOOGLE_GEMINI_2_5_PRO", "Gemini 2.5 Pro"],
  ["MODEL_GPT_5_2_NONE", "GPT-5.2 No Thinking"],
  ["MODEL_GPT_5_2_NONE_PRIORITY", "GPT-5.2 No Thinking Fast"],
  ["MODEL_GPT_5_2_LOW", "GPT-5.2 Low Thinking"],
  ["MODEL_GPT_5_2_LOW_PRIORITY", "GPT-5.2 Low Thinking Fast"],
  ["MODEL_GPT_5_2_MEDIUM", "GPT-5.2 Medium Thinking"],
  ["MODEL_GPT_5_2_MEDIUM_PRIORITY", "GPT-5.2 Medium Thinking Fast"],
  ["MODEL_GPT_5_2_HIGH", "GPT-5.2 High Thinking"],
  ["MODEL_GPT_5_2_HIGH_PRIORITY", "GPT-5.2 High Thinking Fast"],
  ["MODEL_GPT_5_2_XHIGH", "GPT-5.2 XHigh Thinking"],
  ["MODEL_GPT_5_2_XHIGH_PRIORITY", "GPT-5.2 XHigh Priority"],
  ["swe-1-7-lightning-medium", "SWE-1.7 Lightning Medium"],
  ["swe-1-7", "SWE-1.7"],
  ["swe-1-6", "SWE-1.6"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"]
];

const visionToolNames = new Set(["read_image", "view_image", "inspect_image"]);

export function isWindsurfVisionTool(tool) {
  return visionToolNames.has(tool?.name)
    || tool?.requiresVision === true
    || tool?.requires_vision === true
    || Array.isArray(tool?.inputModalities) && tool.inputModalities.includes("image");
}

function variantReasoningEffort(modelUid, label) {
  const tokens = `${modelUid} ${label}`.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  if (tokens.includes("none") || (tokens.includes("no") && tokens.includes("thinking"))) return "off";
  const effort = [...tokens].reverse().find(token => ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(token));
  if (effort) return effort;
  if (tokens.includes("thinking") || tokens.includes("reasoning")) return "high";
  return modelUid === "swe-1-7" ? "max" : undefined;
}

function metadataFor(modelUid) {
  let best;
  for (const candidate of familyMetadata) {
    if (modelUid === candidate[0] || modelUid.startsWith(`${candidate[0]}-`) || modelUid.startsWith(`${candidate[0]}_`)) {
      if (!best || candidate[0].length > best[0].length) best = candidate;
    }
  }
  if (!best) return [modelUid, 256_000, 128_000];
  const suffix = modelUid.slice(best[0].length).replace(/^[-_]+/u, "");
  if (suffix.split(/[-_]+/u).includes("1m")) return [best[0], 1_000_000, best[2]];
  return best;
}

const devinLocalOnlyPattern = /\b(?:only\s+(?:(?:available|supported|usable)\s+)?in\s+devin\s+local|devin\s+local[-\s]+only)\b/iu;

function modelMetadata(value, iterFields, entries = [], depth = 0) {
  if (depth >= 3) return entries;
  let fields;
  try {
    fields = [...iterFields(value)];
  } catch {
    return entries;
  }
  for (const field of fields) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    const text = field.value.toString("utf8").trim();
    if (/\bdevin\s+local\b/iu.test(text)) entries.push(text);
    modelMetadata(field.value, iterFields, entries, depth + 1);
  }
  return entries;
}

function fieldsOf(value, iterFields) {
  try {
    return [...iterFields(value)];
  } catch {
    return [];
  }
}

function realtimeCapability(value, iterFields) {
  let contextWindowTokens;
  let supportsVision = false;
  const fields = fieldsOf(value, iterFields);
  for (const field of fields) {
    if (field.num === 18 && field.wire === 0) {
      const parsed = Number(field.value);
      if (Number.isSafeInteger(parsed) && parsed > 0) contextWindowTokens = parsed;
      continue;
    }
    if (field.num !== 23 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    for (const capabilityGroup of fieldsOf(field.value, iterFields)) {
      if (capabilityGroup.num !== 6 || capabilityGroup.wire !== 2 || !Buffer.isBuffer(capabilityGroup.value)) continue;
      for (const flag of fieldsOf(capabilityGroup.value, iterFields)) {
        if (flag.num === 11 && flag.wire === 0 && flag.value === 1n) supportsVision = true;
      }
    }
  }
  return { authority: "realtime", contextWindowTokens, supportsVision };
}

export function parseWindsurfCatalogModelConfig(value, iterFields) {
  let label = "";
  let modelUid = "";
  let disabled = false;
  for (const child of iterFields(value)) {
    if (child.num === 1 && child.wire === 2 && Buffer.isBuffer(child.value)) label = child.value.toString("utf8");
    else if (child.num === 4 && child.wire === 0) disabled = child.value === 1n;
    else if (child.num === 22 && child.wire === 2 && Buffer.isBuffer(child.value)) modelUid = child.value.toString("utf8");
  }
  return {
    modelUid,
    label,
    disabled,
    metadata: modelMetadata(value, iterFields),
    capability: realtimeCapability(value, iterFields)
  };
}

export function isWindsurfCloudCallableModel(model) {
  const directCascadeUnsupported = directCascadeUnsupportedFamilies.some((family) => (
    model.modelUid === family
    || model.modelUid.startsWith(`${family}-`)
    || model.modelUid.startsWith(`${family}_`)
  ));
  return model.disabled !== true
    && !directCascadeUnsupported
    && !model.metadata.some((entry) => devinLocalOnlyPattern.test(entry));
}

function piModel(modelUid, label, capability = {}) {
  const [, fallbackContextWindow, fallbackMaxTokens] = metadataFor(modelUid);
  const contextWindow = Number.isSafeInteger(capability.contextWindowTokens) && capability.contextWindowTokens > 0
    ? capability.contextWindowTokens
    : fallbackContextWindow;
  const maxTokens = normalizeWindsurfMaxOutputTokens(fallbackMaxTokens);
  const stardustVariantEffort = variantReasoningEffort(modelUid, label);
  return {
    id: modelUid,
    name: label || modelUid,
    api: "windsurf-cloud",
    provider: PROVIDER_ID,
    baseUrl: DEFAULT_HOST,
    reasoning: false,
    input: capability.supportsVision === true && isWindsurfImageAttachmentModel(modelUid) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    stardustReasoningEfforts: [],
    ...(stardustVariantEffort === undefined ? {} : { stardustVariantEffort })
  };
}

function fallbackModelObjects() {
  return fallbackModels.map(([id, name]) => piModel(id, name));
}

export function windsurfFallbackCatalogModels() {
  return fallbackModelObjects().map((model) => ({
    modelUid: model.id,
    label: model.name,
    disabled: false,
    capability: {
      authority: "realtime",
      contextWindowTokens: model.contextWindow,
      supportsVision: Array.isArray(model.input) && model.input.includes("image"),
      reasoningLevels: model.stardustVariantEffort ? [model.stardustVariantEffort] : []
    }
  }));
}

export function mergeWindsurfCatalogModels(liveModels, { disabledModelIds = [] } = {}) {
  const merged = new Map();
  for (const model of fallbackModelObjects()) {
    merged.set(model.id, model);
  }
  for (const model of Array.isArray(liveModels) ? liveModels : []) merged.set(model.id, {
    ...model,
    maxTokens: normalizeWindsurfMaxOutputTokens(model.maxTokens)
  });
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

let models = mergeWindsurfCatalogModels([]);
let catalogCache;

async function fetchCatalog(apiKey, host, signal) {
  const cacheKey = `${host}\u001f${apiKey}`;
  if (catalogCache?.key === cacheKey && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) return catalogCache.models;
  const upstream = await loadWindsurfUpstream();
  const userJwt = await upstream.getCachedUserJwt(apiKey, host, signal);
  const metadata = upstream.buildMetadata({
    apiKey,
    userJwt,
    sessionId: randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: randomUUID()
  });
  const response = await fetch(`${host.replace(/\/$/u, "")}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
    method: "POST",
    headers: { "content-type": "application/proto", "connect-protocol-version": "1" },
    body: upstream.encodeMessage(1, metadata),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Windsurf 模型目录请求失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const next = [];
  const disabledModelIds = [];
  for (const field of upstream.iterFields(buffer)) {
    if (field.num !== 1 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    const model = parseWindsurfCatalogModelConfig(field.value, upstream.iterFields);
    if (model.modelUid && model.disabled === true) disabledModelIds.push(model.modelUid);
    if (model.modelUid && isWindsurfCloudCallableModel(model)) next.push(piModel(model.modelUid, model.label, model.capability));
  }
  if (next.length === 0) throw new Error("Windsurf 没有返回当前账号可用的目标模型");
  const merged = mergeWindsurfCatalogModels(next, { disabledModelIds });
  catalogCache = { key: cacheKey, fetchedAt: Date.now(), models: merged };
  return merged;
}

function mapContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (part?.type === "text") return [{ type: "text", text: part.text }];
    if (part?.type === "image") return [{ type: "image", mimeType: part.mimeType, base64Data: part.data }];
    return [];
  });
}

export function normalizeWindsurfToolDescription(description) {
  if (typeof description !== "string") return description;
  return description.replace(/(^|[^\p{L}\p{N}_])-1(?![\d.])/gu, "$1minus one");
}

function normalizeWindsurfToolSchema(value) {
  if (Array.isArray(value)) return value.map((entry) => normalizeWindsurfToolSchema(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "description" ? normalizeWindsurfToolDescription(entry) : normalizeWindsurfToolSchema(entry)
  ]));
}

export function mapWindsurfContext(context, model = {}) {
  const messages = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages ?? []) {
    if (message.role === "user") messages.push({ role: "user", content: mapContent(message.content) });
    else if (message.role === "assistant") {
      const text = (message.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
      const toolCalls = (message.content ?? []).filter((part) => part?.type === "toolCall").map((part) => ({ id: part.id, name: part.name, arguments: JSON.stringify(part.arguments ?? {}) }));
      messages.push({ role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else if (message.role === "toolResult") {
      messages.push({ role: "tool", content: mapContent(message.content), tool_call_id: message.toolCallId });
    }
  }
  const supportsVision = Array.isArray(model.input) && model.input.includes("image");
  const tools = (context.tools ?? []).filter(tool => supportsVision || !isWindsurfVisionTool(tool)).map((tool) => ({
    name: tool.name,
    description: normalizeWindsurfToolDescription(tool.description),
    parameters: normalizeWindsurfToolSchema(tool.parameters)
  }));
  return { messages, tools };
}

function closeToolCall(stream, output, index, partialJson) {
  const block = output.content[index];
  if (!block || block.type !== "toolCall") return;
  try {
    block.arguments = partialJson ? JSON.parse(partialJson) : {};
  } catch {
    block.arguments = { _raw: partialJson };
  }
  stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
}

function streamWindsurf(model, context, options = {}) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now()
    };
    let textIndex = -1;
    let thinkingIndex = -1;
    let toolIndex = -1;
    let toolArgs = "";
    let usageReported = false;
    try {
      if (!options.apiKey) throw new Error("尚未配置 Windsurf OAuth 或 API Key");
      const upstream = await loadWindsurfUpstream();
      const mapped = mapWindsurfContext(context, model);
      const maxOutputTokens = normalizeWindsurfMaxOutputTokens(options.maxTokens ?? model.maxTokens);
      stream.push({ type: "start", partial: output });
      for await (const event of upstream.streamChatEvents({
        apiKey: options.apiKey,
        apiServerUrl: options.baseUrl ?? model.baseUrl ?? DEFAULT_HOST,
        modelUid: model.id,
        messages: mapped.messages,
        tools: mapped.tools.length ? mapped.tools : undefined,
        signal: options.signal,
        completionOpts: { maxOutputTokens }
      })) {
        if (event.kind === "text") {
          if (thinkingIndex >= 0) {
            stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: output.content[thinkingIndex].thinking, partial: output });
            thinkingIndex = -1;
          }
          if (textIndex < 0) {
            output.content.push({ type: "text", text: "" });
            textIndex = output.content.length - 1;
            stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
          }
          output.content[textIndex].text += event.text;
          stream.push({ type: "text_delta", contentIndex: textIndex, delta: event.text, partial: output });
        } else if (event.kind === "reasoning") {
          if (textIndex >= 0) {
            stream.push({ type: "text_end", contentIndex: textIndex, content: output.content[textIndex].text, partial: output });
            textIndex = -1;
          }
          if (thinkingIndex < 0) {
            output.content.push({ type: "thinking", thinking: "" });
            thinkingIndex = output.content.length - 1;
            stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
          }
          output.content[thinkingIndex].thinking += event.text;
          stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: event.text, partial: output });
        } else if (event.kind === "tool_call_start") {
          if (toolIndex >= 0) closeToolCall(stream, output, toolIndex, toolArgs);
          output.content.push({ type: "toolCall", id: event.id, name: event.name, arguments: {} });
          toolIndex = output.content.length - 1;
          toolArgs = "";
          stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
        } else if (event.kind === "tool_call_args" && toolIndex >= 0) {
          toolArgs += event.argsDelta;
          stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: event.argsDelta, partial: output });
        } else if (event.kind === "usage") {
          usageReported = true;
          output.usage.input = event.promptTokens ?? output.usage.input;
          output.usage.output = event.completionTokens ?? output.usage.output;
          output.usage.cacheRead = event.cachedInputTokens ?? output.usage.cacheRead;
          output.usage.cacheWrite = event.cacheCreationInputTokens ?? output.usage.cacheWrite;
          output.usage.totalTokens = event.totalTokens ?? output.usage.input + output.usage.output;
        } else if (event.kind === "finish") {
          output.stopReason = event.reason === "tool_calls" ? "toolUse" : event.reason === "length" ? "length" : "stop";
        }
      }
      if (textIndex >= 0) stream.push({ type: "text_end", contentIndex: textIndex, content: output.content[textIndex].text, partial: output });
      if (thinkingIndex >= 0) stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: output.content[thinkingIndex].thinking, partial: output });
      if (toolIndex >= 0) closeToolCall(stream, output, toolIndex, toolArgs);
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      if (!usageReported) delete output.usage;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => undefined);
  return stream;
}

let singleton;

export function createWindsurfPiProvider({ apiKeyAuth = windsurfApiKeyAuth, readCredential = readWindsurfCredential } = {}) {
  const useSingleton = apiKeyAuth === windsurfApiKeyAuth && readCredential === readWindsurfCredential;
  if (useSingleton && singleton) return singleton;
  const provider = {
    id: PROVIDER_ID,
    name: "Windsurf / Devin",
    baseUrl: DEFAULT_HOST,
    auth: { apiKey: apiKeyAuth },
    getModels: () => models,
    async refreshModels({ signal } = {}) {
      const credential = await readCredential();
      if (!credential) return;
      const next = await fetchCatalog(credential.apiKey, credential.apiServerUrl ?? DEFAULT_HOST, signal);
      models = next;
    },
    stream: streamWindsurf,
    streamSimple: streamWindsurf
  };
  if (useSingleton) singleton = provider;
  return provider;
}

export function resetWindsurfRuntimeCaches() {
  catalogCache = undefined;
  models = mergeWindsurfCatalogModels([]);
}
