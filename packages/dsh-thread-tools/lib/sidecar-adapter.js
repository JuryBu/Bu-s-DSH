import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { ThreadIntegrationError } from "./errors.js";
import { SidecarLedgerError, SidecarThreadLedger } from "./sidecar-ledger.js";
import { sha256 } from "./util.js";

const RECEIPT_PREFIX = "dshr1";
const PROTECTION_PREFIX = "dshp1";

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ThreadIntegrationError("thread_ledger_invalid_input", `${label} 不能为空`);
  }
  return value;
}

function encodeTarget(targetSessionId) {
  return Buffer.from(requireText(targetSessionId, "targetSessionId"), "utf8").toString("base64url");
}

function decodeTarget(token, prefix, label) {
  const value = requireText(token, label);
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]) {
    throw new ThreadIntegrationError("thread_ledger_token_invalid", `${label} 不是当前线程工具生成的有效编号`);
  }
  try {
    return requireText(Buffer.from(parts[1], "base64url").toString("utf8"), `${label}.targetSessionId`);
  } catch (error) {
    throw new ThreadIntegrationError("thread_ledger_token_invalid", `${label} 无法还原目标会话`, { cause: error });
  }
}

function ownerSessionId(exec) {
  const session = exec?.agent?.session;
  return requireText(String(session?.id ?? session?.meta?.id ?? session?.header?.id ?? ""), "当前 DSH 会话编号");
}

function contextGenerationId(exec) {
  const session = exec?.agent?.session;
  return requireText(String(exec?.agent?.contextGenerationId
    ?? session?.contextGenerationId
    ?? `session:${ownerSessionId(exec)}:runtime`), "当前上下文代次");
}

function currentHumanRound(exec) {
  const events = exec?.agent?.session?.events;
  if (!Array.isArray(events)) return 0;
  return events.filter(event => event?.type === "user/message" && event?.data?.source?.kind === "user").length;
}

function stablePartialFragment(round) {
  const source = round?.source;
  if (round?.partial !== true) return undefined;
  if (typeof source?.blockId !== "string" || source.blockId.length === 0
    || !Number.isSafeInteger(source.startOffset) || source.startOffset < 0
    || !Number.isSafeInteger(source.endOffset) || source.endOffset <= source.startOffset
    || source.unit !== "utf8-byte"
    || typeof source.contentHash !== "string" || !/^[0-9a-f]{64}$/iu.test(source.contentHash)) {
    return undefined;
  }
  return {
    round: round.round,
    blockId: source.blockId,
    startOffset: source.startOffset,
    endOffset: source.endOffset,
    contentHash: source.contentHash,
  };
}

function confirmableFragments(readResult) {
  const partialRounds = readResult?.rounds?.filter(round => round?.partial === true) ?? [];
  if (readResult?.partial === true && partialRounds.length === 0) return undefined;
  const fragments = partialRounds.map(stablePartialFragment);
  return fragments.some(fragment => fragment === undefined) ? undefined : fragments;
}

function assertConfirmableReadResult(readResult) {
  if (confirmableFragments(readResult) === undefined) {
    throw new ThreadIntegrationError("thread_read_not_complete", "本次读取包含没有稳定 block/offset/content hash 定位符的不完整原始轮，不能签发可确认回执");
  }
}

function defaultRootDir() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.resolve(process.env.DSH_THREAD_LEDGER_ROOT || path.join(dshHome, "thread-ledger-v1"));
}

function mapLedgerError(error) {
  if (error instanceof ThreadIntegrationError) return error;
  if (error instanceof SidecarLedgerError) return new ThreadIntegrationError(error.code, error.message, { cause: error });
  return error;
}

