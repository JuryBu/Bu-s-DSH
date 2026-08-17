import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { branchError } from "./errors.js";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function workspacePath(cwd, value) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof value !== "string" || value === "") return undefined;
  const root = path.resolve(cwd);
  const target = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return target;
}

export function trackedFilesAt(events, cwd) {
  const files = new Map();
  for (const event of events) {
    if (event?.type !== "tool/result") continue;
    const diffs = event.data?.meta?.diffs;
    if (!Array.isArray(diffs)) continue;
    for (const diff of diffs) {
      const target = workspacePath(cwd, diff?.path);
      if (target === undefined) continue;
      if (typeof diff?.newText === "string") {
        files.set(target, {
          path: target,
          content: diff.newText,
          sha256: sha256(diff.newText),
          sourceEventSeq: event.seq,
        });
      } else if (diff?.newText === null) {
        files.set(target, {
          path: target,
          missingAtSnapshot: true,
          sourceEventSeq: event.seq,
        });
      }
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function writeMissingFile(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, target);
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function restoreTrackedFiles(files, cwd) {
  const restored = [];
  const conflicts = [];
  for (const file of files) {
    const target = workspacePath(cwd, file?.path);
    if (target === undefined) {
      conflicts.push({ path: String(file?.path ?? ""), reason: "snapshot_entry_invalid" });
      continue;
    }
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (file?.missingAtSnapshot === true) {
      if (info !== undefined) conflicts.push({ path: target, reason: "file_created_after_snapshot" });
      continue;
    }
    if (typeof file?.content !== "string" || file.sha256 !== sha256(file.content)) {
      conflicts.push({ path: String(file?.path ?? ""), reason: "snapshot_entry_invalid" });
      continue;
    }
    if (info === undefined) {
      await writeMissingFile(target, file.content);
      restored.push({ path: target, sha256: file.sha256 });
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      conflicts.push({ path: target, reason: "current_path_not_regular_file" });
      continue;
    }
    const current = await readFile(target, "utf8");
    if (sha256(current) !== file.sha256) {
      conflicts.push({ path: target, reason: "current_file_changed", expectedSha256: file.sha256, currentSha256: sha256(current) });
    }
  }
  return {
    restored,
    conflicts,
    async rollback() {
      for (const file of [...restored].reverse()) {
        const current = await readFile(file.path, "utf8").catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
        if (current !== undefined && sha256(current) === file.sha256) await unlink(file.path);
      }
    },
  };
}

export function renderFileRestorationWarning(result) {
  const lines = [];
  if (result.restored.length > 0) lines.push(`已从分支快照恢复 ${result.restored.length} 个当时存在、现在缺失的系统补丁文件。`);
  if (result.conflicts.length > 0) {
    lines.push("以下系统补丁文件在分支点之后已变化或路径异常，DSH 保留当前文件，没有强行覆盖：");
    for (const conflict of result.conflicts) lines.push(`- ${conflict.path}（${conflict.reason}）`);
  }
  return lines.join("\n");
}
