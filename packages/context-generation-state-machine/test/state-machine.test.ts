import assert from "node:assert/strict";
import test from "node:test";

import {
  CompressionCoordinator,
  ContextGenerationError,
  InMemoryGenerationStore,
  createCandidate,
  pruneToolResult,
  validateCandidate,
  type GenerationOperationContext,
  type PublishedGeneration,
} from "../src/index.ts";

const activeOperation: GenerationOperationContext = { signal: new AbortController().signal };

function seedPublished(id = "published-0"): PublishedGeneration {
  const candidate = createCandidate({
    generationId: id,
    trigger: "recovery",
    createdAt: 1,
    content: "stable published context",
  });
  return { ...candidate, state: "published", validatedAt: 2, publishedAt: 3 };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("feature flag defaults to disabled without invoking the builder", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  let called = false;
  const coordinator = new CompressionCoordinator({ store });
  await expectCode(coordinator.run("bpc", async () => {
    called = true;
    return { content: "new" };
  }), "FEATURE_DISABLED");
  assert.equal(called, false);
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
});

test("publishes only after candidate validation", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  const ticks = [10, 11, 12];
  const coordinator = new CompressionCoordinator({
    enabled: true,
    store,
    now: () => ticks.shift() ?? 13,
    createGenerationId: () => "generation-1",
  });
  const published = await coordinator.run("manual-rebuild", async () => ({
    content: "validated replacement context",
    metadata: { synthetic: true },
  }));
  assert.equal(published.state, "published");
  assert.equal(published.manifest.parentPublishedGenerationId, "published-0");
  assert.equal(published.manifest.trigger, "manual-rebuild");
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "generation-1");
});

test("empty candidate fails validation and keeps the previous publication", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  const coordinator = new CompressionCoordinator({
    enabled: true,
    store,
    createGenerationId: () => "generation-empty",
  });
  await expectCode(coordinator.run("hard", async () => ({ content: "   " })), "VALIDATION_FAILED");
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
  assert.equal(store.getRecord("generation-empty"), undefined);
});

test("build failure keeps the previous publication", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  const coordinator = new CompressionCoordinator({ enabled: true, store });
  await expectCode(coordinator.run("bpc", async () => {
    throw new Error("synthetic build failure");
  }), "BUILD_FAILED");
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
});

test("caller cancellation keeps the previous publication", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  const controller = new AbortController();
  const coordinator = new CompressionCoordinator({ enabled: true, store });
  const run = coordinator.run("bpc", ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { signal: controller.signal });
  controller.abort();
  await expectCode(run, "CANCELLED");
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
});

test("timeout keeps the previous publication", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  const coordinator = new CompressionCoordinator({ enabled: true, store });
  const run = coordinator.run("hard", ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { timeoutMs: 10 });
  await expectCode(run, "TIMEOUT");
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
});

test("compare-and-swap rejects a stale parent without replacing the winner", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  const coordinator = new CompressionCoordinator({
    enabled: true,
    store,
    createGenerationId: () => "generation-stale",
  });
  await expectCode(coordinator.run("recovery", async () => {
    const winner = createCandidate({
      generationId: "generation-winner",
      parentPublishedGenerationId: "published-0",
      trigger: "bpc",
      createdAt: 20,
      content: "winner context",
    });
    await store.putCandidate(winner, activeOperation);
    validateCandidate(winner);
    await store.markValidated("generation-winner", 21, activeOperation);
    await store.publishAtomically("published-0", "generation-winner", 22, activeOperation);
    return { content: "stale context" };
  }), "STALE_PARENT");
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "generation-winner");
  assert.equal(store.getRecord("generation-stale"), undefined);
});

test("tool-result pruning preserves a complete artifact locator", () => {
  const source = "A".repeat(9000) + "Z".repeat(2000);
  const artifact = {
    uri: "file:///tmp/synthetic-tool-result.txt",
    sha256: "a".repeat(64),
    bytes: 11000,
    lines: 1,
    complete: true as const,
    verified: true as const,
  };
  const view = pruneToolResult(source, artifact);
  assert.equal(view.truncated, true);
  assert.deepEqual(view.artifact, artifact);
  assert.match(view.text, /完整结果：file:\/\/\/tmp\/synthetic-tool-result\.txt/);
  assert.match(view.text, /SHA-256=aaaaaaaa/);
  assert.equal(view.originalChars, source.length);
});

