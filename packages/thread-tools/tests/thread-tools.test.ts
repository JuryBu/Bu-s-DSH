import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CursorError,
  FixtureThreadHost,
  InMemoryThreadArtifactStore,
  IncrementalFixtureThreadIndex,
  MemoryAppendOnlySource,
  Rc6ThreadToolsHostAdapter,
  ThreadToolsService,
  MalformedThreadLogError,
  UnsupportedFormatVersionError,
  mergeAdjacentRoundRanges,
  mergeAdjacentSourceRanges,
  type Rc6ThreadHostSeams,
  type ThreadArtifactStore,
  type ThreadArtifactWriter,
  type ThreadMarkUsefulRequest,
  type ThreadProtectRequest,
  type ThreadReleaseProtectionRequest,
  THREAD_EVENT_DRAFTS,
} from "../src/index.ts";
import { BASIC_JSONL_FIXTURE, makeRound } from "./fixtures/session-fixtures.ts";
import {
  encodeSyntheticZstdFrame,
  encodeSyntheticZstdFrames,
  syntheticZstdDecoder,
} from "./fixtures/synthetic-zstd.ts";

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

class RecordingArtifactStore implements ThreadArtifactStore {
  readonly chunks: string[] = [];
  readonly inner = new InMemoryThreadArtifactStore();
  maxChunkBytes = 0;

  async createTextArtifact(): Promise<ThreadArtifactWriter> {
    const writer = await this.inner.createTextArtifact();
    return {
      write: async chunk => {
        this.chunks.push(chunk);
        this.maxChunkBytes = Math.max(this.maxChunkBytes, Buffer.byteLength(chunk, "utf8"));
        await writer.write(chunk);
      },
      complete: () => writer.complete(),
      abort: reason => writer.abort(reason),
    };
  }

  getText(artifactId: string): string | undefined {
    return this.inner.getText(artifactId);
  }
}

test("official adapter delegates list, search, projection and merged read ranges", async () => {
  const calls: Array<{ name: string; from?: number; to?: number }> = [];
  const seams: Rc6ThreadHostSeams = {
    persistence: {
      async listReadonlyHeaders() {
        calls.push({ name: "listReadonlyHeaders" });
        return {
          sessions: [{
            sessionId: "official", sourceFormat: "jsonl-v0", snapshotId: "header-snapshot", roundCount: 2,
            committedThroughOffset: 20, hasPendingTail: false,
          }],
          snapshotId: "catalog-snapshot",
        };
      },
      async *readFrom(request) {
        calls.push({ name: "readFrom", from: request.fromOffset, to: request.toOffset });
        yield {
          source: { blockId: "official:0-20", startOffset: 0, endOffset: 20 },
          rounds: [
            { round: 1, role: "user", content: "official one", source: { blockId: "official:0-10", startOffset: 0, endOffset: 10 } },
            { round: 2, role: "assistant", content: "official two", source: { blockId: "official:10-20", startOffset: 10, endOffset: 20 } },
          ],
        };
      },
    },
    query: {
      async search() {
        calls.push({ name: "search" });
        return {
          matches: [{ sessionId: "official", snapshotId: "query-snapshot", preview: "x".repeat(300), matchKind: "content" }],
          snapshotId: "query-snapshot",
        };
      },
    },
    projectionCache: {
      async getSnapshot() {
        calls.push({ name: "projection" });
        return {
          session: {
            sessionId: "official", sourceFormat: "jsonl-v0", snapshotId: "projection-snapshot", roundCount: 2,
            committedThroughOffset: 20, hasPendingTail: false,
          },
          snapshotId: "projection-snapshot",
          livePersistedReconciled: true,
          roundIndex: [
            {
              round: 1, role: "user", source: { blockId: "official:0-10", startOffset: 0, endOffset: 10 },
              estimatedBytes: 256, estimatedTokens: 64,
            },
            {
              round: 2, role: "assistant", source: { blockId: "official:10-20", startOffset: 10, endOffset: 20 },
              estimatedBytes: 256, estimatedTokens: 64,
            },
          ],
        };
      },
    },
  };
  const service = new ThreadToolsService(new Rc6ThreadToolsHostAdapter(seams, {
    artifactStore: new InMemoryThreadArtifactStore(),
  }));

  await service.thread_list();
  const search = await service.thread_search({ query: "official", previewBytes: 32 });
  const read = await service.thread_read({ sessionId: "official", ranges: [{ start: 1, end: 1 }, { start: 2, end: 2 }] });

  assert.equal(Buffer.byteLength(search.matches[0].preview, "utf8"), 32);
  assert.deepEqual(read.rounds.map(round => round.round), [1, 2]);
  assert.deepEqual(calls.map(call => call.name), ["listReadonlyHeaders", "search", "projection", "readFrom"]);
  assert.deepEqual(calls.at(-1), { name: "readFrom", from: 0, to: 20 });
});

