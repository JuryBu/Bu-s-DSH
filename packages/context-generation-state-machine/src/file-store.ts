import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  ContextGenerationError,
  INTERNAL_MANIFEST_VERSION,
  validateCandidate,
  type CandidateGeneration,
  type GenerationOperationContext,
  type GenerationStore,
  type PublishedGeneration,
  type StoredGeneration,
  type ValidatedGeneration,
} from "./index.ts";

const POINTER_FILE = "published.json";
const LOCK_FILE = ".generation-store.lock";

interface PublishedPointer {
  protocolVersion: typeof INTERNAL_MANIFEST_VERSION;
  generationId: string;
  contentSha256: string;
  publishedAt: number;
}

export interface FileGenerationStoreOptions {
  directory: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

export interface RecoveryReport {
  publishedGenerationId?: string;
  discardedGenerationIds: string[];
}

function assertActive(context: GenerationOperationContext): void {
  if (context.signal.aborted) {
    throw context.signal.reason ?? new ContextGenerationError("Storage operation was cancelled", "CANCELLED");
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function filenameForGeneration(generationId: string): string {
  return `generation-${createHash("sha256").update(generationId, "utf8").digest("hex")}.json`;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ContextGenerationError(`${label} is not valid JSON`, "STORAGE_FAILURE", { cause: error });
  }
}

function validateStoredGeneration(value: unknown): StoredGeneration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextGenerationError("Stored generation is not an object", "STORAGE_FAILURE");
  }
  const record = value as Partial<StoredGeneration>;
  if (record.state !== "candidate" && record.state !== "validated" && record.state !== "published") {
    throw new ContextGenerationError("Stored generation state is unsupported", "STORAGE_FAILURE");
  }
  const candidate: CandidateGeneration = {
    state: "candidate",
    manifest: clone(record.manifest as CandidateGeneration["manifest"]),
    content: record.content as string,
  };
  try {
    validateCandidate(candidate);
  } catch (error) {
    throw new ContextGenerationError("Stored generation failed integrity validation", "STORAGE_FAILURE", { cause: error });
  }
  if (record.state === "candidate") return candidate;
  if (!Number.isFinite(record.validatedAt) || (record.validatedAt as number) < candidate.manifest.createdAt) {
    throw new ContextGenerationError("Stored validation timestamp is invalid", "STORAGE_FAILURE");
  }
  const validated: ValidatedGeneration = {
    ...candidate,
    state: "validated",
    validatedAt: record.validatedAt as number,
  };
  if (record.state === "validated") return validated;
  if (!Number.isFinite(record.publishedAt) || (record.publishedAt as number) < validated.validatedAt) {
    throw new ContextGenerationError("Stored publication timestamp is invalid", "STORAGE_FAILURE");
  }
  return {
    ...validated,
    state: "published",
    publishedAt: record.publishedAt as number,
  };
}

