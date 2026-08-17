import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  contentSha256,
  renderStableContextContent,
  type RecordContextSource,
  type RecordDetail,
  type StableContextContentInput,
  type StableContextInput,
} from "./context-builder.ts";
import { ContextGenerationError } from "./index.ts";

interface RecordPhase {
  id: number;
  roundStart: number;
  roundEnd: number;
  content: string;
}

export class RecordCoverageError extends ContextGenerationError {
  readonly availableRoundEnd: number;
  readonly requestedRoundEnd: number;

  constructor(
    availableRoundEnd: number,
    requestedRoundEnd: number,
  ) {
    super(
      `Memory Store Record only covers ${availableRoundEnd} rounds, but round ${requestedRoundEnd} is required`,
      "BUILD_FAILED",
    );
    this.availableRoundEnd = availableRoundEnd;
    this.requestedRoundEnd = requestedRoundEnd;
  }
}

export interface RecordContextBuildRequest {
  contextGenerationId: string;
  sessionId: string;
  workspace: string;
  selectedSurfaceSeqs: number[];
  roundStart: number;
  roundEnd: number;
  detailByRound: ReadonlyMap<number, RecordDetail>;
  protectedRoundIds?: readonly number[];
  contextWindow: number;
  retainedRequestTokens: number;
  reservedResponseTokens: number;
  estimateStablePrefixTokens: (content: string) => number;
  agent?: unknown;
  signal: AbortSignal;
}

export interface RecordContextBuildResult {
  input: StableContextInput;
  sourceRevision: string;
  recordRoundCount: number;
  protectedProjectionContent?: string;
}

export interface RecordContextSource {
  build(request: RecordContextBuildRequest): Promise<RecordContextBuildResult>;
  close?(): Promise<void>;
  close?(): Promise<void>;
}

export interface RecordToolCallContext {
  agent?: unknown;
  sessionId: string;
  signal: AbortSignal;
}

export type RecordToolCaller = (
  name: string,
  args: Record<string, unknown>,
  context: RecordToolCallContext,
) => Promise<unknown>;

function toolText(result: unknown): string {
  const execution = result as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
  };
  const rendered = (execution?.content ?? [])
    .filter(item => item.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n");
  return rendered || execution?.error?.message || "";
}

async function resolveRecordText(text: string, maxChars: number): Promise<string> {
  const spillPath = text.match(/已保存到临时文件:\s*([^\r\n]+)/u)?.[1]?.trim();
  if (spillPath === undefined) return text;
  if (!isAbsolute(spillPath) || !/^record_[^\\/]+\.md$/iu.test(basename(spillPath))) {
    throw new ContextGenerationError("Memory Store returned an invalid Record spill path", "BUILD_FAILED");
  }

  const [resolvedTempRoot, resolvedSpillPath] = await Promise.all([
    realpath(resolve(tmpdir())),
    realpath(resolve(spillPath)),
  ]);
  const spillRelativePath = relative(resolvedTempRoot, resolvedSpillPath);
  if (spillRelativePath.startsWith("..") || isAbsolute(spillRelativePath)) {
    throw new ContextGenerationError("Memory Store Record spill escaped the system temp directory", "BUILD_FAILED");
  }

  const spillStat = await stat(resolvedSpillPath);
  const maxBytes = Math.max(256_000, maxChars * 4 + 65_536);
  if (!spillStat.isFile() || spillStat.size > maxBytes) {
    throw new ContextGenerationError("Memory Store Record spill is not a bounded regular file", "BUILD_FAILED");
  }
  return await readFile(resolvedSpillPath, "utf8");
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause ?? "");
  return `${error.message}\n${cause}`;
}

function retryableTransportError(error: unknown): boolean {
  const text = errorText(error);
  if (/🔁\s*可重试[：:]\s*否/u.test(text)) return false;
  if (/🔁\s*可重试[：:]\s*是/u.test(text)) return true;
  if (error instanceof ContextGenerationError && error.code === "TIMEOUT") return true;
  return /Memory Store is unavailable|ECONNRESET|ECONNREFUSED|ENETUNREACH|fetch failed|network|timeout|timed out/iu.test(text);
}

async function retryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
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

function parseRoundCount(text: string): number {
  const match = text.match(/-\s*总轮次：\s*(\d+)/u) ?? text.match(/总轮次[：:]\s*(\d+)/u);
  return match ? Number(match[1]) : 0;
}