test("official adapter fails closed when decoded round identity diverges from projection", async () => {
  const source = { blockId: "official:0-10", startOffset: 0, endOffset: 10 };
  const seams: Rc6ThreadHostSeams = {
    persistence: {
      async listReadonlyHeaders() {
        return { sessions: [], snapshotId: "catalog" };
      },
      async *readFrom() {
        yield {
          source,
          rounds: [{ round: 1, role: "assistant", content: "stale role", source }],
        };
      },
    },
    query: {
      async search() {
        return { matches: [], snapshotId: "query" };
      },
    },
    projectionCache: {
      async getSnapshot() {
        return {
          session: {
            sessionId: "official", sourceFormat: "jsonl-v0", snapshotId: "stable", roundCount: 1,
            committedThroughOffset: 10, hasPendingTail: false,
          },
          snapshotId: "stable",
          livePersistedReconciled: true,
          roundIndex: [{ round: 1, role: "user", source, estimatedBytes: 256, estimatedTokens: 64 }],
        };
      },
    },
  };
  const service = new ThreadToolsService(new Rc6ThreadToolsHostAdapter(seams, {
    artifactStore: new InMemoryThreadArtifactStore(),
  }));

  await assert.rejects(service.thread_read({ sessionId: "official" }), MalformedThreadLogError);
});

test("large official read keeps one budgeted round, streams the complete artifact, and resumes after it", async () => {
  const reads: Array<{ from: number; to: number }> = [];
  const artifacts = new RecordingArtifactStore();
  const rounds = Array.from({ length: 200 }, (_, index) => ({
    round: index + 1,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `payload-${String(index + 1).padStart(4, "0")}`,
    source: { blockId: `block-${index + 1}`, startOffset: index, endOffset: index + 1 },
  }));
  const seams: Rc6ThreadHostSeams = {
    persistence: {
      async listReadonlyHeaders() {
        return { sessions: [], snapshotId: "catalog" };
      },
      async *readFrom(request) {
        reads.push({ from: request.fromOffset, to: request.toOffset });
        yield {
          source: { blockId: "all", startOffset: request.fromOffset, endOffset: request.toOffset },
          rounds: (function *iterateRounds() {
            yield *rounds;
          })(),
        };
      },
    },
    query: {
      async search() {
        return { matches: [], snapshotId: "query" };
      },
    },
    projectionCache: {
      async getSnapshot() {
        return {
          session: {
            sessionId: "official", sourceFormat: "jsonl-v0", snapshotId: "stable", roundCount: 200,
            committedThroughOffset: 200, hasPendingTail: false,
          },
          snapshotId: "stable",
          livePersistedReconciled: true,
          roundIndex: rounds.map(round => ({
            round: round.round,
            role: round.role,
            source: round.source,
            estimatedBytes: 256,
            estimatedTokens: 64,
          })),
        };
      },
    },
  };
  const service = new ThreadToolsService(new Rc6ThreadToolsHostAdapter(seams, {
    artifactStore: artifacts,
  }));
  const first = await service.thread_read({ sessionId: "official", maxBytes: 256 });
  assert.deepEqual(first.rounds.map(round => round.round), [1]);
  assert.ok(first.continuationCursor);
  assert.ok(first.artifact);
  assert.equal(first.budget.candidateEstimate, "conservative");
  const artifactText = artifacts.getText(first.artifact!.artifactId) ?? "";
  assert.match(artifactText, /payload-0001/);
  assert.match(artifactText, /payload-0200/);
  assert.equal(first.artifact!.bytes, Buffer.byteLength(artifactText, "utf8"));
  assert.equal(first.artifact!.lines, artifactText.split(/\r?\n/).length);
  assert.equal(first.artifact!.sha256, createHash("sha256").update(artifactText).digest("hex"));
  assert.equal("putText" in artifacts, false);
  assert.equal(artifacts.chunks.length, 599);
  assert.ok(artifacts.maxChunkBytes < first.artifact!.bytes);
  assert.ok(artifacts.chunks.every(chunk => !(chunk.includes("payload-0001") && chunk.includes("payload-0200"))));

  await assert.rejects(
    service.thread_read({
      sessionId: "official",
      ranges: [{ start: 2, end: 200 }],
      continuationCursor: first.continuationCursor,
    }),
    CursorError,
  );
  const second = await service.thread_read({ sessionId: "official", continuationCursor: first.continuationCursor });
  assert.equal(second.rounds.length, 199);
  assert.deepEqual([second.rounds[0].round, second.rounds.at(-1)?.round], [2, 200]);
  assert.deepEqual(reads, [{ from: 0, to: 200 }, { from: 1, to: 200 }]);
});

