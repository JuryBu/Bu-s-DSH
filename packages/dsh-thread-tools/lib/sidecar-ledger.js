import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { normalizeRanges } from "./util.js";

export const SIDECAR_LEDGER_SCHEMA_VERSION = 1;
export const SIDECAR_LEDGER_KIND = "dsh-thread-sidecar";
export const SIDECAR_LEDGER_OPERATIONS = Object.freeze({
  initialized: "ledger/initialized",
  generationRotated: "generation/rotated",
  receiptRegistered: "receipt/registered",
  receiptConfirmed: "receipt/confirmed",
  protectionCreated: "protection/created",
  protectionReleased: "protection/released",
});

const OPERATION_TYPES = new Set(Object.values(SIDECAR_LEDGER_OPERATIONS));
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const processLocks = new Map();

export class SidecarLedgerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SidecarLedgerError";
    this.code = code;
  }
}

export class SidecarLedgerCorruptError extends SidecarLedgerError {
  constructor(message, options = {}) {
    super("ledger_corrupt", message, options);
    this.name = "SidecarLedgerCorruptError";
  }
}

export class SidecarLedgerStaleError extends SidecarLedgerError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "SidecarLedgerStaleError";
  }
}

function canonicalJson(value, label = "value") {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} 必须是可序列化 JSON 值`);
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) {
    throw new TypeError(`${label} 必须是可序列化 JSON 值`);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalJson(item, `${label}[${index}]`)).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} 必须是普通 JSON 对象`);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], `${label}.${key}`)}`).join(",")}}`;
  }
  throw new TypeError(`${label} 必须是可序列化 JSON 值`);
}

function copyJson(value, label) {
  return JSON.parse(canonicalJson(value, label));
}

function hashJson(value, label) {
  return createHash("sha256").update(canonicalJson(value, label), "utf8").digest("hex");
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new SidecarLedgerError("ledger_invalid_input", `${label} 必须是非空且不含控制换行的字符串`);
  }
  return value;
}

function requirePathRoot(rootDir) {
  const value = requireText(String(rootDir ?? ""), "sidecar rootDir");
  if (!path.isAbsolute(value)) throw new SidecarLedgerError("ledger_path_invalid", "sidecar rootDir 必须是绝对路径");
  return path.resolve(value);
}

function encodePathSegment(value, label) {
  const identifier = requireText(value, label);
  if (identifier === "." || identifier === ".." || /[\\/]/u.test(identifier) || path.win32.isAbsolute(identifier) || path.posix.isAbsolute(identifier)) {
    throw new SidecarLedgerError("ledger_path_invalid", `${label} 不能包含路径分隔符或绝对路径`);
  }
  const encoded = Buffer.from(identifier, "utf8").toString("base64url");
  if (!encoded) throw new SidecarLedgerError("ledger_path_invalid", `${label} 编码后为空`);
  return encoded;
}

function assertContained(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SidecarLedgerError("ledger_path_invalid", "sidecar 文件路径越出配置的 rootDir");
  }
}

export function resolveSidecarLedgerPaths({ rootDir, ownerSessionId, targetSessionId }) {
  const resolvedRoot = requirePathRoot(rootDir);
  const ownerSegment = encodePathSegment(ownerSessionId, "ownerSessionId");
  const targetSegment = encodePathSegment(targetSessionId, "targetSessionId");
  const ownerDir = path.join(resolvedRoot, ownerSegment);
  const targetDir = path.join(ownerDir, targetSegment);
  const ledgerPath = path.join(targetDir, "ledger.jsonl");
  const lockPath = path.join(targetDir, "ledger.jsonl.lock");
  for (const candidate of [ownerDir, targetDir, ledgerPath, lockPath]) assertContained(resolvedRoot, candidate);
  return Object.freeze({ rootDir: resolvedRoot, ownerDir, targetDir, ledgerPath, lockPath });
}

function bindingFromRecord(record) {
  return {
    ownerSessionId: record.ownerSessionId,
    targetSessionId: record.targetSessionId,
    contextGenerationId: record.contextGenerationId,
    sourceRevision: record.sourceRevision,
  };
}

function sameBinding(left, right) {
  return Boolean(left && right)
    && left.ownerSessionId === right.ownerSessionId
    && left.targetSessionId === right.targetSessionId
    && left.contextGenerationId === right.contextGenerationId
    && left.sourceRevision === right.sourceRevision;
}

function sameGeneration(left, right) {
  return Boolean(left && right)
    && left.contextGenerationId === right.contextGenerationId
    && left.sourceRevision === right.sourceRevision;
}

function validateHash(value, label) {
  if (value !== null && (typeof value !== "string" || !HASH_PATTERN.test(value))) {
    throw new SidecarLedgerCorruptError(`${label} 不是有效 SHA-256`);
  }
}

function validateRounds(rounds, label, allowEmpty = false) {
  if (!Array.isArray(rounds) || (!allowEmpty && rounds.length === 0)) {
    throw new SidecarLedgerError("ledger_invalid_input", `${label} 必须是非空轮次数组`);
  }
  const seen = new Set();
  for (const round of rounds) {
    if (!Number.isSafeInteger(round) || round < 1 || seen.has(round)) {
      throw new SidecarLedgerError("ledger_invalid_input", `${label} 必须包含不重复的正整数轮次`);
    }
    seen.add(round);
  }
  return [...rounds];
}

