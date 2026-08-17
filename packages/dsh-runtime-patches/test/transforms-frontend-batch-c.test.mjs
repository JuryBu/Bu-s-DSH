import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ACCOUNT_USAGE_PANEL_BROWSER_SOURCE, ACCOUNT_USAGE_PANEL_STYLE } from "../../dsh-account-usage/lib/settings-panel-source.js";
import { MODEL_MENU_STYLE, MODEL_SELECT_BROWSER_SOURCE } from "../../dsh-model-selection-view/lib/browser-source.js";
import { CONTEXT_STATUS_CARD_STYLE, patchContextStatusCardSource } from "../lib/frontend/context-status-card.mjs";
import { patchAccountUsageSettingsSource } from "../lib/frontend/account-usage-panel.mjs";

/**
 * 干净锚点基线。缺失时跳过依赖 release 的用例，不让本机没装 DSH 的环境直接失败。
 */
const BASELINE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai";
const baselineAvailable = existsSync(BASELINE);

function baselineSource(pkg) {
  return readFileSync(path.join(BASELINE, pkg, "lib", "client.js"), "utf8");
}

function assertSyntaxOk(name, source) {
  const dir = path.join(tmpdir(), "dsh-frontend-batch-c");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  writeFileSync(file, source, "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

/** 账户面板的渲染锚点由主线的 Windsurf 设置卡补丁产出，按真实构建顺序组合。 */
async function settingsModelsBaseline() {
  const { patchWindsurfSettingsSource } = await import("../lib/transforms.mjs");
  return patchWindsurfSettingsSource(baselineSource("dsh-client-ui-settings-models"));
}

test("账户面板补丁在干净基线上唯一命中并产出可解析源码", { skip: !baselineAvailable }, async () => {
  const source = await settingsModelsBaseline();
  const patched = patchAccountUsageSettingsSource(source);
  assert.ok(patched.length > source.length);
  assert.equal(patched.split("function AccountUsagePanel()").length - 1, 1);
  assert.equal(patched.split("(0, react_jsx_runtime.jsx)(AccountUsagePanel, {}),").length - 1, 1);
  assertSyntaxOk("settings-models", patched);
});

test("两个面板补丁都拒绝重复注入", { skip: !baselineAvailable }, async () => {
  const settings = patchAccountUsageSettingsSource(await settingsModelsBaseline());
  assert.throws(() => patchAccountUsageSettingsSource(settings), /拒绝重复注入/u);
  const conversation = patchContextStatusCardSource(baselineSource("dsh-client-ui-conversation"));
  assert.throws(() => patchContextStatusCardSource(conversation), /拒绝重复注入/u);
});

test("上下文状态卡补丁唯一命中，并把压缩状态区挂进面板", { skip: !baselineAvailable }, () => {
  const source = baselineSource("dsh-client-ui-conversation");
  const patched = patchContextStatusCardSource(source);
  assert.equal(patched.split("function StardustCompactionStatus(").length - 1, 1);
  assert.equal(patched.split("(0, react_jsx_runtime.jsx)(StardustCompactionStatus, { useProjection })").length - 1, 1);
  assert.equal(patched.split('"data-dsh-context-card": true').length - 1, 1);
  assert.ok(patched.includes('className: "dsh-cs-percent"'));
  assertSyntaxOk("conversation-context-card", patched);
});

test("上下文状态卡与主线上下文阈值补丁顺序可交换", { skip: !baselineAvailable }, async () => {
  const { patchContextMeterThresholdsSource } = await import("../lib/transforms.mjs");
  const source = baselineSource("dsh-client-ui-conversation");
  const mineFirst = patchContextMeterThresholdsSource(patchContextStatusCardSource(source));
  const theirsFirst = patchContextStatusCardSource(patchContextMeterThresholdsSource(source));
  assert.equal(mineFirst.length, theirsFirst.length);
  assertSyntaxOk("conversation-order-a", mineFirst);
  assertSyntaxOk("conversation-order-b", theirsFirst);
});

test("注入的浏览器源码本身语法可解析", () => {
  assertSyntaxOk(
    "account-panel-source",
    `const react={},react_jsx_runtime={},ModelsSection_module_css_default={};\n${ACCOUNT_USAGE_PANEL_BROWSER_SOURCE}`,
  );
  assertSyntaxOk(
    "model-select-source",
    `const react={},react_jsx_runtime={},clsx=()=>{},ModelSelect_module_css_default={},_deepseek_ai_dsh_client_ui_primitives={},STARDUST_FAST_SPEED="fast",STARDUST_STANDARD_SPEED="standard",STARDUST_DEFAULT_CONTEXT="default";\n${MODEL_SELECT_BROWSER_SOURCE}`,
  );
});

test("账户面板不把缺字段换算成 0%，也不显示空条", () => {
  const rows = Function(
    "react", "react_jsx_runtime", "ModelsSection_module_css_default",
    `${ACCOUNT_USAGE_PANEL_BROWSER_SOURCE}\nreturn { accountUsageRows, accountUsagePercentText, accountUsagePlanTag, accountUsageWindsurfRows };`,
  )({}, {}, {});
  const provider = { id: "x", label: "X", unknownLabel: "额度剩余" };

  assert.equal(rows.accountUsagePercentText(null), "未知");
  assert.equal(rows.accountUsagePercentText(undefined), "未知");
  assert.equal(rows.accountUsagePercentText(0), "0%");

  const failed = rows.accountUsageRows(provider, { availability: "unavailable", connection: "disconnected", reason: "credential_unavailable" });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].valueText, "未知");
  assert.equal(failed[0].unknown, true);
  assert.equal(failed[0].percent, null);
  assert.equal(failed[0].caption, "尚未配置凭据，未发起请求");

  const noQuota = rows.accountUsageRows(provider, { availability: "available", connection: "connected", quota: null, reason: "quota_fields_unavailable" });
  assert.equal(noQuota[0].valueText, "未知");
  assert.equal(noQuota[0].caption, "已连接，本次接口未返回额度字段");
});

