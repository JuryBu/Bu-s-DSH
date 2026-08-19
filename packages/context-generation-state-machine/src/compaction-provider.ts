import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";

import { toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { SidecarThreadLedger } from "@stardust/dsh-thread-tools";

import { assertMeasuredContextBudget, buildStableContext } from "./context-builder.ts";
import { FileGenerationStore } from "./file-store.ts";
import { buildHeatDetailPlan } from "./heat-integration.ts";
import {
  ContextGenerationError,
  createCandidate,
  validateCandidate,
  type StoredGeneration,
  type ValidatedGeneration,
} from "./index.ts";
import {
  BrokerRecordContextSource,
  RecordCoverageError,
  type RecordContextBuildResult,
  type RecordContextSource,
} from "./record-context-source.ts";
import {
  ContextPauseRecoveryService,
  ContextRuntimeStateStore,
  defaultContextRuntimeStateDirectory,
  defaultContextStoreDirectory,
  type PreparedContextPointer,
} from "./runtime-state.ts";

const BPC_RATIO = 0.68;
const HARD_RATIO = 0.9;
const RETAIN_RATIO = 0.16;
const RESPONSE_RESERVE_RATIO = 0.08;
const MIN_RESPONSE_RESERVE_TOKENS = 8_192;
const MIN_STABLE_PREFIX_TOKENS = 8_192;
const BPC_RETRY_BASE_MS = 5_000;
const BPC_RETRY_MAX_MS = 60_000;
const HARD_FAILURE_RETRIES = 2;
const HARD_RETRY_BASE_MS = 250;
const PROVIDER_NAME = "memory-store";
const PROVIDER_MODEL = "record-context";

interface SurfaceRange {
  start: number;
  end: number;
  seqs: number[];
  messages: unknown[];
  inputSha256: string;
  selectionKey: string;
}

interface PreparedContext {
  pointer: PreparedContextPointer;
  generation: ValidatedGeneration | StoredGeneration;
}

interface HardAttemptPublication {
  attemptId: string;
  sessionId: string;
  publishedGenerationId?: string;
  publishedReplaceGeneration?: number;
}

interface InFlightBuild {
  selectionKey: string;
  start: number;
  end: number;
  inputSha256: string;
  controller: AbortController;
  promise: Promise<PreparedContext>;
}

interface ScheduledPreparedApply {
  selectionKey: string;
  controller: AbortController;
  promise: Promise<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && messages.length < 4 && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (message && messages.at(-1) !== message) messages.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join("\n原因：").slice(0, 2_048);
}

function normalizeHardBudgetError(error: unknown): unknown {
  if (error instanceof ContextGenerationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (!/summary is not smaller than the shadowed content/iu.test(message)) return error;
  return new ContextGenerationError(message, "BUDGET_EXCEEDED", {
    cause: error instanceof Error ? error : undefined,
  });
}

function isIdleMaintenanceBusy(error: unknown): boolean {
  const message = errorChainMessage(error).toLowerCase();
  return message.includes("requires an idle agent")
    || message.includes("already has active work")
    || message.includes("no waking queued work")
    || message.includes("compaction already in progress");
}

function defaultRoot(): string {
  return defaultContextStoreDirectory();
}

function threadLedgerRoot(): string {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.resolve(process.env.DSH_THREAD_LEDGER_ROOT || path.join(dshHome, "thread-ledger-v1"));
}

function sessionSegment(sessionId: string): string {
  return sha256(sessionId);
}

function estimateMessageTokens(ctx: any, content: string): number {
  return ctx.tokenMeter.estimateMessage({
    id: "memory-context-preview",
    role: "user",
    source: { kind: "plugin", plugin: "memory-context" },
    content: [{ type: "text", text: content }],
  });
}

function effectiveReservedResponseTokens(contextWindow: number, configuredMaxTokens: unknown): number {
  const configured = Math.floor(Number(configuredMaxTokens));
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  const policyReserve = Math.max(MIN_RESPONSE_RESERVE_TOKENS, Math.floor(contextWindow * RESPONSE_RESERVE_RATIO));
  return Math.min(configured, policyReserve, contextWindow);
}

function surfaceRange(session: any, start: number, end: number): SurfaceRange {
  const nodes = [...session.surface.nodes];
  const startIndex = nodes.indexOf(start);
  const endIndex = nodes.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new ContextGenerationError("Selected compaction range is no longer on the surface", "STALE_PARENT");
  }
  const seqs = nodes.slice(startIndex, endIndex + 1);
  const messages = seqs.map(seq => {
    const message = session.deriveEventMessage(session.events[seq]);
    if (message === null) {
      throw new ContextGenerationError(`Surface event ${seq} has no derived message`, "VALIDATION_FAILED");
    }
    return message;
  });
  const inputSha256 = sha256(JSON.stringify(messages));
  const selectionKey = sha256(JSON.stringify({
    sessionId: String(session.id),
    replaceGeneration: session.surface.replaceGeneration,
    start,
    end,
    seqs,
    inputSha256,
  }));
  return { start, end, seqs, messages, inputSha256, selectionKey };
}

function selectHeadRange(
  session: any,
  measurement: any,
  retainTokens: number,
  maxRetainedTokens = Number.POSITIVE_INFINITY,
): { start: number; end: number } | undefined {
  const pricedNodes = measurement.nodes;
  const surfaceNodes = session.surface.nodes;
  if (pricedNodes.length === 0) return undefined;
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq: number, index: number) => seq !== pricedNodes[index]?.seq)) {
    throw new ContextGenerationError("Token meter surface differs from the session surface", "STALE_PARENT");
  }
  const retainedTokensByIndex = new Array<number>(pricedNodes.length + 1).fill(0);
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    retainedTokensByIndex[index] = retainedTokensByIndex[index + 1]! + pricedNodes[index].tokens;
  }
  let keepFromIndex = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    keepFromIndex = index;
    if (retainedTokensByIndex[index]! >= retainTokens) break;
  }
  if (keepFromIndex === 0) return undefined;
  while (keepFromIndex > 0) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIndex])) break;
    keepFromIndex -= 1;
  }
  if (keepFromIndex === 0) return undefined;
  if (retainedTokensByIndex[keepFromIndex]! > maxRetainedTokens) {
    for (let index = keepFromIndex + 1; index < pricedNodes.length; index += 1) {
      if (toolPairingBalancedBefore(session, surfaceNodes[index])
        && retainedTokensByIndex[index]! <= maxRetainedTokens) {
        keepFromIndex = index;
        break;
      }
    }
    if (retainedTokensByIndex[keepFromIndex]! > maxRetainedTokens) return undefined;
  }
  return { start: surfaceNodes[0], end: surfaceNodes[keepFromIndex - 1] };
}

