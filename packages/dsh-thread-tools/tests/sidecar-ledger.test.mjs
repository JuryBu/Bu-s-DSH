import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SidecarLedgerCorruptError,
  SidecarLedgerError,
  SidecarLedgerStaleError,
  SidecarThreadLedger,
  resolveSidecarLedgerPaths,
} from "../lib/sidecar-ledger.js";

async function withRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-thread-ledger-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function openLedger(root, overrides = {}) {
  return SidecarThreadLedger.open({
    rootDir: root,
    ownerSessionId: "owner-session",
    targetSessionId: "target-session",
    contextGenerationId: "generation-a",
    sourceRevision: "revision-a",
    ...overrides,
  });
}

async function initializeLedger(root, overrides = {}) {
  const ledger = await openLedger(root, overrides);
  await ledger.initialize({ operationId: "initialize-1" });
  return ledger;
}

const lockHolderPath = fileURLToPath(new URL("./fixtures/sidecar-lock-holder.mjs", import.meta.url));

async function holdExternalLock(lockPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [lockHolderPath, lockPath], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const timeout = setTimeout(() => reject(new Error("跨进程锁 fixture 未在时限内就绪")), 5000);
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    child.once("message", finish(message => {
      if (message?.type === "locked") resolve(child);
      else reject(new Error(message?.message || "跨进程锁 fixture 启动失败"));
    }));
    child.once("error", finish(reject));
    child.once("exit", finish(code => reject(new Error(`跨进程锁 fixture 提前退出: ${code}`))));
  });
}

async function releaseExternalLock(child) {
  const exited = once(child, "exit");
  child.send({ type: "release" });
  await exited;
}

test("sidecar 重启重放 receipt、confirm、protect、release", async t => {
  const root = await withRoot(t);
  const first = await initializeLedger(root);
  const receipt = await first.registerReceipt({
    operationId: "read-1",
    readReceiptId: "receipt-1",
    snapshotId: "snapshot-1",
    dataSource: "synthetic-fixture",
    rounds: [1, 2, 3],
    fragments: [{ round: 2, blockId: "memory-block-2", startOffset: 64, endOffset: 128, contentHash: "b".repeat(64) }],
  });
  const confirmation = await first.confirmReceipt({
    operationId: "confirm-1",
    readReceiptId: receipt.readReceiptId,
    rounds: [2],
    orderedRounds: [2],
    confirmedAtOwnerRound: 11,
  });
  const protection = await first.protect({ operationId: "protect-1", protectionId: "protection-1", ranges: [{ start: 4, end: 6 }] });
  assert.deepEqual(confirmation.confirmedRounds, [2]);
  assert.equal(protection.protectionId, "protection-1");

  const restarted = await openLedger(root);
  const replayed = restarted.inspect();
  assert.equal(replayed.recordCount, 4);
  assert.deepEqual(replayed.receipts[0].confirmedRounds, [2]);
  assert.deepEqual(replayed.receipts[0].fragments, [{ round: 2, blockId: "memory-block-2", startOffset: 64, endOffset: 128, contentHash: "b".repeat(64) }]);
  assert.deepEqual(replayed.confirmationHistory, [{
    readReceiptId: "receipt-1",
    confirmedRounds: [2],
    orderedRounds: [2],
    confirmedAtOwnerRound: 11,
    createdAt: replayed.confirmationHistory[0].createdAt,
  }]);
  assert.deepEqual(replayed.activeProtections.map(item => item.protectionId), ["protection-1"]);
  const released = await restarted.releaseProtection({ operationId: "release-1", protectionId: "protection-1" });
  assert.equal(released.ledgerDurability, "sidecar-hash-chain");
  assert.equal((await openLedger(root)).inspect().activeProtections.length, 0);
});