test("Windsurf 以每周剩余为主指标，满额的每日额度不占位", () => {
  const api = Function(
    "react", "react_jsx_runtime", "ModelsSection_module_css_default",
    `${ACCOUNT_USAGE_PANEL_BROWSER_SOURCE}\nreturn { accountUsageWindsurfRows };`,
  )({}, {}, {});
  const produced = api.accountUsageWindsurfRows({
    kind: "windsurf",
    planName: "Max",
    windows: [
      { id: "daily", label: "每日额度", remainingPercent: 100, usedPercent: 0 },
      { id: "weekly", label: "每周额度", remainingPercent: 55, usedPercent: 45 },
    ],
    credits: { prompt: null, addOn: null },
    overageBalanceMicros: 1670000,
  });
  assert.deepEqual(produced.map((row) => row.label), ["每周额度剩余", "额外用量余额"]);
  assert.equal(produced[0].percent, 55);
  assert.equal(produced[1].valueText, "$1.67");
  assert.equal(produced[1].bar, false);
});

test("主次额度的字号字重与条高在样式里保持一致", () => {
  assert.match(ACCOUNT_USAGE_PANEL_STYLE, /\.dsh-au-q-lab \.v\{[^}]*font-size:17px;font-weight:650/u);
  assert.equal(ACCOUNT_USAGE_PANEL_STYLE.match(/font-size:17px/gu).length, 1);
  assert.equal(ACCOUNT_USAGE_PANEL_STYLE.match(/\.dsh-au-bar\{[^}]*height:9px/gu).length, 1);
  assert.doesNotMatch(ACCOUNT_USAGE_PANEL_STYLE, /\.dsh-au-q\.sub|knob/u);
  assert.match(ACCOUNT_USAGE_PANEL_STYLE, /prefers-reduced-motion:reduce\)\{\.dsh-au-bar::before\{animation:none\}/u);
});

test("压缩状态没有真实事件时只说状态未知，不画进度条", () => {
  const source = patchContextStatusCardSource(
    baselineAvailable ? baselineSource("dsh-client-ui-conversation") : "\t\tfunction ContextMeter({ useProjection, t }) {",
  );
  assert.ok(source.includes('"状态未知"'));
  assert.doesNotMatch(CONTEXT_STATUS_CARD_STYLE, /progress|width:var\(--dsh-cs/u);
  assert.match(CONTEXT_STATUS_CARD_STYLE, /\.dsh-cs-percent\{[^}]*font-size:26px/u);
});

test("成本副标题只出现在真实高成本档位上", () => {
  const api = Function(
    "react", "react_jsx_runtime", "clsx", "ModelSelect_module_css_default", "_deepseek_ai_dsh_client_ui_primitives",
    "STARDUST_FAST_SPEED", "STARDUST_STANDARD_SPEED", "STARDUST_DEFAULT_CONTEXT",
    `${MODEL_SELECT_BROWSER_SOURCE}\nreturn { stardustSpeedHint, stardustEffortHint };`,
  )({}, {}, () => {}, {}, {}, "fast", "standard", "default");
  assert.equal(api.stardustSpeedHint("fast"), "1.5 倍速度，用量更多");
  assert.equal(api.stardustSpeedHint("standard"), "默认速度");
  assert.equal(api.stardustEffortHint("xhigh"), "更快消耗使用额度");
  assert.equal(api.stardustEffortHint("max"), "更快消耗使用额度");
  assert.equal(api.stardustEffortHint("medium"), undefined);
  assert.equal(api.stardustEffortHint("low"), undefined);
});

test("高级区的档位拖动条只画真实档位，且用 range 承接拖动与键盘", () => {
  // 刻度点数量来自 entries.map，没有任何补齐/插值逻辑。
  assert.match(MODEL_SELECT_BROWSER_SOURCE, /const facetSlider = \(key, label, entries, currentIndex, onPick\)/u);
  assert.match(MODEL_SELECT_BROWSER_SOURCE, /\.\.\.entries\.map\(\(entry, tickIndex\)/u);
  assert.match(MODEL_SELECT_BROWSER_SOURCE, /type: "range"/u);
  assert.match(MODEL_SELECT_BROWSER_SOURCE, /max: Math\.max\(0, total - 1\)/u);
  // 只有两档以上才画滑条，单档不画（避免出现一个拖不动的空条）。
  for (const facet of ["effortChoices", "speedChoices", "contextChoices"]) {
    assert.ok(MODEL_SELECT_BROWSER_SOURCE.includes(`${facet}.length > 1 ? facetSlider(`), `${facet} 应在多档时才渲染滑条`);
  }
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-knob\{/u);
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-tick\{/u);
  // 高级展开后父菜单会超过上游 max-height，必须可滚且页脚吸底。
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-panel\{[^}]*overflow-y:auto/u);
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-foot\{position:sticky/u);
  // 触发器体量：32px 高，主副字号分层。
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-trigger\{height:32px/u);
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-trigeffort\{font-size:12\.5px\}/u);
});

test("模型菜单样式保证子菜单侧开且窄窗口可回折", () => {
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-wrap\{[^}]*flex-direction:row-reverse/u);
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-wrap\{[^}]*flex-wrap:wrap-reverse/u);
  assert.match(MODEL_MENU_STYLE, /\.dsh-ms-panel\{position:static!important/u);
});
