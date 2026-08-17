import { BrokerMemoryStoreClient } from "./memory-store-client.js";
import { CurrentSessionThreadSource } from "./current-session-source.js";
import { MemoryStoreThreadSource } from "./memory-store-source.js";
import { Rc6OfficialSmallSource } from "./official-small-source.js";
import { HybridThreadSource } from "./hybrid-source.js";
import { Rc6SessionEventWriter, ThreadEventLedger } from "./ledger.js";
import { SidecarThreadLedgerAdapter } from "./sidecar-adapter.js";
import { SidecarThreadLedger } from "./sidecar-ledger.js";
import { createThreadToolDefinitions } from "./tool-definitions.js";

export const name = "stardust-thread-tools";
export const inject = ["tools"];

export async function apply(ctx, config = {}) {
  const defineTool = config.defineTool ?? (await import("@deepseek-ai/dsh-tools")).defineTool;
  const client = config.memoryStoreClient ?? new BrokerMemoryStoreClient(config.memoryStore);
  const source = config.source ?? new HybridThreadSource({
    memoryStore: new MemoryStoreThreadSource(client),
    currentSession: new CurrentSessionThreadSource(),
    officialSmall: new Rc6OfficialSmallSource({
      sessionQuery: ctx.get?.("sessionQuery"),
      sessionPersistence: ctx.get?.("sessionPersistence"),
      smallSessionMaxBytes: config.smallSessionMaxBytes,
    }),
    onFallback: config.onFallback,
  });

  if (config.persistLedgerEvents === true) {
    throw new Error("DSH rc.6 不允许把自定义 thread/* 事件写回官方会话；请使用默认 sidecar 持久账本");
  }
  const ledger = config.ledger ?? new SidecarThreadLedgerAdapter({
    rootDir: config.ledgerRootDir,
    idFactory: config.idFactory,
  });
  const disposers = createThreadToolDefinitions({ defineTool, source, ledger })
    .map(definition => ctx.tools.register(definition));
  return async () => {
    for (const dispose of disposers.reverse()) await dispose?.();
    if (!config.memoryStoreClient && typeof client.close === "function") await client.close();
  };
}

export {
  BrokerMemoryStoreClient,
  CurrentSessionThreadSource,
  HybridThreadSource,
  MemoryStoreThreadSource,
  Rc6OfficialSmallSource,
  Rc6SessionEventWriter,
  SidecarThreadLedger,
  SidecarThreadLedgerAdapter,
  ThreadEventLedger,
  createThreadToolDefinitions,
};
