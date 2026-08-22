import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DSH_AP_COPY,
  DSH_AP_DEFAULTS,
  DSH_AP_LIMITS,
  DSH_APPEARANCE_MARKER,
  DSH_APPEARANCE_RUNTIME_SOURCE,
  DSH_APPEARANCE_STYLE,
  dshApAppearanceCssVariables,
  dshApCarouselIntervalMs,
  dshApDeriveGlassAlphas,
  dshApFormatBytesLabel,
  dshApNextWallpaperId,
  dshApNormalizeAppearanceConfig,
  dshApSchemeAssets,
  dshApSelectWallpaper,
  dshApValidateBackgroundFile,
  patchAppearanceThemeSource
} from "../lib/frontend/appearance-shell.mjs";

/** 干净锚点基线；缺失时跳过依赖 release 的用例，不让没装 DSH 的环境直接失败。 */
const BASELINE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai";
const baselineAvailable = existsSync(BASELINE);

/** 官方 Appearance row 注册段的最小 stub（与干净基线逐字节一致）。 */
const THEME_STUB = [
  "\t\tfunction apply(ctx) {",
  "\t\t\tconst theme = new ThemeRuntime(ctx, ctx.settingsScope.bind({ namespace: THEME_SETTINGS_NAMESPACE }));",
  '\t\t\tctx.slots.inject("settings.general.item", () => ctx.slots.register({',
  '\t\t\t\tname: "settings.general.item",',
  '\t\t\t\tid: "appearance",',
  "\t\t\t\torder: 10,",
  "\t\t\t\tstore,",
  "\t\t\t\tlocale: SETTINGS_NS,",
  "\t\t\t\tinject: injected",
  "\t\t\t}, AppearanceRow));",
  "\t\t}"
].join("\n");

function themeBaseline() {
  return readFileSync(path.join(BASELINE, "dsh-client-ui-theme", "lib", "client.js"), "utf8");
}

function frontendCss() {
  const dir = path.join(BASELINE, "dsh-web-frontend", "dist", "assets");
  const file = readFileSync(path.join(dir, "index-CSGf6Qzd.css"), "utf8");
  return file;
}

function assertSyntaxOk(name, source) {
  const dir = path.join(tmpdir(), "dsh-frontend-plan15-appearance");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  writeFileSync(file, source, "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/* ==================== 锚点契约 ==================== */

test("锚点在干净基线里唯一出现，补丁后语法可解析", (t) => {
  if (!baselineAvailable) {
    t.skip("缺少干净基线 release，跳过");
    return;
  }
  const source = themeBaseline();
  assert.equal(occurrences(source, "\t\tfunction apply(ctx) {"), 1);
  assert.equal(occurrences(source, '\t\t\t\tid: "appearance",'), 1);
  const patched = patchAppearanceThemeSource(source);
  assertSyntaxOk("theme-client-patched", patched);
  assert.ok(patched.includes(DSH_APPEARANCE_MARKER));
});

test("stub 也能过锚点：运行时插在 apply 之前，注册段追加在官方 row 之后", () => {
  const patched = patchAppearanceThemeSource(THEME_STUB);
  assertSyntaxOk("theme-stub-patched", `(() => {\nconst require = () => ({});\n${patched}\n})();`);
  const runtimeAt = patched.indexOf("DshAppearanceGlassRow");
  const applyAt = patched.indexOf("\t\tfunction apply(ctx) {");
  assert.ok(runtimeAt >= 0 && applyAt >= 0);
  assert.ok(runtimeAt < applyAt, "组件与 store 必须定义在 apply(ctx) 之前");
  assert.ok(patched.indexOf('id: "appearance",') < patched.indexOf('id: "dsh-appearance-glass",'));
  assert.equal(occurrences(patched, 'id: "dsh-appearance-glass"'), 1);
  assert.equal(occurrences(patched, "order: 11,"), 1);
  assert.ok(patched.includes("dshApInstall(ctx, theme);"));
});

test("重复注入与锚点漂移都必须直接失败，不做模糊替换", () => {
  const patched = patchAppearanceThemeSource(THEME_STUB);
  assert.throws(() => patchAppearanceThemeSource(patched), /拒绝重复注入/);
  assert.throws(() => patchAppearanceThemeSource(THEME_STUB.replace('id: "appearance",', 'id: "appearance-v2",')), /停止修改候选版本/);
  assert.throws(() => patchAppearanceThemeSource(THEME_STUB.replace("\t\tfunction apply(ctx) {", "\t\tfunction apply(context) {")), /停止修改候选版本/);
});

test("官方 AppearanceRow 的返回结构一个字都不改", () => {
  const patched = patchAppearanceThemeSource(THEME_STUB);
  assert.ok(patched.includes("}, AppearanceRow));"), "官方注册段必须原样保留");
  assert.equal(occurrences(patched, "}, AppearanceRow));"), 1);
  assert.ok(!patched.includes("AppearanceRow_module_css_default.group,\n\t\t\t\tchildren"), "不得改写官方 row 的 children");
});

/* ==================== 注入源码卫生 ==================== */

test("注入源码不含反引号与模板插值，避免破坏外层 String.raw", () => {
  assert.equal(DSH_APPEARANCE_RUNTIME_SOURCE.includes("`"), false);
  assert.equal(DSH_APPEARANCE_RUNTIME_SOURCE.includes("${"), false);
});

test("只 require 已声明的 peer 依赖，不碰 Node 专属模块与跨 feature UI 包", () => {
  const requires = [...DSH_APPEARANCE_RUNTIME_SOURCE.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requires)], ["react"]);
  for (const forbidden of ["node:fs", "node:path", "node:crypto", "dsh-client-ui-conversation", "dsh-client-ui-workspace", "dsh-client-ui-settings-models"]) {
    assert.equal(DSH_APPEARANCE_RUNTIME_SOURCE.includes(forbidden), false, `不应出现 ${forbidden}`);
  }
});

