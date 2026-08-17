import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContextRuntimeStateStore } from "../src/runtime-state.ts";

test("same-session runtime updates are serialized without losing fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-context-state-lock-"));
  try {
    const firstStore = new ContextRuntimeStateStore(root);
    const secondStore = new ContextRuntimeStateStore(root);
    const sessionId = "same-session";
    await Promise.all([
      firstStore.update(sessionId, state => ({
        ...state,
        compactionActivity: { trigger: "bpc", phase: "building", startedAt: 10 },
      })),
      secondStore.update(sessionId, state => ({ ...state, lastBpcFailure: "fixture failure" })),
    ]);
    const state = await firstStore.load(sessionId);
    assert.equal(state.compactionActivity?.phase, "building");
    assert.equal(state.lastBpcFailure, "fixture failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
