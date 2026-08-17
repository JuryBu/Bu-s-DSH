import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(argv) {
  const candidateIndex = argv.indexOf("--candidate");
  if (candidateIndex < 0 || !argv[candidateIndex + 1]) throw new Error("必须传 --candidate <候选目录名>");
  return argv[candidateIndex + 1];
}

const candidateName = parseArguments(process.argv.slice(2));
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const candidateRoot = path.join(workspaceRoot, "release", "candidates", candidateName);
const moduleUrl = relativePath => pathToFileURL(path.join(candidateRoot, "node_modules", ...relativePath)).href;

const [{ PiAiAdapter }, fauxModule] = await Promise.all([
  import(moduleUrl(["@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"])),
  import(moduleUrl(["@earendil-works", "pi-ai", "dist", "providers", "faux.js"])),
]);

const faux = fauxModule.fauxProvider({
  provider: "fixture-capability",
  models: [
    {
      id: "fixture-text",
      name: "Fixture Text",
      reasoning: false,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    {
      id: "fixture-vision",
      name: "Fixture Vision",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
  ],
});

const captured = [];
faux.setResponses([
  (context, _options, _state, model) => {
    captured.push({ model: model.id, context: structuredClone(context) });
    return fauxModule.fauxAssistantMessage("text route ok");
  },
  (context, _options, _state, model) => {
    captured.push({ model: model.id, context: structuredClone(context) });
    return fauxModule.fauxAssistantMessage("vision route ok");
  },
]);

const profile = {
  displayName: "Fixture Capability",
  piProvider: faux.provider,
  configuredMaxTokens: new Map(),
  headers: {},
  streamIdleTimeoutMs: 30_000,
};
const profiles = new Map([[faux.provider.id, profile]]);
const adapter = new PiAiAdapter({
  profiles: () => profiles,
  async resolveApiKey() { return undefined; },
});

const tools = [
  {
    name: "read_image",
    description: "读取图片",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read",
    description: "读取文本",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

async function invoke(model) {
  const stream = adapter.stream({
    provider: faux.provider.id,
    model,
    system: "候选能力门控验收",
    messages: [{ role: "user", content: [{ type: "text", text: "检查工具目录" }] }],
    tools,
    signal: new AbortController().signal,
  });
  for await (const _chunk of stream) {}
}

await invoke("fixture-text");
await invoke("fixture-vision");

assert.equal(captured.length, 2);
const textRoute = captured.find(entry => entry.model === "fixture-text");
const visionRoute = captured.find(entry => entry.model === "fixture-vision");
assert.ok(textRoute);
assert.ok(visionRoute);
assert.deepEqual(textRoute.context.tools.map(tool => tool.name), ["read"]);
assert.match(textRoute.context.systemPrompt, /当前模型仅支持文本输入/);
assert.deepEqual(visionRoute.context.tools.map(tool => tool.name), ["read_image", "read"]);
assert.equal(visionRoute.context.systemPrompt, "候选能力门控验收");

process.stdout.write(`${JSON.stringify({
  ok: true,
  candidate: candidateName,
  textRouteTools: textRoute.context.tools.map(tool => tool.name),
  visionRouteTools: visionRoute.context.tools.map(tool => tool.name),
  textCapabilityNoticeInjected: /当前模型仅支持文本输入/.test(textRoute.context.systemPrompt),
}, null, 2)}\n`);
