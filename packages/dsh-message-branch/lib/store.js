import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { MESSAGE_BRANCH_SCHEMA_VERSION } from "./contract.js";
import { branchError, MessageBranchError } from "./errors.js";

const SUPPORTED_MESSAGE_BRANCH_SCHEMA_VERSIONS = new Set([1, MESSAGE_BRANCH_SCHEMA_VERSION]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function operationFileName(operationId) {
  return `${createHash("sha256").update(operationId).digest("hex")}.json`;
}

function canonicalSidecarName(fileName) {
  return /^[a-f0-9]{64}\.json$/.test(fileName);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "EPERM", "EISDIR", "EBADF"]).has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export class BranchRecordStore {
  constructor({ rootDir, now = () => new Date().toISOString(), readFileImpl = readFile }) {
    if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
      throw branchError("invalid_config", "message branch storeDirectory 必须是绝对路径");
    }
    this.rootDir = path.resolve(rootDir);
    this.now = now;
    this.readFile = readFileImpl;
  }

  pathFor(operationId) {
    if (typeof operationId !== "string" || operationId.trim() === "") {
      throw branchError("invalid_request", "operationId 必须是非空字符串");
    }
    return path.join(this.rootDir, operationFileName(operationId));
  }

  async read(operationId) {
    try {
      const record = JSON.parse(await this.readFile(this.pathFor(operationId), "utf8"));
      this.validate(record, operationId);
      return clone(record);
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw branchError("branch_store_corrupt", "消息分支 sidecar 不是合法 JSON", { operationId });
      throw error;
    }
  }

  async save(record) {
    this.validate(record, record.operationId);
    await mkdir(this.rootDir, { recursive: true });
    const target = this.pathFor(record.operationId);
    const prior = await this.read(record.operationId);
    this.validateTransition(prior, record);
    const temp = path.join(this.rootDir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, target);
      await syncDirectory(this.rootDir);
    } finally {
      await handle?.close();
      await unlink(temp).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    return clone(record);
  }

  async list({ skipInvalid = false, onInvalid } = {}) {
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(this.rootDir, entry.name);
      let raw;
      try {
        raw = await this.readFile(file, "utf8");
      } catch (error) {
        throw error;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
        this.validate(parsed, parsed.operationId);
        if (entry.name !== operationFileName(parsed.operationId)) {
          throw branchError("branch_store_corrupt", "消息分支 sidecar 文件名与 operationId 不匹配");
        }
        records.push(parsed);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof MessageBranchError)) throw error;
        const failure = branchError(error instanceof MessageBranchError ? error.code : "branch_store_corrupt", `无法读取消息分支 sidecar：${entry.name}`, {
          cause: String(error),
          fileName: entry.name,
          canonicalFileName: canonicalSidecarName(entry.name),
          ...(typeof parsed?.editedMessageId === "string" ? { editedMessageId: parsed.editedMessageId } : {}),
        });
        if (!skipInvalid) throw failure;
        onInvalid?.(failure);
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }

  async findByEditedMessageId(messageId, { onInvalid } = {}) {
    let blockingFailure;
    const records = await this.list({
      skipInvalid: true,
      onInvalid: failure => {
        onInvalid?.(failure);
        const editedMessageId = failure.details?.editedMessageId;
        const confirmedUnrelated = typeof editedMessageId === "string"
          ? editedMessageId !== messageId
          : failure.details?.canonicalFileName === false;
        if (!confirmedUnrelated && blockingFailure === undefined) blockingFailure = failure;
      },
    });
    if (blockingFailure !== undefined) {
      throw branchError("branch_store_conflict", "消息分支记录损坏，无法确认目标消息的附件与分支状态；已保留现有文件，请先修复记录再重发", {
        cause: blockingFailure.message,
        ...blockingFailure.details,
      });
    }
    return records.find(record => record.state === "created" && record.editedMessageId === messageId);
  }

  validate(record, expectedOperationId) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw branchError("branch_store_corrupt", "消息分支 sidecar 记录格式无效");
    }
    if (typeof record.operationId !== "string" || record.operationId === "") {
      throw branchError("branch_store_corrupt", "消息分支 sidecar 缺少 operationId");
    }
    if (!SUPPORTED_MESSAGE_BRANCH_SCHEMA_VERSIONS.has(record.schemaVersion)) {
      throw branchError("branch_store_version", "消息分支 sidecar 版本不受支持", { schemaVersion: record.schemaVersion });
    }
    if (record.operationId !== expectedOperationId) {
      throw branchError("branch_store_corrupt", "消息分支 sidecar operationId 不匹配");
    }
    if (!new Set(["preparing", "created", "failed"]).has(record.state)) {
      throw branchError("branch_store_corrupt", "消息分支 sidecar state 不受支持", { state: record.state });
    }
    for (const field of ["parentSessionId", "sourceMessageId", "externalEffects", "requestDigest", "createdAt", "updatedAt"]) {
      if (typeof record[field] !== "string" || record[field] === "") {
        throw branchError("branch_store_corrupt", `消息分支 sidecar 缺少 ${field}`);
      }
    }
    for (const field of ["sourceEventSeq", "sourceTurn", "branchPointSeq"]) {
      if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
        throw branchError("branch_store_corrupt", `消息分支 sidecar ${field} 无效`);
      }
    }
    if (!Array.isArray(record.participantIds) || !record.attachments || !Array.isArray(record.attachments.images) || !Array.isArray(record.attachments.files)) {
      throw branchError("branch_store_corrupt", "消息分支 sidecar 附件或参与者格式无效");
    }
    if (record.externalEffects !== "preserved") {
      throw branchError("branch_store_corrupt", "消息分支 sidecar 不得声称外部副作用已撤销");
    }
  }

  validateTransition(prior, next) {
    if (!prior) {
      if (next.state !== "preparing") throw branchError("invalid_state_transition", "首个消息分支状态必须是 preparing");
      return;
    }
    if (prior.requestDigest !== next.requestDigest) {
      throw branchError("operation_conflict", "相同 operationId 对应了不同请求", { operationId: next.operationId });
    }
    const allowed = {
      preparing: new Set(["preparing", "created", "failed"]),
      created: new Set(["created"]),
      failed: new Set(["failed"]),
    };
    if (!allowed[prior.state].has(next.state)) {
      throw branchError("invalid_state_transition", `消息分支状态不能从 ${prior.state} 变为 ${next.state}`);
    }
  }
}

export async function assertRegularWorkspaceFiles(files) {
  const normalized = [];
  for (const file of files) {
    if (file.workspacePath === undefined) {
      normalized.push(file);
      continue;
    }
    let info;
    try {
      info = await stat(file.workspacePath);
    } catch (error) {
      throw branchError("attachment_unavailable", `文件附件不可读取：${file.name}`, { code: error?.code });
    }
    if (!info.isFile()) throw branchError("attachment_unavailable", `文件附件不是普通文件：${file.name}`);
    if (file.bytes !== undefined && file.bytes !== info.size) {
      throw branchError("attachment_changed", `文件附件大小已变化：${file.name}`, { expected: file.bytes, actual: info.size });
    }
    normalized.push({ ...file, bytes: info.size });
  }
  return normalized;
}
