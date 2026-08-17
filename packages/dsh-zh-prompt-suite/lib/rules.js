import { watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const RULE_FILE_PATTERN = /^\d{2}-[^/\\]+\.md$/i;
const REPEATED_GLOBAL_HEADER = [
  "> **这是 DSH 用户全局 Rules，适用于所有会话和工作区，并且始终生效。它在所有用户可配置的文件 Rules 中优先级最高。**",
  ">",
  "> 工作区和目录 Rules 可以补充项目事实，不能覆盖本文件。最新运行状态和宿主安全限制仍按事实执行。",
].join("\n");

function stripRepeatedGlobalHeader(content) {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  return normalized.replace(REPEATED_GLOBAL_HEADER, "").trim();
}

export async function loadRuleModules(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const names = entries
    .filter((entry) => entry.isFile() && RULE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));

  const modules = [];
  for (const name of names) {
    const content = stripRepeatedGlobalHeader(await readFile(join(directory, name), "utf8"));
    if (content.length > 0) modules.push({ name, content });
  }
  return modules;
}

export function renderRuleModules(modules) {
  if (modules.length === 0) return "";
  const body = modules
    .map(({ name, content }) => `【DSH 用户全局规则来源：${basename(name)}】\n\n${content}`)
    .join("\n\n");
  return [
    "【DSH 用户全局规则】",
    "这些规则适用于所有 DSH 会话和工作区，在用户可配置的文件规则中优先级最高。工作区规则可以补充项目事实，但不能覆盖这里的全局要求；宿主当前权限和安全状态始终按真实注入执行。",
    body,
  ].join("\n\n");
}

export function watchRuleModules(directory, onChange, onError = () => {}) {
  let timer;
  let watcher;
  try {
    watcher = watch(directory, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 120);
    });
  } catch (error) {
    if (error?.code !== "ENOENT") onError(error);
    return () => {};
  }
  watcher.on("error", onError);
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