test("operationId 重试幂等，冲突操作拒绝且不追加第二条记录", async t => {
  const root = await withRoot(t);
  const ledger = await initializeLedger(root);
  const first = await ledger.registerReceipt({
    operationId: "read-idempotent",
    readReceiptId: "receipt-idempotent",
    snapshotId: "snapshot-1",
    dataSource: "fixture",
    rounds: [1, 2],
  });
  const duplicate = await ledger.registerReceipt({
    operationId: "read-idempotent",
    readReceiptId: "receipt-idempotent",
    snapshotId: "snapshot-1",
    dataSource: "fixture",
    rounds: [1, 2],
  });
  assert.equal(first.ledgerSeq, duplicate.ledgerSeq);
  assert.equal(duplicate.duplicate, true);

  const confirmed = await ledger.confirmReceipt({ operationId: "confirm-idempotent", readReceiptId: first.readReceiptId, rounds: [1] });
  const confirmedAgain = await ledger.confirmReceipt({ operationId: "confirm-idempotent", readReceiptId: first.readReceiptId, rounds: [1] });
  assert.equal(confirmed.ledgerSeq, confirmedAgain.ledgerSeq);
  assert.equal(confirmedAgain.duplicate, true);
  assert.equal(ledger.inspect().recordCount, 3);
  await assert.rejects(
    ledger.confirmReceipt({ operationId: "confirm-idempotent", readReceiptId: first.readReceiptId, rounds: [2] }),
    error => error instanceof SidecarLedgerError && error.code === "ledger_operation_conflict",
  );
});

test("上下文代次或 source revision 变化后拒绝陈旧回执和保护", async t => {
  const root = await withRoot(t);
  const ledger = await initializeLedger(root);
  const receipt = await ledger.registerReceipt({
    operationId: "read-stale",
    readReceiptId: "receipt-stale",
    snapshotId: "snapshot-1",
    dataSource: "fixture",
    rounds: [1],
  });
  const protection = await ledger.protect({ operationId: "protect-stale", protectionId: "protection-stale", ranges: [{ start: 1, end: 1 }] });
  await ledger.rotateGeneration({ operationId: "rotate-stale", contextGenerationId: "generation-b", sourceRevision: "revision-b" });
  await assert.rejects(
    ledger.confirmReceipt({ operationId: "confirm-stale", readReceiptId: receipt.readReceiptId, rounds: [1], contextGenerationId: "generation-a", sourceRevision: "revision-a" }),
    error => error instanceof SidecarLedgerStaleError && error.code === "ledger_stale_generation",
  );
  await assert.rejects(
    ledger.releaseProtection({ operationId: "release-stale", protectionId: protection.protectionId, contextGenerationId: "generation-a", sourceRevision: "revision-a" }),
    error => error instanceof SidecarLedgerStaleError && error.code === "ledger_stale_generation",
  );
  await assert.rejects(
    ledger.protect({ operationId: "protect-stale-revision", protectionId: "protection-stale-revision", ranges: [{ start: 2, end: 2 }], contextGenerationId: "generation-b", sourceRevision: "revision-a" }),
    error => error instanceof SidecarLedgerStaleError && error.code === "ledger_stale_source_revision",
  );
});

test("完整行哈希损坏、未知 schema 和中间坏行都 fail-closed", async t => {
  const root = await withRoot(t);
  const ledger = await initializeLedger(root);
  await ledger.registerReceipt({ operationId: "read-corrupt", readReceiptId: "receipt-corrupt", snapshotId: "snapshot", dataSource: "fixture", rounds: [1] });
  const original = await readFile(ledger.ledgerPath, "utf8");
  const lines = original.trimEnd().split("\n");
  const first = JSON.parse(lines[0]);
  first.payload = { changed: true };
  lines[0] = JSON.stringify(first);
  await writeFile(ledger.ledgerPath, `${lines.join("\n")}\n`, "utf8");
  await assert.rejects(openLedger(root), error => error instanceof SidecarLedgerCorruptError);

  const unknownRoot = await withRoot(t);
  const unknownLedger = await openLedger(unknownRoot);
  await mkdir(path.dirname(unknownLedger.ledgerPath), { recursive: true });
  await writeFile(unknownLedger.ledgerPath, `${JSON.stringify({ schemaVersion: 999, kind: "dsh-thread-sidecar" })}\n`, "utf8");
  await assert.rejects(openLedger(unknownRoot), error => error instanceof SidecarLedgerCorruptError);

  const middleRoot = await withRoot(t);
  const middleLedger = await initializeLedger(middleRoot);
  await appendFile(middleLedger.ledgerPath, "{not-json}\n", "utf8");
  await assert.rejects(openLedger(middleRoot), error => error instanceof SidecarLedgerCorruptError);
});

