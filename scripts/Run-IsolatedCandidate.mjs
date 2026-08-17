import { access, cp, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error(`无效参数：${name ?? "<missing>"}`);
    }
    values.set(name.slice(2), value);
  }
  const candidate = values.get("candidate");
  const root = values.get("root");
  const profileSource = values.get("profile-source");
  const port = Number.parseInt(values.get("port") ?? "", 10);
  if (!candidate || !root || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("必须提供 --candidate、--root 和有效的 --port");
  }
  return {
    candidate: resolve(candidate),
    root: resolve(root),
    profileSource: profileSource ? resolve(profileSource) : undefined,
    port,
  };
}

const { candidate, root, profileSource, port } = parseArguments(process.argv.slice(2));
if (!isAbsolute(candidate) || !isAbsolute(root)) {
  throw new Error("候选目录和隔离数据目录必须是绝对路径");
}
if (profileSource && !isAbsolute(profileSource)) {
  throw new Error("隔离 Profile 来源目录必须是绝对路径");
}

const entry = join(candidate, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
await access(entry);

if (profileSource) {
  await access(profileSource);
  const profileTarget = join(root, "profiles", "web");
  await mkdir(profileTarget, { recursive: true });
  await cp(profileSource, profileTarget, { recursive: true, force: true });
}

process.env.DSH_HOME = root;
process.env.DSH_OAUTH_STORE_PATH = join(root, "state", "openai-codex-oauth.dpapi");
process.env.DSH_OPENAI_CODEX_MODELS_PATH = join(root, "state", "openai-codex-models.json");
process.env.DSH_WINDSURF_STORE_DIR = join(root, "windsurf");
process.env.DSH_THREAD_LEDGER_ROOT = join(root, "thread-ledger");
process.env.DSH_CONTEXT_STORE_ROOT = join(root, "context-state");
process.chdir(candidate);
process.argv = [process.execPath, entry, "--profile", "web", "--host", "127.0.0.1", "--port", String(port)];

await import(pathToFileURL(entry).href);