function validateFragments(fragments, label = "fragments") {
  if (fragments === undefined) return [];
  if (!Array.isArray(fragments)) throw new SidecarLedgerError("ledger_invalid_input", `${label} 必须是数组`);
  const seen = new Set();
  return fragments.map((fragment, index) => {
    if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) {
      throw new SidecarLedgerError("ledger_invalid_input", `${label}[${index}] 必须是对象`);
    }
    const keys = Object.keys(fragment).sort();
    if (keys.join(",") !== "blockId,contentHash,endOffset,round,startOffset") {
      throw new SidecarLedgerError("ledger_invalid_input", `${label}[${index}] 必须只记录轮次和稳定片段定位符`);
    }
    const round = validateRounds([fragment.round], `${label}[${index}].round`)[0];
    const blockId = requireText(fragment.blockId, `${label}[${index}].blockId`);
    if (!Number.isSafeInteger(fragment.startOffset) || fragment.startOffset < 0
      || !Number.isSafeInteger(fragment.endOffset) || fragment.endOffset <= fragment.startOffset) {
      throw new SidecarLedgerError("ledger_invalid_input", `${label}[${index}] 的 offset 范围无效`);
    }
    if (typeof fragment.contentHash !== "string" || !HASH_PATTERN.test(fragment.contentHash)) {
      throw new SidecarLedgerError("ledger_invalid_input", `${label}[${index}].contentHash 不是有效 SHA-256`);
    }
    const key = `${round}\u0000${blockId}\u0000${fragment.startOffset}\u0000${fragment.endOffset}\u0000${fragment.contentHash}`;
    if (seen.has(key)) throw new SidecarLedgerError("ledger_invalid_input", `${label} 不能重复记录同一实际片段`);
    seen.add(key);
    return { round, blockId, startOffset: fragment.startOffset, endOffset: fragment.endOffset, contentHash: fragment.contentHash };
  });
}

function validateOwnerRound(value, label = "confirmedAtOwnerRound") {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SidecarLedgerError("ledger_invalid_input", `${label} 必须是非负安全整数`);
  }
  return value;
}

function sameMembers(left, right) {
  const rightSet = new Set(right);
  return left.length === rightSet.size && left.every(value => rightSet.has(value));
}

function requestPayloadFromRecord(record, includeConfirmationOwnerRound = false) {
  if (record.operation === SIDECAR_LEDGER_OPERATIONS.receiptRegistered) {
    return {
      readReceiptId: record.payload.readReceiptId,
      snapshotId: record.payload.snapshotId,
      dataSource: record.payload.dataSource,
      rounds: record.payload.rounds,
      ...(record.payload.fragments === undefined ? {} : { fragments: record.payload.fragments }),
    };
  }
  if (record.operation === SIDECAR_LEDGER_OPERATIONS.receiptConfirmed) {
    return {
      readReceiptId: record.payload.readReceiptId,
      rounds: record.payload.rounds,
      ...(record.payload.orderedRounds === undefined ? {} : { orderedRounds: record.payload.orderedRounds }),
      ...(includeConfirmationOwnerRound && record.payload.confirmedAtOwnerRound !== undefined
        ? { confirmedAtOwnerRound: record.payload.confirmedAtOwnerRound }
        : {}),
    };
  }
  if (record.operation === SIDECAR_LEDGER_OPERATIONS.protectionCreated) {
    return { protectionId: record.payload.protectionId, ranges: record.payload.ranges };
  }
  if (record.operation === SIDECAR_LEDGER_OPERATIONS.protectionReleased) {
    return { protectionId: record.payload.protectionId, targetSessionId: record.payload.targetSessionId };
  }
  if (record.operation === SIDECAR_LEDGER_OPERATIONS.generationRotated) {
    return {
      previousContextGenerationId: record.payload.previousContextGenerationId,
      previousSourceRevision: record.payload.previousSourceRevision,
    };
  }
  return {};
}

function requestBodyFromRecord(record, includeConfirmationOwnerRound = false) {
  return {
    operationId: record.operationId,
    operation: record.operation,
    ownerSessionId: record.ownerSessionId,
    targetSessionId: record.targetSessionId,
    contextGenerationId: record.contextGenerationId,
    sourceRevision: record.sourceRevision,
    payload: requestPayloadFromRecord(record, includeConfirmationOwnerRound),
  };
}

function hasValidRequestHash(record) {
  if (hashJson(requestBodyFromRecord(record), "ledger request") === record.requestHash) return true;
  return record.operation === SIDECAR_LEDGER_OPERATIONS.receiptConfirmed
    && hashJson(requestBodyFromRecord(record, true), "ledger request") === record.requestHash;
}