test("JSONL and packed rows support list, title/content search, merged ranges and role filters", async () => {
  const source = new MemoryAppendOnlySource("fixture:jsonl", BASIC_JSONL_FIXTURE);
  const index = new IncrementalFixtureThreadIndex(source, { sourceFormat: "jsonl-v0" });
  const service = new ThreadToolsService(new FixtureThreadHost([index]));

  const listed = await service.thread_list();
  const search = await service.thread_search({ query: "needle", previewBytes: 24 });
  const read = await service.thread_read({
    sessionId: "fixture-jsonl",
    ranges: [{ start: 1, end: 1 }, { start: 2, end: 3 }],
    roles: ["user"],
  });
  const snapshot = await index.getSnapshot();

  assert.equal(listed.sessions[0].roundCount, 3);
  assert.deepEqual(search.matches.map(match => match.matchKind), ["title", "content", "content"]);
  assert.ok(search.matches.every(match => Buffer.byteLength(match.preview, "utf8") <= 24));
  assert.deepEqual(read.rounds.map(round => round.round), [1, 3]);
  assert.ok(snapshot.rounds.every(round => round.source.endOffset > round.source.startOffset));
  assert.equal(index.getDiagnostics().scannedFromOffsets[0], 0);
});

test("list and search cursors retain immutable snapshots and reject changed search requests", async () => {
  const firstSource = new MemoryAppendOnlySource("fixture:a", [
    JSON.stringify({ formatVersion: 0, sessionId: "a", title: "First" }),
    makeRound(1, "user", "needle one").trimEnd(),
    makeRound(2, "assistant", "needle two").trimEnd(),
    "",
  ].join("\n"));
  const secondSource = new MemoryAppendOnlySource("fixture:b", [
    JSON.stringify({ formatVersion: 0, sessionId: "b", title: "Second" }),
    makeRound(1, "user", "other").trimEnd(),
    "",
  ].join("\n"));
  const host = new FixtureThreadHost([
    new IncrementalFixtureThreadIndex(firstSource, { sourceFormat: "jsonl-v0" }),
    new IncrementalFixtureThreadIndex(secondSource, { sourceFormat: "jsonl-v0" }),
  ]);
  const service = new ThreadToolsService(host);

  const firstList = await service.thread_list({ limit: 1 });
  firstSource.append(makeRound(3, "user", "needle three"));
  const secondList = await service.thread_list({ limit: 1, continuationCursor: firstList.continuationCursor });
  assert.deepEqual([...firstList.sessions, ...secondList.sessions].map(session => session.sessionId), ["a", "b"]);
  assert.equal(secondList.snapshotId, firstList.snapshotId);

  const firstSearch = await service.thread_search({ query: "needle", sessionId: "a", roles: ["user"], limit: 1 });
  assert.ok(firstSearch.continuationCursor);
  firstSource.append(makeRound(4, "user", "needle four"));
  const secondSearch = await service.thread_search({
    query: "needle", sessionId: "a", roles: ["user"], limit: 1, continuationCursor: firstSearch.continuationCursor,
  });
  assert.equal(secondSearch.snapshotId, firstSearch.snapshotId);
  assert.ok(secondSearch.matches.every(match => (match.round ?? 0) <= 3));
  await assert.rejects(
    service.thread_search({ query: "changed", sessionId: "a", roles: ["user"], continuationCursor: firstSearch.continuationCursor }),
    CursorError,
  );
});

