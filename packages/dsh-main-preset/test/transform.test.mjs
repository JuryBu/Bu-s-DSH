import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformStandardPreset } from "../lib/transform.mjs";

const FIXTURE = `# standard
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'

- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
`;

const releaseRoot = process.env.DSH_RELEASE_ROOT;

test("从官方标准模式生成中文主力模式", () => {
  const result = transformStandardPreset(FIXTURE);
  assert.match(result, /@stardust\/dsh-zh-prompt-suite/);
  assert.match(result, /instructionFileCandidates:[\s\S]*AGENTS\.md[\s\S]*DSH\.md/);
  assert.match(result, /localInstructionFileCandidates:[\s\S]*AGENTS\.local\.md[\s\S]*DSH\.local\.md/);
  assert.match(result, /@stardust\/dsh-thread-tools/);
  assert.match(result, /@stardust\/dsh-turn-presentation/);
  assert.match(result, /@stardust\/dsh-tool-apply-patch/);
  assert.doesNotMatch(result, /@deepseek-ai\/dsh-mcp-client/);
  assert.match(result, /persistLedgerEvents: false/);
  assert.match(result, /当前 DSH 会话恢复原文时优先使用 thread_recall/);
  assert.match(result, /跨会话、跨宿主、full\/auto 深层回溯/);
  assert.match(result, /只为实际交付的 raw 原文签发本地 sidecar 回执/);
  assert.match(result, /@dsh-experimental\/context-generation-state-machine\/compaction-provider/);
  assert.doesNotMatch(result, /name: '@deepseek-ai\/dsh-compaction-basic'/);
  assert.match(result, /mode: both/);
  assert.doesNotMatch(result, /You are a coding agent/);
});

test("官方结构变化时停止生成而不是静默产生残缺模式", () => {
  assert.throws(
    () => transformStandardPreset(FIXTURE.replace("maxBytes: 65536", "maxBytes: 32768")),
    /工作区规则结构/,
  );
});

test("已经带工具呈现方式时拒绝重复追加", () => {
  assert.throws(
    () => transformStandardPreset(`${FIXTURE}\n- name: '@deepseek-ai/dsh-agent-tool-presentation'`),
    /不能重复追加/,
  );
});

test("真实 0.1.0-rc.6 标准模式可以生成完整主力模式", { skip: !releaseRoot }, async () => {
  const path = `${releaseRoot}/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml`;
  const source = await readFile(path, "utf8");
  const result = transformStandardPreset(source);
  assert.match(result, /@deepseek-ai\/dsh-plan-mode/);
  assert.match(result, /@deepseek-ai\/dsh-tool-subagent/);
  assert.match(result, /@stardust\/dsh-thread-tools/);
  assert.match(result, /@stardust\/dsh-turn-presentation/);
  assert.match(result, /@stardust\/dsh-tool-apply-patch/);
  assert.doesNotMatch(result, /serverName: sandbox/);
  assert.match(result, /@deepseek-ai\/dsh-agent-tool-presentation/);
  assert.match(result, /@dsh-experimental\/context-generation-state-machine\/compaction-provider/);
  assert.doesNotMatch(result, /name: '@deepseek-ai\/dsh-compaction-basic'/);
  assert.match(result, /mode: both/);
});