test("只容忍最终 torn line，下一次追加先截断尾行再继续哈希链", async t => {
  const root = await withRoot(t);
  const ledger = await initializeLedger(root);
  await appendFile(ledger.ledgerPath, "{\"partial\":", "utf8");
  const restarted = await openLedger(root);
  assert.equal(restarted.inspect().tornTail, true);
  assert.equal(restarted.inspect().recordCount, 1);
  await restarted.protect({ operationId: "protect-after-tail", protectionId: "protection-after-tail", ranges: [{ start: 5, end: 5 }] });
  const repaired = (await openLedger(root)).inspect();
  assert.equal(repaired.tornTail, false);
  assert.equal(repaired.recordCount, 2);
  assert.deepEqual(repaired.activeProtections.map(item => item.protectionId), ["protection-after-tail"]);
});

test("sidecar 路径拒绝越界标识，持久化失败不静默退回内存", async t => {
  const root = await withRoot(t);
  assert.throws(() => resolveSidecarLedgerPaths({ rootDir: root, ownerSessionId: "..\\escape", targetSessionId: "target" }), /路径分隔符/u);
  assert.throws(() => resolveSidecarLedgerPaths({ rootDir: root, ownerSessionId: "owner", targetSessionId: "C:\\outside" }), /路径分隔符/u);
  assert.throws(() => resolveSidecarLedgerPaths({ rootDir: ".", ownerSessionId: "owner", targetSessionId: "target" }), /绝对路径/u);

  const notDirectory = path.join(root, "not-a-directory");
  await writeFile(notDirectory, "fixture", "utf8");
  const ledger = await openLedger(notDirectory);
  await assert.rejects(ledger.initialize({ operationId: "will-fail" }), error => error?.code === "ledger_unavailable");
});

test("同一 sidecar 的并行写入按锁顺序追加，不破坏 seq/hash 链", async t => {
  const root = await withRoot(t);
  const ledger = await initializeLedger(root);
  const secondInstance = await openLedger(root);
  await Promise.all([
    ledger.protect({ operationId: "parallel-protect-1", protectionId: "parallel-protection-1", ranges: [{ start: 1, end: 1 }] }),
    secondInstance.protect({ operationId: "parallel-protect-2", protectionId: "parallel-protection-2", ranges: [{ start: 2, end: 2 }] }),
  ]);
  const replayed = (await openLedger(root)).inspect();
  assert.equal(replayed.recordCount, 3);
  assert.deepEqual(replayed.activeProtections.map(item => item.protectionId).sort(), ["parallel-protection-1", "parallel-protection-2"]);
});

test("跨进程 EEXIST 不会删除其它进程持有的 sidecar lock", async t => {
  const root = await withRoot(t);
  const ledger = await initializeLedger(root);
  const child = await holdExternalLock(ledger.lockPath);
  let released = false;
  t.after(async () => {
    if (!released && child.exitCode === null) await releaseExternalLock(child);
  });
  const contender = await openLedger(root);
  await assert.rejects(
    contender.protect({ operationId: "blocked-by-external-lock", protectionId: "blocked-protection", ranges: [{ start: 1, end: 1 }] }),
    error => error instanceof SidecarLedgerError && error.code === "ledger_lock_unavailable",
  );
  await access(ledger.lockPath);
  await releaseExternalLock(child);
  released = true;
  await contender.protect({ operationId: "after-external-lock", protectionId: "after-protection", ranges: [{ start: 1, end: 1 }] });
});

test("sidecar 写入不改变官方 session 文件字节", async t => {
  const root = await withRoot(t);
  const officialSessionPath = path.join(root, "official-session.jsonl");
  const officialBytes = "official session fixture\n";
  await writeFile(officialSessionPath, officialBytes, "utf8");
  const ledger = await initializeLedger(path.join(root, "thread-ledger-v1"));
  await ledger.registerReceipt({ operationId: "read-official-unchanged", readReceiptId: "receipt-official-unchanged", snapshotId: "snapshot", dataSource: "fixture", rounds: [1] });
  await ledger.protect({ operationId: "protect-official-unchanged", protectionId: "protection-official-unchanged", ranges: [{ start: 1, end: 1 }] });
  assert.equal(await readFile(officialSessionPath, "utf8"), officialBytes);
  assert.notEqual(ledger.ledgerPath, officialSessionPath);
});