test("纯逻辑是同一份实现：注入源码里带着 toString 后的函数体", () => {
  for (const name of [
    "function dshApNormalizeAppearanceConfig",
    "function dshApDeriveGlassAlphas",
    "function dshApAppearanceCssVariables",
    "function dshApNextWallpaperId",
    "function dshApValidateBackgroundFile"
  ]) {
    assert.equal(occurrences(DSH_APPEARANCE_RUNTIME_SOURCE, name), 1, `${name} 应恰好注入一次`);
  }
});

/* ==================== 样式契约：命名空间与经典外观不被污染 ==================== */

test("新变量只落在 --dsh-appearance-* / --dsh-glass-* 两个命名空间", () => {
  const declared = [...new Set([...DSH_APPEARANCE_STYLE.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]))];
  const foreign = declared.filter((name) => !name.startsWith("--dsh-appearance-") && !name.startsWith("--dsh-glass-") && !name.startsWith("--dsw-"));
  assert.deepEqual(foreign, [], "除官方 --dsw-* 桥接外不得声明其它前缀的变量");
});

test("官方 token 桥接只发生在 glass 选择器里，经典外观逐字不改", () => {
  const glassStart = DSH_APPEARANCE_STYLE.indexOf('body[data-dsh-appearance="glass"]{');
  assert.ok(glassStart > 0);
  const beforeGlass = DSH_APPEARANCE_STYLE.slice(0, glassStart);
  for (const token of [
    "--dsw-alias-bg-base:",
    "--dsw-alias-bg-layer-1:",
    "--dsw-alias-bg-layer-2:",
    "--dsw-alias-bg-layer-3:",
    "--dsw-alias-bg-overlay:",
    "--dsw-alias-border-l2:",
    "--dsw-specific-sidebar-fill:",
    "--dsw-specific-input-major:"
  ]) {
    assert.equal(beforeGlass.includes(token), false, `${token} 不得在 glass 之外被改写`);
  }
});

test("派生基色只引用干净基线里真实存在的 --dsw-* token", (t) => {
  if (!baselineAvailable) {
    t.skip("缺少干净基线 release，跳过");
    return;
  }
  const css = frontendCss();
  const referenced = [...new Set([...DSH_APPEARANCE_STYLE.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))];
  assert.ok(referenced.length > 0);
  for (const token of referenced) {
    assert.ok(css.includes(`${token}:`), `${token} 在干净基线里不存在，不能引用`);
  }
});