function validateRecordShape(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new SidecarLedgerCorruptError("账本记录不是对象");
  const allowedKeys = new Set([
    "schemaVersion", "kind", "seq", "prevHash", "hash", "operationId", "operation", "ownerSessionId",
    "targetSessionId", "contextGenerationId", "sourceRevision", "requestHash", "payload", "createdAt",
  ]);
  const unknownKeys = Object.keys(record).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length > 0) throw new SidecarLedgerCorruptError(`账本记录含未知字段: ${unknownKeys.join(",")}`);
  if (record.schemaVersion !== SIDECAR_LEDGER_SCHEMA_VERSION) throw new SidecarLedgerCorruptError(`不支持账本 schemaVersion=${String(record.schemaVersion)}`);
  if (record.kind !== SIDECAR_LEDGER_KIND) throw new SidecarLedgerCorruptError(`不支持账本 kind=${String(record.kind)}`);
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) throw new SidecarLedgerCorruptError("账本 seq 必须从 1 开始的安全整数");
  validateHash(record.prevHash, "prevHash");
  if (typeof record.hash !== "string" || !HASH_PATTERN.test(record.hash)) throw new SidecarLedgerCorruptError("hash 不是有效 SHA-256");
  requireText(record.operationId, "operationId");
  if (!OPERATION_TYPES.has(record.operation)) throw new SidecarLedgerCorruptError(`未知账本 operation=${String(record.operation)}`);
  requireText(record.ownerSessionId, "ownerSessionId");
  requireText(record.targetSessionId, "targetSessionId");
  requireText(record.contextGenerationId, "contextGenerationId");
  requireText(record.sourceRevision, "sourceRevision");
  if (typeof record.requestHash !== "string" || !HASH_PATTERN.test(record.requestHash)) throw new SidecarLedgerCorruptError("requestHash 不是有效 SHA-256");
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new SidecarLedgerCorruptError("账本 payload 必须是对象");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new SidecarLedgerCorruptError("createdAt 不是有效时间");
  const withoutHash = { ...record };
  delete withoutHash.hash;
  if (hashJson(withoutHash, "ledger record") !== record.hash) throw new SidecarLedgerCorruptError(`账本 seq=${record.seq} 的 hash 校验失败`);
  if (!hasValidRequestHash(record)) throw new SidecarLedgerCorruptError(`账本 seq=${record.seq} 的 requestHash 校验失败`);
}

function createState() {
  return {
    records: [],
    operations: new Map(),
    receipts: new Map(),
    protections: new Map(),
    protectionHistory: new Map(),
    binding: null,
    lastHash: null,
  };
}

function corrupt(message) {
  throw new SidecarLedgerCorruptError(message);
}