export class SidecarThreadLedgerAdapter {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || defaultRootDir());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  operationId(input, action) {
    if (input?.operationId !== undefined) return requireText(input.operationId, "operationId");
    return requireText(`${action}-${this.idFactory()}`, "operationId");
  }

  token(prefix, targetSessionId, operationId) {
    const discriminator = operationId === undefined
      ? this.idFactory()
      : sha256(`${prefix}\u0000${targetSessionId}\u0000${operationId}`).slice(0, 32);
    return `${prefix}.${encodeTarget(targetSessionId)}.${discriminator}`;
  }

  async open(ownerId, targetSessionId, generationId, sourceRevision) {
    return SidecarThreadLedger.open({
      rootDir: this.rootDir,
      ownerSessionId: ownerId,
      targetSessionId,
      contextGenerationId: generationId,
      sourceRevision,
      idFactory: this.idFactory,
    });
  }

  async ensureForRead(exec, readResult, operationId) {
    const ownerId = ownerSessionId(exec);
    const targetSessionId = requireText(readResult.sessionId, "读取结果的会话编号");
    const generationId = contextGenerationId(exec);
    const sourceRevision = requireText(readResult.sourceRevision ?? readResult.snapshotId, "读取结果的来源版本");
    const ledger = await this.open(ownerId, targetSessionId, generationId, sourceRevision);
    const state = ledger.inspect();
    if (!state.binding) {
      await ledger.initialize({ operationId: `${operationId}:initialize` });
    } else if (state.binding.contextGenerationId !== generationId || state.binding.sourceRevision !== sourceRevision) {
      await ledger.rotateGeneration({
        operationId: `${operationId}:rotate`,
        contextGenerationId: generationId,
        sourceRevision,
        previousContextGenerationId: state.binding.contextGenerationId,
        previousSourceRevision: state.binding.sourceRevision,
      });
    }
    return { ledger, targetSessionId, generationId, sourceRevision };
  }

  async openExisting(exec, targetSessionId) {
    const ownerId = ownerSessionId(exec);
    const generationId = contextGenerationId(exec);
    const probe = await this.open(ownerId, targetSessionId, generationId, "probe-current-binding");
    const state = probe.inspect();
    if (!state.binding) {
      throw new ThreadIntegrationError("thread_ledger_not_initialized", "这条会话尚无有效读取回执，请先用 thread_read 读取需要的轮次");
    }
    if (state.binding.contextGenerationId !== generationId) {
      throw new ThreadIntegrationError("expired_read_receipt", "线程回执属于旧上下文代次，请重新读取需要的历史轮");
    }
    const ledger = await this.open(ownerId, targetSessionId, generationId, state.binding.sourceRevision);
    return { ledger, targetSessionId, generationId, sourceRevision: state.binding.sourceRevision };
  }

  async registerRead(exec, readResult, input = {}) {
    try {
      assertConfirmableReadResult(readResult);
      const operationId = this.operationId(input, "read");
      const opened = await this.ensureForRead(exec, readResult, operationId);
      const fragments = confirmableFragments(readResult);
      return await opened.ledger.registerReceipt({
        operationId,
        readReceiptId: this.token(RECEIPT_PREFIX, opened.targetSessionId, operationId),
        snapshotId: readResult.snapshotId,
        dataSource: readResult.dataSource,
        rounds: readResult.rounds?.map(round => round.round),
        ...(fragments.length === 0 ? {} : { fragments }),
        contextGenerationId: opened.generationId,
        sourceRevision: opened.sourceRevision,
      });
    } catch (error) {
      throw mapLedgerError(error);
    }
  }

  async confirm(exec, input) {
    try {
      const targetSessionId = decodeTarget(input.readReceiptId, RECEIPT_PREFIX, "readReceiptId");
      const opened = await this.openExisting(exec, targetSessionId);
      return await opened.ledger.confirmReceipt({
        operationId: this.operationId(input, "confirm"),
        readReceiptId: input.readReceiptId,
        rounds: input.rounds,
        orderedRounds: input.orderedRounds,
        confirmedAtOwnerRound: currentHumanRound(exec),
        contextGenerationId: opened.generationId,
        sourceRevision: opened.sourceRevision,
      });
    } catch (error) {
      throw mapLedgerError(error);
    }
  }

  async protect(exec, input) {
    try {
      const targetSessionId = requireText(input.sessionId, "sessionId");
      const opened = await this.openExisting(exec, targetSessionId);
      const operationId = this.operationId(input, "protect");
      return await opened.ledger.protect({
        operationId,
        protectionId: this.token(PROTECTION_PREFIX, targetSessionId, operationId),
        ranges: input.ranges,
        contextGenerationId: opened.generationId,
        sourceRevision: opened.sourceRevision,
      });
    } catch (error) {
      throw mapLedgerError(error);
    }
  }

  async release(exec, input) {
    try {
      const targetSessionId = decodeTarget(input.protectionId, PROTECTION_PREFIX, "protectionId");
      if (input.sessionId && input.sessionId !== targetSessionId) {
        throw new ThreadIntegrationError("protection_session_mismatch", "保护编号属于另一条目标会话");
      }
      const opened = await this.openExisting(exec, targetSessionId);
      return await opened.ledger.releaseProtection({
        operationId: this.operationId(input, "release"),
        protectionId: input.protectionId,
        sessionId: targetSessionId,
        contextGenerationId: opened.generationId,
        sourceRevision: opened.sourceRevision,
      });
    } catch (error) {
      throw mapLedgerError(error);
    }
  }
}

export const sidecarTokenFormat = Object.freeze({ receiptPrefix: RECEIPT_PREFIX, protectionPrefix: PROTECTION_PREFIX });
