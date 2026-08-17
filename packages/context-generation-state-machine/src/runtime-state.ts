import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { ContextGenerationError } from "./index.ts";

export const CONTEXT_RUNTIME_STATE_VERSION = 1 as const;

export interface PreparedContextPointer {
  selectionKey: string;
  generationId: string;
  start: number;
  end: number;
  inputSha256: string;
  sourceRevision: string;
  heatState?: PersistedHeatState;
  createdAt: number;
}

export interface PersistedRoundHeat {
  roundId: number;
  heat: number;
  observedAtRound: number;
}

export interface PersistedHeatState {
  targetRoundCount: number;
  observedAtRound: number;
  rounds: PersistedRoundHeat[];
}

export interface HardCompactionFailure {
  reason: string;
  failedAt: number;
}

export interface ExplicitPauseRecovery {
  reason: string;
  recoveredAt: number;
  failure: HardCompactionFailure;
}

export interface ContextRuntimeState {
  version: typeof CONTEXT_RUNTIME_STATE_VERSION;
  sessionId: string;
  paused: boolean;
  pauseReason?: string;
  lastHardFailure?: HardCompactionFailure;
  lastRecovery?: ExplicitPauseRecovery;
  prepared?: PreparedContextPointer;
  publishedGenerationId?: string;
  publishedSelectionKey?: string;
  lastBpcFailure?: string;
  bpcFailureCount?: number;
  nextBpcRetryAt?: number;
  heatState?: PersistedHeatState;
  needsReconcile?: boolean;
  compactionActivity?: {
    trigger: "bpc" | "hard";
    phase: "building" | "prepared" | "applying";
    startedAt: number;
    generationId?: string;
  };
  lastPublishedAt?: number;
  updatedAt: number;
}

export function defaultContextStoreDirectory(): string {
  const dshHome = process.env.DSH_HOME || join(os.homedir(), ".dsh");
  return resolve(process.env.DSH_CONTEXT_STORE_ROOT || join(dshHome, "context-generations-v1"));
}

export function defaultContextRuntimeStateDirectory(): string {
  return join(defaultContextStoreDirectory(), "runtime-state");
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContextGenerationError(`${label} is invalid`, "STORAGE_FAILURE");
  }
  return value;
}

function statePath(rootDirectory: string, sessionId: string): string {
  const segment = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return join(rootDirectory, `session-${segment}.json`);
}

const updateTails = new Map<string, Promise<void>>();

function validateHeatState(value: unknown, label: string): PersistedHeatState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextGenerationError(`${label} is invalid`, "STORAGE_FAILURE");
  }
  const heat = value as Partial<PersistedHeatState>;
  if (!Number.isSafeInteger(heat.targetRoundCount) || heat.targetRoundCount! < 1
    || !Number.isSafeInteger(heat.observedAtRound) || heat.observedAtRound! < 0
    || !Array.isArray(heat.rounds)) {
    throw new ContextGenerationError(`${label} fields are invalid`, "STORAGE_FAILURE");
  }
  const seen = new Set<number>();
  for (const round of heat.rounds) {
    if (!Number.isSafeInteger(round?.roundId) || round.roundId < 1 || seen.has(round.roundId)
      || !Number.isFinite(round.heat) || round.heat < 0
      || !Number.isSafeInteger(round.observedAtRound) || round.observedAtRound < 0) {
      throw new ContextGenerationError(`${label} round entry is invalid`, "STORAGE_FAILURE");
    }
    seen.add(round.roundId);
  }
  return structuredClone(heat as PersistedHeatState);
}

function validateHardFailure(value: unknown, label: string): HardCompactionFailure {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextGenerationError(`${label} is invalid`, "STORAGE_FAILURE");
  }
  const failure = value as Partial<HardCompactionFailure>;
  requireText(failure.reason, `${label} reason`);
  if (!Number.isFinite(failure.failedAt)) {
    throw new ContextGenerationError(`${label} time is invalid`, "STORAGE_FAILURE");
  }
  return structuredClone(failure as HardCompactionFailure);
}

function validateRecovery(value: unknown): ExplicitPauseRecovery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextGenerationError("Context pause recovery is invalid", "STORAGE_FAILURE");
  }
  const recovery = value as Partial<ExplicitPauseRecovery>;
  requireText(recovery.reason, "Context pause recovery reason");
  if (!Number.isFinite(recovery.recoveredAt)) {
    throw new ContextGenerationError("Context pause recovery time is invalid", "STORAGE_FAILURE");
  }
  return {
    reason: recovery.reason!,
    recoveredAt: recovery.recoveredAt!,
    failure: validateHardFailure(recovery.failure, "Context pause recovery failure"),
  };
}