function validatePointer(value: unknown): PublishedPointer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextGenerationError("Published pointer is not an object", "STORAGE_FAILURE");
  }
  const pointer = value as Partial<PublishedPointer>;
  if (pointer.protocolVersion !== INTERNAL_MANIFEST_VERSION) {
    throw new ContextGenerationError("Published pointer version is unsupported", "STORAGE_FAILURE");
  }
  if (typeof pointer.generationId !== "string" || pointer.generationId.trim().length === 0) {
    throw new ContextGenerationError("Published pointer generation id is invalid", "STORAGE_FAILURE");
  }
  if (typeof pointer.contentSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(pointer.contentSha256)) {
    throw new ContextGenerationError("Published pointer hash is invalid", "STORAGE_FAILURE");
  }
  if (!Number.isFinite(pointer.publishedAt) || (pointer.publishedAt as number) < 0) {
    throw new ContextGenerationError("Published pointer timestamp is invalid", "STORAGE_FAILURE");
  }
  return pointer as PublishedPointer;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class FileGenerationStore implements GenerationStore {
  readonly directory: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;

  constructor(options: FileGenerationStoreOptions) {
    if (!isAbsolute(options.directory)) {
      throw new ContextGenerationError("Generation store directory must be absolute", "VALIDATION_FAILED");
    }
    this.directory = options.directory;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    this.lockRetryMs = options.lockRetryMs ?? 20;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs <= 0) {
      throw new ContextGenerationError("Generation store lock timeout is invalid", "VALIDATION_FAILED");
    }
    if (!Number.isSafeInteger(this.lockRetryMs) || this.lockRetryMs <= 0) {
      throw new ContextGenerationError("Generation store lock retry interval is invalid", "VALIDATION_FAILED");
    }
  }

  private generationPath(generationId: string): string {
    return join(this.directory, filenameForGeneration(generationId));
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  private async readPointer(): Promise<PublishedPointer | undefined> {
    try {
      return validatePointer(parseJson(await readFile(join(this.directory, POINTER_FILE), "utf8"), "Published pointer"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readGeneration(generationId: string): Promise<StoredGeneration | undefined> {
    try {
      return validateStoredGeneration(parseJson(
        await readFile(this.generationPath(generationId), "utf8"),
        `Generation ${generationId}`,
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async atomicWriteJson(path: string, value: unknown, context: GenerationOperationContext): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx");
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      assertActive(context);
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async lockIsAbandoned(lockPath: string): Promise<boolean> {
    let value: unknown;
    try {
      value = parseJson(await readFile(lockPath, "utf8"), "Generation store lock");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
      return false;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const pid = (value as { pid?: unknown }).pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
    try {
      process.kill(pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ESRCH";
    }
  }

  private async withLock<T>(context: GenerationOperationContext, operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lockPath = join(this.directory, LOCK_FILE);
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (handle === undefined) {
      assertActive(context);
      try {
        handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
        } catch (error) {
          await handle.close().catch(() => undefined);
          handle = undefined;
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        if (await this.lockIsAbandoned(lockPath)) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new ContextGenerationError("Generation store lock timed out", "STORAGE_FAILURE");
        }
        await delay(this.lockRetryMs, context.signal);
      }
    }
    try {
      assertActive(context);
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async getPublished(context: GenerationOperationContext): Promise<PublishedGeneration | undefined> {
    assertActive(context);
    await this.ensureDirectory();
    const pointer = await this.readPointer();
    if (pointer === undefined) return undefined;
    const record = await this.readGeneration(pointer.generationId);
    if (record?.state !== "published") {
      throw new ContextGenerationError("Published generation record is unavailable", "STORAGE_FAILURE");
    }
    if (record.manifest.contentSha256 !== pointer.contentSha256 || record.publishedAt !== pointer.publishedAt) {
      throw new ContextGenerationError("Published pointer does not match its generation", "STORAGE_FAILURE");
    }
    return clone(record);
  }

  async getGeneration(
    generationId: string,
    context: GenerationOperationContext,
  ): Promise<StoredGeneration | undefined> {
    assertActive(context);
    await this.ensureDirectory();
    const record = await this.readGeneration(generationId);
    return record === undefined ? undefined : clone(record);
  }

  async putCandidate(candidate: CandidateGeneration, context: GenerationOperationContext): Promise<void> {
    validateCandidate(candidate);
    await this.withLock(context, async () => {
      if (await this.readGeneration(candidate.manifest.generationId) !== undefined) {
        throw new ContextGenerationError(`Generation ${candidate.manifest.generationId} already exists`, "STORAGE_FAILURE");
      }
      await this.atomicWriteJson(this.generationPath(candidate.manifest.generationId), candidate, context);
    });
  }

  async markValidated(
    generationId: string,
    validatedAt: number,
    context: GenerationOperationContext,
  ): Promise<ValidatedGeneration> {
    return this.withLock(context, async () => {
      const candidate = await this.readGeneration(generationId);
      if (candidate?.state !== "candidate") {
        throw new ContextGenerationError(`Candidate ${generationId} is unavailable`, "STORAGE_FAILURE");
      }
      if (!Number.isFinite(validatedAt) || validatedAt < candidate.manifest.createdAt) {
        throw new ContextGenerationError("Candidate validation time is invalid", "STORAGE_FAILURE");
      }
      const validated: ValidatedGeneration = {
        ...candidate,
        state: "validated",
        validatedAt,
      };
      await this.atomicWriteJson(this.generationPath(generationId), validated, context);
      return clone(validated);
    });
  }

  async publishAtomically(
    expectedPublishedGenerationId: string | undefined,
    generationId: string,
    publishedAt: number,
    context: GenerationOperationContext,
  ): Promise<PublishedGeneration> {
    return this.withLock(context, async () => {
      const pointer = await this.readPointer();
      if (pointer?.generationId !== expectedPublishedGenerationId) {
        throw new ContextGenerationError(
          `Published generation changed while ${generationId} was building`,
          "STALE_PARENT",
        );
      }
      const validated = await this.readGeneration(generationId);
      if (validated?.state !== "validated") {
        throw new ContextGenerationError(`Validated generation ${generationId} is unavailable`, "STORAGE_FAILURE");
      }
      if (!Number.isFinite(publishedAt) || publishedAt < validated.validatedAt) {
        throw new ContextGenerationError("Generation publication time is invalid", "STORAGE_FAILURE");
      }
      const published: PublishedGeneration = {
        ...validated,
        state: "published",
        publishedAt,
      };
      await this.atomicWriteJson(this.generationPath(generationId), published, context);
      const nextPointer: PublishedPointer = {
        protocolVersion: INTERNAL_MANIFEST_VERSION,
        generationId,
        contentSha256: published.manifest.contentSha256,
        publishedAt,
      };
      await this.atomicWriteJson(join(this.directory, POINTER_FILE), nextPointer, context);
      return clone(published);
    });
  }

  async discardUnpublished(generationId: string): Promise<void> {
    const context: GenerationOperationContext = { signal: new AbortController().signal };
    await this.withLock(context, async () => {
      const pointer = await this.readPointer();
      if (pointer?.generationId === generationId) return;
      await unlink(this.generationPath(generationId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }

  async recoverUnpublished(context: GenerationOperationContext): Promise<RecoveryReport> {
    return this.withLock(context, async () => {
      const pointer = await this.readPointer();
      if (pointer !== undefined) {
        const published = await this.readGeneration(pointer.generationId);
        if (published?.state !== "published" || published.manifest.contentSha256 !== pointer.contentSha256) {
          throw new ContextGenerationError("Published generation cannot be recovered", "STORAGE_FAILURE");
        }
      }
      const discardedGenerationIds: string[] = [];
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith("generation-") || !entry.name.endsWith(".json")) continue;
        const path = join(this.directory, entry.name);
        const record = validateStoredGeneration(parseJson(await readFile(path, "utf8"), entry.name));
        if (record.manifest.generationId === pointer?.generationId) continue;
        await unlink(path);
        discardedGenerationIds.push(record.manifest.generationId);
      }
      discardedGenerationIds.sort();
      return {
        ...(pointer === undefined ? {} : { publishedGenerationId: pointer.generationId }),
        discardedGenerationIds,
      };
    });
  }
}
