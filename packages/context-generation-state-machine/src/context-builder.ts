import { createHash } from "node:crypto";

import { ContextGenerationError, type BuildResult } from "./index.ts";

export const CONTEXT_SURFACE_PROTOCOL_VERSION = "dsh-memory-context-surface/v0" as const;

export type RecordDetail = "full" | "summary" | "brief";

export interface RecordContextSource {
  kind: "record";
  recordId: string;
  recordGenerationId: string;
  roundStart: number;
  roundEnd: number;
  detail: RecordDetail;
  /** Exact current-surface events represented by this Record projection. */
  sourceSeqs: number[];
  content: string;
  contentSha256: string;
}

export interface RawRoundContextSource {
  kind: "raw-round";
  round: number;
  sourceSeqs: number[];
  content: string;
  contentSha256: string;
}

export interface ContextTokenBudget {
  contextWindow: number;
  stablePrefixTokens: number;
  recentRawTokens: number;
  reservedResponseTokens: number;
}

export interface StableContextInput {
  contextGenerationId: string;
  sessionId: string;
  shadowedSeqs: number[];
  records: RecordContextSource[];
  rawRounds: RawRoundContextSource[];
  tokenBudget: ContextTokenBudget;
}

export type StableContextContentInput = Omit<StableContextInput, "tokenBudget">;

export interface StableContextManifest {
  protocolVersion: typeof CONTEXT_SURFACE_PROTOCOL_VERSION;
  contextGenerationId: string;
  sessionId: string;
  shadowedSeqs: number[];
  records: Array<Omit<RecordContextSource, "content">>;
  rawRounds: Array<Omit<RawRoundContextSource, "content">>;
  tokenBudget: ContextTokenBudget;
  stablePrefixSha256: string;
}

export interface StableContextBuild {
  content: string;
  contentSha256: string;
  manifest: StableContextManifest;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function contentSha256(value: string): string {
  return sha256(value);
}

function assertIdentifier(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new ContextGenerationError(`${label} is invalid`, "VALIDATION_FAILED");
  }
}

function assertPositiveInteger(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ContextGenerationError(`${label} is invalid`, "VALIDATION_FAILED");
  }
}

function assertHash(content: string, expected: string, label: string): void {
  if (!/^[0-9a-f]{64}$/i.test(expected) || sha256(content) !== expected.toLowerCase()) {
    throw new ContextGenerationError(`${label} hash does not match its content`, "VALIDATION_FAILED");
  }
}

function assertUniqueSeqs(seqs: readonly number[], label: string): void {
  const seen = new Set<number>();
  for (const seq of seqs) {
    assertPositiveInteger(seq, `${label} sequence`, true);
    if (seen.has(seq)) throw new ContextGenerationError(`${label} contains duplicate sequence ids`, "VALIDATION_FAILED");
    seen.add(seq);
  }
}

function validateTokenBudget(budget: ContextTokenBudget): void {
  assertPositiveInteger(budget.contextWindow, "Context window");
  assertPositiveInteger(budget.stablePrefixTokens, "Stable prefix token count", true);
  assertPositiveInteger(budget.recentRawTokens, "Recent raw token count", true);
  assertPositiveInteger(budget.reservedResponseTokens, "Reserved response token count", true);
  const total = budget.stablePrefixTokens + budget.recentRawTokens + budget.reservedResponseTokens;
  if (total > budget.contextWindow) {
    throw new ContextGenerationError("Context token budget exceeds the model window", "VALIDATION_FAILED");
  }
}

function assertExactCoverage(input: StableContextContentInput): void {
  const represented = [
    ...input.records.flatMap(record => record.sourceSeqs),
    ...input.rawRounds.flatMap(round => round.sourceSeqs),
  ];
  assertUniqueSeqs(represented, "Context sources");
  const expected = [...input.shadowedSeqs].sort((left, right) => left - right);
  const actual = represented.sort((left, right) => left - right);
  if (expected.length !== actual.length || expected.some((seq, index) => seq !== actual[index])) {
    throw new ContextGenerationError(
      "Record and raw-round sources do not exactly cover the shadowed surface events",
      "VALIDATION_FAILED",
    );
  }
}

function validateStableContextContentInput(input: StableContextContentInput): void {
  assertIdentifier(input.contextGenerationId, "Context generation id");
  assertIdentifier(input.sessionId, "Session id");
  if (input.shadowedSeqs.length === 0) {
    throw new ContextGenerationError("Stable context must identify shadowed source events", "VALIDATION_FAILED");
  }
  assertUniqueSeqs(input.shadowedSeqs, "Shadowed source events");
  for (const record of input.records) {
    assertIdentifier(record.recordId, "Record id");
    assertIdentifier(record.recordGenerationId, "Record generation id");
    assertPositiveInteger(record.roundStart, "Record start round");
    assertPositiveInteger(record.roundEnd, "Record end round");
    if (record.roundEnd < record.roundStart) {
      throw new ContextGenerationError("Record round range is reversed", "VALIDATION_FAILED");
    }
    if (!(["full", "summary", "brief"] as const).includes(record.detail)) {
      throw new ContextGenerationError("Record detail is unsupported", "VALIDATION_FAILED");
    }
    if (record.sourceSeqs.length === 0) {
      throw new ContextGenerationError("Record source sequence list is empty", "VALIDATION_FAILED");
    }
    assertUniqueSeqs(record.sourceSeqs, `Record ${record.recordId}`);
    if (record.content.trim().length === 0) {
      throw new ContextGenerationError("Record content is empty", "VALIDATION_FAILED");
    }
    assertHash(record.content, record.contentSha256, `Record ${record.recordId}`);
  }
  for (const round of input.rawRounds) {
    assertPositiveInteger(round.round, "Raw round");
    if (round.sourceSeqs.length === 0) {
      throw new ContextGenerationError("Raw round source sequence list is empty", "VALIDATION_FAILED");
    }
    assertUniqueSeqs(round.sourceSeqs, `Raw round ${round.round}`);
    if (round.content.trim().length === 0) {
      throw new ContextGenerationError("Raw round content is empty", "VALIDATION_FAILED");
    }
    assertHash(round.content, round.contentSha256, `Raw round ${round.round}`);
  }
  assertExactCoverage(input);
}

