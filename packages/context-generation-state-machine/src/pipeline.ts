import {
  CompressionCoordinator,
  ContextGenerationError,
  type BuildContext,
  type CompressionRunPhase,
  type PublishedGeneration,
} from "./index.ts";
import { type FileGenerationStore, type RecoveryReport } from "./file-store.ts";
import { toCoordinatorBuildResult, type StableContextInput } from "./context-builder.ts";

export type ContextPipelinePhase =
  | "disabled"
  | "idle"
  | "bpc-building"
  | "hard-building"
  | "validating"
  | "publishing"
  | "published"
  | "bpc-failed-using-previous"
  | "paused-protected";

export interface PressureThresholds {
  bpcRatio: number;
  hardRatio: number;
}

export type PressureAction = "none" | "bpc" | "hard";

export interface ContextPipelineStatus {
  enabled: boolean;
  phase: ContextPipelinePhase;
  paused: boolean;
  activeTrigger?: "bpc" | "hard";
  publishedGenerationId?: string;
  stablePrefixSha256?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface ContextPipelineControllerOptions {
  enabled?: boolean;
  store: FileGenerationStore;
  coordinator?: CompressionCoordinator;
}

export type StableContextFactory = (context: BuildContext) => Promise<StableContextInput>;

interface ActiveRun {
  trigger: "bpc" | "hard";
  controller: AbortController;
  promise: Promise<PublishedGeneration>;
}

export function classifyPressure(ratio: number, thresholds: PressureThresholds): PressureAction {
  if (!Number.isFinite(ratio) || ratio < 0) {
    throw new ContextGenerationError("Context pressure ratio is invalid", "VALIDATION_FAILED");
  }
  if (
    !Number.isFinite(thresholds.bpcRatio)
    || !Number.isFinite(thresholds.hardRatio)
    || thresholds.bpcRatio <= 0
    || thresholds.hardRatio > 1
    || thresholds.bpcRatio >= thresholds.hardRatio
  ) {
    throw new ContextGenerationError("Context pressure thresholds are invalid", "VALIDATION_FAILED");
  }
  if (ratio >= thresholds.hardRatio) return "hard";
  if (ratio >= thresholds.bpcRatio) return "bpc";
  return "none";
}

function errorStatus(error: unknown): Pick<ContextPipelineStatus, "lastErrorCode" | "lastErrorMessage"> {
  return {
    lastErrorCode: error instanceof ContextGenerationError ? error.code : "UNKNOWN",
    lastErrorMessage: error instanceof Error ? error.message : String(error),
  };
}

function prefixHash(published: PublishedGeneration): string | undefined {
  const manifest = published.manifest.metadata.surfaceManifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
  const hash = (manifest as { stablePrefixSha256?: unknown }).stablePrefixSha256;
  return typeof hash === "string" ? hash : undefined;
}

export class ContextPipelineController {
  private readonly enabled: boolean;
  private readonly store: FileGenerationStore;
  private readonly coordinator: CompressionCoordinator;
  private activeRun: ActiveRun | undefined;
  private status: ContextPipelineStatus;

  constructor(options: ContextPipelineControllerOptions) {
    this.enabled = options.enabled ?? false;
    this.store = options.store;
    this.coordinator = options.coordinator ?? new CompressionCoordinator({ enabled: this.enabled, store: this.store });
    this.status = {
      enabled: this.enabled,
      phase: this.enabled ? "idle" : "disabled",
      paused: false,
    };
  }

  getStatus(): ContextPipelineStatus {
    return structuredClone(this.status);
  }

  async initialize(signal: AbortSignal = new AbortController().signal): Promise<RecoveryReport | undefined> {
    if (!this.enabled) return undefined;
    const report = await this.store.recoverUnpublished({ signal });
    const published = await this.store.getPublished({ signal });
    this.status = {
      enabled: true,
      phase: "idle",
      paused: false,
      ...(published === undefined ? {} : {
        publishedGenerationId: published.manifest.generationId,
        stablePrefixSha256: prefixHash(published),
      }),
    };
    return report;
  }