test("glass 派生不形成循环引用：被桥接的 alias 不参与自身派生", () => {
  const bridged = ["--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3", "--dsw-alias-border-l2"];
  const surfaceBlock = DSH_APPEARANCE_STYLE.slice(
    DSH_APPEARANCE_STYLE.indexOf("--dsh-appearance-surface-panel:"),
    DSH_APPEARANCE_STYLE.indexOf("--dsw-alias-bg-base:transparent")
  );
  for (const token of bridged) {
    assert.equal(surfaceBlock.includes(`var(${token})`), false, `${token} 不得出现在 surface 派生里，否则循环引用会让整份变量失效`);
  }
});

test("暗色分支挂在官方 body[data-ds-dark-theme] 上，不自造暗色开关", () => {
  assert.ok(DSH_APPEARANCE_STYLE.includes("body[data-ds-dark-theme]{"));
  assert.equal(DSH_APPEARANCE_STYLE.includes("prefers-color-scheme"), false, "亮暗由官方 ThemeRuntime 决定，样式层不自己判断系统主题");
});

test("与 W3 工作区壳互通：磨砂下提供它读取的四个 --dsh-glass-* 别名", () => {
  for (const alias of ["--dsh-glass-panel-bg:", "--dsh-glass-input-bg:", "--dsh-glass-border:", "--dsh-glass-backdrop:"]) {
    assert.ok(DSH_APPEARANCE_STYLE.includes(alias), `${alias} 缺失会让工作区壳在磨砂下回落到经典实色`);
  }
});

test("不支持 color-mix 时有 @supports 降级，面板保持实色而不是变全透明", () => {
  assert.ok(DSH_APPEARANCE_STYLE.includes("@supports not (color: color-mix(in srgb, red 50%, transparent))"));
});

/* ==================== 变量映射与三层 alpha ==================== */

test("经典外观的变量集合是中性值，磨砂参数不泄漏", () => {
  const vars = dshApAppearanceCssVariables(null);
  assert.equal(vars["--dsh-appearance-mode"], "classic");
  assert.equal(vars["--dsh-glass-blur"], "0px");
  assert.equal(vars["--dsh-appearance-blur-panel"], "none");
  assert.equal(vars["--dsh-appearance-blur-code"], "none");
  for (const key of ["--dsh-glass-panel-alpha", "--dsh-glass-code-alpha", "--dsh-glass-input-alpha", "--dsh-glass-solid-alpha", "--dsh-glass-veil-alpha"]) {
    assert.equal(vars[key], "1", `${key} 在经典外观必须是 1`);
  }
});

test("三层 alpha 默认命中 0.72 / 0.42 / 0.25 / 0.97，叶子模糊跟随总开关", () => {
  const alphas = dshApDeriveGlassAlphas(DSH_AP_DEFAULTS.glass.panelAlpha);
  assert.deepEqual(alphas, { panel: 0.72, code: 0.42, input: 0.25, solid: 0.97 });
  const vars = dshApAppearanceCssVariables({ appearanceMode: "glass" });
  assert.equal(vars["--dsh-glass-panel-alpha"], "0.72");
  assert.equal(vars["--dsh-glass-code-alpha"], "0.42");
  assert.equal(vars["--dsh-glass-input-alpha"], "0.25");
  assert.equal(vars["--dsh-glass-solid-alpha"], "0.97");
  assert.equal(vars["--dsh-glass-blur-code"], "var(--dsh-glass-blur)");
  assert.equal(vars["--dsh-appearance-blur-code"], "blur(var(--dsh-glass-blur-code))");
});

test("面板 alpha 变化时三层一起动，浮层始终近不透明", () => {
  const low = dshApDeriveGlassAlphas(0.5);
  assert.ok(low.code < 0.42 && low.input < 0.25, "面板变透时叶子和输入必须跟着变透");
  assert.equal(low.solid, DSH_AP_LIMITS.solidAlpha);
  const clamped = dshApDeriveGlassAlphas(0);
  assert.equal(clamped.panel, DSH_AP_LIMITS.panelAlpha.min, "面板 alpha 有下限，避免正文完全不可读");
});