function reportsFailure(text: string): boolean {
  if (/^\s*❌/mu.test(text) || /需要修复/u.test(text)) return true;
  for (const match of text.matchAll(/失败\s*[：:]?\s*(\d+)/gu)) {
    if (Number(match[1]) > 0) return true;
  }
  return /(?:^|\n)\s*(?:状态\s*[：:]\s*)?(?:failed|失败)(?!\s*[：:]?\s*0(?:\D|$))/imu.test(text);
}

function reportsTerminalSuccess(text: string): boolean {
  return /(?:^|\n)\s*(?:状态\s*[：:]\s*)?(?:succeeded|completed|done)\b/imu.test(text)
    || /(?:^|\n)[^\n]{0,100}Record scheduler 任务\s*[：:]\s*(?:succeeded|completed|done)\b/imu.test(text)
    || /✅[^\n]{0,160}(?:已完成|完成成功|成功结束)/u.test(text);
}

function parseTaskId(text: string): string | undefined {
  return text.match(/["']?taskId["']?\s*[:：=]\s*["']?([\w-]+)/u)?.[1]
    ?? text.match(/🆔\s*([\w-]+)/u)?.[1];
}

function parsePhases(text: string): RecordPhase[] {
  const headings = [...text.matchAll(/^##\s+Phase\s+(\d+)[：:]?.*?（轮次\s+(\d+)(?:-(\d+))?）\s*$/gmu)];
  return headings.map((heading, index) => ({
    id: Number(heading[1]),
    roundStart: Number(heading[2]),
    roundEnd: Number(heading[3] ?? heading[2]),
    content: text.slice(heading.index, headings[index + 1]?.index ?? text.length).trim(),
  }));
}

function detailRank(detail: RecordDetail): number {
  return detail === "full" ? 3 : detail === "summary" ? 2 : 1;
}

function phaseDetail(phase: RecordPhase, detailByRound: ReadonlyMap<number, RecordDetail>): RecordDetail {
  let selected: RecordDetail = "brief";
  for (let round = phase.roundStart; round <= phase.roundEnd; round += 1) {
    const candidate = detailByRound.get(round);
    if (candidate !== undefined && detailRank(candidate) > detailRank(selected)) selected = candidate;
  }
  return selected;
}

function renderSummaryPhase(content: string): string {
  const lines = content.split(/\r?\n/u);
  const kept = lines.filter((line, index) => index === 0 || /^\*\*(?:用户操作|关键决策|产出文件|风险|经验教训|当前状态|验证)\*\*[：:]/u.test(line.trim()));
  return kept.join("\n").trim();
}

function renderPhase(phase: RecordPhase, detail: RecordDetail): string {
  if (detail === "full") return phase.content;
  if (detail === "summary") return renderSummaryPhase(phase.content);
  return phase.content.split(/\r?\n/u)[0]!.trim();
}

function combinedDetail(details: readonly RecordDetail[]): RecordDetail {
  if (details.includes("full")) return "full";
  if (details.includes("summary")) return "summary";
  return "brief";
}

function nextDowngradeIndex(details: readonly RecordDetail[], protectedPhaseIndexes: ReadonlySet<number>): number | undefined {
  for (const detail of ["full", "summary"] as const) {
    const index = details.findIndex((candidate, phaseIndex) => candidate === detail && !protectedPhaseIndexes.has(phaseIndex));
    if (index >= 0) return index;
  }
  return undefined;
}

function downgradedDetail(detail: RecordDetail): RecordDetail {
  if (detail === "full") return "summary";
  if (detail === "summary") return "brief";
  throw new ContextGenerationError("Record brief detail cannot be downgraded further", "BUDGET_EXCEEDED");
}

function measuredStablePrefixTokens(request: RecordContextBuildRequest, content: string): number {
  const measured = request.estimateStablePrefixTokens(content);
  if (!Number.isSafeInteger(measured) || measured < 0) {
    throw new ContextGenerationError("Token meter returned an invalid stable-prefix measurement", "VALIDATION_FAILED");
  }
  return measured;
}

export class BrokerRecordContextSource implements RecordContextSource {
  private readonly endpoint: URL | undefined;
  private readonly callTool: RecordToolCaller | undefined;
  private readonly timeoutMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly transportAttempts: number;
  private readonly retryBaseDelayMs: number;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(options: {
    endpoint?: string;
    callTool?: RecordToolCaller;
    timeoutMs?: number;
    refreshTimeoutMs?: number;
    transportAttempts?: number;
    retryBaseDelayMs?: number;
  } = {}) {
    this.callTool = options.callTool;
    this.endpoint = options.endpoint === undefined
      ? (options.callTool === undefined ? new URL("http://127.0.0.1:14588/memory-store/mcp") : undefined)
      : new URL(options.endpoint);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 600_000;
    this.transportAttempts = options.transportAttempts ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 750;
    if (!Number.isSafeInteger(this.transportAttempts) || this.transportAttempts < 1) {
      throw new ContextGenerationError("Memory Store transportAttempts must be a positive integer", "VALIDATION_FAILED");
    }
    if (!Number.isFinite(this.retryBaseDelayMs) || this.retryBaseDelayMs < 0) {
      throw new ContextGenerationError("Memory Store retryBaseDelayMs must be non-negative", "VALIDATION_FAILED");
    }
  }

  private async connect(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = (async () => {
      if (this.endpoint === undefined) {
        throw new ContextGenerationError("Memory Store HTTP endpoint is not configured", "BUILD_FAILED");
      }
      const client = new Client({ name: "dsh-memory-context", version: "0.0.0-candidate" });
      try {
        await client.connect(new StreamableHTTPClientTransport(this.endpoint));
      } catch (error) {
        await client.close().catch(() => undefined);
        throw new ContextGenerationError("Memory Store is unavailable", "BUILD_FAILED", { cause: error });
      }
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    agent?: unknown,
    sessionId = "unknown",
  ): Promise<string> {
    if (signal.aborted) throw signal.reason;
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ContextGenerationError(
        `Memory Store call ${name} exceeded ${this.timeoutMs}ms`,
        "TIMEOUT",
      )), this.timeoutMs);
    });
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const onAbort = (): void => rejectAbort?.(signal.reason);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        this.callTool === undefined
          ? (await this.connect()).callTool({ name, arguments: args })
          : this.callTool(name, args, { agent, sessionId, signal }),
        timeoutPromise,
        abortPromise,
      ]);
      const text = toolText(result);
      if ((result as { isError?: boolean })?.isError) {
        throw new ContextGenerationError(text || `Memory Store call ${name} failed`, "BUILD_FAILED");
      }
      return text;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async callWithRetry(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    agent?: unknown,
    sessionId = "unknown",
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.transportAttempts; attempt += 1) {
      try {
        return await this.call(name, args, signal, agent, sessionId);
      } catch (error) {
        lastError = error;
        if (signal.aborted || !retryableTransportError(error) || attempt + 1 >= this.transportAttempts) throw error;
        const client = this.client;
        this.client = undefined;
        if (client !== undefined) await client.close().catch(() => undefined);
        await retryDelay(this.retryBaseDelayMs * (2 ** attempt), signal);
      }
    }
    throw lastError;
  }

  private readArgs(request: RecordContextBuildRequest): Record<string, unknown> {
    return {
      action: "read",
      conversationId: request.sessionId,
      chain: "dsh",
      workspace: request.workspace,
      format: "text",
      view: "raw",
      maxChars: Math.max(64_000, request.contextWindow * 2),
      withCitations: true,
    };
  }

  private async readExisting(request: RecordContextBuildRequest): Promise<string | undefined> {
    const rendered = await this.callWithRetry(
      "record_manage",
      this.readArgs(request),
      request.signal,
      request.agent,
      request.sessionId,
    );
    const text = await resolveRecordText(rendered, Math.max(64_000, request.contextWindow * 2));
    if (/❌\s*未找到/u.test(text)) return undefined;
    if (/^\s*❌/mu.test(text)) {
      throw new ContextGenerationError("Memory Store Record read failed", "BUILD_FAILED", { cause: new Error(text) });
    }
    return text;
  }

  private async refresh(request: RecordContextBuildRequest): Promise<void> {
    const started = await this.callWithRetry("record_manage", {
      action: "update",
      conversationId: request.sessionId,
      dataChain: "dsh",
      modelChain: "codex",
      workspace: request.workspace,
      background: true,
      force: false,
    }, request.signal, request.agent, request.sessionId);
    const taskId = parseTaskId(started);
    if (taskId === undefined) {
      if (reportsFailure(started)) {
        throw new ContextGenerationError("Memory Store Record refresh failed", "BUILD_FAILED", { cause: new Error(started) });
      }
      return;
    }
    const deadline = Date.now() + this.refreshTimeoutMs;
    while (Date.now() < deadline) {
      request.signal.throwIfAborted();
      const current = await this.readExisting(request);
      if (current !== undefined && parseRoundCount(current) >= request.roundEnd) return;
      const status = await this.callWithRetry("record_manage", {
        action: "task_status",
        taskId,
        conversationId: request.sessionId,
        waitSeconds: 5,
      }, request.signal, request.agent, request.sessionId);
      if (reportsFailure(status)) {
        throw new ContextGenerationError("Memory Store Record scheduler failed", "BUILD_FAILED", { cause: new Error(status) });
      }
      if (reportsTerminalSuccess(status)) {
        const published = await this.readExisting(request);
        const availableRoundEnd = published === undefined ? 0 : parseRoundCount(published);
        if (availableRoundEnd >= request.roundEnd) return;
        throw new RecordCoverageError(availableRoundEnd, request.roundEnd);
      }
    }
    throw new ContextGenerationError("Memory Store Record refresh timed out", "TIMEOUT");
  }

  async build(request: RecordContextBuildRequest): Promise<RecordContextBuildResult> {
    let recordText = await this.readExisting(request);
    if (recordText === undefined || parseRoundCount(recordText) < request.roundEnd) {
      await this.refresh(request);
      recordText = await this.readExisting(request);
    }
    if (recordText === undefined) {
      throw new ContextGenerationError("Memory Store did not publish a Record", "BUILD_FAILED");
    }
    const recordRoundCount = parseRoundCount(recordText);
    if (recordRoundCount < request.roundEnd) {
      throw new RecordCoverageError(recordRoundCount, request.roundEnd);
    }
    const selectedPhases = parsePhases(recordText).filter(phase => (
      phase.roundEnd >= request.roundStart && phase.roundStart <= request.roundEnd
    ));
    if (selectedPhases.length === 0) {
      throw new ContextGenerationError("Memory Store Record has no phase covering the selected rounds", "BUILD_FAILED");
    }
    const protectedRoundIds = new Set(request.protectedRoundIds ?? []);
    const protectedPhaseIndexes = new Set<number>();
    for (const [index, phase] of selectedPhases.entries()) {
      for (let round = phase.roundStart; round <= phase.roundEnd; round += 1) {
        if (protectedRoundIds.has(round)) {
          protectedPhaseIndexes.add(index);
          break;
        }
      }
    }
    const details = selectedPhases.map((phase, index) => (
      protectedPhaseIndexes.has(index) ? "full" : phaseDetail(phase, request.detailByRound)
    ));
    const sourceRevision = hash(recordText);
    const buildInput = (): StableContextInput => {
      const recordContent = [
        `【本次 Record 覆盖轮次 ${request.roundStart}-${request.roundEnd}；其余轮次未放入本检查点】`,
        ...selectedPhases.map((phase, index) => renderPhase(phase, details[index]!)),
      ].join("\n\n");
      const record: RecordContextSource = {
        kind: "record",
        recordId: `record:${request.sessionId}`,
        recordGenerationId: `memory-store:${sourceRevision}`,
        roundStart: request.roundStart,
        roundEnd: request.roundEnd,
        detail: combinedDetail(details),
        sourceSeqs: [...request.selectedSurfaceSeqs],
        content: recordContent,
        contentSha256: contentSha256(recordContent),
      };
      const contentInput: StableContextContentInput = {
        contextGenerationId: request.contextGenerationId,
        sessionId: request.sessionId,
        shadowedSeqs: [...request.selectedSurfaceSeqs],
        records: [record],
        rawRounds: [],
      };
      const stablePrefixTokens = measuredStablePrefixTokens(request, renderStableContextContent(contentInput));
      return {
        ...contentInput,
        tokenBudget: {
          contextWindow: request.contextWindow,
          stablePrefixTokens,
          recentRawTokens: request.retainedRequestTokens,
          reservedResponseTokens: request.reservedResponseTokens,
        },
      };
    };
    let input = buildInput();
    while (
      input.tokenBudget.stablePrefixTokens
      + input.tokenBudget.recentRawTokens
      + input.tokenBudget.reservedResponseTokens
      > input.tokenBudget.contextWindow
    ) {
      const index = nextDowngradeIndex(details, protectedPhaseIndexes);
      if (index === undefined) {
        throw new ContextGenerationError(
          "Record projection cannot fit the model window after every non-protected phase reached brief detail",
          "BUDGET_EXCEEDED",
        );
      }
      details[index] = downgradedDetail(details[index]!);
      input = buildInput();
    }
    return {
      sourceRevision,
      recordRoundCount,
      ...(protectedPhaseIndexes.size === 0 ? {} : {
        protectedProjectionContent: selectedPhases
          .filter((_phase, index) => protectedPhaseIndexes.has(index))
          .map(phase => phase.content)
          .join("\n\n"),
      }),
      input,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.close().catch(() => undefined);
  }
}

export const recordContextTesting = Object.freeze({
  parseRoundCount,
  parsePhases,
  phaseDetail,
  renderPhase,
});
