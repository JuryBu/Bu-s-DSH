import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContextGenerationError } from "../src/index.ts";
import {
  StablePrefixCache,
  assertMeasuredContextBudget,
  buildStableContext,
  contentSha256,
  toCoordinatorBuildResult,
  type StableContextInput,
} from "../src/context-builder.ts";
import { apply } from "../src/dsh-plugin.ts";
import { FileGenerationStore } from "../src/file-store.ts";
import { ContextPipelineController, classifyPressure } from "../src/pipeline.ts";
import { ContextPauseRecoveryService } from "../src/runtime-state.ts";

async function withStoreDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-context-pipeline-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function contextInput(contextGenerationId: string): StableContextInput {
  const recordContent = "项目早期已经决定保留官方标准模式作为救援入口。";
  const rawContent = "主人：请在候选 release 中验证，不要直接覆盖生产。";
  return {
    contextGenerationId,
    sessionId: "session-synthetic",
    shadowedSeqs: [2, 3, 12, 13],
    records: [{
      kind: "record",
      recordId: "record-1",
      recordGenerationId: "memory-store-generation-7",
      roundStart: 1,
      roundEnd: 6,
      detail: "summary",
      sourceSeqs: [2, 3],
      content: recordContent,
      contentSha256: contentSha256(recordContent),
    }],
    rawRounds: [{
      kind: "raw-round",
      round: 7,
      sourceSeqs: [12, 13],
      content: rawContent,
      contentSha256: contentSha256(rawContent),
    }],
    tokenBudget: {
      contextWindow: 100_000,
      stablePrefixTokens: 2_000,
      recentRawTokens: 10_000,
      reservedResponseTokens: 8_000,
    },
  };
}

test("stable prefix is cache-stable and marks Record and raw-round provenance", () => {
  const cache = new StablePrefixCache();
  const input = contextInput("generation-stable-prefix");
  const first = cache.getOrBuild(input);
  const second = cache.getOrBuild(structuredClone(input));
  assert.deepEqual(second, first);
  assert.match(first.content, /【Record 来源｜summary｜轮 1-6】/);
  assert.match(first.content, /recordGeneration=memory-store-generation-7/);
  assert.match(first.content, /【原始轮次来源｜轮 7】/);
  assert.match(first.content, /sourceSeqs=12,13/);
  assert.match(first.content, /精确细节时，必须使用线程读取工具恢复原文/);

  const result = toCoordinatorBuildResult(input);
  assert.equal(result.metadata?.sourceKind, "plugin");
  assert.equal(result.metadata?.sourcePlugin, "memory-context");
});

test("tampered Record content is rejected before candidate storage", () => {
  const input = contextInput("generation-tampered-source");
  input.records[0]!.content = "篡改后的内容";
  assert.throws(() => buildStableContext(input), (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, "VALIDATION_FAILED");
    return true;
  });
});

test("Record and raw-round sources must exactly cover the shadowed surface", () => {
  const input = contextInput("generation-bad-coverage");
  input.records[0]!.sourceSeqs = [2, 8];
  assert.throws(() => buildStableContext(input), (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, "VALIDATION_FAILED");
    return true;
  });
});

test("the host token meter, not caller metadata, decides whether the built surface fits", () => {
  const built = buildStableContext(contextInput("generation-real-token-budget"));
  assert.equal(assertMeasuredContextBudget(built, () => 1_000), 1_000);
  assert.throws(() => assertMeasuredContextBudget(built, () => 100_000), (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, "VALIDATION_FAILED");
    return true;
  });
});

test("one context generation id cannot cache two different surfaces", () => {
  const cache = new StablePrefixCache();
  const input = contextInput("generation-immutable");
  cache.getOrBuild(input);
  const changed = contextInput("generation-immutable");
  changed.records[0]!.content = "同一代次下的另一份内容";
  changed.records[0]!.contentSha256 = contentSha256(changed.records[0]!.content);
  assert.throws(() => cache.getOrBuild(changed), (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, "VALIDATION_FAILED");
    return true;
  });
});

test("pressure classification requires host-supplied ordered thresholds", () => {
  assert.equal(classifyPressure(0.4, { bpcRatio: 0.68, hardRatio: 0.9 }), "none");
  assert.equal(classifyPressure(0.7, { bpcRatio: 0.68, hardRatio: 0.9 }), "bpc");
  assert.equal(classifyPressure(0.95, { bpcRatio: 0.68, hardRatio: 0.9 }), "hard");
  assert.throws(() => classifyPressure(0.8, { bpcRatio: 0.9, hardRatio: 0.8 }));
});