function applyRecord(state, record) {
  validateRecordShape(record);
  const previous = state.records.at(-1);
  if (record.seq !== state.records.length + 1) corrupt(`账本 seq 不连续，期待 ${state.records.length + 1}，实际 ${record.seq}`);
  if (record.prevHash !== (previous?.hash ?? null)) corrupt(`账本 seq=${record.seq} 的 prevHash 不匹配`);
  const identity = bindingFromRecord(record);
  if (state.operations.has(record.operationId)) corrupt(`账本出现重复 operationId=${record.operationId}`);
  if (record.operation === SIDECAR_LEDGER_OPERATIONS.initialized) {
    if (state.binding) corrupt("账本重复初始化");
    if (Object.keys(record.payload).length !== 0) corrupt("账本初始化 payload 必须为空对象");
    state.binding = identity;
  } else if (record.operation === SIDECAR_LEDGER_OPERATIONS.generationRotated) {
    if (!state.binding) corrupt("账本在初始化前切换上下文代次");
    if (record.payload.previousContextGenerationId !== state.binding.contextGenerationId
      || record.payload.previousSourceRevision !== state.binding.sourceRevision) {
      corrupt(`账本 seq=${record.seq} 的前置上下文代次不匹配`);
    }
    requireText(record.payload.previousContextGenerationId, "previousContextGenerationId");
    requireText(record.payload.previousSourceRevision, "previousSourceRevision");
    if (sameGeneration(state.binding, identity)) corrupt("账本代次切换没有改变 generation 或 source revision");
    state.binding = identity;
  } else {
    if (!state.binding) corrupt("账本业务记录出现在初始化前");
    if (!sameBinding(state.binding, identity)) corrupt(`账本 seq=${record.seq} 跨上下文代次写入`);
  }

  const payload = record.payload;
  if (record.operation === SIDECAR_LEDGER_OPERATIONS.receiptRegistered) {
    requireText(payload.readReceiptId, "readReceiptId");
    requireText(payload.snapshotId, "snapshotId");
    requireText(payload.dataSource, "dataSource");
    validateRounds(payload.rounds, "receipt.rounds");
    const fragments = validateFragments(payload.fragments, "receipt.fragments");
    if (fragments.some(fragment => !payload.rounds.includes(fragment.round))) corrupt("回执片段引用未交付的轮次");
    if (!Array.isArray(payload.confirmedRounds) || payload.confirmedRounds.length !== 0) corrupt("新回执 confirmedRounds 必须为空");
    if (state.receipts.has(payload.readReceiptId)) corrupt(`账本重复注册 readReceiptId=${payload.readReceiptId}`);
    state.receipts.set(payload.readReceiptId, {
      readReceiptId: payload.readReceiptId,
      targetSessionId: record.targetSessionId,
      contextGenerationId: record.contextGenerationId,
      sourceRevision: record.sourceRevision,
      snapshotId: payload.snapshotId,
      dataSource: payload.dataSource,
      rounds: [...payload.rounds],
      fragments,
      confirmedRounds: [],
    });
  } else if (record.operation === SIDECAR_LEDGER_OPERATIONS.receiptConfirmed) {
    const receipt = state.receipts.get(payload.readReceiptId);
    if (!receipt) corrupt(`确认引用未知 readReceiptId=${String(payload.readReceiptId)}`);
    if (receipt.contextGenerationId !== record.contextGenerationId || receipt.sourceRevision !== record.sourceRevision) corrupt("确认记录与回执代次不匹配");
    const rounds = validateRounds(payload.rounds, "confirmation.rounds");
    const orderedRounds = payload.orderedRounds === undefined ? undefined : validateRounds(payload.orderedRounds, "confirmation.orderedRounds");
    validateOwnerRound(payload.confirmedAtOwnerRound, "confirmation.confirmedAtOwnerRound");
    if (orderedRounds && !sameMembers(orderedRounds, rounds)) corrupt("orderedRounds 与 rounds 成员不一致");
    if (rounds.some(round => !receipt.rounds.includes(round))) corrupt("确认记录包含回执未交付的轮次");
    const already = new Set(receipt.confirmedRounds);
    const expectedNew = rounds.filter(round => !already.has(round));
    const expectedAlready = rounds.filter(round => already.has(round));
    if (!Array.isArray(payload.newlyConfirmed) || !Array.isArray(payload.alreadyConfirmedRounds)
      || JSON.stringify(payload.newlyConfirmed) !== JSON.stringify(expectedNew)
      || JSON.stringify(payload.alreadyConfirmedRounds) !== JSON.stringify(expectedAlready)) {
      corrupt("确认记录的去重结果不匹配重放状态");
    }
    receipt.confirmedRounds.push(...expectedNew);
  } else if (record.operation === SIDECAR_LEDGER_OPERATIONS.protectionCreated) {
    requireText(payload.protectionId, "protectionId");
    const ranges = normalizeRanges(payload.ranges);
    if (ranges.length === 0 || canonicalJson(ranges, "normalized protection ranges") !== canonicalJson(payload.ranges, "protection ranges")) corrupt("保护范围不是规范化结果");
    if (state.protectionHistory.has(payload.protectionId)) corrupt(`账本重复创建 protectionId=${payload.protectionId}`);
    const protection = {
      protectionId: payload.protectionId,
      targetSessionId: record.targetSessionId,
      contextGenerationId: record.contextGenerationId,
      sourceRevision: record.sourceRevision,
      ranges: copyJson(payload.ranges, "protection.ranges"),
      active: true,
    };
    state.protections.set(payload.protectionId, protection);
    state.protectionHistory.set(payload.protectionId, protection);
  } else if (record.operation === SIDECAR_LEDGER_OPERATIONS.protectionReleased) {
    requireText(payload.protectionId, "protectionId");
    const protection = state.protectionHistory.get(payload.protectionId);
    if (!protection || !state.protections.has(payload.protectionId)) corrupt(`释放引用未知或已释放 protectionId=${payload.protectionId}`);
    if (protection.contextGenerationId !== record.contextGenerationId || protection.sourceRevision !== record.sourceRevision) corrupt("释放记录与保护代次不匹配");
    if (payload.targetSessionId !== protection.targetSessionId) corrupt("释放记录与保护目标不匹配");
    state.protections.delete(payload.protectionId);
    protection.active = false;
  }
  state.records.push(record);
  state.operations.set(record.operationId, record);
  state.lastHash = record.hash;
}

async function readLedgerFile(paths, expectedIdentity) {
  let bytes;
  try {
    bytes = await fs.readFile(paths.ledgerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: createState(), validBytes: 0, tornTail: false, fileExists: false };
    throw new SidecarLedgerError("ledger_unavailable", `无法读取 sidecar ledger: ${error.message}`, { cause: error });
  }
  const lastNewline = bytes.lastIndexOf(0x0a);
  const validBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  const prefix = bytes.subarray(0, validBytes);
  const tornTail = validBytes < bytes.length;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
  } catch (error) {
    throw new SidecarLedgerCorruptError("账本完整前缀不是有效 UTF-8", { cause: error });
  }
  const state = createState();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.length === 0) corrupt("账本中出现空行");
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new SidecarLedgerCorruptError("账本完整行不是有效 JSON", { cause: error });
    }
    if (record.ownerSessionId !== expectedIdentity.ownerSessionId || record.targetSessionId !== expectedIdentity.targetSessionId) {
      corrupt("账本记录的 owner/target 与当前 sidecar 路径不匹配");
    }
    applyRecord(state, record);
  }
  return { state, validBytes, tornTail, fileExists: true };
}

