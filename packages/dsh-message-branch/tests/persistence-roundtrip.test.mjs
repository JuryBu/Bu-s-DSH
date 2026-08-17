import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { BranchRecordStore, MessageBranchService } from "../lib/testing.js";
import { FakeAgentRegistry, makeHarness, makeSourceAgent, withPackageTemp } from "./helpers.mjs";

async function importRuntimePackage(runtimeRoot, packageName) {
  const file = path.join(runtimeRoot, "node_modules", ...packageName.split("/"), "lib", "index.js");
  return import(pathToFileURL(file).href);
}

test("官方 JSONL persistence 可往返读取父分支和编辑后子分支", { timeout: 20_000 }, async t => {
  const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT;
  if (!runtimeRoot) return t.skip("需要 DSH_TEST_RUNTIME_ROOT 指向候选运行目录");
  await withPackageTemp("persistence-roundtrip", async root => {
    const sourceAgent = makeSourceAgent({ cwd: path.join(root, "workspace") });
    const registry = new FakeAgentRegistry(sourceAgent);
    const store = new BranchRecordStore({ rootDir: path.join(root, "branch-store") });
    const harness = makeHarness({ sourceAgent, registry, store, emitted: [] });
    const service = new MessageBranchService(harness.options);
    const sourceBefore = structuredClone(sourceAgent.session.events);
    const result = await service.editAndResend({
      operationId: "op-persistence",
      sessionId: sourceAgent.id,
      expectedSourceMessageId: "user-1",
      draft: {
        text: "持久化往返后的新分支消息",
        images: [{ attachment: { attachmentId: "durable-image", mediaType: "image/png", bytes: 3, width: 1, height: 1 } }],
        files: [{ name: "evidence.txt", attachmentRef: "host-file:evidence" }],
      },
    });
    const child = registry.get(result.childSessionId);

    const [{ Context }, { SessionId, SessionStore }, { JsonlSessionPersistence }] = await Promise.all([
      importRuntimePackage(runtimeRoot, "@deepseek-ai/cordis"),
      importRuntimePackage(runtimeRoot, "@deepseek-ai/dsh-session"),
      importRuntimePackage(runtimeRoot, "@deepseek-ai/dsh-session-persistence-jsonl"),
    ]);
    const ctx = new Context();
    new SessionStore(ctx);
    const persistence = new JsonlSessionPersistence(ctx, {
      root: path.join(root, "sessions"),
      compression: "none",
      packChunks: false,
      writeBatchMaxDelayMs: 1,
    });
    for (const session of [sourceAgent.session, child.session]) {
      const id = SessionId(session.id);
      const header = { ...structuredClone(session.header), id };
      await persistence.create(header);
      await persistence.append(id, session.events);
    }
    const loadedParent = await persistence.load(SessionId(sourceAgent.id));
    const loadedChild = await persistence.load(SessionId(child.id));
    assert.deepEqual(loadedParent.events, sourceBefore);
    assert.equal(loadedChild.meta.parentSession, sourceAgent.id);
    assert.equal(loadedChild.meta.seedLength, 3);
    assert.deepEqual(loadedChild.events.slice(0, 3), sourceBefore.slice(0, 3));
    assert.equal(loadedChild.events.some(event => event.type === "user/message" && event.data.id === "user-1"), false);
    const edited = loadedChild.events.find(event => event.type === "user/message" && event.data.id === result.editedMessageId);
    assert.equal(edited.data.content[0].text, "持久化往返后的新分支消息");
    assert.equal(edited.data.content[1].attachment.attachmentId, "durable-image");
    assert.match(edited.data.content[2].text, /evidence\.txt/);
    assert.equal((await store.read("op-persistence")).state, "created");
    assert.equal(sourceAgent.session.events.length, sourceBefore.length);
    await ctx.stop?.();
  });
});