test("tool-result pruning refuses to truncate without a valid complete artifact", () => {
  const source = "synthetic".repeat(2000);
  assert.throws(
    () => pruneToolResult(source, undefined, { thresholdChars: 100 }),
    (error: unknown) => error instanceof ContextGenerationError && error.code === "VALIDATION_FAILED",
  );
  assert.throws(
    () => pruneToolResult(source, {
      uri: "artifact://synthetic",
      sha256: "b".repeat(64),
      bytes: 0,
      complete: true,
      verified: true,
    }),
    (error: unknown) => error instanceof ContextGenerationError && error.code === "VALIDATION_FAILED",
  );
  assert.throws(
    () => pruneToolResult(source, {
      uri: "artifact://synthetic",
      sha256: "b".repeat(64),
      bytes: source.length,
      complete: false,
      verified: true,
    } as never),
    (error: unknown) => error instanceof ContextGenerationError && error.code === "VALIDATION_FAILED",
  );
});

test("tool-result pruning never splits a Unicode code point", () => {
  const source = "前" + "😀".repeat(30) + "后";
  const view = pruneToolResult(source, {
    uri: "artifact://unicode",
    sha256: "c".repeat(64),
    bytes: Buffer.byteLength(source, "utf8"),
    complete: true,
    verified: true,
  }, { thresholdChars: 2, headChars: 2, tailChars: 2 });
  assert.equal(view.truncated, true);
  assert.equal(/\p{Cs}/u.test(view.text), false);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(view.text, "utf8")));
});

test("tool-result pruning preserves the complete continuation parameters at the tail", () => {
  const cursor = `dsh-native-thread-v1.${"c".repeat(1800)}.checksum`;
  const continuation = `➡️ 下一段参数（必须原样复制）\n${JSON.stringify({ continuation_cursor: cursor })}`;
  const source = `${"A".repeat(12_000)}\n${continuation}`;
  const view = pruneToolResult(source, {
    uri: "artifact://thread-page",
    sha256: "d".repeat(64),
    bytes: Buffer.byteLength(source, "utf8"),
    complete: true,
    verified: true,
  });
  assert.equal(view.truncated, true);
  assert.equal(view.text.endsWith(JSON.stringify({ continuation_cursor: cursor })), true);
  assert.match(view.text, /➡️ 下一段参数（必须原样复制）/u);
});

test("tampered candidate manifest is rejected", () => {
  const candidate = createCandidate({
    generationId: "generation-tampered",
    trigger: "bpc",
    createdAt: 1,
    content: "original",
  });
  candidate.content = "tampered";
  assert.throws(() => validateCandidate(candidate), (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, "VALIDATION_FAILED");
    return true;
  });
});

test("cancellation during the published-generation read cannot miss the abort", async () => {
  class DelayedReadStore extends InMemoryGenerationStore {
    override async getPublished(context: GenerationOperationContext): Promise<PublishedGeneration | undefined> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(context.signal.reason);
        }, { once: true });
      });
      return super.getPublished(context);
    }
  }

  const store = new DelayedReadStore(seedPublished());
  const caller = new AbortController();
  const coordinator = new CompressionCoordinator({ enabled: true, store });
  let builderCalled = false;
  const run = coordinator.run("bpc", async () => {
    builderCalled = true;
    return { content: "must not build" };
  }, { signal: caller.signal });
  caller.abort(new Error("synthetic caller cancellation"));

  await expectCode(run, "CANCELLED");
  assert.equal(builderCalled, false);
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
});

test("a publish operation that observes timeout cannot publish later", async () => {
  class DelayedPublishStore extends InMemoryGenerationStore {
    override async publishAtomically(
      expectedPublishedGenerationId: string | undefined,
      generationId: string,
      publishedAt: number,
      context: GenerationOperationContext,
    ): Promise<PublishedGeneration> {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return super.publishAtomically(expectedPublishedGenerationId, generationId, publishedAt, context);
    }
  }

  const store = new DelayedPublishStore(seedPublished());
  const coordinator = new CompressionCoordinator({
    enabled: true,
    store,
    createGenerationId: () => "generation-timeout-publish",
  });
  await expectCode(
    coordinator.run("hard", async () => ({ content: "late candidate" }), { timeoutMs: 5 }),
    "TIMEOUT",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
  assert.equal(store.getRecord("generation-timeout-publish"), undefined);
});

test("an unsupported runtime trigger fails before reading storage or invoking the builder", async () => {
  const store = new InMemoryGenerationStore(seedPublished());
  let builderCalled = false;
  const coordinator = new CompressionCoordinator({ enabled: true, store });
  await expectCode(coordinator.run("unsupported" as never, async () => {
    builderCalled = true;
    return { content: "must not build" };
  }), "VALIDATION_FAILED");
  assert.equal(builderCalled, false);
  assert.equal((await store.getPublished(activeOperation))?.manifest.generationId, "published-0");
});
