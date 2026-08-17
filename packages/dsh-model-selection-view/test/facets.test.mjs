import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_FACET_BROWSER_SOURCE } from "../lib/browser-source.js";

const api = Function(`${MODEL_FACET_BROWSER_SOURCE}\nreturn { stardustFacetGroups, stardustFamilyForCurrent, stardustFamilyContexts, stardustFamilyEfforts, stardustFamilySpeeds, stardustSelectionForFamily };`)();

test("Windsurf 同一模型的推理与速度变体归并为一行", () => {
  const groups = api.stardustFacetGroups([{ id: "windsurf", name: "Windsurf / Devin", models: [
    { id: "claude-opus-4-8-low", name: "Claude Opus 4.8 Low" },
    { id: "claude-opus-4-8-high", name: "Claude Opus 4.8 High" },
    { id: "claude-opus-4-8-high-fast", name: "Claude Opus 4.8 High Fast" },
    { id: "claude-opus-4-8-max", name: "Claude Opus 4.8 Max" }
  ] }]);
  assert.equal(groups[0].families.length, 1);
  assert.equal(groups[0].families[0].name, "Claude Opus 4.8");
  assert.deepEqual(api.stardustFamilyEfforts(groups[0].families[0], "standard"), ["low", "high", "max"]);
  assert.deepEqual(api.stardustFamilySpeeds(groups[0].families[0], "high"), ["standard", "fast"]);
  assert.equal(api.stardustSelectionForFamily(groups[0].families[0], { effort: "high" }).reasoningEffort, undefined);
});

test("不存在的 Windsurf 组合不会被凭空拼出", () => {
  const [group] = api.stardustFacetGroups([{ id: "windsurf", name: "Windsurf / Devin", models: [
    { id: "claude-opus-4-8-high-fast", name: "Claude Opus 4.8 High Fast" },
    { id: "claude-opus-4-8-max", name: "Claude Opus 4.8 Max" }
  ] }]);
  const selection = api.stardustSelectionForFamily(group.families[0], { effort: "max", speed: "fast" });
  assert.equal(selection.model, "claude-opus-4-8-max");
  assert.equal(selection.__speed, "standard");
});

test("OpenAI Fast 只成为速度档，不再成为第二个模型名", () => {
  const [group] = api.stardustFacetGroups([{ id: "openai-codex", name: "ChatGPT 订阅", models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: { efforts: [{ id: "low" }, { id: "high" }, { id: "max" }] } },
    { id: "fast::gpt-5.6-sol", name: "GPT-5.6 Sol · Fast", reasoning: { efforts: [{ id: "low" }, { id: "high" }, { id: "max" }] } }
  ] }]);
  assert.equal(group.families.length, 1);
  assert.equal(group.families[0].name, "GPT-5.6 Sol");
  assert.deepEqual(api.stardustFamilySpeeds(group.families[0], "high"), ["standard", "fast"]);
  assert.equal(api.stardustSelectionForFamily(group.families[0], { effort: "high", speed: "fast" }).model, "fast::gpt-5.6-sol");
});

test("没有 provider default，首次选择优先使用真实 High", () => {
  const [group] = api.stardustFacetGroups([{ id: "openai-codex", name: "ChatGPT 订阅", models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: { efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }, { id: "ultra" }] } }
  ] }]);
  const selection = api.stardustSelectionForFamily(group.families[0], { speed: "standard" });
  assert.equal(selection.reasoningEffort, "high");
});