function hardRetainTokensForRetry(contextWindow: number, retryLevel: number): number {
  if (retryLevel <= 0) return Math.floor(contextWindow * RETAIN_RATIO);
  if (retryLevel === 1) return Math.floor(contextWindow * RETAIN_RATIO * 0.5);
  return 0;
}

function roundMap(session: any): Map<number, number> {
  const map = new Map<number, number>();
  let round = 0;
  for (const event of session.events) {
    if (event.type === "user/message" && event.data?.source?.kind === "user") round += 1;
    if (event.surfaceOp !== undefined && round > 0) map.set(event.seq, round);
  }
  return map;
}

function selectedRounds(session: any, seqs: readonly number[]): number[] {
  const direct = roundMap(session);
  const collected = new Set<number>();
  const visiting = new Set<number>();
  const visit = (seq: number): void => {
    if (visiting.has(seq)) return;
    visiting.add(seq);
    const event = session.events[seq];
    if (event?.surfaceOp !== undefined
      && typeof event.surfaceOp === "object"
      && event.surfaceOp.op === "replace"
      && Array.isArray(event.sourceEventSeqs)) {
      for (const sourceSeq of event.sourceEventSeqs) {
        if (session.events[sourceSeq]?.surfaceOp !== undefined) visit(sourceSeq);
      }
    } else {
      const round = direct.get(seq);
      if (round !== undefined) collected.add(round);
    }
    visiting.delete(seq);
  };
  for (const seq of seqs) visit(seq);
  if (collected.size === 0) {
    for (const seq of seqs) {
      const round = direct.get(seq);
      if (round !== undefined) collected.add(round);
    }
  }
  return [...collected].sort((left, right) => left - right);
}

function trimSurfaceRangeToRoundEnd(
  session: any,
  range: SurfaceRange,
  availableRoundEnd: number,
): SurfaceRange | undefined {
  const nodes = [...session.surface.nodes];
  const startIndex = nodes.indexOf(range.start);
  const endIndex = nodes.indexOf(range.end);
  if (startIndex < 0 || endIndex < startIndex) return undefined;
  let candidateEndIndex = startIndex - 1;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const rounds = selectedRounds(session, [nodes[index]!]);
    if (rounds.some(round => round > availableRoundEnd)) break;
    candidateEndIndex = index;
  }
  while (candidateEndIndex >= startIndex) {
    const next = nodes[candidateEndIndex + 1];
    if (next !== undefined && toolPairingBalancedBefore(session, next)) {
      return surfaceRange(session, nodes[startIndex]!, nodes[candidateEndIndex]!);
    }
    candidateEndIndex -= 1;
  }
  return undefined;
}

