import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  assert.ok(index >= 0 && argv[index + 1], "必须使用 --root 指定候选发布目录");
  return resolve(argv[index + 1]);
}

function candidateModule(candidateRoot, packageName) {
  return pathToFileURL(join(candidateRoot, "node_modules", "@deepseek-ai", packageName, "lib", "index.js")).href;
}

function assertTemporaryPath(value) {
  const systemTemp = resolve(tmpdir());
  const target = resolve(value);
  const child = relative(systemTemp, target);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), `拒绝清理系统临时目录之外的路径: ${target}`);
  assert.match(child, /^dsh-read-image-candidate-test-/i, `拒绝清理非本测试创建的目录: ${target}`);
  return target;
}

function agentFor(model, cwd) {
  return {
    session: {
      header: { cwd },
      requestHeader: () => ({ config: { provider: "fixture", model } }),
    },
    options: {},
  };
}

const candidateRoot = parseRoot(process.argv.slice(2));
const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-read-image-candidate-test-"));
const imagePath = join(temporaryRoot, "one-pixel.png");
await writeFile(
  imagePath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"),
);

let toolFsFiber;
let attachmentFiber;
let fsFiber;
let toolsFiber;

try {
  const { Context } = await import(candidateModule(candidateRoot, "cordis"));
  const { ToolRuntime } = await import(candidateModule(candidateRoot, "dsh-tools"));
  const { LocalFileSystem } = await import(candidateModule(candidateRoot, "dsh-fs-local"));
  const { LocalAttachmentStore } = await import(candidateModule(candidateRoot, "dsh-attachment-local"));
  const toolFs = await import(candidateModule(candidateRoot, "dsh-tool-fs"));

  const context = new Context();
  context.provide("systemPrompt", { tools() {}, section() {} });
  context.provide("llm", {
    async resolveModelInfo(_provider, model) {
      return { inputModalities: model === "vision" ? ["text", "image"] : ["text"] };
    },
  });

  toolsFiber = context.plugin(ToolRuntime, { mode: "native" });
  await toolsFiber;
  fsFiber = context.plugin(LocalFileSystem, { cwd: temporaryRoot });
  await fsFiber;
  attachmentFiber = context.plugin(LocalAttachmentStore, { dshHome: temporaryRoot });
  await attachmentFiber;
  toolFsFiber = context.plugin(toolFs, {
    readLimit: 2_000,
    readMaxLineLength: 2_000,
    readMaxBytes: 5 * 1024 * 1024,
    readStreamMinSize: 10 * 1024 * 1024,
  });
  await toolFsFiber;

  assert.ok(context.tools.schemas().some((schema) => schema.name === "read_image"));
  const textOnly = await context.tools.execute({
    callId: "read-image-text-only",
    name: "read_image",
    arguments: { file_path: imagePath },
    agent: agentFor("text-only", temporaryRoot),
    signal: new AbortController().signal,
  });
  assert.equal(textOnly.isError, true);
  assert.ok(textOnly.content.some((block) => block.type === "text" && block.text?.includes("does not declare image input")));

  const vision = await context.tools.execute({
    callId: "read-image-vision",
    name: "read_image",
    arguments: { file_path: imagePath },
    agent: agentFor("vision", temporaryRoot),
    signal: new AbortController().signal,
  });
  assert.equal(vision.isError, false, JSON.stringify(vision));
  assert.ok(vision.content.some((block) => block.type === "image" && block.attachment?.mediaType === "image/png"));

  process.stdout.write(`${JSON.stringify({
    candidateRoot,
    toolVisibleWithAttachmentService: true,
    textOnlyRoute: {
      rejected: true,
      reason: textOnly.content.find((block) => block.type === "text")?.text,
    },
    visionRoute: vision.content.find((block) => block.type === "image")?.attachment,
  }, null, 2)}\n`);
} finally {
  await toolFsFiber?.dispose();
  await attachmentFiber?.dispose();
  await fsFiber?.dispose();
  await toolsFiber?.dispose();
  await rm(assertTemporaryPath(temporaryRoot), { recursive: true, force: true });
}