test("GLM 200K 与 1M 归并为同一基础模型的上下文选项", () => {
  const [group] = api.stardustFacetGroups([{ id: "windsurf", name: "Windsurf / Devin", models: [
    { id: "glm-5-2", name: "GLM-5.2", stardustVariantEffort: "high" },
    { id: "glm-5-2-1m", name: "GLM-5.2 1M", stardustVariantEffort: "high" }
  ] }]);
  assert.deepEqual(group.families.map((family) => family.name), ["GLM-5.2"]);
  assert.deepEqual(api.stardustFamilyContexts(group.families[0]), ["default", "1m"]);
  assert.deepEqual(api.stardustFamilyEfforts(group.families[0], "standard", "default"), ["high"]);
  assert.equal(api.stardustSelectionForFamily(group.families[0], { context: "default", effort: "high" }).model, "glm-5-2");
  const oneMillion = api.stardustSelectionForFamily(group.families[0], { context: "1m", effort: "high" });
  assert.equal(oneMillion.model, "glm-5-2-1m");
  assert.equal(oneMillion.reasoningEffort, undefined);
});

test("Windsurf 通用显示名称不再被猜成推理档位，只信目录元数据或模型 ID", () => {
  const [group] = api.stardustFacetGroups([{ id: "windsurf", name: "Windsurf / Devin", models: [
    { id: "provider-model-a", name: "Provider Model High" },
    { id: "provider-model-b", name: "Provider Model B", stardustVariantEffort: "max" }
  ] }]);
  const efforts = group.families.flatMap(family => api.stardustFamilyEfforts(family, "standard"));
  assert.equal(efforts.includes("high"), false);
  assert.equal(efforts.includes("max"), true);
});

test("跨 Provider 继承无效推理强度时自动回到目标模型合法组合", () => {
  const [group] = api.stardustFacetGroups([{ id: "deepseek", name: "DeepSeek", models: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }
  ] }]);
  assert.deepEqual(api.stardustSelectionForFamily(group.families[0], { effort: "high", speed: "fast" }), {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    __familyId: "deepseek-v4-pro",
    __speed: "standard",
    __context: "default"
  });
});

test("Windsurf 编码变体只选择真实模型 ID，不重复发送推理参数", () => {
  const [group] = api.stardustFacetGroups([{ id: "windsurf", name: "Windsurf / Devin", models: [
    { id: "gpt-5-6-sol-high", name: "GPT-5.6 Sol High" },
    { id: "gpt-5-6-sol-max", name: "GPT-5.6 Sol Max" }
  ] }]);
  const selection = api.stardustSelectionForFamily(group.families[0], { effort: "high" });
  assert.equal(selection.model, "gpt-5-6-sol-high");
  assert.equal(selection.reasoningEffort, undefined);
});

test("三类提供方目录里的每个基础模型都能解析出可提交的真实组合", () => {
  const groups = api.stardustFacetGroups([
    { id: "deepseek", name: "DeepSeek", models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }
    ] },
    { id: "openai-codex", name: "ChatGPT 订阅", models: [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: { efforts: [{ id: "low" }, { id: "high" }, { id: "max" }] } },
      { id: "fast::gpt-5.6-sol", name: "GPT-5.6 Sol · Fast", reasoning: { efforts: [{ id: "low" }, { id: "high" }, { id: "max" }] } },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: { efforts: [{ id: "low" }, { id: "high" }, { id: "max" }] } }
    ] },
    { id: "windsurf", name: "Windsurf / Devin", models: [
      { id: "claude-opus-5-high", name: "Claude Opus 5 High" },
      { id: "claude-sonnet-5-max", name: "Claude Sonnet 5 Max" },
      { id: "gemini-3-1-pro-high", name: "Gemini 3.1 Pro High" },
      { id: "glm-5-2", name: "GLM-5.2 High" },
      { id: "glm-5-2-1m", name: "GLM-5.2 High 1M" },
      { id: "gpt-5-6-sol-high", name: "GPT-5.6 Sol High" },
      { id: "grok-4-5", name: "Grok 4.5" }
    ] }
  ]);
  for (const group of groups) {
    for (const family of group.families) {
      const selection = api.stardustSelectionForFamily(family);
      assert.ok(selection, `${group.name} / ${family.name} 应存在合法默认组合`);
      assert.equal(selection.provider, group.id);
      assert.ok(family.variants.some((variant) => variant.model === selection.model));
      if (group.id === "windsurf") assert.equal(selection.reasoningEffort, undefined);
    }
  }
});
