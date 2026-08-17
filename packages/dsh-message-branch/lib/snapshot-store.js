import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { branchError } from "./errors.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
export const TURN_SNAPSHOT_SCHEMA_VERSION = 1;

function segment(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

export class TurnSnapshotStore {
  constructor({ rootDir }) {
    if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
      throw branchError("invalid_config", "turn snapshot rootDir 必须是绝对路径");
    }
    this.rootDir = path.resolve(rootDir);
  }

  pathFor(sessionId, messageId) {
    if (typeof sessionId !== "string" || sessionId === "" || typeof messageId !== "string" || messageId === "") {
      throw branchError("invalid_request", "turn snapshot 需要非空 sessionId 和 messageId");
    }
    return path.join(this.rootDir, segment(sessionId), `${segment(messageId)}.json.gz`);
  }

  async read(sessionId, messageId) {
    const target = this.pathFor(sessionId, messageId);
    try {
      const snapshot = JSON.parse((await gunzipAsync(await readFile(target))).toString("utf8"));
      this.validate(snapshot, sessionId, messageId);
      return clone(snapshot);
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError || error?.code === "Z_DATA_ERROR") {
        throw branchError("snapshot_corrupt", "该轮历史状态快照损坏", { sessionId, messageId });
      }
      throw error;
    }
  }

  async save(snapshot) {
    this.validate(snapshot, snapshot.sessionId, snapshot.messageId);
    const target = this.pathFor(snapshot.sessionId, snapshot.messageId);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true });
    const temp = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    const backup = `${target}.bak`;
    const payload = await gzipAsync(Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8"), { level: 6 });
    let handle;
    try {
      await copyFile(target, backup).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(payload);
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
    return clone(snapshot);
  }

  validate(snapshot, sessionId, messageId) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw branchError("snapshot_corrupt", "该轮历史状态快照格式无效");
    }
    if (snapshot.schemaVersion !== TURN_SNAPSHOT_SCHEMA_VERSION) {
      throw branchError("snapshot_version", "该轮历史状态快照版本不受支持");
    }
    if (snapshot.sessionId !== sessionId || snapshot.messageId !== messageId) {
      throw branchError("snapshot_corrupt", "该轮历史状态快照身份不匹配");
    }
    if (!Number.isSafeInteger(snapshot.branchPointSeq) || snapshot.branchPointSeq < 0 || !Array.isArray(snapshot.seed)) {
      throw branchError("snapshot_corrupt", "该轮历史状态快照缺少分支前缀");
    }
    if (!Array.isArray(snapshot.participants) || !Array.isArray(snapshot.trackedFiles)) {
      throw branchError("snapshot_corrupt", "该轮历史状态快照缺少内部状态或文件记录");
    }
  }
}