test("模糊为 0 时不产生 blur(0px)，避免白付一层合成开销", () => {
  const vars = dshApAppearanceCssVariables({ appearanceMode: "glass", glass: { blurPx: 0 } });
  assert.equal(vars["--dsh-glass-blur"], "0px");
  assert.equal(vars["--dsh-appearance-blur-panel"], "none");
  assert.equal(vars["--dsh-appearance-blur-code"], "none");
});

/* ==================== 配置规范化 ==================== */

test("坏值回落到默认而不是变 0", () => {
  const config = dshApNormalizeAppearanceConfig({
    appearanceMode: "frosted",
    glass: { blurPx: "abc", panelAlpha: null, veilAlpha: 99, borderAlpha: -1, accent: 42 },
    wallpapers: { light: { mode: "spin", fit: "stretch", intervalSec: 1 } },
    assets: "nope"
  });
  assert.equal(config.appearanceMode, "classic");
  assert.equal(config.glass.blurPx, DSH_AP_DEFAULTS.glass.blurPx);
  assert.equal(config.glass.panelAlpha, DSH_AP_DEFAULTS.glass.panelAlpha);
  assert.equal(config.glass.veilAlpha, DSH_AP_LIMITS.veilAlpha.max);
  assert.equal(config.glass.borderAlpha, DSH_AP_LIMITS.borderAlpha.min);
  assert.equal(config.glass.accent, "");
  assert.equal(config.wallpapers.light.mode, "static");
  assert.equal(config.wallpapers.light.fit, "cover");
  assert.equal(config.wallpapers.light.intervalSec, DSH_AP_LIMITS.minIntervalSeconds);
  assert.deepEqual(config.assets, []);
});

test("selectedId 指向已不存在的资源时清空，界面不会去显示一张打不开的背景", () => {
  const config = dshApNormalizeAppearanceConfig({
    assets: [{ id: "a", scheme: "both", mime: "image/png", bytes: 10 }],
    wallpapers: { light: { selectedId: "missing" }, dark: { selectedId: "a" } }
  });
  assert.equal(config.wallpapers.light.selectedId, null);
  assert.equal(config.wallpapers.dark.selectedId, "a");
});

test("资源列表去重，未知 mime 与 scheme 收敛到安全值", () => {
  const config = dshApNormalizeAppearanceConfig({
    assets: [
      { id: "a", mime: "image/gif", scheme: "auto", bytes: 1 },
      { id: "a", mime: "image/png", scheme: "dark", bytes: 2 },
      { id: "", mime: "image/png" },
      null
    ]
  });
  assert.equal(config.assets.length, 1);
  assert.equal(config.assets[0].mime, "image/png");
  assert.equal(config.assets[0].scheme, "both");
  assert.equal(config.assets[0].role, "background");
});

/* ==================== 亮暗分组与轮播 ==================== */

const CAROUSEL_CONFIG = {
  appearanceMode: "glass",
  assets: [
    { id: "l1", scheme: "light", mime: "image/png", bytes: 1 },
    { id: "l2", scheme: "light", mime: "image/png", bytes: 1 },
    { id: "d1", scheme: "dark", mime: "image/png", bytes: 1 },
    { id: "any", scheme: "both", mime: "image/png", bytes: 1 }
  ],
  wallpapers: {
    light: { selectedId: "l1", mode: "sequential", fit: "cover", intervalSec: 30 },
    dark: { selectedId: "d1", mode: "static", fit: "cover", intervalSec: 30 }
  }
};

test("亮暗分组各看各的资源，通用图两边都算", () => {
  assert.deepEqual(dshApSchemeAssets(CAROUSEL_CONFIG, "light").map((asset) => asset.id), ["l1", "l2", "any"]);
  assert.deepEqual(dshApSchemeAssets(CAROUSEL_CONFIG, "dark").map((asset) => asset.id), ["d1", "any"]);
  assert.equal(dshApSelectWallpaper(CAROUSEL_CONFIG, "light").id, "l1");
  assert.equal(dshApSelectWallpaper(CAROUSEL_CONFIG, "dark").id, "d1");
  assert.equal(dshApSelectWallpaper({ assets: [] }, "light"), null);
});

