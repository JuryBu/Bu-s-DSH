import { randomUUID } from "node:crypto";
import path from "node:path";

import { MESSAGE_BRANCH_SERVICE, MESSAGE_BRANCH_STATE_EVENT } from "./contract.js";
import { createMessageBranchRoutes } from "./http.js";
import { BranchRecordStore } from "./store.js";
import { MessageBranchService } from "./service.js";
import { TurnSnapshotStore } from "./snapshot-store.js";

export const name = "stardust-message-branch";
export const inject = ["agents", "agentPresets", "webServer", "workspaceRegistry"];

export async function apply(ctx, config = {}) {
  if (typeof config.storeDirectory !== "string" || !path.isAbsolute(config.storeDirectory)) {
    throw new Error("dsh-message-branch: storeDirectory 必须配置为绝对路径");
  }
  const [{ createUserMessage }, { SessionId }] = await Promise.all([
    import("@deepseek-ai/dsh-llm"),
    import("@deepseek-ai/dsh-session"),
  ]);
  const service = new MessageBranchService({
    agents: config.agents ?? ctx.agents,
    agentPresets: config.agentPresets ?? ctx.agentPresets,
    workspaceRegistry: config.workspaceRegistry ?? ctx.workspaceRegistry ?? ctx.get?.("workspaceRegistry"),
    attachments: config.attachments ?? ctx.get?.("attachments"),
    sessions: config.sessions ?? ctx.get?.("sessions") ?? ctx.sessions,
    createUserMessage: config.createUserMessage ?? createUserMessage,
    sessionIdFactory: config.sessionIdFactory ?? (() => SessionId(`session-branch-${randomUUID()}`)),
    store: config.store ?? new BranchRecordStore({ rootDir: config.storeDirectory }),
    snapshotStore: config.snapshotStore === false
      ? undefined
      : config.snapshotStore ?? new TurnSnapshotStore({ rootDir: path.join(config.storeDirectory, "turn-snapshots") }),
    replayRegistry: config.replayRegistry,
    emitState: config.emitState ?? (record => ctx.emit(MESSAGE_BRANCH_STATE_EVENT, record)),
    observerError: config.observerError ?? (error => ctx.logger?.warn?.("message branch observer failed", error)),
    acceptanceTimeoutMs: config.acceptanceTimeoutMs,
  });
  const disposeService = ctx.provide(MESSAGE_BRANCH_SERVICE, service);
  const disposeCapture = typeof ctx.on === "function"
    ? ctx.on("agent/pre-step", async (event, next) => {
        await service.captureIncomingMessages(event);
        return next();
      })
    : undefined;
  const routes = createMessageBranchRoutes(service, { maxBodyBytes: config.maxBodyBytes });
  const disposeRoutes = routes.map(route => ctx.webServer.register(route));
  ctx.logger?.info?.("message-branch: local edit-and-resend routes ready");
  return async () => {
    for (const dispose of disposeRoutes.reverse()) await dispose?.();
    await disposeCapture?.();
    await service.dispose();
    await disposeService?.();
  };
}

export * from "./contract.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./replay-registry.js";
export * from "./service.js";
export * from "./snapshot-store.js";
export * from "./store.js";
export * from "./tracked-files.js";
