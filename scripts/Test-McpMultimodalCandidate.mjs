import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(current.slice(2), true);
      continue;
    }
    values.set(current.slice(2), next);
    index += 1;
  }
  return values;
}

function assertCandidateRoot(value) {
  assert.equal(typeof value, "string", "必须使用 --root 指定候选发布目录");
  const candidateRoot = resolve(value);
  assert.ok(isAbsolute(candidateRoot), "候选发布目录必须是绝对路径");
  return candidateRoot;
}

function assertTemporaryPath(value) {
  const systemTemp = resolve(tmpdir());
  const target = resolve(value);
  const child = relative(systemTemp, target);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), `拒绝清理系统临时目录之外的路径: ${target}`);
  assert.match(child, /^dsh-mcp-candidate-test-/i, `拒绝清理非本测试创建的目录: ${target}`);
  return target;
}

function candidateModule(candidateRoot, packageName, modulePath = "lib/index.js") {
  return pathToFileURL(join(candidateRoot, "node_modules", "@deepseek-ai", packageName, modulePath)).href;
}

const values = parseArgs(process.argv.slice(2));
const candidateRoot = assertCandidateRoot(values.get("root"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-mcp-candidate-test-"));
process.env.DSH_MCP_ARTIFACT_ROOT = join(temporaryRoot, "mcp-artifacts");

let mcpFiber;
let attachmentFiber;
let toolsFiber;

try {
  const { Context } = await import(candidateModule(candidateRoot, "cordis"));
  const { ToolRuntime } = await import(candidateModule(candidateRoot, "dsh-tools"));
  const { LocalAttachmentStore } = await import(candidateModule(candidateRoot, "dsh-attachment-local"));
  const mcpClient = await import(candidateModule(candidateRoot, "dsh-mcp-client"));

  const context = new Context();
  context.provide("systemPrompt", { tools() {}, section() {} });
  context.provide("llm", {
    async resolveModelInfo() {
      return { inputModalities: ["text", "image"] };
    },
  });

  toolsFiber = context.plugin(ToolRuntime, { mode: "native" });
  await toolsFiber;
  attachmentFiber = context.plugin(LocalAttachmentStore, { dshHome: temporaryRoot });
  await attachmentFiber;

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
  const serverCode = [
    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    "import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    "const server = new Server({ name: 'stardust-multimodal-fixture', version: '1' }, { capabilities: { tools: {} } });",
    "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'multimedia', description: '多媒体桥接验收夹具', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));",
    `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'hello-mcp' }, { type: 'image', data: '${png}', mimeType: 'image/png' }, { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }, { type: 'resource', resource: { uri: 'fixture://note', mimeType: 'text/plain', text: 'resource-body' } }] }));`,
    "await server.connect(new StdioServerTransport());",
  ].join("\n");

  mcpFiber = context.plugin(mcpClient, {
    transport: "stdio",
    serverName: "fixture",
    command: process.execPath,
    args: ["--input-type=module", "-e", serverCode],
    env: {},
    cwd: candidateRoot,
    toolCallTimeoutMs: 10_000,
    failOnStartupError: true,
    reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 1 },
  });
  await mcpFiber;

  assert.ok(context.tools.schemas().some((schema) => schema.name === "mcp__fixture__multimedia"));
  const result = await context.tools.execute({
    callId: "mcp-multimodal-candidate-test",
    name: "mcp__fixture__multimedia",
    arguments: {},
    agent: {
      session: { requestHeader: () => ({ config: { provider: "fixture", model: "vision" } }) },
      options: {},
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.isError, false);
  assert.ok(result.content.some((block) => block.type === "image" && block.attachment?.mediaType === "image/png"));
  assert.ok(result.content.some((block) => block.type === "text" && block.text === "hello-mcp"));
  assert.ok(result.content.some((block) => block.type === "text" && block.text?.includes("MCP 音频 已完整保存")));
  assert.ok(result.content.some((block) => block.type === "text" && block.text?.includes("resource-body")));
  assert.ok(result.content.every((block) => !block.text?.includes("content discarded")));

  const artifactNames = await readdir(process.env.DSH_MCP_ARTIFACT_ROOT);
  const artifactBlocks = await Promise.all(
    artifactNames.map(async (name) => JSON.parse(await readFile(join(process.env.DSH_MCP_ARTIFACT_ROOT, name), "utf8"))),
  );
  assert.deepEqual(new Set(artifactBlocks.map((block) => block.type)), new Set(["audio", "resource"]));

  process.stdout.write(`${JSON.stringify({
    candidateRoot,
    tool: "mcp__fixture__multimedia",
    image: result.content.find((block) => block.type === "image")?.attachment,
    artifactTypes: artifactBlocks.map((block) => block.type).sort(),
    discardedPlaceholderSeen: false,
  }, null, 2)}\n`);
} finally {
  await mcpFiber?.dispose();
  await attachmentFiber?.dispose();
  await toolsFiber?.dispose();
  await rm(assertTemporaryPath(temporaryRoot), { recursive: true, force: true });
}