  private updatePhase(trigger: "bpc" | "hard", phase: CompressionRunPhase): void {
    if (phase === "build" || phase === "prepare" || phase === "store" || phase === "read-parent") {
      this.status.phase = trigger === "bpc" ? "bpc-building" : "hard-building";
    } else if (phase === "validate") {
      this.status.phase = "validating";
    } else if (phase === "publish") {
      this.status.phase = "publishing";
    }
  }

  private launch(trigger: "bpc" | "hard", factory: StableContextFactory): Promise<PublishedGeneration> {
    if (!this.enabled) {
      return Promise.reject(new ContextGenerationError("Experimental context pipeline is disabled", "FEATURE_DISABLED"));
    }
    if (this.status.paused) {
      return Promise.reject(new ContextGenerationError("Conversation is paused after hard compaction failure", "BUILD_FAILED"));
    }
    if (this.activeRun !== undefined) {
      return Promise.reject(new ContextGenerationError("Another context generation is already running", "STORAGE_FAILURE"));
    }

    const controller = new AbortController();
    this.status = {
      ...this.status,
      phase: trigger === "bpc" ? "bpc-building" : "hard-building",
      activeTrigger: trigger,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    };
    const promise = this.coordinator.run(trigger, async (context) => {
      const input = await factory(context);
      if (input.contextGenerationId !== context.generationId) {
        throw new ContextGenerationError("Stable context generation id does not match the transaction", "VALIDATION_FAILED");
      }
      return toCoordinatorBuildResult(input);
    }, {
      signal: controller.signal,
      onPhase: (phase) => this.updatePhase(trigger, phase),
    }).then((published) => {
      this.status = {
        enabled: true,
        phase: "published",
        paused: false,
        publishedGenerationId: published.manifest.generationId,
        stablePrefixSha256: prefixHash(published),
      };
      return published;
    }).catch((error: unknown) => {
      this.status = {
        ...this.status,
        phase: trigger === "bpc" ? "bpc-failed-using-previous" : "paused-protected",
        paused: trigger === "hard",
        activeTrigger: undefined,
        ...errorStatus(error),
      };
      throw error;
    }).finally(() => {
      if (this.activeRun?.promise === promise) this.activeRun = undefined;
    });
    this.activeRun = { trigger, controller, promise };
    return promise;
  }

  runBpc(factory: StableContextFactory): Promise<PublishedGeneration> {
    return this.launch("bpc", factory);
  }

  async runHard(factory: StableContextFactory): Promise<PublishedGeneration> {
    if (this.activeRun?.trigger === "bpc") {
      const previous = this.activeRun;
      previous.controller.abort(new Error("Hard compaction superseded the background candidate"));
      await previous.promise.catch(() => undefined);
    }
    if (this.activeRun?.trigger === "hard") return this.activeRun.promise;
    return this.launch("hard", factory);
  }

  resumeAfterExplicitRecovery(): void {
    if (!this.enabled) return;
    this.status = {
      enabled: true,
      phase: "idle",
      paused: false,
      ...(this.status.publishedGenerationId === undefined ? {} : {
        publishedGenerationId: this.status.publishedGenerationId,
        stablePrefixSha256: this.status.stablePrefixSha256,
      }),
    };
  }

  renderDynamicStatus(): string {
    const status = this.status;
    const lines = [
      "【上下文维护状态｜动态信息，不属于稳定 Record 前缀】",
      `状态：${status.phase}`,
      `对话暂停保护：${status.paused ? "是" : "否"}`,
    ];
    if (status.publishedGenerationId !== undefined) lines.push(`当前代次：${status.publishedGenerationId}`);
    if (status.lastErrorMessage !== undefined) lines.push(`最近错误：${status.lastErrorMessage}`);
    if (status.phase === "bpc-failed-using-previous") {
      lines.push("后台预压缩失败，继续使用上一份已发布上下文。"
      );
    }
    if (status.phase === "paused-protected") {
      lines.push("同步硬压缩也失败，已暂停继续请求并保留现场，需要显式恢复后才能继续。"
      );
    }
    return lines.join("\n");
  }
}
