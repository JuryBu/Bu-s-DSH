import assert from "node:assert/strict";
import test from "node:test";

import { createWindsurfPiProvider, isWindsurfCloudCallableModel, isWindsurfVisionTool, mapWindsurfContext, normalizeWindsurfToolDescription, parseWindsurfCatalogModelConfig, resetWindsurfRuntimeCaches } from "../src/pi-provider.js";

test("Windsurf 工具说明把负一哨兵改成云端可接受的等义文字", () => {
  assert.equal(
    normalizeWindsurfToolDescription("Use [start_line, -1] to read to the end."),
    "Use [start_line, minus one] to read to the end."
  );
  assert.equal(normalizeWindsurfToolDescription("A version like build-1 remains unchanged."), "A version like build-1 remains unchanged.");
  assert.equal(normalizeWindsurfToolDescription("A decimal like -1.5 remains unchanged."), "A decimal like -1.5 remains unchanged.");
});

test("Windsurf 上下文只改写工具说明而不改变真实参数约束", () => {
  const original = {
    type: "object",
    properties: {
      view_range: {
        type: "array",
        description: "Setting [start_line, -1] reads through the final line.",
        items: { type: "integer", minimum: -1 }
      }
    },
    required: ["view_range"]
  };

  const mapped = mapWindsurfContext({
    messages: [],
    tools: [{ name: "str_replace_editor", description: "Use -1 as the final-line sentinel.", parameters: original }]
  });

  assert.equal(mapped.tools[0].description, "Use minus one as the final-line sentinel.");
  assert.equal(mapped.tools[0].parameters.properties.view_range.description, "Setting [start_line, minus one] reads through the final line.");
  assert.equal(mapped.tools[0].parameters.properties.view_range.items.minimum, -1);
  assert.equal(original.properties.view_range.description.includes("-1"), true);
});

test("文本模型在上游请求映射前移除视觉工具 schema，视觉模型保留", () => {
  const context = {
    messages: [],
    tools: [
      { name: "read", description: "Read text", parameters: {} },
      { name: "read_image", description: "Read image", parameters: {} },
      { name: "view_image", description: "View image", parameters: {} },
      { name: "custom", description: "Needs vision", parameters: {}, requiresVision: true },
    ],
  };
  const textOnly = mapWindsurfContext(context, { input: ["text"] });
  assert.deepEqual(textOnly.tools.map(tool => tool.name), ["read"]);
  const visual = mapWindsurfContext(context, { input: ["text", "image"] });
  assert.deepEqual(visual.tools.map(tool => tool.name), ["read", "read_image", "view_image", "custom"]);
  assert.equal(isWindsurfVisionTool({ name: "inspect_image" }), true);
});

test("GLM 默认目录使用 200K，上游 1M 变体再单独提升窗口", () => {
  resetWindsurfRuntimeCaches();
  const glm = createWindsurfPiProvider().getModels().find(model => model.id === "glm-5-2-max");
  assert.equal(glm.contextWindow, 200_000);
  assert.equal(glm.reasoning, false);
  assert.equal(glm.stardustVariantEffort, "max");
  assert.deepEqual(glm.input, ["text"]);
});

test("实时目录只把明确带视觉能力位的模型标为多模态", () => {
  const visual = Buffer.from("visual-model");
  const visualEnvelope = Buffer.from("visual-envelope");
  const visualFlags = Buffer.from("visual-flags");
  const textOnly = Buffer.from("text-model");
  const textEnvelope = Buffer.from("text-envelope");
  const textFlags = Buffer.from("text-flags");
  const fieldMap = new Map([
    [visual, [
      { num: 1, wire: 2, value: Buffer.from("Visual Model") },
      { num: 18, wire: 0, value: 1_000_000n },
      { num: 22, wire: 2, value: Buffer.from("gemini-3-1-pro-high") },
      { num: 23, wire: 2, value: visualEnvelope }
    ]],
    [visualEnvelope, [{ num: 6, wire: 2, value: visualFlags }]],
    [visualFlags, [{ num: 11, wire: 0, value: 1n }]],
    [textOnly, [
      { num: 1, wire: 2, value: Buffer.from("Text Model") },
      { num: 18, wire: 0, value: 200_000n },
      { num: 22, wire: 2, value: Buffer.from("glm-5-2-max") },
      { num: 23, wire: 2, value: textEnvelope }
    ]],
    [textEnvelope, [{ num: 6, wire: 2, value: textFlags }]],
    [textFlags, [{ num: 8, wire: 0, value: 1n }]]
  ]);
  const iterFields = (value) => fieldMap.get(value) ?? [];

  const visualModel = parseWindsurfCatalogModelConfig(visual, iterFields);
  const textModel = parseWindsurfCatalogModelConfig(textOnly, iterFields);

  assert.deepEqual(visualModel.capability, {
    authority: "realtime",
    contextWindowTokens: 1_000_000,
    supportsVision: true
  });
  assert.deepEqual(textModel.capability, {
    authority: "realtime",
    contextWindowTokens: 200_000,
    supportsVision: false
  });
});

test("Windsurf 目录把编码档位作为只读展示元数据，不伪造成可提交推理参数", () => {
  resetWindsurfRuntimeCaches();
  const models = createWindsurfPiProvider().getModels();
  const high = models.find(model => model.id === "claude-opus-4-8-high");
  assert.equal(high.stardustVariantEffort, "high");
  assert.equal(high.reasoning, false);
  assert.deepEqual(high.stardustReasoningEfforts, []);
});

test("实时目录的 Devin Local-only 元数据和已确认不支持直连的家族不会进入云端调用链", () => {
  const config = Buffer.from("model-config");
  const localOnly = Buffer.from("This model is only in Devin Local");
  const fieldMap = new Map([
    [config, [
      { num: 1, wire: 2, value: Buffer.from("GPT-5.6 Sol") },
      { num: 22, wire: 2, value: Buffer.from("gpt-5-6-sol-high") },
      { num: 31, wire: 2, value: localOnly }
    ]],
    [localOnly, []]
  ]);
  const model = parseWindsurfCatalogModelConfig(config, (value) => fieldMap.get(value) ?? []);

  assert.deepEqual(model.metadata, ["This model is only in Devin Local"]);
  assert.equal(isWindsurfCloudCallableModel(model), false);
  assert.equal(isWindsurfCloudCallableModel({ ...model, metadata: ["Available in the cloud"] }), false);
  assert.equal(isWindsurfCloudCallableModel({ ...model, modelUid: "claude-opus-5-high", metadata: ["Available in the cloud"] }), true);
});

test("实时目录即使把 WSF GPT 标为 enabled，也不会把仅 Devin Local 可用的家族暴露给直连选择器", () => {
  assert.equal(isWindsurfCloudCallableModel({
    modelUid: "gpt-5-6-sol-medium",
    disabled: false,
    metadata: []
  }), false);
});
