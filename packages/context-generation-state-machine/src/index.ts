import { createHash, randomUUID } from "node:crypto";

export const INTERNAL_MANIFEST_VERSION = "dsh-context-candidate/v0" as const;

export type CompressionTrigger = "bpc" | "hard" | "manual-rebuild" | "recovery";
export type GenerationState = "candidate" | "validated" | "published";

export type ContextGenerationErrorCode =
  | "FEATURE_DISABLED"
  | "BUILD_FAILED"
  | "BUDGET_EXCEEDED"
  | "VALIDATION_FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "STALE_PARENT"
  | "STORAGE_FAILURE";

export class ContextGenerationError extends Error {
  readonly code: ContextGenerationErrorCode;

  constructor(message: string, code: ContextGenerationErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextGenerationError";
    this.code = code;
  }
}

export interface ArtifactLocator {
  uri: string;
  sha256: string;
  bytes: number;
  lines?: number;
  /** The artifact writer has finished and the locator addresses the complete immutable result. */
  complete: true;
  /** The caller verified that the immutable artifact exists and matches sha256/bytes before pruning. */
  verified: true;
}

export interface ToolResultView {
  text: string;
  truncated: boolean;
  originalChars: number;
  artifact?: ArtifactLocator;
}

export interface ContextCandidateManifest {
  protocolVersion: typeof INTERNAL_MANIFEST_VERSION;
  generationId: string;
  parentPublishedGenerationId?: string;
  trigger: CompressionTrigger;
  createdAt: number;
  contentSha256: string;
  contentBytes: number;
  metadata: Readonly<Record<string, unknown>>;
}

export interface CandidateGeneration {
  state: "candidate";
  manifest: ContextCandidateManifest;
  content: string;
}

export interface ValidatedGeneration {
  state: "validated";
  manifest: ContextCandidateManifest;
  content: string;
  validatedAt: number;
}

export interface PublishedGeneration {
  state: "published";
  manifest: ContextCandidateManifest;
  content: string;
  validatedAt: number;
  publishedAt: number;
}

export type StoredGeneration = CandidateGeneration | ValidatedGeneration | PublishedGeneration;

export interface GenerationStore {
  getPublished(context: GenerationOperationContext): Promise<PublishedGeneration | undefined>;
  getGeneration(generationId: string, context: GenerationOperationContext): Promise<StoredGeneration | undefined>;
  putCandidate(candidate: CandidateGeneration, context: GenerationOperationContext): Promise<void>;
  markValidated(
    generationId: string,
    validatedAt: number,
    context: GenerationOperationContext,
  ): Promise<ValidatedGeneration>;
  publishAtomically(
    expectedPublishedGenerationId: string | undefined,
    generationId: string,
    publishedAt: number,
    context: GenerationOperationContext,
  ): Promise<PublishedGeneration>;
  discardUnpublished(generationId: string): Promise<void>;
}

export interface GenerationOperationContext {
  signal: AbortSignal;
}

export interface BuildContext {
  generationId: string;
  parentPublished?: PublishedGeneration;
  trigger: CompressionTrigger;
  signal: AbortSignal;
}

export interface BuildResult {
  content: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface CompressionRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onPhase?: (phase: CompressionRunPhase) => void;
}

export type CompressionRunPhase = "read-parent" | "build" | "prepare" | "store" | "validate" | "publish";

export interface CompressionCoordinatorOptions {
  enabled?: boolean;
  store: GenerationStore;
  now?: () => number;
  createGenerationId?: () => string;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function cloneGeneration<T extends StoredGeneration>(generation: T): T {
  return structuredClone(generation);
}

class RunAbort extends Error {
  readonly code: "CANCELLED" | "TIMEOUT";

