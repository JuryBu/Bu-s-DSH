import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";
import { loadRuleModules, renderRuleModules } from "../lib/rules.js";
import { translateAssembly, untranslatedToolNames } from "../lib/translations.js";

test("规则模块按文件名稳定排序，只读取编号 Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-zh-rules-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "20-engineering.md"), "工程规则", "utf8");
    await writeFile(join(root, "00-persona.md"), "人格规则", "utf8");
    await writeFile(join(root, "README.md"), "不应加载", "utf8");
    const modules = await loadRuleModules(root);
    assert.deepEqual(modules.map((module) => module.name), ["00-persona.md", "20-engineering.md"]);
    const rendered = renderRuleModules(modules);
    assert.match(rendered, /用户全局规则/);
    assert.ok(rendered.indexOf("人格规则") < rendered.indexOf("工程规则"));
    assert.doesNotMatch(rendered, /不应加载/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("不存在规则目录时返回空基线", async () => {
  const modules = await loadRuleModules(join(tmpdir(), `missing-dsh-rules-${Date.now()}`));
  assert.deepEqual(modules, []);
  assert.equal(renderRuleModules(modules), "");
});

test("逐文件保留的全局身份声明在组装时只注入一次", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-zh-header-"));
  const header = [
    "> **这是 DSH 用户全局 Rules，适用于所有会话和工作区，并且始终生效。它在所有用户可配置的文件 Rules 中优先级最高。**",
    ">",
    "> 工作区和目录 Rules 可以补充项目事实，不能覆盖本文件。最新运行状态和宿主安全限制仍按事实执行。",
  ].join("\n");
  try {
    await writeFile(join(root, "00-persona.md"), `${header}\n\n人格正文`, "utf8");
    await writeFile(join(root, "10-work.md"), `${header}\n\n工作正文`, "utf8");
    const rendered = renderRuleModules(await loadRuleModules(root));
    assert.equal(rendered.match(/它在所有用户可配置的文件 Rules 中优先级最高/g)?.length ?? 0, 0);
    assert.equal(rendered.match(/这些规则适用于所有 DSH 会话和工作区/g)?.length, 1);
    assert.match(rendered, /人格正文/);
    assert.match(rendered, /工作正文/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("组装阶段中文化已知系统段、动态状态和工具 Schema", () => {
  const assembly = translateAssembly({
    sections: [{ name: "harness:identity", text: "English identity" }],
    contexts: [{ name: "subagent:delegation", text: "English delegation" }],
    tools: [{
      name: "read",
      description: "English read description",
      parameters: { type: "object", properties: { file_path: { type: "string" } } },
    }],
    variables: {},
  });
  assert.match(assembly.sections[0].text, /DeepSeek Harness/);
  assert.doesNotMatch(assembly.sections[0].text, /English/);
  assert.match(assembly.contexts[0].text, /子代理/);
  assert.match(assembly.tools[0].description, /UTF-8/);
  assert.equal(assembly.tools[0].parameters.properties.file_path.description, "文件路径");
});

test("同一真人轮中的权限与审批变化仍会立即更新", () => {
  const writable = translateAssembly({
    sections: [],
    contexts: [
      { name: "sandbox:policy", text: "Current DSH file policy: workspace-write. session workspace: C:\\workspace. Some platform directories are writable." },
      { name: "approval:policy", text: "Current approval policy: ask" },
    ],
    tools: [],
    variables: {},
  });
  const readOnly = translateAssembly({
    sections: [],
    contexts: [
      { name: "sandbox:policy", text: "Current DSH file policy: read-only." },
      { name: "approval:policy", text: "Approval prompts are disabled; actions are rejected automatically." },
    ],
    tools: [],
    variables: {},
  });
  assert.match(writable.contexts[0].text, /工作区可写/);
  assert.match(writable.contexts[1].text, /审批策略为询问/);
  assert.match(readOnly.contexts[0].text, /权限为只读/);
  assert.match(readOnly.contexts[1].text, /审批已关闭/);
  assert.notDeepEqual(readOnly.contexts, writable.contexts);
});

test("上游停用的空系统段保持为空，不会被翻译成启用状态", () => {
  const assembly = translateAssembly({
    sections: [{ name: "plan:policy", text: "" }],
    contexts: [],
    tools: [],
    variables: {},
  });
  assert.equal(assembly.sections[0].text, "");
});

test("未知第三方工具保持原 Schema 并进入缺口清单", () => {
  const tool = { name: "third_party_tool", description: "Upstream text", parameters: { type: "object" } };
  const assembly = translateAssembly({ sections: [], contexts: [], tools: [tool], variables: {} });
  assert.equal(assembly.tools[0].description, "Upstream text");
  assert.deepEqual(untranslatedToolNames(assembly.tools), ["third_party_tool"]);
});

test("已知参数覆盖上游英文说明", () => {
  const assembly = translateAssembly({
    sections: [],
    contexts: [],
    tools: [{
      name: "job_output",
      description: "upstream",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job id returned by the background tool." },
          timeout_ms: { type: "number", description: "Maximum wait in milliseconds." },
        },
      },
    }],
  });
  assert.equal(assembly.tools[0].parameters.properties.job_id.description, "启动后台任务时返回的任务编号");
  assert.equal(assembly.tools[0].parameters.properties.timeout_ms.description, "最长等待毫秒数");
});

test("动态身份状态只在真人新轮、上下文重建或字段变化时注入", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-zh-runtime-"));
  const defaults = await mkdtemp(join(tmpdir(), "dsh-zh-defaults-"));
  let assemble;
  let persona;
  let resolvedModels = 0;
  const ctx = {
    llm: {
      async resolveModelInfo(provider, model) {
        resolvedModels += 1;
        assert.equal(provider, "openai-codex");
        assert.equal(model, "gpt-5.6-sol");
        return { name: "GPT-5.6 Sol", context: { contextWindow: 272000 } };
      },
    },
    logger: { warn() {} },
    systemPrompt: { section(definition) { persona = definition; return () => {}; } },
    effect(callback) { return callback(); },
    emit() {},
    on(name, callback) {
      if (name === "system-prompt/assemble") assemble = callback;
    },
  };
  try {
    await apply(ctx, {
      rulesDirectory: root,
      defaultRulesDirectory: defaults,
      watchRules: false,
      runtimeInstanceName: "stage11-candidate-test",
      runtimeInstanceKind: "隔离候选",
    });
    assert.doesNotMatch(persona.text(), /\{\{model\}\}/);
    const session = {
      id: "session-runtime-test",
      events: [{ type: "turn/start", time: "2026-08-15T17:00:00Z", data: { turn: 1 } }],
      requestContext() { return { provider: "stale", model: "stale", contextWindow: 1000000 }; },
    };
    const context = {
      agent: {
        options: {},
        contextGenerationId: 4,
        session,
      },
    };
    const next = async () => ({
      sections: [],
      contexts: [],
      tools: [],
      variables: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning_effort: "xhigh" },
    });
    const result = await assemble({}, context, next);
    const runtime = result.contexts.find(context => context.name === "stardust:runtime-identity")?.text ?? "";
    assert.match(runtime, /session-runtime-test/);
    assert.match(runtime, /当前真人消息轮次：1/);
    assert.match(runtime, /当前运行实例：隔离候选 \/ stage11-candidate-test/);
    assert.match(runtime, /本机时区：.+UTC[+-]\d{2}:\d{2}/);
    assert.doesNotMatch(runtime, /本步骤开始时间/);
    assert.doesNotMatch(runtime, /触发当前轮的真人消息时间/);
    assert.match(runtime, /openai-codex \/ gpt-5\.6-sol/);
    assert.match(runtime, /当前推理强度：极高/);
    assert.match(runtime, /当前速度：标准/);
    assert.match(runtime, /当前上下文窗口：272K Token/);
    assert.match(runtime, /当前上下文重建代次：4/);
    assert.equal(result.contexts.at(-2)?.name, "stardust:runtime-identity");
    assert.match(result.contexts.find(entry => entry.name === "stardust:runtime-time")?.text ?? "", /^本机时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    context.agent.session = { ...session };
    const repeated = await assemble({}, context, next);
    assert.equal(repeated.contexts.find(context => context.name === "stardust:runtime-identity"), undefined);
    assert.equal(repeated.contexts.find(context => context.name === "stardust:runtime-time"), undefined);
    assert.equal(resolvedModels, 1);
    session.events.push({ type: "user/message", time: "2026-08-15T17:00:01Z", data: { source: { kind: "user" } } });
    const sameTurnAfterUserPersistence = await assemble({}, context, next);
    assert.equal(sameTurnAfterUserPersistence.contexts.find(context => context.name === "stardust:runtime-identity"), undefined);
    assert.equal(resolvedModels, 1);
    session.events.push({ type: "turn/start", time: "2026-08-15T17:05:00Z", data: { turn: 2 } });
    context.agent.session = { ...session };
    const nextTurn = await assemble({}, context, next);
    const nextTurnRuntime = nextTurn.contexts.find(entry => entry.name === "stardust:runtime-identity")?.text ?? "";
    assert.notEqual(nextTurnRuntime, runtime);
    assert.match(nextTurnRuntime, /当前真人消息轮次：2/);
    assert.equal(resolvedModels, 2);
    context.agent.contextGenerationId = 5;
    const rebuilt = await assemble({}, context, next);
    assert.match(rebuilt.contexts.at(-1)?.text ?? "", /当前上下文重建代次：5/);
    assert.equal(resolvedModels, 3);
    const changedEffort = await assemble({}, context, async () => ({
      sections: [],
      contexts: [],
      tools: [],
      variables: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning_effort: "high" },
    }));
    assert.match(changedEffort.contexts.at(-1)?.text ?? "", /当前推理强度：高/);
    assert.equal(resolvedModels, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(defaults, { recursive: true, force: true });
  }
});

test("权限与审批状态首次注入并且只在文本变化时替换", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-zh-runtime-status-"));
  const defaults = await mkdtemp(join(tmpdir(), "dsh-zh-defaults-status-"));
  let assemble;
  const ctx = {
    llm: { async resolveModelInfo() { return {}; } },
    logger: { warn() {} },
    systemPrompt: { section() { return () => {}; } },
    effect(callback) { return callback(); },
    emit() {},
    on(name, callback) {
      if (name === "system-prompt/assemble") assemble = callback;
    },
  };
  const session = {
    id: "session-runtime-status",
    events: [{ type: "turn/start", data: { turn: 1 } }],
    requestContext() { return undefined; },
  };
  const context = { agent: { options: {}, session } };
  const assemblyFor = (approval) => ({
    sections: [],
    contexts: [
      { name: "sandbox:policy", text: "Current DSH file policy: read-only." },
      { name: "approval:policy", text: approval },
    ],
    tools: [],
    variables: {},
  });
  try {
    await apply(ctx, { rulesDirectory: root, defaultRulesDirectory: defaults, watchRules: false });
    const initial = await assemble({}, context, async () => assemblyFor("Current approval policy: ask"));
    assert.equal(initial.contexts.filter(entry => entry.name === "sandbox:policy" || entry.name === "approval:policy").length, 2);
    const unchanged = await assemble({}, context, async () => assemblyFor("Current approval policy: ask"));
    assert.equal(unchanged.contexts.some(entry => entry.name === "sandbox:policy" || entry.name === "approval:policy"), false);
    session.events.push({ type: "turn/start", data: { turn: 2 } });
    const nextHumanTurn = await assemble({}, context, async () => assemblyFor("Current approval policy: ask"));
    assert.equal(nextHumanTurn.contexts.filter(entry => entry.name === "sandbox:policy" || entry.name === "approval:policy").length, 2);
    const changed = await assemble({}, context, async () => assemblyFor("Approval prompts are disabled; actions are rejected automatically."));
    assert.equal(changed.contexts.filter(entry => entry.name === "sandbox:policy" || entry.name === "approval:policy").length, 2);
    assert.match(changed.contexts.find(entry => entry.name === "approval:policy")?.text ?? "", /审批已关闭/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(defaults, { recursive: true, force: true });
  }
});

test("本机时间只在真人新轮或满一分钟后作为独立动态尾段注入", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-zh-runtime-time-"));
  const defaults = await mkdtemp(join(tmpdir(), "dsh-zh-defaults-time-"));
  const originalNow = Date.now;
  let now = Date.parse("2026-08-16T00:00:00.000Z");
  let assemble;
  const ctx = {
    llm: { async resolveModelInfo() { return {}; } },
    logger: { warn() {} },
    systemPrompt: { section() { return () => {}; } },
    effect(callback) { return callback(); },
    emit() {},
    on(name, callback) {
      if (name === "system-prompt/assemble") assemble = callback;
    },
  };
  const session = {
    id: "session-runtime-time",
    events: [{ type: "turn/start", data: { turn: 1 } }],
    requestContext() { return undefined; },
  };
  const context = { agent: { options: {}, session } };
  const next = async () => ({ sections: [], contexts: [], tools: [], variables: {} });
  try {
    Date.now = () => now;
    await apply(ctx, { rulesDirectory: root, defaultRulesDirectory: defaults, watchRules: false });
    const initial = await assemble({}, context, next);
    assert.ok(initial.contexts.some(entry => entry.name === "stardust:runtime-identity"));
    assert.ok(initial.contexts.some(entry => entry.name === "stardust:runtime-time"));
    now += 59_999;
    const beforeMinute = await assemble({}, context, next);
    assert.equal(beforeMinute.contexts.some(entry => entry.name === "stardust:runtime-identity" || entry.name === "stardust:runtime-time"), false);
    now += 1;
    const refreshed = await assemble({}, context, next);
    assert.equal(refreshed.contexts.some(entry => entry.name === "stardust:runtime-identity"), false);
    assert.equal(refreshed.contexts.at(-1)?.name, "stardust:runtime-time");
    session.events.push({ type: "turn/start", data: { turn: 2 } });
    now += 1;
    const nextHumanTurn = await assemble({}, context, next);
    assert.equal(nextHumanTurn.contexts.at(-2)?.name, "stardust:runtime-identity");
    assert.equal(nextHumanTurn.contexts.at(-1)?.name, "stardust:runtime-time");
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
    await rm(defaults, { recursive: true, force: true });
  }
});

test("编码在模型名称里的 Windsurf 推理档位与上下文首轮即可注入", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-zh-runtime-wsf-"));
  const defaults = await mkdtemp(join(tmpdir(), "dsh-zh-defaults-wsf-"));
  let assemble;
  const ctx = {
    llm: {
      async resolveModelInfo(provider, model) {
        assert.equal(provider, "windsurf");
        assert.equal(model, "glm-5-2-1m");
        return {
          name: "GLM-5.2 1M",
          stardustVariantEffort: "high",
          context: { contextWindow: 1000000 },
        };
      },
    },
    logger: { warn() {} },
    systemPrompt: { section() { return () => {}; } },
    effect(callback) { return callback(); },
    emit() {},
    on(name, callback) {
      if (name === "system-prompt/assemble") assemble = callback;
    },
  };
  try {
    await apply(ctx, { rulesDirectory: root, defaultRulesDirectory: defaults, watchRules: false });
    const result = await assemble({}, {
      agent: {
        options: {},
        session: {
          id: "session-runtime-wsf",
          requestContext() { return undefined; },
        },
      },
    }, async () => ({
      sections: [],
      contexts: [],
      tools: [],
      variables: { provider: "windsurf", model: "glm-5-2-1m" },
    }));
    const runtime = result.contexts.find(context => context.name === "stardust:runtime-identity")?.text ?? "";
    assert.match(runtime, /当前推理强度：高/);
    assert.match(runtime, /当前上下文窗口：1M Token/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(defaults, { recursive: true, force: true });
  }
});

test("空规则目录首次安装内置中文 Rules，已有用户 Rules 时绝不覆盖", async () => {
  const defaults = await mkdtemp(join(tmpdir(), "dsh-zh-defaults-"));
  const emptyRules = await mkdtemp(join(tmpdir(), "dsh-zh-empty-rules-"));
  const userRules = await mkdtemp(join(tmpdir(), "dsh-zh-user-rules-"));
  const createCtx = () => ({
    llm: { async resolveModelInfo() { return {}; } },
    logger: { warn() {} },
    systemPrompt: { section() { return () => {}; } },
    effect(callback) { return callback(); },
    emit() {},
    on() {},
  });
  try {
    await writeFile(join(defaults, "00-persona.md"), "默认猫娘人格", "utf8");
    await writeFile(join(defaults, "README.md"), "不应安装", "utf8");
    await apply(createCtx(), { rulesDirectory: emptyRules, defaultRulesDirectory: defaults, watchRules: false });
    assert.equal(await readFile(join(emptyRules, "00-persona.md"), "utf8"), "默认猫娘人格");
    assert.ok((await readdir(emptyRules)).includes(".stardust-default-rules-v1"));
    assert.ok(!(await readdir(emptyRules)).includes("README.md"));

    await writeFile(join(userRules, "00-persona.md"), "主人自己的规则", "utf8");
    await apply(createCtx(), { rulesDirectory: userRules, defaultRulesDirectory: defaults, watchRules: false });
    assert.equal(await readFile(join(userRules, "00-persona.md"), "utf8"), "主人自己的规则");
    assert.ok((await readdir(userRules)).includes(".stardust-default-rules-v1"));
  } finally {
    await rm(defaults, { recursive: true, force: true });
    await rm(emptyRules, { recursive: true, force: true });
    await rm(userRules, { recursive: true, force: true });
  }
});
