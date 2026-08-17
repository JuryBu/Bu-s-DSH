import { randomUUID } from "node:crypto";

import { ThreadIntegrationError } from "./errors.js";
import { normalizeRanges } from "./util.js";

export const THREAD_LEDGER_EVENTS = Object.freeze({
  readRegistered: "thread/read-registered",
  usefulMarked: "thread/useful-marked",
  protectionCreated: "thread/protection-created",
  protectionReleased: "thread/protection-released",
});

export class Rc6SessionEventWriter {
  constructor(knownEventTypes) {
    this.knownEventTypes = knownEventTypes ?? new Set();
  }

  append(session, type, data) {
    if (!this.knownEventTypes.has(type)) {
      throw new ThreadIntegrationError(
        "rc6_event_catalog_missing",
        `DSH rc.6 的已知事件目录尚未注册 ${type}；为避免写出重启后无法读取的会话日志，本次账本写入已拒绝`,
      );
    }
    session.append(type, data);
    return { durability: "session-event-log" };
  }
}

export class VolatileThreadEventWriter {
  append() {
    return { durability: "volatile-current-process" };
  }
}

function requireSession(exec) {
  const session = exec?.agent?.session;
  if (!session || typeof session.append !== "function") {
    throw new ThreadIntegrationError("thread_ledger_requires_agent", "线程回执和保护只能写入当前智能体自己的 DSH 会话事件账本");
  }
  return session;
}

function sessionKey(session) {
  return String(session.id ?? session.meta?.id ?? session.header?.id ?? "current-agent-session");
}

function uniqueRounds(rounds) {
  const result = [...new Set((rounds ?? []).map(Number))];
  if (result.some(round => !Number.isSafeInteger(round) || round < 1)) throw new RangeError("轮号必须是正整数");
  return result;
}

function sameMembers(left, right) {
  const rightSet = new Set(right);
  return left.length === rightSet.size && left.every(value => rightSet.has(value));
}

export class ThreadEventLedger {
  constructor(options = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.contextGenerationResolver = options.contextGenerationResolver;
    this.eventWriter = options.eventWriter ?? new VolatileThreadEventWriter();
    this.sessions = new WeakMap();
  }

  stateFor(session) {
    let state = this.sessions.get(session);
    if (!state) {
      state = { receipts: new Map(), protections: new Map() };
      this.sessions.set(session, state);
    }
    return state;
  }

  contextGenerationId(exec, session) {
    return String(this.contextGenerationResolver?.(exec)
      ?? exec?.agent?.contextGenerationId
      ?? session.contextGenerationId
      ?? `session:${sessionKey(session)}:runtime`);
  }

  registerRead(exec, readResult) {
    const session = requireSession(exec);
    const state = this.stateFor(session);
    const rounds = uniqueRounds(readResult.rounds?.map(round => round.round));
    const readReceiptId = `read-${this.idFactory()}`;
    const receipt = {
      version: 1,
      readReceiptId,
      targetSessionId: readResult.sessionId,
      contextGenerationId: this.contextGenerationId(exec, session),
      snapshotId: readResult.snapshotId,
      dataSource: readResult.dataSource,
      rounds,
      confirmedRounds: [],
    };
    const write = this.eventWriter.append(session, THREAD_LEDGER_EVENTS.readRegistered, receipt);
    state.receipts.set(readReceiptId, receipt);
    return { ...receipt, ledgerDurability: write.durability };
  }

  confirm(exec, input) {
    const session = requireSession(exec);
    const state = this.stateFor(session);
    const receipt = state.receipts.get(input.readReceiptId);
    if (!receipt) throw new ThreadIntegrationError("unknown_read_receipt", "找不到这张读取回执；它可能属于别的 DSH 会话或已随运行态重启失效");
    const contextGenerationId = this.contextGenerationId(exec, session);
    if (receipt.contextGenerationId !== contextGenerationId) {
      throw new ThreadIntegrationError("expired_read_receipt", "读取回执不属于当前上下文代次，不能再用于确认历史轮");
    }
    const rounds = uniqueRounds(input.rounds);
    const eligible = new Set(receipt.rounds);
    if (rounds.some(round => !eligible.has(round))) {
      throw new ThreadIntegrationError("round_not_in_read_receipt", "只能确认这张读取回执实际交付过的轮");
    }
    const orderedRounds = input.orderedRounds === undefined ? undefined : uniqueRounds(input.orderedRounds);
    if (orderedRounds && !sameMembers(orderedRounds, rounds)) {
      throw new ThreadIntegrationError("ordered_rounds_mismatch", "ordered_rounds 必须与 rounds 包含完全相同的轮，只用于表达先后顺序");
    }
    const already = new Set(receipt.confirmedRounds);
    const newlyConfirmed = rounds.filter(round => !already.has(round));
    receipt.confirmedRounds.push(...newlyConfirmed);
    let ledgerDurability = "unchanged";
    if (newlyConfirmed.length > 0) {
      const write = this.eventWriter.append(session, THREAD_LEDGER_EVENTS.usefulMarked, {
        version: 1,
        readReceiptId: receipt.readReceiptId,
        targetSessionId: receipt.targetSessionId,
        contextGenerationId,
        rounds: newlyConfirmed,
        ...(orderedRounds ? { orderedRounds: orderedRounds.filter(round => newlyConfirmed.includes(round)) } : {}),
      });
      ledgerDurability = write.durability;
    }
    return {
      readReceiptId: receipt.readReceiptId,
      targetSessionId: receipt.targetSessionId,
      confirmedRounds: newlyConfirmed,
      alreadyConfirmedRounds: rounds.filter(round => already.has(round)),
      ledgerDurability,
    };
  }

  protect(exec, input) {
    const session = requireSession(exec);
    const state = this.stateFor(session);
    const ranges = normalizeRanges(input.ranges);
    if (ranges.length === 0) throw new RangeError("至少提供一个需要保护的轮次范围");
    const protectionId = `protect-${this.idFactory()}`;
    const protection = {
      version: 1,
      protectionId,
      targetSessionId: input.sessionId,
      contextGenerationId: this.contextGenerationId(exec, session),
      ranges,
    };
    const write = this.eventWriter.append(session, THREAD_LEDGER_EVENTS.protectionCreated, protection);
    state.protections.set(protectionId, protection);
    return { ...protection, ledgerDurability: write.durability };
  }

  release(exec, input) {
    const session = requireSession(exec);
    const state = this.stateFor(session);
    const protection = state.protections.get(input.protectionId);
    if (!protection) throw new ThreadIntegrationError("unknown_protection", "找不到仍在生效的线程保护");
    if (input.sessionId && input.sessionId !== protection.targetSessionId) {
      throw new ThreadIntegrationError("protection_session_mismatch", "保护编号属于另一条目标会话");
    }
    const event = {
      version: 1,
      protectionId: protection.protectionId,
      targetSessionId: protection.targetSessionId,
      contextGenerationId: this.contextGenerationId(exec, session),
    };
    const write = this.eventWriter.append(session, THREAD_LEDGER_EVENTS.protectionReleased, event);
    state.protections.delete(input.protectionId);
    return { ...event, ledgerDurability: write.durability };
  }
}