async function truncateAndSync(filePath, byteLength) {
  let handle;
  try {
    handle = await fs.open(filePath, "r+");
    await handle.truncate(byteLength);
    await handle.sync();
  } catch (error) {
    throw new SidecarLedgerError("ledger_recovery_failed", `无法截断 sidecar 最终破损尾行: ${error.message}`, { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function appendAndSync(filePath, line, expectedBytes) {
  let handle;
  let before = expectedBytes;
  try {
    handle = await fs.open(filePath, "a+");
    before = (await handle.stat()).size;
    if (before !== expectedBytes) throw new Error(`append 前文件大小发生变化，期待 ${expectedBytes}，实际 ${before}`);
    const buffer = Buffer.from(`${line}\n`, "utf8");
    const result = await handle.write(buffer, 0, buffer.length);
    if (result.bytesWritten !== buffer.length) throw new Error("sidecar append 未写完整行");
    await handle.sync();
    const after = (await handle.stat()).size;
    if (after !== before + buffer.length) throw new Error("sidecar append 后文件大小不符合预期");
    return after;
  } catch (error) {
    try {
      if (handle) {
        await handle.truncate(before);
        await handle.sync();
      }
    } catch (rollbackError) {
      throw new SidecarLedgerCorruptError("sidecar append 失败且回滚失败，已拒绝继续写入", { cause: rollbackError });
    }
    if (error instanceof SidecarLedgerError) throw error;
    throw new SidecarLedgerError("ledger_append_failed", `sidecar append 失败，已回滚到 ${before} 字节: ${error.message}`, { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function acquireFileLock(lockPath) {
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle) await fs.rm(lockPath, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") throw new SidecarLedgerError("ledger_lock_unavailable", "sidecar 已有其它进程持有锁，拒绝并发写入");
    throw new SidecarLedgerError("ledger_lock_failed", `无法创建 sidecar 独占锁: ${error.message}`, { cause: error });
  }
  return async () => {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  };
}

async function withProcessLock(key, callback) {
  const previous = processLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  processLocks.set(key, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (processLocks.get(key) === current) processLocks.delete(key);
  }
}

function operationRequest({ operationId, operation, binding, payload }) {
  return {
    operationId,
    operation,
    ownerSessionId: binding.ownerSessionId,
    targetSessionId: binding.targetSessionId,
    contextGenerationId: binding.contextGenerationId,
    sourceRevision: binding.sourceRevision,
    payload: copyJson(payload, "operation payload"),
  };
}

function requestHashFor(request) {
  return hashJson(request, "ledger request");
}

function sameOperationRequest(record, request) {
  return requestHashFor(requestBodyFromRecord(record)) === requestHashFor(request);
}

function recordFromRequest(request, state, payload) {
  const recordWithoutHash = {
    schemaVersion: SIDECAR_LEDGER_SCHEMA_VERSION,
    kind: SIDECAR_LEDGER_KIND,
    seq: state.records.length + 1,
    prevHash: state.lastHash,
    operationId: request.operationId,
    operation: request.operation,
    ownerSessionId: request.ownerSessionId,
    targetSessionId: request.targetSessionId,
    contextGenerationId: request.contextGenerationId,
    sourceRevision: request.sourceRevision,
    requestHash: requestHashFor(request),
    payload: copyJson(payload, "record payload"),
    createdAt: new Date().toISOString(),
  };
  return {
    ...recordWithoutHash,
    hash: hashJson(recordWithoutHash, "ledger record"),
  };
}

function assertCurrentBinding(state, binding, action) {
  if (!state.binding) throw new SidecarLedgerError("ledger_not_initialized", "sidecar 尚未初始化上下文代次");
  if (state.binding.ownerSessionId !== binding.ownerSessionId || state.binding.targetSessionId !== binding.targetSessionId) {
    throw new SidecarLedgerError("ledger_session_mismatch", `${action} 的 owner/target 与 sidecar 不匹配`);
  }
  if (state.binding.contextGenerationId !== binding.contextGenerationId) {
    throw new SidecarLedgerStaleError("ledger_stale_generation", `${action} 属于旧 contextGenerationId，已拒绝`);
  }
  if (state.binding.sourceRevision !== binding.sourceRevision) {
    throw new SidecarLedgerStaleError("ledger_stale_source_revision", `${action} 属于旧 sourceRevision，已拒绝`);
  }
}

function publicReceipt(receipt) {
  return {
    ...copyJson(receipt, "receipt"),
    confirmedRounds: [...receipt.confirmedRounds],
  };
}

function publicProtection(protection) {
  return copyJson(protection, "protection");
}

export class SidecarThreadLedger {
  constructor(options) {
    const ownerSessionId = requireText(options?.ownerSessionId, "ownerSessionId");
    const targetSessionId = requireText(options?.targetSessionId, "targetSessionId");
    const contextGenerationId = requireText(options?.contextGenerationId, "contextGenerationId");
    const sourceRevision = requireText(options?.sourceRevision, "sourceRevision");
    this.paths = resolveSidecarLedgerPaths({ rootDir: options?.rootDir, ownerSessionId, targetSessionId });
    this.ownerSessionId = ownerSessionId;
    this.targetSessionId = targetSessionId;
    this.contextGenerationId = contextGenerationId;
    this.sourceRevision = sourceRevision;
    this.idFactory = options?.idFactory ?? randomUUID;
    this.state = createState();
    this.tornTail = false;
    this.validBytes = 0;
  }

  static async open(options) {
    const ledger = new SidecarThreadLedger(options);
    await ledger.refresh();
    return ledger;
  }

  get ledgerPath() {
    return this.paths.ledgerPath;
  }

  get lockPath() {
    return this.paths.lockPath;
  }

  binding() {
    return {
      ownerSessionId: this.ownerSessionId,
      targetSessionId: this.targetSessionId,
      contextGenerationId: this.contextGenerationId,
      sourceRevision: this.sourceRevision,
    };
  }

  async refresh() {
    const loaded = await readLedgerFile(this.paths, {
      ownerSessionId: this.ownerSessionId,
      targetSessionId: this.targetSessionId,
    });
    this.state = loaded.state;
    this.validBytes = loaded.validBytes;
    this.tornTail = loaded.tornTail;
    return this.inspect();
  }

  inspect() {
    const binding = this.state.binding ? copyJson(this.state.binding, "ledger binding") : null;
    const receipts = [...this.state.receipts.values()].map(publicReceipt);
    const activeProtections = [...this.state.protections.values()]
      .filter(protection => this.state.binding && sameGeneration(protection, this.state.binding))
      .map(publicProtection);
    const confirmationHistory = this.state.records
      .filter(record => record.operation === SIDECAR_LEDGER_OPERATIONS.receiptConfirmed
        && this.state.binding
        && sameGeneration(record, this.state.binding))
      .map(record => ({
        readReceiptId: record.payload.readReceiptId,
        confirmedRounds: [...record.payload.newlyConfirmed],
        ...(record.payload.orderedRounds === undefined ? {} : { orderedRounds: [...record.payload.orderedRounds] }),
        ...(record.payload.confirmedAtOwnerRound === undefined ? {} : { confirmedAtOwnerRound: record.payload.confirmedAtOwnerRound }),
        createdAt: record.createdAt,
      }));
    return {
      ledgerPath: this.ledgerPath,
      recordCount: this.state.records.length,
      lastHash: this.state.lastHash,
      binding,
      receipts,
      confirmationHistory,
      activeProtections,
      tornTail: this.tornTail,
      validBytes: this.validBytes,
      durable: true,
    };
  }

  async _append({ operationId, operation, binding, requestPayload, makePayload = () => requestPayload, preflight }) {
    requireText(operationId, "operationId");
    if (!OPERATION_TYPES.has(operation)) throw new SidecarLedgerError("ledger_invalid_input", `未知 sidecar operation=${operation}`);
    const request = operationRequest({ operationId, operation, binding, payload: requestPayload });
    return withProcessLock(this.ledgerPath, async () => {
      try {
        await fs.mkdir(this.paths.targetDir, { recursive: true });
      } catch (error) {
        throw new SidecarLedgerError("ledger_unavailable", `无法创建 sidecar 目录: ${error.message}`, { cause: error });
      }
      const releaseFileLock = await acquireFileLock(this.lockPath);
      try {
        const loaded = await readLedgerFile(this.paths, {
          ownerSessionId: this.ownerSessionId,
          targetSessionId: this.targetSessionId,
        });
        const existing = loaded.state.operations.get(operationId);
        if (existing) {
          if (!sameOperationRequest(existing, request)) throw new SidecarLedgerError("ledger_operation_conflict", `operationId=${operationId} 已绑定另一种操作`);
          this.state = loaded.state;
          this.validBytes = loaded.validBytes;
          this.tornTail = loaded.tornTail;
          return { record: copyJson(existing, "existing ledger record"), duplicate: true };
        }
        preflight?.(loaded.state);
        const payload = makePayload(loaded.state);
        const record = recordFromRequest(request, loaded.state, payload);
        applyRecord(loaded.state, record);
        if (loaded.tornTail) {
          await truncateAndSync(this.ledgerPath, loaded.validBytes);
        }
        const nextBytes = await appendAndSync(this.ledgerPath, canonicalJson(record, "ledger record"), loaded.validBytes);
        this.state = loaded.state;
        this.validBytes = nextBytes;
        this.tornTail = false;
        if (operation === SIDECAR_LEDGER_OPERATIONS.generationRotated) {
          this.contextGenerationId = binding.contextGenerationId;
          this.sourceRevision = binding.sourceRevision;
        }
        return { record, duplicate: false };
      } finally {
        await releaseFileLock();
      }
    });
  }

  async initialize({ operationId }) {
    const binding = this.binding();
    const result = await this._append({
      operationId,
      operation: SIDECAR_LEDGER_OPERATIONS.initialized,
      binding,
      requestPayload: {},
      preflight: state => {
        if (state.binding) throw new SidecarLedgerError("ledger_already_initialized", "sidecar 已经初始化，不能重复初始化");
      },
    });
    return { ledgerDurability: "sidecar-hash-chain", ledgerSeq: result.record.seq, duplicate: result.duplicate, binding };
  }

  async rotateGeneration({ operationId, contextGenerationId, sourceRevision, previousContextGenerationId = this.state.binding?.contextGenerationId, previousSourceRevision = this.state.binding?.sourceRevision }) {
    const nextBinding = {
      ownerSessionId: this.ownerSessionId,
      targetSessionId: this.targetSessionId,
      contextGenerationId: requireText(contextGenerationId, "contextGenerationId"),
      sourceRevision: requireText(sourceRevision, "sourceRevision"),
    };
    const previousGeneration = requireText(previousContextGenerationId, "previousContextGenerationId");
    const previousRevision = requireText(previousSourceRevision, "previousSourceRevision");
    const result = await this._append({
      operationId,
      operation: SIDECAR_LEDGER_OPERATIONS.generationRotated,
      binding: nextBinding,
      requestPayload: { previousContextGenerationId: previousGeneration, previousSourceRevision: previousRevision },
      preflight: state => {
        if (!state.binding) throw new SidecarLedgerError("ledger_not_initialized", "sidecar 尚未初始化，不能切换上下文代次");
        if (state.binding.contextGenerationId !== previousGeneration || state.binding.sourceRevision !== previousRevision) {
          throw new SidecarLedgerStaleError("ledger_stale_generation", "generation 切换的前置代次不是 sidecar 当前代次");
        }
        if (sameGeneration(state.binding, nextBinding)) throw new SidecarLedgerError("ledger_invalid_input", "generation 切换必须改变 contextGenerationId 或 sourceRevision");
      },
    });
    this.contextGenerationId = nextBinding.contextGenerationId;
    this.sourceRevision = nextBinding.sourceRevision;
    return { ledgerDurability: "sidecar-hash-chain", ledgerSeq: result.record.seq, duplicate: result.duplicate, binding: nextBinding };
  }

  async registerReceipt({ operationId, readReceiptId = `read-${operationId}`, snapshotId, dataSource, rounds, fragments, contextGenerationId = this.contextGenerationId, sourceRevision = this.sourceRevision }) {
    const binding = { ...this.binding(), contextGenerationId: requireText(contextGenerationId, "contextGenerationId"), sourceRevision: requireText(sourceRevision, "sourceRevision") };
    const normalizedFragments = validateFragments(fragments);
    const requestPayload = {
      readReceiptId: requireText(readReceiptId, "readReceiptId"),
      snapshotId: requireText(snapshotId, "snapshotId"),
      dataSource: requireText(dataSource, "dataSource"),
      rounds: validateRounds(rounds, "rounds"),
      ...(normalizedFragments.length === 0 ? {} : { fragments: normalizedFragments }),
    };
    const result = await this._append({
      operationId,
      operation: SIDECAR_LEDGER_OPERATIONS.receiptRegistered,
      binding,
      requestPayload,
      makePayload: state => {
        assertCurrentBinding(state, binding, "registerReceipt");
        if (state.receipts.has(requestPayload.readReceiptId)) throw new SidecarLedgerError("ledger_duplicate_receipt", `readReceiptId=${requestPayload.readReceiptId} 已存在`);
        return { ...requestPayload, confirmedRounds: [] };
      },
      preflight: state => assertCurrentBinding(state, binding, "registerReceipt"),
    });
    const payload = result.record.payload;
    return {
      ...copyJson(payload, "receipt payload"),
      contextGenerationId: result.record.contextGenerationId,
      sourceRevision: result.record.sourceRevision,
      ledgerDurability: "sidecar-hash-chain",
      ledgerSeq: result.record.seq,
      duplicate: result.duplicate,
    };
  }

  async confirmReceipt({ operationId, readReceiptId, rounds, orderedRounds, confirmedAtOwnerRound, contextGenerationId = this.contextGenerationId, sourceRevision = this.sourceRevision }) {
    const binding = { ...this.binding(), contextGenerationId: requireText(contextGenerationId, "contextGenerationId"), sourceRevision: requireText(sourceRevision, "sourceRevision") };
    const requestPayload = {
      readReceiptId: requireText(readReceiptId, "readReceiptId"),
      rounds: validateRounds(rounds, "rounds"),
      ...(orderedRounds === undefined ? {} : { orderedRounds: validateRounds(orderedRounds, "orderedRounds") }),
    };
    const confirmationMetadata = confirmedAtOwnerRound === undefined ? {} : { confirmedAtOwnerRound: validateOwnerRound(confirmedAtOwnerRound) };
    if (requestPayload.orderedRounds && !sameMembers(requestPayload.orderedRounds, requestPayload.rounds)) throw new SidecarLedgerError("ledger_invalid_input", "orderedRounds 与 rounds 成员不一致");
    const result = await this._append({
      operationId,
      operation: SIDECAR_LEDGER_OPERATIONS.receiptConfirmed,
      binding,
      requestPayload,
      makePayload: state => {
        assertCurrentBinding(state, binding, "confirmReceipt");
        const receipt = state.receipts.get(requestPayload.readReceiptId);
        if (!receipt) throw new SidecarLedgerError("unknown_read_receipt", `找不到 readReceiptId=${requestPayload.readReceiptId}`);
        if (receipt.contextGenerationId !== binding.contextGenerationId || receipt.sourceRevision !== binding.sourceRevision) throw new SidecarLedgerStaleError("ledger_stale_receipt", "读取回执不属于当前上下文代次或 source revision");
        if (requestPayload.rounds.some(round => !receipt.rounds.includes(round))) throw new SidecarLedgerError("round_not_in_read_receipt", "只能确认回执实际交付过的轮次");
        const already = new Set(receipt.confirmedRounds);
        const newlyConfirmed = requestPayload.rounds.filter(round => !already.has(round));
        const alreadyConfirmedRounds = requestPayload.rounds.filter(round => already.has(round));
        return { ...requestPayload, ...confirmationMetadata, newlyConfirmed, alreadyConfirmedRounds };
      },
      preflight: state => assertCurrentBinding(state, binding, "confirmReceipt"),
    });
    return {
      readReceiptId: result.record.payload.readReceiptId,
      targetSessionId: result.record.targetSessionId,
      confirmedRounds: [...result.record.payload.newlyConfirmed],
      alreadyConfirmedRounds: [...result.record.payload.alreadyConfirmedRounds],
      contextGenerationId: result.record.contextGenerationId,
      sourceRevision: result.record.sourceRevision,
      ledgerDurability: "sidecar-hash-chain",
      ledgerSeq: result.record.seq,
      duplicate: result.duplicate,
    };
  }

  async protect({ operationId, protectionId = `protect-${operationId}`, ranges, contextGenerationId = this.contextGenerationId, sourceRevision = this.sourceRevision }) {
    const binding = { ...this.binding(), contextGenerationId: requireText(contextGenerationId, "contextGenerationId"), sourceRevision: requireText(sourceRevision, "sourceRevision") };
    const requestPayload = {
      protectionId: requireText(protectionId, "protectionId"),
      ranges: normalizeRanges(ranges),
    };
    if (requestPayload.ranges.length === 0) throw new SidecarLedgerError("ledger_invalid_input", "至少提供一个需要保护的轮次范围");
    const result = await this._append({
      operationId,
      operation: SIDECAR_LEDGER_OPERATIONS.protectionCreated,
      binding,
      requestPayload,
      makePayload: state => {
        assertCurrentBinding(state, binding, "protect");
        if (state.protectionHistory.has(requestPayload.protectionId)) throw new SidecarLedgerError("ledger_duplicate_protection", `protectionId=${requestPayload.protectionId} 已存在`);
        return requestPayload;
      },
      preflight: state => assertCurrentBinding(state, binding, "protect"),
    });
    return {
      ...copyJson(result.record.payload, "protection payload"),
      targetSessionId: result.record.targetSessionId,
      contextGenerationId: result.record.contextGenerationId,
      sourceRevision: result.record.sourceRevision,
      ledgerDurability: "sidecar-hash-chain",
      ledgerSeq: result.record.seq,
      duplicate: result.duplicate,
    };
  }

  async releaseProtection({ operationId, protectionId, sessionId, contextGenerationId = this.contextGenerationId, sourceRevision = this.sourceRevision }) {
    const binding = { ...this.binding(), contextGenerationId: requireText(contextGenerationId, "contextGenerationId"), sourceRevision: requireText(sourceRevision, "sourceRevision") };
    const requestPayload = {
      protectionId: requireText(protectionId, "protectionId"),
      targetSessionId: sessionId === undefined ? this.targetSessionId : requireText(sessionId, "sessionId"),
    };
    if (requestPayload.targetSessionId !== this.targetSessionId) throw new SidecarLedgerError("ledger_session_mismatch", "释放目标与 sidecar targetSessionId 不匹配");
    const result = await this._append({
      operationId,
      operation: SIDECAR_LEDGER_OPERATIONS.protectionReleased,
      binding,
      requestPayload,
      makePayload: state => {
        assertCurrentBinding(state, binding, "releaseProtection");
        const protection = state.protectionHistory.get(requestPayload.protectionId);
        if (!protection) throw new SidecarLedgerError("unknown_protection", `找不到 protectionId=${requestPayload.protectionId}`);
        if (!state.protections.has(requestPayload.protectionId)) throw new SidecarLedgerError("protection_already_released", `protectionId=${requestPayload.protectionId} 已释放`);
        if (protection.contextGenerationId !== binding.contextGenerationId || protection.sourceRevision !== binding.sourceRevision) throw new SidecarLedgerStaleError("ledger_stale_protection", "保护属于旧上下文代次或 source revision");
        return requestPayload;
      },
      preflight: state => assertCurrentBinding(state, binding, "releaseProtection"),
    });
    return {
      protectionId: result.record.payload.protectionId,
      targetSessionId: result.record.payload.targetSessionId,
      contextGenerationId: result.record.contextGenerationId,
      sourceRevision: result.record.sourceRevision,
      ledgerDurability: "sidecar-hash-chain",
      ledgerSeq: result.record.seq,
      duplicate: result.duplicate,
    };
  }
}