test("静态模式与资源不足时不切换，返回 null 表示不该动状态", () => {
  assert.equal(dshApNextWallpaperId(CAROUSEL_CONFIG, "dark", 0.5), null, "dark 是 static");
  const single = { appearanceMode: "glass", assets: [{ id: "only", scheme: "both", mime: "image/png", bytes: 1 }], wallpapers: { light: { mode: "sequential" } } };
  assert.equal(dshApNextWallpaperId(single, "light", 0.5), null, "只有一张时不该轮播");
});

test("顺序轮播按分组内顺序绕回", () => {
  assert.equal(dshApNextWallpaperId(CAROUSEL_CONFIG, "light", 0), "l2");
  const atTail = { ...CAROUSEL_CONFIG, wallpapers: { ...CAROUSEL_CONFIG.wallpapers, light: { ...CAROUSEL_CONFIG.wallpapers.light, selectedId: "any" } } };
  assert.equal(dshApNextWallpaperId(atTail, "light", 0), "l1");
});

test("随机轮播不会重复当前那张", () => {
  const random = { ...CAROUSEL_CONFIG, wallpapers: { ...CAROUSEL_CONFIG.wallpapers, light: { ...CAROUSEL_CONFIG.wallpapers.light, mode: "random" } } };
  for (const ratio of [0, 0.2, 0.49, 0.5, 0.9, 0.999999]) {
    const next = dshApNextWallpaperId(random, "light", ratio);
    assert.notEqual(next, "l1", `ratio=${ratio} 时不应选回当前图`);
    assert.ok(["l2", "any"].includes(next));
  }
});

test("轮播间隔下限 10 秒，预设值原样透传", () => {
  assert.equal(dshApCarouselIntervalMs(1), 10000);
  assert.equal(dshApCarouselIntervalMs(-5), 10000);
  assert.equal(dshApCarouselIntervalMs("abc"), 10000);
  for (const preset of DSH_AP_LIMITS.intervalPresets) {
    assert.equal(dshApCarouselIntervalMs(preset), preset * 1000);
  }
});

/* ==================== 背景图软校验 ==================== */

test("背景图校验：格式、单张上限、总量上限各自给出中文原因", () => {
  assert.deepEqual(dshApValidateBackgroundFile({ type: "image/png", size: 1024 }, 0), { ok: true, code: "ok", message: "" });
  assert.equal(dshApValidateBackgroundFile({ type: "image/avif", size: 10 }, 0).code, "mime");
  assert.equal(dshApValidateBackgroundFile({ type: "image/avif", size: 10 }, 0).message, DSH_AP_COPY.rejectMime);
  assert.equal(dshApValidateBackgroundFile({ type: "image/png", size: DSH_AP_LIMITS.maxAssetBytes + 1 }, 0).code, "size");
  assert.equal(dshApValidateBackgroundFile({ type: "image/png", size: 1024 }, DSH_AP_LIMITS.maxTotalBytes).code, "total");
});

test("字节标签走真实换算，不吞小数", () => {
  assert.equal(dshApFormatBytesLabel(0), "0 B");
  assert.equal(dshApFormatBytesLabel(2048), "2 KB");
  assert.equal(dshApFormatBytesLabel(1024 * 1024 * 3.25), "3.3 MB");
});

/* ==================== 未接后端的能力必须显式禁用 ==================== */

test("保存到 DSH 设置按钮使用本地持久层并给出结果提示", () => {
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes("function dshApSaveConfig()"));
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes("onClick: () => api.save()"));
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes("save: () => dshApSaveConfig()"));
  assert.ok(DSH_AP_COPY.saveOk.includes("已保存"));
});

test("草稿只写一个小 JSON key，图片本体走 IndexedDB", () => {
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes('"dsh.appearance.v1.draft"'));
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes('"dsh-appearance-v1"'));
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes('"draftBackgroundAssets"'));
  assert.equal(DSH_APPEARANCE_RUNTIME_SOURCE.includes("readAsDataURL"), false, "不得把大图转 data URL 塞进 localStorage");
});

test("自动轮播不写草稿，只有手动操作才持久化", () => {
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes('"carousel", false)'), "轮播必须以 persist=false 调用");
  assert.ok(DSH_APPEARANCE_RUNTIME_SOURCE.includes('"settings-wallpaper-select", true)'), "手动选图必须持久化");
});
