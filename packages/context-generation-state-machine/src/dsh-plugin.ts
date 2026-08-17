import { isAbsolute } from "node:path";

import { ContextGenerationError } from "./index.ts";
import { FileGenerationStore } from "./file-store.ts";
import { ContextPipelineController } from "./pipeline.ts";
import {
  ContextPauseRecoveryService,
  ContextRuntimeStateStore,
  defaultContextRuntimeStateDirectory,
} from "./runtime-state.ts";

export const name = "memory-context-candidate";
export const inject: string[] = [];

export interface DshContextCandidatePluginConfig {
  enabled?: boolean;
  storeDirectory?: string;
  runtimeStateDirectory?: string;
}

interface CandidatePluginContext {
  logger?: {
    info?: (message: string, ...args: unknown[]) => void;
  };
  provide: (name: string, value: unknown) => (() => void) | void;
}

/**
 * rc.6 candidate plugin entrypoint.
 *
 * It exposes a candidate pipeline service and a durable pause-recovery service.
 * It does not register itself as `ctx.compaction`, does not hook `agent/pre-step`,
 * and does not append session replacement events. A host integration must opt in
 * explicitly after CTX-07 and shadow-price compatibility are frozen.
 */
export async function apply(
  ctx: CandidatePluginContext,
  config: DshContextCandidatePluginConfig = {},
): Promise<(() => void) | void> {
  if (config.enabled !== true) {
    ctx.logger?.info?.("Memory Context 候选插件未启用，官方压缩器保持不变");
    return;
  }
  if (config.storeDirectory === undefined || !isAbsolute(config.storeDirectory)) {
    throw new ContextGenerationError("Enabled context candidate plugin requires an absolute storeDirectory", "VALIDATION_FAILED");
  }
  if (config.runtimeStateDirectory !== undefined && !isAbsolute(config.runtimeStateDirectory)) {
    throw new ContextGenerationError("Context recovery runtimeStateDirectory must be absolute", "VALIDATION_FAILED");
  }
  const store = new FileGenerationStore({ directory: config.storeDirectory });
  const pipeline = new ContextPipelineController({ enabled: true, store });
  const recovery = new ContextPauseRecoveryService(new ContextRuntimeStateStore(
    config.runtimeStateDirectory ?? defaultContextRuntimeStateDirectory(),
  ));
  await pipeline.initialize();
  const disposeCandidate = ctx.provide("memoryContextCandidate", pipeline);
  const disposeRecovery = ctx.provide("memoryContextRecovery", recovery);
  return () => {
    disposeRecovery?.();
    disposeCandidate?.();
  };
}