test("read cursor stays on its immutable snapshot and exposes a complete verified artifact", async () => {
  const long = "content ".repeat(35);
  const source = new MemoryAppendOnlySource("fixture:cursor", [
    JSON.stringify({ formatVersion: 0, sessionId: "fixture-cursor", title: "Cursor" }),
    makeRound(1, "user", `${long}one`).trimEnd(),
    makeRound(2, "assistant", `${long}two`).trimEnd(),
    makeRound(3, "user", `${long}three`).trimEnd(),
    "",
  ].join("\n"));
  const artifacts = new InMemoryThreadArtifactStore();
  const index = new IncrementalFixtureThreadIndex(source, { sourceFormat: "jsonl-v0" });
  const service = new ThreadToolsService(new FixtureThreadHost([index], { artifactStore: artifacts }));

  const first = await service.thread_read({ sessionId: "fixture-cursor", maxBytes: 620, maxTokens: 2000 });
  assert.equal(first.truncated, true);
  assert.ok(first.continuationCursor);
  assert.ok(first.artifact);
  const artifactText = artifacts.getText(first.artifact!.artifactId) ?? "";
  assert.match(artifactText, /three/);
  assert.equal(first.artifact!.bytes, Buffer.byteLength(artifactText, "utf8"));
  assert.equal(first.artifact!.lines, artifactText.split(/\r?\n/).length);
  assert.equal(first.artifact!.sha256, createHash("sha256").update(artifactText).digest("hex"));

  source.append(makeRound(4, "assistant", `${long}four`));
  await assert.rejects(
    service.thread_read({
      sessionId: "fixture-cursor",
      roles: ["assistant"],
      continuationCursor: first.continuationCursor,
    }),
    CursorError,
  );
  const next = await service.thread_read({
    sessionId: "fixture-cursor",
    continuationCursor: first.continuationCursor,
    maxBytes: 620,
    maxTokens: 2000,
  });
  assert.ok(next.rounds.every(round => round.round <= 3));
  assert.equal(next.snapshotId, first.snapshotId);
});

test("JSONL live append scans only the pending suffix and publishes pending-tail transitions", async () => {
  const header = `${JSON.stringify({ formatVersion: 0, sessionId: "fixture-tail" })}\n`;
  const partial = JSON.stringify({ type: "round", round: 1, role: "user", content: "completes later" });
  const source = new MemoryAppendOnlySource("fixture:tail", header);
  const index = new IncrementalFixtureThreadIndex(source, { sourceFormat: "jsonl-v0" });

  const committed = await index.getSnapshot();
  assert.equal(committed.header.hasPendingTail, false);
  source.append(partial.slice(0, 25));
  const pending = await index.getSnapshot();
  assert.equal(pending.header.hasPendingTail, true);
  assert.notEqual(pending.header.snapshotId, committed.header.snapshotId);

  source.append(`${partial.slice(25)}\n${makeRound(2, "assistant", "new committed row")}`);
  const completed = await index.getSnapshot();
  const diagnostics = index.getDiagnostics();
  assert.deepEqual(completed.rounds.map(round => round.round), [1, 2]);
  assert.deepEqual(diagnostics.scannedFromOffsets, [0, Buffer.byteLength(header), Buffer.byteLength(header)]);
  assert.equal(diagnostics.indexedRoundCount, 2);
  assert.equal(diagnostics.indexedBlockCount, 2);
  assert.equal(completed.header.hasPendingTail, false);
});

test("unknown JSONL format version fails closed", async () => {
  const source = new MemoryAppendOnlySource("fixture:unknown", `${JSON.stringify({ formatVersion: 1, sessionId: "unknown" })}\n`);
  const index = new IncrementalFixtureThreadIndex(source, { sourceFormat: "jsonl-v0" });
  await assert.rejects(index.getSnapshot(), UnsupportedFormatVersionError);
});