test("BPC failure keeps conversation usable while hard failure pauses and protects it", async () => {
  await withStoreDirectory(async (directory) => {
    const pipeline = new ContextPipelineController({
      enabled: true,
      store: new FileGenerationStore({ directory }),
    });
    await pipeline.initialize();
    const stable = await pipeline.runBpc(async ({ generationId }) => contextInput(generationId));
    await assert.rejects(pipeline.runBpc(async () => {
      throw new Error("background synthesis failed");
    }));
    assert.equal(pipeline.getStatus().phase, "bpc-failed-using-previous");
    assert.equal(pipeline.getStatus().paused, false);
    assert.equal(pipeline.getStatus().publishedGenerationId, stable.manifest.generationId);
    assert.match(pipeline.renderDynamicStatus(), /继续使用上一份已发布上下文/);

    await assert.rejects(pipeline.runHard(async () => {
      throw new Error("hard synthesis failed");
    }));
    assert.equal(pipeline.getStatus().phase, "paused-protected");
    assert.equal(pipeline.getStatus().paused, true);
    assert.equal(pipeline.getStatus().publishedGenerationId, stable.manifest.generationId);
    assert.match(pipeline.renderDynamicStatus(), /已暂停继续请求并保留现场/);
    pipeline.resumeAfterExplicitRecovery();
    assert.equal(pipeline.getStatus().phase, "idle");
    assert.equal(pipeline.getStatus().paused, false);
  });
});

test("successful pipeline publication survives controller restart", async () => {
  await withStoreDirectory(async (directory) => {
    const first = new ContextPipelineController({
      enabled: true,
      store: new FileGenerationStore({ directory }),
    });
    await first.initialize();
    const published = await first.runBpc(async ({ generationId }) => contextInput(generationId));
    assert.equal(first.getStatus().phase, "published");
    assert.equal(first.getStatus().stablePrefixSha256, published.manifest.contentSha256);

    const restarted = new ContextPipelineController({
      enabled: true,
      store: new FileGenerationStore({ directory }),
    });
    const report = await restarted.initialize();
    assert.equal(report?.publishedGenerationId, published.manifest.generationId);
    assert.equal(restarted.getStatus().publishedGenerationId, published.manifest.generationId);
    assert.equal(restarted.getStatus().stablePrefixSha256, published.manifest.contentSha256);
  });
});

test("hard compaction cancels an in-flight BPC before publishing its own complete generation", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileGenerationStore({ directory });
    const pipeline = new ContextPipelineController({ enabled: true, store });
    await pipeline.initialize();
    let backgroundStarted!: () => void;
    const started = new Promise<void>((resolve) => { backgroundStarted = resolve; });
    const background = pipeline.runBpc(async ({ signal }) => {
      backgroundStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return contextInput("unreachable");
    });
    await started;
    const hard = pipeline.runHard(async ({ generationId }) => contextInput(generationId));
    await assert.rejects(background, (error: unknown) => {
      return error instanceof ContextGenerationError && error.code === "CANCELLED";
    });
    const published = await hard;
    assert.equal(published.manifest.trigger, "hard");
    assert.equal((await store.getPublished({ signal: new AbortController().signal }))?.manifest.generationId, published.manifest.generationId);
    assert.equal(pipeline.getStatus().phase, "published");
  });
});

test("disabled rc.6 plugin does not touch storage or provide a replacement service", async () => {
  let provided = false;
  await apply({
    provide: () => {
      provided = true;
    },
  }, { enabled: false, storeDirectory: "relative-path-must-not-be-read" });
  assert.equal(provided, false);
});

test("enabled rc.6 plugin exposes candidate and durable recovery services", async () => {
  await withStoreDirectory(async (directory) => {
    const provided = new Map<string, unknown>();
    const dispose = await apply({
      provide: (name, value) => {
        provided.set(name, value);
        return () => undefined;
      },
    }, { enabled: true, storeDirectory: directory });
    const candidate = provided.get("memoryContextCandidate");
    assert.ok(candidate instanceof ContextPipelineController);
    assert.equal(candidate.getStatus().phase, "idle");
    assert.ok(provided.get("memoryContextRecovery") instanceof ContextPauseRecoveryService);
    assert.equal(typeof dispose, "function");
  });
});