  constructor(code: "CANCELLED" | "TIMEOUT", cause?: unknown) {
    super(code === "TIMEOUT" ? "Context generation timed out" : "Context generation was cancelled", { cause });
    this.name = "RunAbort";
    this.code = code;
  }
}

function assertOperationActive(context: GenerationOperationContext): void {
  if (context.signal.aborted) {
    throw context.signal.reason ?? new RunAbort("CANCELLED");
  }
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation may already be scheduled (for example a builder queued in
    // a microtask). Observe its eventual rejection so the early abort does not
    // leak an unhandled rejection after the coordinator has returned.
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason ?? new RunAbort("CANCELLED"));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      settle(() => reject(signal.reason ?? new RunAbort("CANCELLED")));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function assertArtifact(locator: ArtifactLocator): void {
  if (locator.complete !== true) {
    throw new ContextGenerationError("Artifact is not complete", "VALIDATION_FAILED");
  }
  if (locator.verified !== true) {
    throw new ContextGenerationError("Artifact was not verified before pruning", "VALIDATION_FAILED");
  }
  if (locator.uri.trim().length === 0) {
    throw new ContextGenerationError("Artifact URI is empty", "VALIDATION_FAILED");
  }
  if (!/^[0-9a-f]{64}$/i.test(locator.sha256)) {
    throw new ContextGenerationError("Artifact SHA-256 is invalid", "VALIDATION_FAILED");
  }
  if (!Number.isSafeInteger(locator.bytes) || locator.bytes <= 0) {
    throw new ContextGenerationError("Artifact byte count is invalid", "VALIDATION_FAILED");
  }
  if (locator.lines !== undefined && (!Number.isSafeInteger(locator.lines) || locator.lines <= 0)) {
    throw new ContextGenerationError("Artifact line count is invalid", "VALIDATION_FAILED");
  }
}

export function pruneToolResult(
  text: string,
  artifact: ArtifactLocator | undefined,
  limits: { thresholdChars?: number; headChars?: number; tailChars?: number } = {},
): ToolResultView {
  const thresholdChars = limits.thresholdChars ?? 8192;
  const headChars = limits.headChars ?? 4096;
  const tailChars = limits.tailChars ?? 1024;
  if (![thresholdChars, headChars, tailChars].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new ContextGenerationError("Tool-result pruning limits are invalid", "VALIDATION_FAILED");
  }
  if (text.length <= thresholdChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  if (artifact === undefined) {
    throw new ContextGenerationError(
      "A truncated tool result requires a complete artifact locator",
      "VALIDATION_FAILED",
    );
  }
  assertArtifact(artifact);
  const marker = [
    "",
    `[中段已裁剪，完整结果：${artifact.uri}]`,
    `[SHA-256=${artifact.sha256} bytes=${artifact.bytes}${artifact.lines === undefined ? "" : ` lines=${artifact.lines}`}]`,
    "",
  ].join("\n");
  const codePoints = Array.from(text);
  const head = codePoints.slice(0, headChars).join("");
  const defaultTailStart = Math.max(headChars, codePoints.length - tailChars);
  const continuationMarker = text.lastIndexOf("\n➡️ 下一段参数");
  const continuationSuffix = continuationMarker < 0 ? undefined : text.slice(continuationMarker + 1);
  const continuationStart = continuationSuffix === undefined || continuationSuffix.length > 16_384
    ? undefined
    : Array.from(text.slice(0, continuationMarker + 1)).length;
  const tailStart = continuationStart === undefined
    ? defaultTailStart
    : Math.min(defaultTailStart, Math.max(headChars, continuationStart));
  const tail = codePoints.slice(tailStart).join("");
  return {
    text: head + marker + tail,
    truncated: true,
    originalChars: text.length,
    artifact: structuredClone(artifact),
  };
}

export function validateCandidate(candidate: CandidateGeneration): void {
  const { manifest, content } = candidate;
  if (candidate.state !== "candidate") {
    throw new ContextGenerationError("Generation is not a candidate", "VALIDATION_FAILED");
  }
  if (manifest.protocolVersion !== INTERNAL_MANIFEST_VERSION) {
    throw new ContextGenerationError("Candidate manifest version is unsupported", "VALIDATION_FAILED");
  }
  if (manifest.generationId.trim().length === 0) {
    throw new ContextGenerationError("Candidate generation id is empty", "VALIDATION_FAILED");
  }
  if (
    manifest.parentPublishedGenerationId !== undefined
    && manifest.parentPublishedGenerationId.trim().length === 0
  ) {
    throw new ContextGenerationError("Candidate parent generation id is empty", "VALIDATION_FAILED");
  }
  if (!["bpc", "hard", "manual-rebuild", "recovery"].includes(manifest.trigger)) {
    throw new ContextGenerationError("Candidate trigger is unsupported", "VALIDATION_FAILED");
  }
  if (content.trim().length === 0) {
    throw new ContextGenerationError("Candidate content is empty", "VALIDATION_FAILED");
  }
  if (!Number.isFinite(manifest.createdAt) || manifest.createdAt < 0) {
    throw new ContextGenerationError("Candidate creation time is invalid", "VALIDATION_FAILED");
  }
  if (manifest.contentBytes !== utf8Bytes(content)) {
    throw new ContextGenerationError("Candidate content byte count does not match", "VALIDATION_FAILED");
  }
  if (manifest.contentSha256 !== sha256Text(content)) {
    throw new ContextGenerationError("Candidate content hash does not match", "VALIDATION_FAILED");
  }
  if (manifest.metadata === null || typeof manifest.metadata !== "object" || Array.isArray(manifest.metadata)) {
    throw new ContextGenerationError("Candidate metadata is invalid", "VALIDATION_FAILED");
  }
}

export function createCandidate(input: {
  generationId: string;
  parentPublishedGenerationId?: string;
  trigger: CompressionTrigger;
  createdAt: number;
  content: string;
  metadata?: Readonly<Record<string, unknown>>;
}): CandidateGeneration {
  return {
    state: "candidate",
    manifest: {
      protocolVersion: INTERNAL_MANIFEST_VERSION,
      generationId: input.generationId,
      ...(input.parentPublishedGenerationId === undefined
        ? {}
        : { parentPublishedGenerationId: input.parentPublishedGenerationId }),
      trigger: input.trigger,
      createdAt: input.createdAt,
      contentSha256: sha256Text(input.content),
      contentBytes: utf8Bytes(input.content),
      metadata: structuredClone(input.metadata ?? {}),
    },
    content: input.content,
  };
}

export class InMemoryGenerationStore implements GenerationStore {
  private readonly records = new Map<string, StoredGeneration>();
  private publishedGenerationId: string | undefined;

  constructor(seed?: PublishedGeneration) {
    if (seed !== undefined) {
      this.records.set(seed.manifest.generationId, cloneGeneration(seed));
      this.publishedGenerationId = seed.manifest.generationId;
    }
  }

  async getPublished(context: GenerationOperationContext): Promise<PublishedGeneration | undefined> {
    assertOperationActive(context);
    if (this.publishedGenerationId === undefined) return undefined;
    const record = this.records.get(this.publishedGenerationId);
    if (record?.state !== "published") {
      throw new ContextGenerationError("Published pointer is corrupt", "STORAGE_FAILURE");
    }
    return cloneGeneration(record);
  }

  async getGeneration(
    generationId: string,
    context: GenerationOperationContext,
  ): Promise<StoredGeneration | undefined> {
    assertOperationActive(context);
    const record = this.records.get(generationId);
    return record === undefined ? undefined : cloneGeneration(record);
  }

  async putCandidate(candidate: CandidateGeneration, context: GenerationOperationContext): Promise<void> {
    assertOperationActive(context);
    const id = candidate.manifest.generationId;
    if (this.records.has(id)) {
      throw new ContextGenerationError(`Generation ${id} already exists`, "STORAGE_FAILURE");
    }
    this.records.set(id, cloneGeneration(candidate));
  }

  async markValidated(
    generationId: string,
    validatedAt: number,
    context: GenerationOperationContext,
  ): Promise<ValidatedGeneration> {
    assertOperationActive(context);
    const candidate = this.records.get(generationId);
    if (candidate?.state !== "candidate") {
      throw new ContextGenerationError(`Candidate ${generationId} is unavailable`, "STORAGE_FAILURE");
    }
    if (!Number.isFinite(validatedAt) || validatedAt < candidate.manifest.createdAt) {
      throw new ContextGenerationError("Candidate validation time is invalid", "STORAGE_FAILURE");
    }
    validateCandidate(candidate);
    const validated: ValidatedGeneration = {
      state: "validated",
      manifest: structuredClone(candidate.manifest),
      content: candidate.content,
      validatedAt,
    };
    this.records.set(generationId, cloneGeneration(validated));
    return validated;
  }

  async publishAtomically(
    expectedPublishedGenerationId: string | undefined,
    generationId: string,
    publishedAt: number,
    context: GenerationOperationContext,
  ): Promise<PublishedGeneration> {
    assertOperationActive(context);
    if (this.publishedGenerationId !== expectedPublishedGenerationId) {
      throw new ContextGenerationError(
        `Published generation changed while ${generationId} was building`,
        "STALE_PARENT",
      );
    }
    const validated = this.records.get(generationId);
    if (validated?.state !== "validated") {
      throw new ContextGenerationError(`Validated generation ${generationId} is unavailable`, "STORAGE_FAILURE");
    }
    if (!Number.isFinite(publishedAt) || publishedAt < validated.validatedAt) {
      throw new ContextGenerationError("Generation publication time is invalid", "STORAGE_FAILURE");
    }
    const published: PublishedGeneration = {
      state: "published",
      manifest: structuredClone(validated.manifest),
      content: validated.content,
      validatedAt: validated.validatedAt,
      publishedAt,
    };
    this.records.set(generationId, cloneGeneration(published));
    this.publishedGenerationId = generationId;
    return published;
  }

  async discardUnpublished(generationId: string): Promise<void> {
    const record = this.records.get(generationId);
    if (record !== undefined && record.state !== "published") this.records.delete(generationId);
  }

  getRecord(generationId: string): StoredGeneration | undefined {
    const record = this.records.get(generationId);
    return record === undefined ? undefined : cloneGeneration(record);
  }
}

export class CompressionCoordinator {
  private readonly enabled: boolean;
  private readonly store: GenerationStore;
  private readonly now: () => number;
  private readonly createGenerationId: () => string;

  constructor(options: CompressionCoordinatorOptions) {
    this.enabled = options.enabled ?? false;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.createGenerationId = options.createGenerationId ?? randomUUID;
  }

  async run(
    trigger: CompressionTrigger,
    build: (context: BuildContext) => Promise<BuildResult>,
    options: CompressionRunOptions = {},
  ): Promise<PublishedGeneration> {
    if (!this.enabled) {
      throw new ContextGenerationError("Experimental context generation is disabled", "FEATURE_DISABLED");
    }
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new ContextGenerationError("Compression timeout is invalid", "VALIDATION_FAILED");
    }
    if (!["bpc", "hard", "manual-rebuild", "recovery"].includes(trigger)) {
      throw new ContextGenerationError("Compression trigger is unsupported", "VALIDATION_FAILED");
    }
    const controller = new AbortController();
    let candidateStored = false;
    let phase: CompressionRunPhase = "read-parent";
    let generationId: string | undefined;
    const operationContext: GenerationOperationContext = { signal: controller.signal };
    const cancel = (): void => controller.abort(new RunAbort("CANCELLED", options.signal?.reason));
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new RunAbort("TIMEOUT"));
        }, options.timeoutMs);
    try {
      options.onPhase?.(phase);
      const parentPublished = await this.store.getPublished(operationContext);
      assertOperationActive(operationContext);
      phase = "prepare";
      options.onPhase?.(phase);
      generationId = this.createGenerationId();
      if (generationId.trim().length === 0) {
        throw new ContextGenerationError("Generated context generation id is empty", "VALIDATION_FAILED");
      }

      phase = "build";
      options.onPhase?.(phase);
      const buildPromise = Promise.resolve().then(() => {
        assertOperationActive(operationContext);
        return build({ generationId, parentPublished, trigger, signal: controller.signal });
      });
      const result = await awaitWithAbort(buildPromise, controller.signal);
      if (typeof result?.content !== "string") {
        throw new ContextGenerationError("Builder returned invalid context content", "VALIDATION_FAILED");
      }

      phase = "prepare";
      options.onPhase?.(phase);
      const candidate = createCandidate({
        generationId,
        parentPublishedGenerationId: parentPublished?.manifest.generationId,
        trigger,
        createdAt: this.now(),
        content: result.content,
        metadata: result.metadata,
      });
      validateCandidate(candidate);

      phase = "store";
      options.onPhase?.(phase);
      await this.store.putCandidate(candidate, operationContext);
      candidateStored = true;

      phase = "validate";
      options.onPhase?.(phase);
      const validated = await this.store.markValidated(generationId, this.now(), operationContext);

      phase = "publish";
      options.onPhase?.(phase);
      return await this.store.publishAtomically(
        parentPublished?.manifest.generationId,
        validated.manifest.generationId,
        this.now(),
        operationContext,
      );
    } catch (error) {
      if (candidateStored && generationId !== undefined) {
        try {
          await this.store.discardUnpublished(generationId);
        } catch {
          // Cleanup failure must not replace the original failure or change published state.
        }
      }
      const abort = error instanceof RunAbort
        ? error
        : controller.signal.reason instanceof RunAbort
          ? controller.signal.reason
          : undefined;
      if (abort !== undefined) {
        throw new ContextGenerationError(abort.message, abort.code, { cause: abort.cause ?? error });
      }
      if (error instanceof ContextGenerationError) throw error;
      throw new ContextGenerationError(
        phase === "build" ? "Context generation build failed" : `Context generation ${phase} failed`,
        phase === "build"
          ? "BUILD_FAILED"
          : phase === "prepare" || phase === "validate"
            ? "VALIDATION_FAILED"
            : "STORAGE_FAILURE",
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
}
