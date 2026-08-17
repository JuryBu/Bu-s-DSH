import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildStableContext } from "../src/context-builder.ts";

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/ext-01/context-surface-v0.json", import.meta.url));
const schemaPath = fileURLToPath(new URL("../../../docs/contracts/dsh-memory-context-surface.v0.schema.json", import.meta.url));

test("EXT-01 上下文来源清单样例与运行时构建结果一致", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const built = buildStableContext(fixture.input);
  assert.deepEqual(built.manifest, fixture.manifest);
  assert.equal(built.contentSha256, fixture.contentSha256);
});

test("EXT-01 上下文来源清单 schema 锁定正式字段", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(schema.properties.protocolVersion.const, fixture.manifest.protocolVersion);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(fixture.manifest)));
  assert.equal(schema.$defs.record.additionalProperties, false);
  assert.equal(schema.$defs.rawRound.additionalProperties, false);
  assert.equal(schema.$defs.tokenBudget.additionalProperties, false);
});
