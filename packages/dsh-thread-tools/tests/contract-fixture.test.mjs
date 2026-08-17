import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SIDECAR_LEDGER_KIND,
  SIDECAR_LEDGER_SCHEMA_VERSION,
  SidecarLedgerCorruptError,
  SidecarThreadLedger,
  resolveSidecarLedgerPaths,
} from "../lib/sidecar-ledger.js";

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/ext-01/thread-sidecar-v1.jsonl", import.meta.url));
const schemaPath = fileURLToPath(new URL("../../../docs/contracts/dsh-thread-sidecar.v1.schema.json", import.meta.url));

const binding = {
  ownerSessionId: "owner-session-fixture",
  targetSessionId: "target-session-fixture",
  contextGenerationId: "context-generation-fixture-2",
  sourceRevision: "source-revision-fixture-2",
};

async function materializeFixture(rootDir, text) {
  const paths = resolveSidecarLedgerPaths({ rootDir, ...binding });
  await mkdir(paths.targetDir, { recursive: true });
  await writeFile(paths.ledgerPath, text, "utf8");
}

test("EXT-01 sidecar 样例可以由真实哈希链 reader 完整重放", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "dsh-sidecar-contract-"));
  const text = await readFile(fixturePath, "utf8");
  await materializeFixture(rootDir, text);
  const ledger = await SidecarThreadLedger.open({ rootDir, ...binding });
  const state = ledger.inspect();
  assert.equal(state.recordCount, 6);
  assert.equal(state.binding.contextGenerationId, binding.contextGenerationId);
  assert.equal(state.binding.sourceRevision, binding.sourceRevision);
  assert.equal(state.receipts[0].confirmedRounds.join(","), "3,5");
  assert.equal(state.activeProtections.length, 0);
  assert.equal(state.tornTail, false);
});

test("EXT-01 sidecar schema 与样例锁定同一版本和字段", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const records = (await readFile(fixturePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(schema.properties.schemaVersion.const, SIDECAR_LEDGER_SCHEMA_VERSION);
  assert.equal(schema.properties.kind.const, SIDECAR_LEDGER_KIND);
  assert.equal(schema.additionalProperties, false);
  for (const record of records) {
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(record)));
    assert.ok(schema.properties.operation.enum.includes(record.operation));
  }
});

test("EXT-01 sidecar 未知版本继续 fail closed", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "dsh-sidecar-contract-unknown-"));
  const records = (await readFile(fixturePath, "utf8")).trim().split("\n");
  const first = JSON.parse(records[0]);
  first.schemaVersion = 2;
  records[0] = JSON.stringify(first);
  await materializeFixture(rootDir, `${records.join("\n")}\n`);
  await assert.rejects(SidecarThreadLedger.open({ rootDir, ...binding }), SidecarLedgerCorruptError);
});