function humanRoundCount(session: any): number {
  return session.events.filter((event: any) => event?.type === "user/message" && event?.data?.source?.kind === "user").length;
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function delayWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class MemoryRecordCompactionEngine extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, "commands", "tools"];

  private readonly rootDirectory: string;
  private readonly runtimeStates: ContextRuntimeStateStore;
  private readonly recovery: ContextPauseRecoveryService;
  private readonly recordSource: RecordContextSource;
  private readonly stores = new Map<string, FileGenerationStore>();
  private readonly inFlight = new Map<string, InFlightBuild>();
  private readonly activePrepared = new Map<string, PreparedContext>();
  private readonly scheduledApplies = new Map<string, ScheduledPreparedApply>();
  private readonly hardTakeovers = new Set<string>();
  private readonly hardAttemptContext = new AsyncLocalStorage<HardAttemptPublication>();

  constructor(ctx: any, config: Record<string, any> = {}) {
    const { recordContextSource, rootDirectory, runtimeStateDirectory, ...basicConfig } = config;
    super(ctx, {
      ...basicConfig,
      thresholdRatio: HARD_RATIO,
      retainRatio: basicConfig.retainTokens === undefined ? RETAIN_RATIO : undefined,
      modelPolicies: Array.isArray(basicConfig.modelPolicies)
        ? basicConfig.modelPolicies.map((policy: Record<string, unknown>) => ({ ...policy, thresholdRatio: HARD_RATIO }))
        : undefined,
    });
    this.rootDirectory = rootDirectory ?? defaultRoot();
    this.runtimeStates = new ContextRuntimeStateStore(runtimeStateDirectory ?? defaultContextRuntimeStateDirectory());
    this.recovery = new ContextPauseRecoveryService(this.runtimeStates);
    const memoryStoreEndpoint = process.env.DSH_MEMORY_STORE_ENDPOINT;
    this.recordSource = recordContextSource ?? new BrokerRecordContextSource({
      endpoint: memoryStoreEndpoint,
      ...(memoryStoreEndpoint === undefined ? {
        callTool: async (name, args, context) => ctx.tools.execute({
          callId: `context:${context.sessionId}:${name}:${randomUUID()}`,
          name: `mcp__memory-store__${name}`,
          arguments: args,
          agent: context.agent,
          signal: context.signal,
        }),
      } : {}),
    });
    ctx.effect(() => ctx.commands.register({
      name: "context-recover",
      description: "恢复因上下文硬压缩失败而暂停保护的当前会话",
      input: { hint: "<恢复原因>" },
      handler: async (invocation: any) => {
        const reason = invocation.rawInput.trim();
        if (reason.length === 0) {
          return {
            kind: "error",
            text: "用法：/context-recover <恢复原因>。恢复会保留原失败证据，只解除暂停保护。",
          };
        }
        try {
          const state = await this.recovery.resume(String(invocation.agent.session.id), reason);
          return {
            kind: "success",
            text: `已解除上下文暂停保护；原失败证据仍保留。恢复原因：${state.lastRecovery?.reason ?? reason}`,
          };
        } catch (error) {
          return {
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }), "Memory Context 恢复命令");
    ctx.on("agent/pre-step", async ({ agent }: any, next: () => Promise<unknown>) => {
      const state = await this.runtimeStates.load(String(agent.session.id));
      if (state.publishedGenerationId !== undefined) agent.contextGenerationId = state.publishedGenerationId;
      if (state.paused) {
        throw new ContextGenerationError(
          `上下文硬压缩失败后已暂停保护：${state.pauseReason ?? "原因未记录"}。确认现场安全后可输入 /context-recover <恢复原因> 继续。`,
          "BUILD_FAILED",
        );
      }
      try {
        await this.compactIfNeeded(agent, "pressure", agent.session?.requestHeader?.()?.signal ?? new AbortController().signal);
      } catch (error) {
        const latestState = await this.runtimeStates.load(String(agent.session.id));
        if (latestState.paused) {
          throw new ContextGenerationError(
            `上下文硬压缩失败后已暂停保护：${latestState.pauseReason ?? errorChainMessage(error)}。确认现场安全后可输入 /context-recover <恢复原因> 继续。`,
            "BUILD_FAILED",
          );
        }
        this.ctx.logger?.warn?.(`BPC/硬压缩 pre-step 检查失败，继续执行：${error instanceof Error ? error.message : String(error)}`);
      }
      return next();
    });
    ctx.effect(() => async () => this.close(), "Memory Context 后台任务清理");
  }

  private store(sessionId: string): FileGenerationStore {
    let store = this.stores.get(sessionId);
    if (store === undefined) {
      store = new FileGenerationStore({
        directory: path.join(this.rootDirectory, "sessions", sessionSegment(sessionId), "generations"),
      });
      this.stores.set(sessionId, store);
    }
    return store;
  }

  private async contextWindow(agent: any, signal: AbortSignal): Promise<number> {
    const durable = agent.session.requestContext?.()?.contextWindow;
    if (Number.isSafeInteger(durable) && durable > 0) return durable;
    const header = agent.session.requestHeader?.();
    const provider = header?.config?.provider ?? agent.options?.provider;
    const model = header?.config?.model ?? agent.options?.model;
    if (!provider || !model) {
      throw new ContextGenerationError("Cannot resolve the active model context window", "VALIDATION_FAILED");
    }
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal);
    const value = info?.context?.contextWindow;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ContextGenerationError(`Model ${provider}/${model} has no context window`, "VALIDATION_FAILED");
    }
    return value;
  }

  private async markPaused(sessionId: string, error: unknown): Promise<void> {
    const message = errorChainMessage(error);
    await this.runtimeStates.update(sessionId, state => ({
      ...state,
      paused: true,
      pauseReason: message,
      compactionActivity: undefined,
      lastHardFailure: {
        reason: message,
        failedAt: Date.now(),
      },
    }));
  }

  private expectedHardInterruption(signal: AbortSignal, error: unknown): boolean {
    return signal.aborted
      || (error instanceof ContextGenerationError && error.code === "STALE_PARENT");
  }

  private async clearCompactionActivity(sessionId: string): Promise<void> {
    await this.runtimeStates.update(sessionId, state => ({
      ...state,
      compactionActivity: undefined,
    }));
  }

  private async handleHardFailure(
    sessionId: string,
    signal: AbortSignal,
    error: unknown,
  ): Promise<void> {
    const state = await this.runtimeStates.load(sessionId);
    if (state.paused) return;
    if (this.expectedHardInterruption(signal, error)) {
      await this.clearCompactionActivity(sessionId);
      return;
    }
    await this.markPaused(sessionId, error);
  }

  private async noteBpcFailure(sessionId: string, error: unknown, clearPrepared = false): Promise<void> {
    const message = errorChainMessage(error);
    await this.runtimeStates.update(sessionId, state => {
      const failureCount = (state.bpcFailureCount ?? 0) + 1;
      const retryDelay = Math.min(BPC_RETRY_MAX_MS, BPC_RETRY_BASE_MS * (2 ** (failureCount - 1)));
      return {
        ...state,
        ...(clearPrepared ? { prepared: undefined } : {}),
        compactionActivity: clearPrepared || state.prepared === undefined
          ? undefined
          : {
              trigger: state.compactionActivity?.trigger ?? "bpc",
              phase: "prepared",
              startedAt: state.compactionActivity?.startedAt ?? Date.now(),
              ...(state.compactionActivity?.generationId === undefined
                ? {}
                : { generationId: state.compactionActivity.generationId }),
            },
        lastBpcFailure: message,
        bpcFailureCount: failureCount,
        nextBpcRetryAt: Date.now() + retryDelay,
      };
    });
  }

  private async clearPrepared(sessionId: string): Promise<void> {
    await this.runtimeStates.update(sessionId, state => {
      const preparedGenerationId = state.prepared?.generationId;
      const activity = state.compactionActivity;
      const clearActivity = preparedGenerationId !== undefined
        && activity?.generationId === preparedGenerationId;
      return {
        ...state,
        prepared: undefined,
        ...(clearActivity ? { compactionActivity: undefined } : {}),
      };
    });
  }

  inspectRecovery(sessionId: string) {
    return this.recovery.inspect(sessionId);
  }

  resumePausedSession(sessionId: string, recoveryReason: string) {
    return this.recovery.resume(sessionId, recoveryReason);
  }

  private async threadHeatSignals(agent: any, currentGenerationId: string): Promise<{
    confirmations: Array<{ readReceiptId: string; confirmedRounds: number[]; orderedRounds?: number[]; confirmedAtOwnerRound?: number }>;
    protections: Array<{ ranges: Array<{ start: number; end: number }> }>;
  }> {
    const sessionId = String(agent.session.id);
    try {
      const ledger = await SidecarThreadLedger.open({
        rootDir: threadLedgerRoot(),
        ownerSessionId: sessionId,
        targetSessionId: sessionId,
        contextGenerationId: currentGenerationId,
        sourceRevision: "probe-current-binding",
      });
      const inspected = ledger.inspect();
      if (inspected.binding?.contextGenerationId !== currentGenerationId) {
        return { confirmations: [], protections: [] };
      }
      return {
        confirmations: inspected.confirmationHistory ?? [],
        protections: inspected.activeProtections ?? [],
      };
    } catch (error) {
      this.ctx.logger.warn(`线程热度账本不可用，本次只按历史热度和近期位置重建：${error instanceof Error ? error.message : String(error)}`);
      return { confirmations: [], protections: [] };
    }
  }

  private async clearPause(sessionId: string): Promise<void> {
    await this.runtimeStates.update(sessionId, state => ({
      ...state,
      paused: false,
      pauseReason: undefined,
    }));
  }

  private async buildCandidate(
    agent: any,
    range: SurfaceRange,
    signal: AbortSignal,
    trigger: "bpc" | "hard" = "bpc",
  ): Promise<PreparedContext> {
    const sessionId = String(agent.session.id);
    const store = this.store(sessionId);
    const operation = { signal };
    const state = await this.runtimeStates.load(sessionId);
    if (state.prepared?.selectionKey === range.selectionKey) {
      const existing = await store.getGeneration(state.prepared.generationId, operation);
      if (existing?.state === "validated" || existing?.state === "published") {
        return { pointer: state.prepared, generation: existing };
      }
    }
    const rounds = selectedRounds(agent.session, range.seqs);
    if (rounds.length === 0) {
      throw new ContextGenerationError("Selected surface has no recoverable human round", "VALIDATION_FAILED");
    }
    const measurement = this.ctx.tokenMeter.measure(agent.session);
    const selectedTokens = measurement.nodes
      .filter((node: any) => range.seqs.includes(node.seq))
      .reduce((total: number, node: any) => total + node.tokens, 0);
    const contextWindow = await this.contextWindow(agent, signal);
    const reservedResponseTokens = effectiveReservedResponseTokens(
      contextWindow,
      agent.session.requestHeader?.()?.config?.maxTokens,
    );
    const workspace = agent.session.header?.cwd;
    if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
      throw new ContextGenerationError("Session workspace is unavailable for Memory Store Record lookup", "VALIDATION_FAILED");
    }
    const generationId = `context-${Date.now()}-${randomUUID()}`;
    const currentGenerationId = state.publishedGenerationId
      ?? String(agent.contextGenerationId ?? agent.session.contextGenerationId ?? `session:${sessionId}:runtime`);
    const signals = await this.threadHeatSignals(agent, currentGenerationId);
    const heatPlan = buildHeatDetailPlan({
      roundStart: rounds[0]!,
      roundEnd: rounds.at(-1)!,
      observedAtRound: humanRoundCount(agent.session),
      previous: state.heatState,
      confirmations: signals.confirmations,
      protections: signals.protections,
      explorationSeed: `${sessionId}:${range.selectionKey}`,
    });
    const built: RecordContextBuildResult = await this.recordSource.build({
      contextGenerationId: generationId,
      sessionId,
      workspace,
      selectedSurfaceSeqs: range.seqs,
      roundStart: rounds[0]!,
      roundEnd: rounds.at(-1)!,
      detailByRound: heatPlan.detailByRound,
      protectedRoundIds: heatPlan.protectedRoundIds,
      contextWindow,
      retainedRequestTokens: Math.max(0, measurement.totalTokens - selectedTokens),
      reservedResponseTokens,
      estimateStablePrefixTokens: content => estimateMessageTokens(this.ctx, content),
      agent,
      signal,
    });
    if (built.protectedProjectionContent !== undefined) {
      const protectedTokens = estimateMessageTokens(this.ctx, built.protectedProjectionContent);
      if (protectedTokens > Math.floor(contextWindow * 0.5)) {
        throw new ContextGenerationError("受保护 Record 已超过模型窗口的 50%，拒绝新增这代压缩内容", "VALIDATION_FAILED");
      }
    }
    const preview = buildStableContext(built.input);
    const stable = buildStableContext({
      ...built.input,
      tokenBudget: {
        ...built.input.tokenBudget,
        stablePrefixTokens: estimateMessageTokens(this.ctx, preview.content),
      },
    });
    assertMeasuredContextBudget(stable, content => estimateMessageTokens(this.ctx, content));
    const parent = await store.getPublished(operation);
    const candidate = createCandidate({
      generationId,
      parentPublishedGenerationId: parent?.manifest.generationId,
      trigger,
      createdAt: Date.now(),
      content: stable.content,
      metadata: {
        surfaceManifest: stable.manifest,
        selectionKey: range.selectionKey,
        inputSha256: range.inputSha256,
        sourceRevision: built.sourceRevision,
        sourceRoundCount: built.recordRoundCount,
        heatTargetRoundCount: heatPlan.schedule.targetRoundCount,
        fullRecordRounds: heatPlan.schedule.selectedRoundIds,
        protectedRecordRounds: heatPlan.protectedRoundIds,
      },
    });
    validateCandidate(candidate);
    await store.putCandidate(candidate, operation);
    const validated = await store.markValidated(generationId, Date.now(), operation);
    const pointer: PreparedContextPointer = {
      selectionKey: range.selectionKey,
      generationId,
      start: range.start,
      end: range.end,
      inputSha256: range.inputSha256,
      sourceRevision: built.sourceRevision,
      heatState: heatPlan.heatState,
      createdAt: Date.now(),
    };
    await this.runtimeStates.update(sessionId, current => ({
      ...current,
      prepared: pointer,
      compactionActivity: {
        trigger,
        phase: "prepared",
        startedAt: current.compactionActivity?.startedAt ?? Date.now(),
        generationId,
      },
      lastBpcFailure: undefined,
      bpcFailureCount: undefined,
      nextBpcRetryAt: undefined,
    }));
    return { pointer, generation: validated };
  }

  async close(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const scheduled of this.scheduledApplies.values()) {
      scheduled.controller.abort(new Error("上下文压缩器正在关闭"));
      pending.push(scheduled.promise);
    }
    for (const build of this.inFlight.values()) {
      build.controller.abort(new Error("上下文压缩器正在关闭"));
      pending.push(build.promise);
    }
    this.scheduledApplies.clear();
    this.inFlight.clear();
    await Promise.allSettled(pending);
    await this.recordSource.close?.();
  }

  private startBpc(agent: any, range: SurfaceRange): void {
    const sessionId = String(agent.session.id);
    if (this.hardTakeovers.has(sessionId)) return;
    const current = this.inFlight.get(sessionId);
    if (current !== undefined) {
      try {
        const stillCurrent = surfaceRange(agent.session, current.start, current.end);
        if (stillCurrent.selectionKey === current.selectionKey
          && stillCurrent.inputSha256 === current.inputSha256) return;
      } catch {}
      current.controller.abort(new Error("后台预压缩的原始范围已经变化，由新快照取代"));
    }
    const controller = new AbortController();
    const promise = this.runtimeStates.update(sessionId, state => ({
      ...state,
      compactionActivity: { trigger: "bpc", phase: "building", startedAt: Date.now() },
    })).then(() => this.buildCandidate(agent, range, controller.signal))
      .then(prepared => {
        if (!this.hardTakeovers.has(sessionId)) this.schedulePreparedApply(agent, prepared);
        return prepared;
      })
      .catch(async error => {
        if (!controller.signal.aborted) {
          await this.noteBpcFailure(sessionId, error).catch(() => undefined);
        }
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(sessionId)?.promise === promise) this.inFlight.delete(sessionId);
      });
    this.inFlight.set(sessionId, {
      selectionKey: range.selectionKey,
      start: range.start,
      end: range.end,
      inputSha256: range.inputSha256,
      controller,
      promise,
    });
    void promise.catch(error => {
      this.ctx.logger.warn(`后台预压缩失败，继续使用现有上下文：${errorChainMessage(error)}`);
    });
  }

  private async prepareForCommit(
    agent: any,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<PreparedContext> {
    const range = surfaceRange(agent.session, start, end);
    const sessionId = String(agent.session.id);
    const current = this.inFlight.get(sessionId);
    if (current !== undefined) {
      current.controller.abort(new Error("硬压缩取代了尚未完成的后台候选"));
      await current.promise.catch(() => undefined);
    }
    return this.buildCandidate(agent, range, signal, "hard");
  }

  private async loadPreparedForCurrentSurface(agent: any): Promise<PreparedContext | undefined> {
    const sessionId = String(agent.session.id);
    const state = await this.runtimeStates.load(sessionId);
    const pointer = state.prepared;
    if (pointer === undefined) return undefined;
    try {
      const range = surfaceRange(agent.session, pointer.start, pointer.end);
      if (range.selectionKey !== pointer.selectionKey || range.inputSha256 !== pointer.inputSha256) {
        await this.clearPrepared(sessionId);
        return undefined;
      }
      const generation = await this.store(sessionId).getGeneration(
        pointer.generationId,
        { signal: new AbortController().signal },
      );
      if (generation?.state !== "validated" && generation?.state !== "published") {
        await this.clearPrepared(sessionId);
        return undefined;
      }
      return { pointer, generation };
    } catch (error) {
      if (error instanceof ContextGenerationError && error.code === "STALE_PARENT") {
        await this.clearPrepared(sessionId);
        return undefined;
      }
      throw error;
    }
  }

  private cancelScheduledApply(sessionId: string, reason: string): void {
    const scheduled = this.scheduledApplies.get(sessionId);
    if (scheduled === undefined) return;
    scheduled.controller.abort(new Error(reason));
    this.scheduledApplies.delete(sessionId);
  }

  private async compactPreparedAtIdle(
    prepared: PreparedContext,
    agent: any,
    signal: AbortSignal,
  ): Promise<any> {
    const basePrototype = Object.getPrototypeOf(MemoryRecordCompactionEngine.prototype) as Record<string, any>;
    const compactIdleRegion = basePrototype.compactIdleRegion;
    if (typeof compactIdleRegion !== "function") {
      throw new ContextGenerationError(
        "当前 DSH 基础压缩器缺少指定范围的空闲事务接口，拒绝不安全地直接改写会话",
        "VALIDATION_FAILED",
      );
    }
    return compactIdleRegion.call(
      this,
      prepared.pointer.start,
      prepared.pointer.end,
      agent,
      signal,
      `bpc:${prepared.generation.manifest.generationId}`,
    );
  }

  private schedulePreparedApply(agent: any, prepared: PreparedContext): void {
    const sessionId = String(agent.session.id);
    if (this.hardTakeovers.has(sessionId)) return;
    const existing = this.scheduledApplies.get(sessionId);
    if (existing?.selectionKey === prepared.pointer.selectionKey) return;
    if (existing !== undefined) existing.controller.abort(new Error("新的后台候选取代了旧的待提交候选"));
    const controller = new AbortController();
    const promise = this.applyPreparedWhenIdle(agent, prepared.pointer.generationId, controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) {
          this.ctx.logger.warn(`后台预压缩候选自动换入失败，保留旧上下文：${errorChainMessage(error)}`);
        }
      })
      .finally(() => {
        if (this.scheduledApplies.get(sessionId)?.promise === promise) this.scheduledApplies.delete(sessionId);
      });
    this.scheduledApplies.set(sessionId, {
      selectionKey: prepared.pointer.selectionKey,
      controller,
      promise,
    });
  }

  private async applyPreparedWhenIdle(
    agent: any,
    generationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionId = String(agent.session.id);
    while (!signal.aborted && !this.hardTakeovers.has(sessionId)) {
      if (typeof agent.whenIdle === "function") {
        await awaitWithSignal(Promise.resolve(agent.whenIdle()), signal);
      }
      signal.throwIfAborted();
      if (this.hardTakeovers.has(sessionId)) return;
      const prepared = await this.loadPreparedForCurrentSurface(agent);
      if (prepared === undefined || prepared.pointer.generationId !== generationId) return;
      try {
        const result = await this.applyPreparedBpc(agent, prepared, signal, true);
        if (result !== null) return;
      } catch (error) {
        if (!isIdleMaintenanceBusy(error)) throw error;
      }
      const state = await this.runtimeStates.load(sessionId);
      if (state.prepared?.generationId !== generationId) return;
      const retryAt = Math.max(Date.now() + 25, state.nextBpcRetryAt ?? 0);
      await delayWithSignal(retryAt - Date.now(), signal);
    }
  }

  private async applyPreparedBpc(
    agent: any,
    prepared: PreparedContext,
    signal: AbortSignal,
    idle = false,
  ): Promise<any> {
    const sessionId = String(agent.session.id);
    const replaceGeneration = agent.session.surface.replaceGeneration;
    await this.runtimeStates.update(sessionId, state => ({
      ...state,
      compactionActivity: {
        trigger: prepared.generation.manifest.trigger === "hard" ? "hard" : "bpc",
        phase: "applying",
        startedAt: state.compactionActivity?.startedAt ?? Date.now(),
        generationId: prepared.generation.manifest.generationId,
      },
    }));
    this.activePrepared.set(sessionId, prepared);
    try {
      const result = idle
        ? await this.compactPreparedAtIdle(prepared, agent, signal)
        : await super.compactRegion(
            prepared.pointer.start,
            prepared.pointer.end,
            agent,
            signal,
          );
      await this.publishPrepared(agent, prepared);
      return result;
    } catch (error) {
      if (idle && isIdleMaintenanceBusy(error)) {
        await this.runtimeStates.update(sessionId, state => ({
          ...state,
          compactionActivity: state.prepared === undefined ? undefined : {
            trigger: "bpc",
            phase: "prepared",
            startedAt: state.compactionActivity?.startedAt ?? Date.now(),
            generationId: prepared.generation.manifest.generationId,
          },
        })).catch(() => undefined);
        throw error;
      }
      if (agent.session.surface.replaceGeneration !== replaceGeneration) {
        const currentState = await this.runtimeStates.load(sessionId);
        if (idle && (this.hardTakeovers.has(sessionId)
          || currentState.prepared?.generationId !== prepared.pointer.generationId)) return null;
        if (!currentState.paused) await this.markPaused(sessionId, error);
        throw error;
      }
      await this.noteBpcFailure(sessionId, error).catch(() => undefined);
      this.ctx.logger.warn(`后台预压缩候选暂时无法提交，保留旧上下文并稍后重试：${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.activePrepared.delete(sessionId);
    }
  }

  private async runHardWithRetries(
    agent: any,
    trigger: "pressure" | "context-overflow",
    signal: AbortSignal,
  ): Promise<any> {
    const sessionId = String(agent.session.id);
    this.hardTakeovers.add(sessionId);
    this.cancelScheduledApply(sessionId, "硬压缩已经接管当前上下文");
    const currentBuild = this.inFlight.get(sessionId);
    if (currentBuild !== undefined) {
      currentBuild.controller.abort(new Error("硬压缩已经接管尚未完成的后台预压缩"));
      await currentBuild.promise.catch(() => undefined);
    }
    try {
      let lastError: unknown;
      let budgetRetryLevel = 0;
      for (let attempt = 0; attempt <= HARD_FAILURE_RETRIES; attempt += 1) {
        signal.throwIfAborted();
        const replaceGeneration = agent.session.surface.replaceGeneration;
        const contextGenerationId = agent.contextGenerationId;
        const attemptPublication: HardAttemptPublication = {
          attemptId: randomUUID(),
          sessionId,
        };
        try {
          return await this.hardAttemptContext.run(attemptPublication, async () => {
            if (trigger === "pressure") {
              const contextWindow = await this.contextWindow(agent, signal);
              const retainedTokens = hardRetainTokensForRetry(contextWindow, budgetRetryLevel);
              const measurement = this.ctx.tokenMeter.measure(agent.session);
              const reservedResponseTokens = effectiveReservedResponseTokens(
                contextWindow,
                agent.session.requestHeader?.()?.config?.maxTokens,
              );
              const range = selectHeadRange(
                agent.session,
                measurement,
                retainedTokens,
                Math.max(0, contextWindow - reservedResponseTokens - MIN_STABLE_PREFIX_TOKENS),
              );
              if (range === undefined) {
                throw new ContextGenerationError(
                  `硬压缩无法在保留 ${retainedTokens} Token 近期原文时找到安全切分点`,
                  "BUDGET_EXCEEDED",
                );
              }
              const result = await this.compactRegion(range.start, range.end, agent, signal);
              if (this.ctx.tokenMeter.measure(agent.session).totalTokens < Math.floor(contextWindow * HARD_RATIO)) {
                return result;
              }
              const continued = await super.compactIfNeeded(agent, trigger, signal);
              if (this.ctx.tokenMeter.measure(agent.session).totalTokens < Math.floor(contextWindow * HARD_RATIO)) {
                return continued ?? result;
              }
              throw new ContextGenerationError(
                "硬压缩提交后仍未回到安全窗口，继续降低近期原文保留量",
                "BUDGET_EXCEEDED",
              );
            }
            return await super.compactIfNeeded(agent, trigger, signal);
          });
        } catch (error) {
          const retryError = normalizeHardBudgetError(error);
          lastError = retryError;
          if (signal.aborted) throw retryError;
          const currentReplaceGeneration = agent.session.surface.replaceGeneration;
          const currentContextGenerationId = agent.contextGenerationId;
          const surfaceChanged = currentReplaceGeneration !== replaceGeneration;
          const contextChanged = currentContextGenerationId !== contextGenerationId;
          const ownPublication = attemptPublication.publishedGenerationId !== undefined
            && currentContextGenerationId === attemptPublication.publishedGenerationId
            && currentReplaceGeneration === attemptPublication.publishedReplaceGeneration;
          if ((surfaceChanged || contextChanged) && !ownPublication) {
            const state = await this.runtimeStates.load(sessionId);
            if (state.paused) throw retryError;
            throw new ContextGenerationError(
              "硬压缩期间会话表面被其它操作替换，本次压缩已取消",
              "STALE_PARENT",
              { cause: retryError instanceof Error ? retryError : undefined },
            );
          }
          if (trigger === "pressure"
            && retryError instanceof ContextGenerationError
            && retryError.code === "BUDGET_EXCEEDED") {
            budgetRetryLevel += 1;
          }
          if (attempt >= HARD_FAILURE_RETRIES) break;
          const delayMs = HARD_RETRY_BASE_MS * (2 ** attempt);
          const adaptation = budgetRetryLevel > 0
            ? `，下一次把近期原文目标降到 ${hardRetainTokensForRetry(await this.contextWindow(agent, signal), budgetRetryLevel)} Token`
            : "";
          this.ctx.logger.warn(`硬压缩第 ${attempt + 1} 次失败${adaptation}，${delayMs}ms 后重试：${retryError instanceof Error ? retryError.message : String(retryError)}`);
          await delayWithSignal(delayMs, signal);
        }
      }
      throw lastError;
    } finally {
      this.hardTakeovers.delete(sessionId);
    }
  }

  private async publishPrepared(agent: any, prepared: PreparedContext): Promise<void> {
    const sessionId = String(agent.session.id);
    if (prepared.generation.state === "published") {
      await this.runtimeStates.update(sessionId, state => ({
        ...state,
        paused: false,
        pauseReason: undefined,
        prepared: undefined,
        publishedGenerationId: prepared.generation.manifest.generationId,
        publishedSelectionKey: prepared.pointer.selectionKey,
        heatState: prepared.pointer.heatState ?? state.heatState,
        lastBpcFailure: undefined,
        bpcFailureCount: undefined,
        nextBpcRetryAt: undefined,
        compactionActivity: undefined,
        lastPublishedAt: Date.now(),
      }));
      agent.contextGenerationId = prepared.generation.manifest.generationId;
      this.noteHardAttemptPublication(agent, prepared.generation.manifest.generationId);
      return;
    }
    const store = this.store(sessionId);
    try {
      const published = await store.publishAtomically(
        prepared.generation.manifest.parentPublishedGenerationId,
        prepared.generation.manifest.generationId,
        Date.now(),
        { signal: new AbortController().signal },
      );
      await this.runtimeStates.update(sessionId, state => ({
        ...state,
        paused: false,
        pauseReason: undefined,
        prepared: undefined,
        publishedGenerationId: published.manifest.generationId,
        publishedSelectionKey: prepared.pointer.selectionKey,
        heatState: prepared.pointer.heatState ?? state.heatState,
        needsReconcile: false,
        lastBpcFailure: undefined,
        bpcFailureCount: undefined,
        nextBpcRetryAt: undefined,
        compactionActivity: undefined,
        lastPublishedAt: Date.now(),
      }));
      agent.contextGenerationId = published.manifest.generationId;
      this.noteHardAttemptPublication(agent, published.manifest.generationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.runtimeStates.update(sessionId, state => ({
        ...state,
        paused: true,
        pauseReason: `DSH 压缩已经提交，但私有上下文发布失败：${message}`,
        heatState: prepared.pointer.heatState ?? state.heatState,
        needsReconcile: true,
        compactionActivity: {
          trigger: state.compactionActivity?.trigger ?? "bpc",
          phase: "applying",
          startedAt: state.compactionActivity?.startedAt ?? Date.now(),
          generationId: prepared.generation.manifest.generationId,
        },
      })).catch(() => undefined);
      this.ctx.logger.error(`DSH 压缩已经提交，但私有上下文发布失败，已暂停保护：${message}`);
      throw error;
    }
  }

  private noteHardAttemptPublication(agent: any, generationId: string): void {
    const publication = this.hardAttemptContext.getStore();
    if (publication === undefined || publication.sessionId !== String(agent.session.id)) return;
    publication.publishedGenerationId = generationId;
    publication.publishedReplaceGeneration = agent.session.surface.replaceGeneration;
  }

  async compactIfNeeded(agent: any, trigger: "pressure" | "context-overflow", signal: AbortSignal): Promise<any> {
    const sessionId = String(agent.session.id);
    if (trigger === "context-overflow") {
      try {
        return await this.runHardWithRetries(agent, trigger, signal);
      } catch (error) {
        await this.handleHardFailure(sessionId, signal, error);
        throw error;
      }
    }
    const initialState = await this.runtimeStates.load(sessionId);
    if (initialState.paused) {
      throw new ContextGenerationError(`上下文处于暂停保护状态：${initialState.pauseReason ?? "原因未记录"}`, "BUILD_FAILED");
    }
    const pruner = this.ctx.get("toolResultPruner");
    if (pruner !== undefined) pruner.pruneSession(agent.session);
    let applied: any = null;
    if ((initialState.nextBpcRetryAt ?? 0) <= Date.now()) {
      const prepared = await this.loadPreparedForCurrentSurface(agent);
      if (prepared !== undefined) applied = await this.applyPreparedBpc(agent, prepared, signal);
    }
    const measurement = this.ctx.tokenMeter.measure(agent.session);
    const contextWindow = await this.contextWindow(agent, signal);
    const ratio = measurement.totalTokens / contextWindow;
    if (ratio < BPC_RATIO) return applied;
    const reservedResponseTokens = effectiveReservedResponseTokens(
      contextWindow,
      agent.session.requestHeader?.()?.config?.maxTokens,
    );
    const maxRetainedTokens = Math.max(0, contextWindow - reservedResponseTokens - MIN_STABLE_PREFIX_TOKENS);
    const range = selectHeadRange(
      agent.session,
      measurement,
      Math.floor(contextWindow * RETAIN_RATIO),
      maxRetainedTokens,
    );
    if (range === undefined) return applied;
    if (ratio < HARD_RATIO) {
      const currentState = await this.runtimeStates.load(sessionId);
      if ((currentState.nextBpcRetryAt ?? 0) <= Date.now()) {
        this.startBpc(agent, surfaceRange(agent.session, range.start, range.end));
      }
      return applied;
    }
    try {
      return await this.runHardWithRetries(agent, trigger, signal);
    } catch (error) {
      await this.handleHardFailure(sessionId, signal, error);
      throw error;
    }
  }

  async compactRegion(start: number, end: number, agent: any, signal?: AbortSignal): Promise<any> {
    const operationSignal = signal ?? new AbortController().signal;
    const sessionId = String(agent.session.id);
    let effectiveStart = start;
    let effectiveEnd = end;
    let prepared: PreparedContext;
    try {
      prepared = await this.prepareForCommit(agent, effectiveStart, effectiveEnd, operationSignal);
    } catch (error) {
      if (!(error instanceof RecordCoverageError)) throw error;
      const trimmed = trimSurfaceRangeToRoundEnd(
        agent.session,
        surfaceRange(agent.session, effectiveStart, effectiveEnd),
        error.availableRoundEnd,
      );
      if (trimmed === undefined || trimmed.end === effectiveEnd) throw error;
      this.ctx.logger.warn(
        `Memory Store Record 只覆盖到第 ${error.availableRoundEnd} 轮，压缩范围从第 ${error.requestedRoundEnd} 轮前收缩并保留未覆盖原文`,
      );
      effectiveStart = trimmed.start;
      effectiveEnd = trimmed.end;
      prepared = await this.prepareForCommit(agent, effectiveStart, effectiveEnd, operationSignal);
    }
    this.activePrepared.set(sessionId, prepared);
    try {
      const result = await super.compactRegion(effectiveStart, effectiveEnd, agent, operationSignal);
      await this.publishPrepared(agent, prepared);
      return result;
    } finally {
      this.activePrepared.delete(sessionId);
    }
  }

  async compactNow(agent: any, signal: AbortSignal, sourceCommandId?: unknown): Promise<any> {
    const sessionId = String(agent.session.id);
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId as never);
      const prepared = this.activePrepared.get(sessionId);
      if (result !== null && prepared !== undefined) await this.publishPrepared(agent, prepared);
      return result;
    } catch (error) {
      await this.handleHardFailure(sessionId, signal, error);
      throw error;
    } finally {
      this.activePrepared.delete(sessionId);
    }
  }

  protected async summarize(input: any, agent: any, signal?: AbortSignal): Promise<any> {
    const operationSignal = signal ?? new AbortController().signal;
    const sessionId = String(agent.session.id);
    const inputSha256 = sha256(JSON.stringify(input.messages));
    let prepared = this.activePrepared.get(sessionId);
    if (prepared === undefined || prepared.pointer.inputSha256 !== inputSha256) {
      const nodes = [...agent.session.surface.nodes];
      const count = input.messages.length;
      if (count < 1 || count > nodes.length) {
        throw new ContextGenerationError("Compaction input does not match a surface prefix", "STALE_PARENT");
      }
      const range = surfaceRange(agent.session, nodes[0], nodes[count - 1]);
      if (range.inputSha256 !== inputSha256) {
        throw new ContextGenerationError("Compaction input changed before Record reconstruction", "STALE_PARENT");
      }
      prepared = await this.prepareForCommit(agent, range.start, range.end, operationSignal);
      this.activePrepared.set(sessionId, prepared);
    }
    if (prepared.pointer.inputSha256 !== inputSha256) {
      throw new ContextGenerationError("Prepared Record belongs to another surface", "STALE_PARENT");
    }
    return {
      summary: [{ type: "text", text: prepared.generation.content }],
      provider: PROVIDER_NAME,
      model: PROVIDER_MODEL,
    };
  }
}

export default MemoryRecordCompactionEngine;

export const compactionProviderTesting = Object.freeze({
  effectiveReservedResponseTokens,
  selectHeadRange,
});