test("concatenated Zstd frames and packed rows retain compressed block offsets", async () => {
  const bytes = encodeSyntheticZstdFrames([
    `${JSON.stringify({ formatVersion: 0, sessionId: "fixture-zstd", title: "Frames" })}\n${makeRound(1, "user", "first frame")}`,
    `${JSON.stringify({ type: "packed", rows: [[2, "assistant", "second frame"], [3, "user", "third frame"]] })}\n`,
  ]);
  const source = new MemoryAppendOnlySource("fixture:zstd", bytes);
  const index = new IncrementalFixtureThreadIndex(source, { sourceFormat: "zstd-v0", zstdDecoder: syntheticZstdDecoder });
  const snapshot = await index.getSnapshot();

  assert.deepEqual(snapshot.rounds.map(round => round.round), [1, 2, 3]);
  assert.equal(snapshot.rounds[0].source.startOffset, 0);
  assert.ok(snapshot.rounds[1].source.startOffset >= snapshot.rounds[0].source.endOffset);
  assert.deepEqual(snapshot.rounds[1].source, snapshot.rounds[2].source);
});

test("truncated Zstd frame stays pending, resumes from its frame offset, and unknown versions fail closed", async () => {
  const firstFrame = encodeSyntheticZstdFrame(
    `${JSON.stringify({ formatVersion: 0, sessionId: "fixture-zstd-tail" })}\n${makeRound(1, "user", "first")}`,
  );
  const secondFrame = encodeSyntheticZstdFrame(makeRound(2, "assistant", "second"));
  const split = Math.floor(secondFrame.byteLength / 2);
  const source = new MemoryAppendOnlySource("fixture:zstd-tail", concatBytes(firstFrame, secondFrame.slice(0, split)));
  const index = new IncrementalFixtureThreadIndex(source, { sourceFormat: "zstd-v0", zstdDecoder: syntheticZstdDecoder });

  const pending = await index.getSnapshot();
  assert.deepEqual(pending.rounds.map(round => round.round), [1]);
  assert.equal(pending.header.hasPendingTail, true);
  source.append(secondFrame.slice(split));
  const completed = await index.getSnapshot();
  assert.deepEqual(completed.rounds.map(round => round.round), [1, 2]);
  assert.equal(completed.header.hasPendingTail, false);
  assert.deepEqual(index.getDiagnostics().scannedFromOffsets, [0, firstFrame.byteLength]);

  const unknown = new IncrementalFixtureThreadIndex(
    new MemoryAppendOnlySource("fixture:zstd-unknown", encodeSyntheticZstdFrame(
      `${JSON.stringify({ formatVersion: 9, sessionId: "unknown" })}\n`,
    )),
    { sourceFormat: "zstd-v0", zstdDecoder: syntheticZstdDecoder },
  );
  await assert.rejects(unknown.getSnapshot(), UnsupportedFormatVersionError);
});

test("round and source ranges merge adjacent spans without widening gaps", () => {
  assert.deepEqual(
    mergeAdjacentRoundRanges([{ start: 8, end: 9 }, { start: 1, end: 2 }, { start: 3, end: 4 }]),
    [{ start: 1, end: 4 }, { start: 8, end: 9 }],
  );
  assert.deepEqual(
    mergeAdjacentSourceRanges([
      { blockId: "b", startOffset: 10, endOffset: 20 },
      { blockId: "a", startOffset: 0, endOffset: 10 },
      { blockId: "c", startOffset: 30, endOffset: 40 },
    ]).map(range => [range.startOffset, range.endOffset]),
    [[0, 20], [30, 40]],
  );
});

test("write-side contracts stay frozen and event drafts expose no heat or budget policy", () => {
  const useful: ThreadMarkUsefulRequest = { sessionId: "s", rounds: [1, 2], orderedRounds: [2, 1] };
  const protect: ThreadProtectRequest = { sessionId: "s", ranges: [{ start: 1, end: 2 }] };
  const release: ThreadReleaseProtectionRequest = { sessionId: "s", protectionId: "p-1" };
  assert.deepEqual(useful.rounds, [1, 2]);
  assert.equal(protect.ranges.length, 1);
  assert.equal(release.protectionId, "p-1");
  assert.equal(JSON.stringify(THREAD_EVENT_DRAFTS).match(/heat|weight|score|quota|budget/i), null);
});