function parseState(value: unknown, expectedSessionId: string): ContextRuntimeState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextGenerationError("Context runtime state is not an object", "STORAGE_FAILURE");
  }
  const state = value as Partial<ContextRuntimeState>;
  if (state.version !== CONTEXT_RUNTIME_STATE_VERSION) {
    throw new ContextGenerationError("Context runtime state version is unsupported", "STORAGE_FAILURE");
  }
  if (requireText(state.sessionId, "Context runtime session id") !== expectedSessionId) {
    throw new ContextGenerationError("Context runtime state belongs to another session", "STORAGE_FAILURE");
  }
  if (typeof state.paused !== "boolean" || !Number.isFinite(state.updatedAt)) {
    throw new ContextGenerationError("Context runtime state fields are invalid", "STORAGE_FAILURE");
  }
  if (state.pauseReason !== undefined) requireText(state.pauseReason, "Context pause reason");
  if (state.lastHardFailure !== undefined) validateHardFailure(state.lastHardFailure, "Context hard compaction failure");
  if (state.lastRecovery !== undefined) validateRecovery(state.lastRecovery);
  if (state.bpcFailureCount !== undefined
    && (!Number.isSafeInteger(state.bpcFailureCount) || state.bpcFailureCount < 0)) {
    throw new ContextGenerationError("Context BPC failure count is invalid", "STORAGE_FAILURE");
  }
  if (state.nextBpcRetryAt !== undefined && !Number.isFinite(state.nextBpcRetryAt)) {
    throw new ContextGenerationError("Context BPC retry time is invalid", "STORAGE_FAILURE");
  }
  if (state.compactionActivity !== undefined) {
    const activity = state.compactionActivity;
    if (!["bpc", "hard"].includes(activity.trigger)
      || !["building", "prepared", "applying"].includes(activity.phase)
      || !Number.isFinite(activity.startedAt)) {
      throw new ContextGenerationError("Context compaction activity is invalid", "STORAGE_FAILURE");
    }
    if (activity.generationId !== undefined) requireText(activity.generationId, "Context compaction generation id");
  }
  if (state.lastPublishedAt !== undefined && !Number.isFinite(state.lastPublishedAt)) {
    throw new ContextGenerationError("Context last publication time is invalid", "STORAGE_FAILURE");
  }
  if (state.prepared !== undefined) {
    const prepared = state.prepared;
    for (const [label, field] of [
      ["selectionKey", prepared.selectionKey],
      ["generationId", prepared.generationId],
      ["inputSha256", prepared.inputSha256],
      ["sourceRevision", prepared.sourceRevision],
    ] as const) requireText(field, `Prepared context ${label}`);
    if (![prepared.start, prepared.end].every(Number.isSafeInteger)
      || prepared.start! < 0
      || prepared.end! < 0
      || !Number.isFinite(prepared.createdAt)) {
      throw new ContextGenerationError("Prepared context range is invalid", "STORAGE_FAILURE");
    }
    if (prepared.heatState !== undefined) validateHeatState(prepared.heatState, "Prepared context heat state");
  }
  if (state.heatState !== undefined) validateHeatState(state.heatState, "Context heat state");
  return structuredClone(state as ContextRuntimeState);
}

export class ContextRuntimeStateStore {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!isAbsolute(rootDirectory)) {
      throw new ContextGenerationError("Context runtime state root must be absolute", "VALIDATION_FAILED");
    }
    this.rootDirectory = rootDirectory;
  }

  async load(sessionId: string): Promise<ContextRuntimeState> {
    requireText(sessionId, "Session id");
    try {
      const parsed = JSON.parse(await readFile(statePath(this.rootDirectory, sessionId), "utf8"));
      return parseState(parsed, sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return {
          version: CONTEXT_RUNTIME_STATE_VERSION,
          sessionId,
          paused: false,
          updatedAt: 0,
        };
      }
      if (error instanceof ContextGenerationError) throw error;
      throw new ContextGenerationError("Context runtime state cannot be read", "STORAGE_FAILURE", { cause: error });
    }
  }

  async save(state: ContextRuntimeState): Promise<void> {
    const validated = parseState(state, state.sessionId);
    await mkdir(this.rootDirectory, { recursive: true });
    const destination = statePath(this.rootDirectory, validated.sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ContextGenerationError("Context runtime state cannot be committed", "STORAGE_FAILURE", { cause: error });
    }
  }

  async update(
    sessionId: string,
    transform: (state: ContextRuntimeState) => ContextRuntimeState,
  ): Promise<ContextRuntimeState> {
    const key = statePath(this.rootDirectory, requireText(sessionId, "Session id"));
    const previous = updateTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    updateTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      const current = await this.load(sessionId);
      const next = transform(structuredClone(current));
      next.version = CONTEXT_RUNTIME_STATE_VERSION;
      next.sessionId = sessionId;
      next.updatedAt = Date.now();
      await this.save(next);
      return structuredClone(next);
    } finally {
      release();
      if (updateTails.get(key) === tail) updateTails.delete(key);
    }
  }
}

export class ContextPauseRecoveryService {
  private readonly states: ContextRuntimeStateStore;

  constructor(states: ContextRuntimeStateStore) {
    this.states = states;
  }

  inspect(sessionId: string): Promise<ContextRuntimeState> {
    return this.states.load(sessionId);
  }

  async resume(sessionId: string, recoveryReason: string): Promise<ContextRuntimeState> {
    const reason = requireText(recoveryReason, "Explicit recovery reason");
    return this.states.update(sessionId, state => {
      if (!state.paused) {
        throw new ContextGenerationError("Context session is not paused", "VALIDATION_FAILED");
      }
      const failure = state.lastHardFailure ?? {
        reason: state.pauseReason ?? "Context session was paused without a recorded failure reason",
        failedAt: state.updatedAt,
      };
      return {
        ...state,
        paused: false,
        pauseReason: undefined,
        lastHardFailure: failure,
        lastRecovery: {
          reason,
          recoveredAt: Date.now(),
          failure,
        },
      };
    });
  }
}