export function validateStableContextInput(input: StableContextInput): void {
  validateStableContextContentInput(input);
  validateTokenBudget(input.tokenBudget);
}

function renderRecord(record: RecordContextSource): string {
  return [
    `【Record 来源｜${record.detail}｜轮 ${record.roundStart}-${record.roundEnd}】`,
    `recordId=${record.recordId} recordGeneration=${record.recordGenerationId} sourceSeqs=${record.sourceSeqs.join(",")} sha256=${record.contentSha256}`,
    record.content,
  ].join("\n");
}

function renderRawRound(round: RawRoundContextSource): string {
  return [
    `【原始轮次来源｜轮 ${round.round}】`,
    `sourceSeqs=${round.sourceSeqs.join(",")} sha256=${round.contentSha256}`,
    round.content,
  ].join("\n");
}

function renderStableContextContentUnchecked(input: StableContextContentInput): string {
  const sections = [
    `<dsh-memory-context protocol="${CONTEXT_SURFACE_PROTOCOL_VERSION}" generation="${input.contextGenerationId}">`,
    "【上下文说明】下方包含压缩后的 Record 与少量原始轮次，并非完整对话。需要逐字内容或精确细节时，必须使用线程读取工具恢复原文，不得凭摘要补写。",
    ...input.records.map(renderRecord),
    ...input.rawRounds.map(renderRawRound),
    "</dsh-memory-context>",
  ];
  return sections.join("\n\n");
}

export function renderStableContextContent(input: StableContextContentInput): string {
  validateStableContextContentInput(input);
  return renderStableContextContentUnchecked(input);
}

export function buildStableContext(input: StableContextInput): StableContextBuild {
  validateStableContextInput(input);
  const content = renderStableContextContentUnchecked(input);
  const stablePrefixSha256 = sha256(content);
  const manifest: StableContextManifest = {
    protocolVersion: CONTEXT_SURFACE_PROTOCOL_VERSION,
    contextGenerationId: input.contextGenerationId,
    sessionId: input.sessionId,
    shadowedSeqs: [...input.shadowedSeqs],
    records: input.records.map(({ content: _content, ...source }) => structuredClone(source)),
    rawRounds: input.rawRounds.map(({ content: _content, ...source }) => structuredClone(source)),
    tokenBudget: structuredClone(input.tokenBudget),
    stablePrefixSha256,
  };
  return { content, contentSha256: stablePrefixSha256, manifest };
}

export function assertMeasuredContextBudget(
  built: StableContextBuild,
  estimateStablePrefixTokens: (content: string) => number,
): number {
  const measured = estimateStablePrefixTokens(built.content);
  if (!Number.isSafeInteger(measured) || measured < 0) {
    throw new ContextGenerationError("Token meter returned an invalid stable-prefix measurement", "VALIDATION_FAILED");
  }
  const budget = built.manifest.tokenBudget;
  const total = measured + budget.recentRawTokens + budget.reservedResponseTokens;
  if (total > budget.contextWindow) {
    throw new ContextGenerationError("Measured context exceeds the model window", "VALIDATION_FAILED");
  }
  return measured;
}

export function toCoordinatorBuildResult(input: StableContextInput): BuildResult {
  const built = buildStableContext(input);
  return {
    content: built.content,
    metadata: {
      surfaceProtocolVersion: CONTEXT_SURFACE_PROTOCOL_VERSION,
      surfaceManifest: built.manifest,
      sourceKind: "plugin",
      sourcePlugin: "memory-context",
    },
  };
}

export class StablePrefixCache {
  private readonly cache = new Map<string, StableContextBuild>();
  private readonly generationHashes = new Map<string, string>();

  getOrBuild(input: StableContextInput): StableContextBuild {
    const built = buildStableContext(input);
    const existingHash = this.generationHashes.get(input.contextGenerationId);
    if (existingHash !== undefined && existingHash !== built.contentSha256) {
      throw new ContextGenerationError(
        `Context generation ${input.contextGenerationId} is immutable and already has different content`,
        "VALIDATION_FAILED",
      );
    }
    this.generationHashes.set(input.contextGenerationId, built.contentSha256);
    const key = `${input.contextGenerationId}:${built.contentSha256}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return structuredClone(cached);
    this.cache.set(key, structuredClone(built));
    return structuredClone(built);
  }

  clearExcept(contextGenerationId?: string): void {
    if (contextGenerationId === undefined) {
      this.cache.clear();
      this.generationHashes.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (!key.startsWith(`${contextGenerationId}:`)) this.cache.delete(key);
    }
    for (const generationId of this.generationHashes.keys()) {
      if (generationId !== contextGenerationId) this.generationHashes.delete(generationId);
    }
  }
}
