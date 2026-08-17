import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CompressionCoordinator,
  ContextGenerationError,
  createCandidate,
  type GenerationOperationContext,
} from "../src/index.ts";
import { FileGenerationStore } from "../src/file-store.ts";

const active: GenerationOperationContext = { signal: new AbortController().signal };

async function withStoreDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-context-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContextGenerationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("published generation survives process-style store reconstruction", async () => {
  await withStoreDirectory(async (directory) => {
    const firstStore = new FileGenerationStore({ directory });
    const coordinator = new CompressionCoordinator({
      enabled: true,
      store: firstStore,
      createGenerationId: () => "persistent-generation",
    });
    await coordinator.run("recovery", async () => ({ content: "persistent stable prefix" }));

    const restartedStore = new FileGenerationStore({ directory });
    const recovered = await restartedStore.recoverUnpublished(active);
    const published = await restartedStore.getPublished(active);
    assert.equal(recovered.publishedGenerationId, "persistent-generation");
    assert.deepEqual(recovered.discardedGenerationIds, []);
    assert.equal(published?.content, "persistent stable prefix");
  });
});

test("restart recovery discards candidate and validated half-products without moving the pointer", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileGenerationStore({ directory });
    const coordinator = new CompressionCoordinator({
      enabled: true,
      store,
      createGenerationId: () => "published-before-restart",
    });
    await coordinator.run("recovery", async () => ({ content: "last known good" }));

    const candidate = createCandidate({
      generationId: "candidate-at-crash",
      parentPublishedGenerationId: "published-before-restart",
      trigger: "bpc",
      createdAt: Date.now(),
      content: "not published candidate",
    });
    await store.putCandidate(candidate, active);
    const validated = createCandidate({
      generationId: "validated-at-crash",
      parentPublishedGenerationId: "published-before-restart",
      trigger: "bpc",
      createdAt: Date.now(),
      content: "not published validated candidate",
    });
    await store.putCandidate(validated, active);
    await store.markValidated("validated-at-crash", Date.now(), active);

    const restartedStore = new FileGenerationStore({ directory });
    const report = await restartedStore.recoverUnpublished(active);
    assert.deepEqual(report.discardedGenerationIds, ["candidate-at-crash", "validated-at-crash"]);
    assert.equal((await restartedStore.getPublished(active))?.manifest.generationId, "published-before-restart");
  });
});

test("file-backed compare-and-swap rejects a stale builder and preserves the winner", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileGenerationStore({ directory });
    let releaseStale!: () => void;
    const waitForWinner = new Promise<void>((resolve) => { releaseStale = resolve; });
    let staleStarted!: () => void;
    const staleIsBuilding = new Promise<void>((resolve) => { staleStarted = resolve; });
    const stale = new CompressionCoordinator({
      enabled: true,
      store,
      createGenerationId: () => "stale-generation",
    });
    const winner = new CompressionCoordinator({
      enabled: true,
      store,
      createGenerationId: () => "winner-generation",
    });
    const staleRun = stale.run("bpc", async () => {
      staleStarted();
      await waitForWinner;
      return { content: "stale prefix" };
    });
    await staleIsBuilding;
    await winner.run("hard", async () => ({ content: "winner prefix" }));
    releaseStale();
    await expectCode(staleRun, "STALE_PARENT");
    assert.equal((await store.getPublished(active))?.manifest.generationId, "winner-generation");
  });
});

test("persistent build failure leaves the prior publication untouched", async () => {
  await withStoreDirectory(async (directory) => {
    const store = new FileGenerationStore({ directory });
    const seed = new CompressionCoordinator({
      enabled: true,
      store,
      createGenerationId: () => "stable-before-failure",
    });
    await seed.run("recovery", async () => ({ content: "stable" }));
    const failing = new CompressionCoordinator({
      enabled: true,
      store,
      createGenerationId: () => "failed-generation",
    });
    await expectCode(failing.run("bpc", async () => {
      throw new Error("synthetic builder failure");
    }), "BUILD_FAILED");
    assert.equal((await store.getPublished(active))?.manifest.generationId, "stable-before-failure");
  });
});

test("restart recovery removes a lock left by a dead process without weakening live-lock exclusion", async () => {
  await withStoreDirectory(async (directory) => {
    await writeFile(join(directory, ".generation-store.lock"), JSON.stringify({
      pid: 2_147_483_647,
      createdAt: 1,
    }), "utf8");
    const store = new FileGenerationStore({ directory, lockTimeoutMs: 500 });
    const report = await store.recoverUnpublished(active);
    assert.deepEqual(report.discardedGenerationIds, []);
  });
});
