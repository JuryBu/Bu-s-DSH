/**
 * Plan_15 W1/W2 · 外观扩展（经典 / 磨砂玻璃 + 磨砂参数 + 背景图与轮播 + 设置页入口）。
 *
 * 目标 bundle：`@deepseek-ai/dsh-client-ui-theme/lib/client.js`。
 *
 * 边界（`plans_windsurf/frontend-spec.md` P15-1 / P15-2 / P15-3 / P15-4 / P15-11）：
 *
 * - 外观模式（`classic` / `glass`）与官方颜色（`light` / `dark` / `system`）是**正交两个维度**，
 *   磨砂**不是**新的 theme id：颜色仍由官方 `ThemeRuntime.setTheme` 拥有，外观走 `body[data-dsh-appearance]`。
 * - **不替换官方 `AppearanceRow` 的返回结构**，只用 `ctx.slots.inject` 追加一个 `id:"dsh-appearance-glass"`、
 *   `order:11` 的独立 row（P15-11.1 / R3 Q70）。
 * - 亮暗同步走 `ctx.on("theme/change", ...)`，`MutationObserver` 不作为主路径（P15-11.3 / R3 Q72）。
 * - 新变量只落在 `--dsh-appearance-*` / `--dsh-glass-*` 两个命名空间，默认值从真实 `--dsw-*` token 派生；
 *   经典外观下所有派生值都等于官方原值，**不污染经典外观**。
 * - 背景草稿：图片本体进 IndexedDB（`dsh-appearance-v1` / `draftBackgroundAssets`），
 *   localStorage 只存 `dsh.appearance.v1.draft` 这一份小 JSON（P15-4.1 / R3 Q69）。
 * - 只复用该 bundle 已有的局部变量与 peer 依赖 `react`，不跨 feature UI 包 require，
 *   不碰 `fs` / `path` / `crypto` 这类 Node 专属模块（R3 Q71）。
 *
 * 本文件只导出补丁函数与可单测的纯逻辑；`transforms.mjs` / `transforms-frontend.mjs` /
 * `Build-CandidateRelease.mjs` 的组合由 Codex 负责，WSF 不碰。
 */

import { assertNotAlreadyPatched, replaceExactlyOnce } from "./replace-exactly.mjs";

/** 注入后一定存在的标记，用于拦住对已打补丁候选的重复注入。 */
export const DSH_APPEARANCE_MARKER = "DshAppearanceShell";

/**
 * UI 软限制与派生比例。
 *
 * `codeRatio` / `inputRatio` 是「叶子层 / 输入层相对容器层」的比例，来自 P15-3.1 的
 * 三层 alpha 建议值：容器 0.72 → 叶子 0.42 → 输入 0.25。
 * 0.72 × 0.5833 ≈ 0.42、0.72 × 0.3472 ≈ 0.25，所以默认面板 alpha 下三层恰好落在建议值上；
 * 用户调面板 alpha 时三层按比例一起动，不会退化成「只有一个面板 alpha 在起作用」。
 */
export const DSH_AP_LIMITS = Object.freeze({
  maxAssetBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  mimeTypes: ["image/png", "image/jpeg", "image/webp"],
  minIntervalSeconds: 10,
  intervalPresets: [10, 30, 60, 300],
  blurPx: { min: 0, max: 40 },
  panelAlpha: { min: 0.35, max: 1 },
  veilAlpha: { min: 0, max: 1 },
  borderAlpha: { min: 0, max: 0.4 },
  codeRatio: 0.5833,
  inputRatio: 0.3472,
  solidAlpha: 0.97,
  draftAssetTtlMs: 7 * 24 * 60 * 60 * 1000
});

/** 草稿配置默认值。结构对齐 `ANSWERS_Plan15.md` Q7 与 R2 Q32 的 `DshAppearanceAsset`。 */
export const DSH_AP_DEFAULTS = Object.freeze({
  version: 1,
  appearanceMode: "classic",
  glass: { blurPx: 18, panelAlpha: 0.72, veilAlpha: 0.55, borderAlpha: 0.14, accent: "" },
  wallpapers: {
    light: { selectedId: null, mode: "static", fit: "cover", intervalSec: 30 },
    dark: { selectedId: null, mode: "static", fit: "cover", intervalSec: 30 }
  },
  assets: []
});

/** 全部用户可见文案。中文优先，集中一处，不引入 i18n 依赖（P15-10）。 */
export const DSH_AP_COPY = Object.freeze({
  title: "外观扩展（DSH）",
  subtitle: "经典与磨砂玻璃是独立维度，与上面的浅色 / 深色 / 跟随系统同时生效。当前修改保存为本地草稿。",
  modeClassic: "经典",
  modeGlass: "磨砂玻璃",
  glassSection: "磨砂参数",
  blur: "背景模糊",
  panelAlpha: "面板不透明度",
  veilAlpha: "背景遮罩不透明度",
  borderAlpha: "边框亮度",
  derivedTitle: "三层不透明度（由面板不透明度派生）",
  derivedPanel: "容器层",
  derivedCode: "叶子层",
  derivedInput: "输入层",
  derivedSolid: "浮层",
  derivedBlurNote: "叶子模糊跟随总开关：--dsh-glass-blur-code: var(--dsh-glass-blur)",
  classicHint: "切换到「磨砂玻璃」后这些参数才会生效；经典外观完全沿用官方配色。",
  backgroundSection: "背景图",
  backgroundScopeLight: "当前编辑：浅色分组",
  backgroundScopeDark: "当前编辑：深色分组",
  pick: "选择图片",
  fit: "适配方式",
  fitCover: "填满",
  fitContain: "完整显示",
  fitRepeat: "平铺",
  playback: "播放方式",
  playbackStatic: "静态",
  playbackSequential: "轮播（顺序）",
  playbackRandom: "轮播（随机）",
  interval: "轮播间隔",
  intervalSuffix: "秒",
  intervalFloor: "轮播间隔下限 10 秒；设置面板打开、页面隐藏或输入框聚焦时自动暂停。",
  assetsEmpty: "还没有背景图。支持 png / jpeg / webp，单张最大 20 MB，总量最大 100 MB。",
  assetUse: "用于当前",
  assetInUse: "已选用",
  assetRemove: "删除",
  assetSchemeLight: "浅色",
  assetSchemeDark: "深色",
  assetSchemeBoth: "通用",
  backgroundUnavailable: "背景图不可用",
  storageIndexedDb: "背景草稿存放在 IndexedDB（dsh-appearance-v1），刷新后仍在。",
  storageFallback: "IndexedDB 打开失败，已降级为临时对象 URL：刷新后背景草稿会丢失。",
  storageUnknown: "正在检查背景草稿存储……",
  draftPersistFailed: "草稿写入 localStorage 失败，本次修改只在当前页面生效。",
  saveDisabled: "保存到 DSH 设置",
  saveDisabledReason: "保存当前外观到 DSH 本地设置，背景资源仍由 IndexedDB 保存",
  saveOk: "已保存到 DSH 本地设置",
  reset: "恢复默认",
  rejectMime: "格式不支持，只接受 png / jpeg / webp",
  rejectSize: "单张超过 20 MB",
  rejectTotal: "总量会超过 100 MB"
});

/**
 * 数值钳制：非有限值回落到 fallback，而不是悄悄变 0 或被钳到区间下限。
 *
 * 这里刻意不用 `Number(value)` 兜全部类型：`Number(null)` 是 0、`Number(true)` 是 1，
 * 会把「这个字段根本没填」误判成「用户填了一个极端值」，进而钳到 min。
 * 只接受真数字和非空数字字符串，其余一律当缺值。
 */
export function dshApClampNumber(value, min, max, fallback) {
  const num = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

/** alpha 统一保留两位小数，避免 0.4199760000000001 这种值写进 CSS 变量。 */
export function dshApRoundAlpha(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 三层 alpha 体系（P15-3.1）。
 *
 * 只给一个面板 alpha 会踩 Synapse 记录的真实坑：面板 0.75 里面再叠 0.88 的代码块，
 * 壁纸实际透出率只剩约 3%，用户会反馈「开了磨砂但一点都不透」。
 * 浮层固定近不透明 0.97，因为半透明菜单会透出底层文字导致不可读（Synapse 踩坑三）。
 */
export function dshApDeriveGlassAlphas(panelAlpha) {
  const panel = dshApRoundAlpha(
    dshApClampNumber(panelAlpha, DSH_AP_LIMITS.panelAlpha.min, DSH_AP_LIMITS.panelAlpha.max, DSH_AP_DEFAULTS.glass.panelAlpha)
  );
  return {
    panel: panel,
    code: dshApRoundAlpha(panel * DSH_AP_LIMITS.codeRatio),
    input: dshApRoundAlpha(panel * DSH_AP_LIMITS.inputRatio),
    solid: DSH_AP_LIMITS.solidAlpha
  };
}

/** 单个背景资源元数据规范化；图片本体不在这里（只存 IndexedDB）。 */
export function dshApNormalizeAsset(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
  if (id === null) return null;
  const mime = DSH_AP_LIMITS.mimeTypes.indexOf(raw.mime) >= 0 ? raw.mime : "image/png";
  const scheme = raw.scheme === "light" || raw.scheme === "dark" ? raw.scheme : "both";
  const asset = {
    id: id,
    fileName: typeof raw.fileName === "string" ? raw.fileName : id,
    mime: mime,
    bytes: dshApClampNumber(raw.bytes, 0, DSH_AP_LIMITS.maxTotalBytes, 0),
    scheme: scheme,
    role: "background",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString()
  };
  if (Number.isFinite(raw.width) && raw.width > 0) asset.width = Math.round(raw.width);
  if (Number.isFinite(raw.height) && raw.height > 0) asset.height = Math.round(raw.height);
  return asset;
}

/**
 * 草稿配置规范化。
 *
 * 同时负责一件重要的事：**selectedId 指向已不存在的资源时直接清空**，
 * 这样图片 blob 丢了以后界面不会去显示一张不存在的背景。
 */
export function dshApNormalizeAppearanceConfig(raw) {
  const input = raw === null || typeof raw !== "object" ? {} : raw;
  const glassIn = input.glass === null || typeof input.glass !== "object" ? {} : input.glass;
  const wallIn = input.wallpapers === null || typeof input.wallpapers !== "object" ? {} : input.wallpapers;
  const assets = [];
  const seen = {};
  if (Array.isArray(input.assets)) {
    for (const candidate of input.assets) {
      const asset = dshApNormalizeAsset(candidate);
      if (asset === null) continue;
      if (seen[asset.id] === true) continue;
      seen[asset.id] = true;
      assets.push(asset);
    }
  }
  const wallpapers = {};
  for (const scheme of ["light", "dark"]) {
    const entry = wallIn[scheme] === null || typeof wallIn[scheme] !== "object" ? {} : wallIn[scheme];
    const selected = typeof entry.selectedId === "string" && seen[entry.selectedId] === true ? entry.selectedId : null;
    wallpapers[scheme] = {
      selectedId: selected,
      mode: entry.mode === "sequential" || entry.mode === "random" ? entry.mode : "static",
      fit: entry.fit === "contain" || entry.fit === "repeat" ? entry.fit : "cover",
      intervalSec: Math.round(
        dshApClampNumber(entry.intervalSec, DSH_AP_LIMITS.minIntervalSeconds, 3600, DSH_AP_DEFAULTS.wallpapers[scheme].intervalSec)
      )
    };
  }
  return {
    version: 1,
    appearanceMode: input.appearanceMode === "glass" ? "glass" : "classic",
    glass: {
      blurPx: Math.round(
        dshApClampNumber(glassIn.blurPx, DSH_AP_LIMITS.blurPx.min, DSH_AP_LIMITS.blurPx.max, DSH_AP_DEFAULTS.glass.blurPx)
      ),
      panelAlpha: dshApRoundAlpha(
        dshApClampNumber(glassIn.panelAlpha, DSH_AP_LIMITS.panelAlpha.min, DSH_AP_LIMITS.panelAlpha.max, DSH_AP_DEFAULTS.glass.panelAlpha)
      ),
      veilAlpha: dshApRoundAlpha(
        dshApClampNumber(glassIn.veilAlpha, DSH_AP_LIMITS.veilAlpha.min, DSH_AP_LIMITS.veilAlpha.max, DSH_AP_DEFAULTS.glass.veilAlpha)
      ),
      borderAlpha: dshApRoundAlpha(
        dshApClampNumber(glassIn.borderAlpha, DSH_AP_LIMITS.borderAlpha.min, DSH_AP_LIMITS.borderAlpha.max, DSH_AP_DEFAULTS.glass.borderAlpha)
      ),
      accent: typeof glassIn.accent === "string" ? glassIn.accent : ""
    },
    wallpapers: wallpapers,
    assets: assets
  };
}

/**
 * 写到 `body` 上的 CSS 变量。
 *
 * 经典外观返回的是「等于官方原值」的中性集合（alpha 全 1、模糊 none），
 * 所以即使补丁常驻，经典外观也不会被磨砂参数污染。
 */
export function dshApAppearanceCssVariables(config) {
  const cfg = dshApNormalizeAppearanceConfig(config);
  const glass = cfg.appearanceMode === "glass";
  const alphas = dshApDeriveGlassAlphas(cfg.glass.panelAlpha);
  const blur = glass ? cfg.glass.blurPx : 0;
  return {
    "--dsh-appearance-mode": cfg.appearanceMode,
    "--dsh-glass-blur": blur + "px",
    "--dsh-glass-blur-code": "var(--dsh-glass-blur)",
    "--dsh-glass-panel-alpha": glass ? String(alphas.panel) : "1",
    "--dsh-glass-code-alpha": glass ? String(alphas.code) : "1",
    "--dsh-glass-input-alpha": glass ? String(alphas.input) : "1",
    "--dsh-glass-solid-alpha": glass ? String(alphas.solid) : "1",
    "--dsh-glass-veil-alpha": glass ? String(cfg.glass.veilAlpha) : "1",
    "--dsh-glass-border-alpha": glass ? String(cfg.glass.borderAlpha) : "1",
    "--dsh-glass-accent": cfg.glass.accent === "" ? "var(--dsw-static-deepseek-500)" : cfg.glass.accent,
    "--dsh-appearance-blur-panel": glass && blur > 0 ? "blur(" + blur + "px)" : "none",
    "--dsh-appearance-blur-code": glass && blur > 0 ? "blur(var(--dsh-glass-blur-code))" : "none"
  };
}

/** 某个亮暗分组下可用的背景资源（`both` 两边都算）。 */
export function dshApSchemeAssets(config, colorScheme) {
  const cfg = dshApNormalizeAppearanceConfig(config);
  const scheme = colorScheme === "dark" ? "dark" : "light";
  return cfg.assets.filter((asset) => asset.scheme === "both" || asset.scheme === scheme);
}

/** 当前应该显示的背景资源；没有选中时取该分组第一张，没有可用资源返回 null。 */
export function dshApSelectWallpaper(config, colorScheme) {
  const cfg = dshApNormalizeAppearanceConfig(config);
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const list = dshApSchemeAssets(cfg, scheme);
  if (list.length === 0) return null;
  const selectedId = cfg.wallpapers[scheme].selectedId;
  if (selectedId !== null) {
    const hit = list.find((asset) => asset.id === selectedId);
    if (hit !== undefined) return hit;
  }
  return list[0];
}

/**
 * 轮播的下一张。
 *
 * 返回 null 表示「不该切换」（静态模式、可切换资源不足）——调用方据此不写任何状态，
 * 而不是切到一张不存在的图。随机模式在有 2 张以上时保证不重复当前那张。
 */
export function dshApNextWallpaperId(config, colorScheme, randomValue) {
  const cfg = dshApNormalizeAppearanceConfig(config);
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const entry = cfg.wallpapers[scheme];
  if (entry.mode === "static") return null;
  const list = dshApSchemeAssets(cfg, scheme);
  if (list.length < 2) return null;
  const current = dshApSelectWallpaper(cfg, scheme);
  const index = current === null ? -1 : list.findIndex((asset) => asset.id === current.id);
  if (entry.mode === "random") {
    const ratio = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 0.999999) : 0;
    const pick = Math.floor(ratio * (list.length - 1));
    const shifted = pick >= index ? pick + 1 : pick;
    return list[shifted % list.length].id;
  }
  return list[(index + 1 + list.length) % list.length].id;
}

/** 轮播间隔毫秒数，下限 10 秒（与 Synapse 的 `Math.max(10, ...)` 同口径）。 */
export function dshApCarouselIntervalMs(intervalSec) {
  const seconds = dshApClampNumber(intervalSec, 0, 3600, DSH_AP_LIMITS.minIntervalSeconds);
  return Math.max(DSH_AP_LIMITS.minIntervalSeconds, Math.round(seconds)) * 1000;
}

/** 背景图前端软校验。只做提示，硬限制由后端确认（R2 Q34）。 */
export function dshApValidateBackgroundFile(file, existingTotalBytes) {
  const mime = file === null || file === undefined ? "" : String(file.type || "");
  const bytes = file === null || file === undefined ? 0 : Number(file.size || 0);
  if (DSH_AP_LIMITS.mimeTypes.indexOf(mime) < 0) return { ok: false, code: "mime", message: DSH_AP_COPY.rejectMime };
  if (bytes > DSH_AP_LIMITS.maxAssetBytes) return { ok: false, code: "size", message: DSH_AP_COPY.rejectSize };
  const total = Number.isFinite(existingTotalBytes) ? existingTotalBytes : 0;
  if (total + bytes > DSH_AP_LIMITS.maxTotalBytes) return { ok: false, code: "total", message: DSH_AP_COPY.rejectTotal };
  return { ok: true, code: "ok", message: "" };
}

/** 字节数的人类可读标签。 */
export function dshApFormatBytesLabel(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0;
  if (value >= 1024 * 1024) return Math.round((value / (1024 * 1024)) * 10) / 10 + " MB";
  if (value >= 1024) return Math.round(value / 1024) + " KB";
  return value + " B";
}

/**
 * 外观样式表。
 *
 * 两个关键设计决定（已写进交付报告，需回写 `frontend-spec.md`）：
 *
 * 1. **派生基色取自真实 static token，不硬编码颜色，也不做 JS 快照。**
 *    干净基线里 `--dsw-alias-bg-layer-1` 就等于 `--dsw-static-neutral-bluish-00`（浅）/ `-875`（深），
 *    所以直接引用同一批 static token，既拿到真实值，又不会形成
 *    「alias → 派生 → 再改写同一个 alias」的循环引用（循环会让整份变量失效，面板会变全透明）。
 * 2. **磨砂的模糊做在背景层上，不给每个官方面板挂 `backdrop-filter`。**
 *    壁纸本身先模糊，半透明面板透出的就是已经模糊过的图，视觉等价磨砂玻璃，
 *    却天然避开 Synapse 踩坑二（多层 `backdrop-filter` 合成导致卡顿与截图超时）。
 *    `--dsh-appearance-blur-panel` / `--dsh-appearance-blur-code` 仍然导出，供 W3 / W4 自己的新面板按需使用。
 *
 * 官方 token 桥接只在 `body[data-dsh-appearance="glass"]` 下发生，经典外观逐字节不变。
 * 桥接名单来自干净基线的真实用法：布局 frame 用 `--dsw-alias-bg-base`、
 * 侧栏用 `--dsw-specific-sidebar-fill`、输入框用 `--dsw-specific-input-major`、
 * 菜单 `--dsw-specific-menu` 本身就指向 `--dsw-alias-bg-layer-3`（所以浮层 0.97 自动覆盖菜单）。
 */
export const DSH_APPEARANCE_STYLE = String.raw`
body{
	--dsh-appearance-mode:classic;
	--dsh-glass-blur:0px;
	--dsh-glass-blur-code:var(--dsh-glass-blur);
	--dsh-glass-panel-alpha:1;
	--dsh-glass-code-alpha:1;
	--dsh-glass-input-alpha:1;
	--dsh-glass-solid-alpha:1;
	--dsh-glass-veil-alpha:1;
	--dsh-glass-border-alpha:1;
	--dsh-glass-accent:var(--dsw-static-deepseek-500);
	--dsh-appearance-blur-panel:none;
	--dsh-appearance-blur-code:none;
	--dsh-appearance-base-panel:var(--dsw-static-neutral-bluish-00);
	--dsh-appearance-base-code:var(--dsw-static-neutral-bluish-00);
	--dsh-appearance-base-input:var(--dsw-static-neutral-bluish-00);
	--dsh-appearance-base-solid:var(--dsw-static-neutral-bluish-00);
	--dsh-appearance-base-canvas:var(--dsw-static-neutral-bluish-00);
	--dsh-appearance-base-sidebar:var(--dsw-static-neutral-bluish-50);
	--dsh-appearance-base-ink:var(--dsw-static-neutral-bluish-1000);
}
body[data-ds-dark-theme]{
	--dsh-appearance-base-panel:var(--dsw-static-neutral-bluish-875);
	--dsh-appearance-base-code:var(--dsw-static-neutral-bluish-850);
	--dsh-appearance-base-input:var(--dsw-static-neutral-bluish-850);
	--dsh-appearance-base-solid:var(--dsw-static-neutral-bluish-800);
	--dsh-appearance-base-canvas:var(--dsw-static-neutral-bluish-950);
	--dsh-appearance-base-sidebar:var(--dsw-static-neutral-bluish-900);
	--dsh-appearance-base-ink:var(--dsw-static-neutral-bluish-50);
}
body[data-dsh-appearance="glass"]{
	--dsh-appearance-surface-panel:color-mix(in srgb, var(--dsh-appearance-base-panel) calc(var(--dsh-glass-panel-alpha) * 100%), transparent);
	--dsh-appearance-surface-sidebar:color-mix(in srgb, var(--dsh-appearance-base-sidebar) calc(var(--dsh-glass-panel-alpha) * 100%), transparent);
	--dsh-appearance-surface-code:color-mix(in srgb, var(--dsh-appearance-base-code) calc(var(--dsh-glass-code-alpha) * 100%), transparent);
	--dsh-appearance-surface-input:color-mix(in srgb, var(--dsh-appearance-base-input) calc(var(--dsh-glass-input-alpha) * 100%), transparent);
	--dsh-appearance-surface-solid:color-mix(in srgb, var(--dsh-appearance-base-solid) calc(var(--dsh-glass-solid-alpha) * 100%), transparent);
	--dsh-appearance-surface-veil:color-mix(in srgb, var(--dsh-appearance-base-canvas) calc(var(--dsh-glass-veil-alpha) * 100%), transparent);
	--dsh-appearance-surface-border:color-mix(in srgb, var(--dsh-appearance-base-ink) calc(var(--dsh-glass-border-alpha) * 100%), transparent);
	--dsw-alias-bg-base:transparent;
	--dsw-alias-bg-layer-1:var(--dsh-appearance-surface-panel);
	--dsw-alias-bg-layer-2:var(--dsh-appearance-surface-code);
	--dsw-alias-bg-layer-3:var(--dsh-appearance-surface-solid);
	--dsw-alias-bg-overlay:var(--dsh-appearance-surface-solid);
	--dsw-specific-sidebar-fill:var(--dsh-appearance-surface-sidebar);
	--dsw-specific-input-major:var(--dsh-appearance-surface-input);
	--dsw-alias-border-l2:var(--dsh-appearance-surface-border);
	--dsh-glass-panel-bg:var(--dsh-appearance-surface-panel);
	--dsh-glass-input-bg:var(--dsh-appearance-surface-input);
	--dsh-glass-border:var(--dsh-appearance-surface-border);
	--dsh-glass-backdrop:var(--dsh-appearance-blur-panel);
	background:transparent;
}
@supports not (color: color-mix(in srgb, red 50%, transparent)){
	body[data-dsh-appearance="glass"]{
		--dsw-alias-bg-base:var(--dsh-appearance-base-canvas);
		--dsw-alias-bg-layer-1:var(--dsh-appearance-base-panel);
		--dsw-alias-bg-layer-2:var(--dsh-appearance-base-code);
		--dsw-alias-bg-layer-3:var(--dsh-appearance-base-solid);
		--dsw-alias-bg-overlay:var(--dsh-appearance-base-solid);
		--dsw-specific-sidebar-fill:var(--dsh-appearance-base-sidebar);
		--dsw-specific-input-major:var(--dsh-appearance-base-input);
		--dsh-glass-panel-bg:var(--dsh-appearance-base-panel);
		--dsh-glass-input-bg:var(--dsh-appearance-base-input);
		--dsh-glass-backdrop:none;
	}
}
.dsh-appearance-background{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;display:none}
body[data-dsh-appearance="glass"] .dsh-appearance-background[data-dsh-has-image="true"]{display:block}
.dsh-appearance-background-frame{position:absolute;inset:0;background-position:center;background-repeat:no-repeat;transform:scale(1.04);filter:blur(var(--dsh-glass-blur));opacity:0;transition:opacity 420ms ease}
.dsh-appearance-background-frame[data-dsh-active="true"]{opacity:1}
.dsh-appearance-background-veil{position:absolute;inset:0;background:var(--dsh-appearance-surface-veil)}
.dsh-appearance-background-fallback{position:absolute;inset:0;display:none;place-items:center;background:linear-gradient(135deg,var(--dsh-appearance-base-panel),var(--dsh-appearance-base-solid));color:var(--dsw-alias-label-caption);font-size:12px}
.dsh-appearance-background[data-dsh-image-error="true"] .dsh-appearance-background-fallback{display:grid}
.dsh-appearance-background[data-dsh-image-error="true"] .dsh-appearance-background-frame{opacity:0}
@media (prefers-reduced-motion:reduce){.dsh-appearance-background-frame{transition:none}}
.dsh-ap-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-ap-block{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-ap-legend{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;font-weight:500}
.dsh-ap-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 16px}
.dsh-ap-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-ap-field-head{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-ap-field-head span[data-dsh-value]{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-ap-field input[type="range"]{width:100%;margin:0;height:16px;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer}
.dsh-ap-field input[type="range"]::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--dsw-alias-bg-skeleton)}
.dsh-ap-field input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;margin-top:-4px;border-radius:50%;border:none;background:var(--dsh-glass-accent)}
.dsh-ap-field input[type="range"]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px color-mix(in srgb, var(--dsh-glass-accent) 32%, transparent)}
body[data-ds-dark-theme] .dsh-ap-select,body[data-ds-dark-theme] select.dsh-ap-mini{color-scheme:dark}
.dsh-ap-tags{display:flex;flex-wrap:wrap;gap:6px}
.dsh-ap-tag{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-ap-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-ap-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:20px;padding:4px 12px;border-radius:999px;cursor:pointer}
.dsh-ap-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ap-btn[disabled]{opacity:.55;cursor:not-allowed;border-style:dashed;color:var(--dsw-alias-label-caption)}
.dsh-ap-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:20px;padding:3px 8px;border-radius:8px}
.dsh-ap-thumbs{display:flex;flex-wrap:wrap;gap:8px}
.dsh-ap-thumb{box-sizing:border-box;width:132px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);display:flex;flex-direction:column}
.dsh-ap-thumb[data-dsh-selected="true"]{border-color:var(--dsh-glass-accent);box-shadow:0 0 0 1px var(--dsh-glass-accent)}
.dsh-ap-thumb-img{height:70px;background-position:center;background-size:cover;background-repeat:no-repeat}
.dsh-ap-thumb-meta{padding:4px 6px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-ap-thumb-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dsh-ap-thumb-ops{display:flex;flex-wrap:wrap;gap:4px;padding:6px}
.dsh-ap-mini{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:6px;font:inherit;font-size:11px;line-height:16px;padding:1px 6px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-ap-mini[disabled]{opacity:.55;cursor:default}
.dsh-ap-empty{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:12px}
.dsh-ap-notice{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
@media (max-width:820px){.dsh-ap-grid{grid-template-columns:minmax(0,1fr)}}
`;

/** 会被原样搬进 bundle 的纯逻辑函数（用 `toString()` 注入，保证单测与线上是同一份实现）。 */
const DSH_AP_PURE_FUNCTIONS = [
  dshApClampNumber,
  dshApRoundAlpha,
  dshApDeriveGlassAlphas,
  dshApNormalizeAsset,
  dshApNormalizeAppearanceConfig,
  dshApAppearanceCssVariables,
  dshApSchemeAssets,
  dshApSelectWallpaper,
  dshApNextWallpaperId,
  dshApCarouselIntervalMs,
  dshApValidateBackgroundFile,
  dshApFormatBytesLabel
];

/**
 * 浏览器运行时（第一段）：样式注入、背景层、配置应用、草稿与 IndexedDB。
 *
 * 注入源码里**不允许出现裸反引号和模板字符串插值**（外层是 `String.raw`，会被提前结束），
 * 所以全部用字符串拼接；常量走 `JSON.stringify` 生成，天然不含反引号。
 */
const DSH_AP_RUNTIME_DOM = String.raw`
		let dshApReact = require("react");
		const dshApH = dshApReact.createElement;
		const DSH_AP_DRAFT_KEY = "dsh.appearance.v1.draft";
		const DSH_AP_DB_NAME = "dsh-appearance-v1";
		const DSH_AP_DB_VERSION = 1;
		const DSH_AP_DB_STORE = "draftBackgroundAssets";
		const DSH_AP_STYLE_TAG = "appearance-shell";
		let dshApStoreActions = null;
		let dshApCurrentConfig = dshApNormalizeAppearanceConfig(null);
		let dshApCurrentColorScheme = "light";
		let dshApStorageMode = "unknown";
		let dshApRevision = 0;
		let dshApTimer = null;
		let dshApRowMounts = 0;
		let dshApIdSeed = 0;
		const dshApAssetUrls = new Map();
		function dshApStorageMessage() {
			if (dshApStorageMode === "indexeddb") return DSH_AP_COPY.storageIndexedDb;
			if (dshApStorageMode === "objecturl") return DSH_AP_COPY.storageFallback;
			return DSH_AP_COPY.storageUnknown;
		}
		function dshApPublishStorage() {
			if (dshApStoreActions === null) return;
			dshApStoreActions.setStorage(dshApStorageMode, dshApStorageMessage());
		}
		function dshApPublishUrls() {
			if (dshApStoreActions === null) return;
			const urls = {};
			dshApAssetUrls.forEach((value, key) => {
				urls[key] = value;
			});
			dshApStoreActions.setAssetUrls(urls);
		}
		function dshApNextAssetId() {
			dshApIdSeed += 1;
			return "draft-" + Date.now().toString(36) + "-" + dshApIdSeed.toString(36);
		}
		function dshApEnsureStyle() {
			if (typeof document === "undefined") return;
			const selector = "style[data-dsh-frontend=" + JSON.stringify(DSH_AP_STYLE_TAG) + "]";
			if (document.querySelector(selector) !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-frontend", DSH_AP_STYLE_TAG);
			tag.textContent = DSH_AP_STYLE;
			document.head.appendChild(tag);
		}
		function dshApEnsureBackgroundLayer() {
			if (typeof document === "undefined" || document.body === null) return null;
			const existing = document.querySelector(".dsh-appearance-background");
			if (existing !== null) return existing;
			const layer = document.createElement("div");
			layer.className = "dsh-appearance-background";
			layer.setAttribute("data-dsh-has-image", "false");
			layer.setAttribute("data-dsh-image-error", "false");
			layer.setAttribute("aria-hidden", "true");
			for (const slot of ["a", "b"]) {
				const frame = document.createElement("div");
				frame.className = "dsh-appearance-background-frame";
				frame.setAttribute("data-dsh-slot", slot);
				frame.setAttribute("data-dsh-active", "false");
				layer.appendChild(frame);
			}
			const veil = document.createElement("div");
			veil.className = "dsh-appearance-background-veil";
			layer.appendChild(veil);
			const fallback = document.createElement("div");
			fallback.className = "dsh-appearance-background-fallback";
			fallback.textContent = DSH_AP_COPY.backgroundUnavailable;
			layer.appendChild(fallback);
			document.body.appendChild(layer);
			return layer;
		}
		function dshApApplyFit(frame, fit) {
			if (fit === "repeat") {
				frame.style.backgroundSize = "auto";
				frame.style.backgroundRepeat = "repeat";
				return;
			}
			frame.style.backgroundSize = fit === "contain" ? "contain" : "cover";
			frame.style.backgroundRepeat = "no-repeat";
		}
		function dshApPaintBackground(url, fit) {
			const layer = dshApEnsureBackgroundLayer();
			if (layer === null) return;
			if (typeof url !== "string" || url === "") {
				layer.setAttribute("data-dsh-has-image", "false");
				layer.setAttribute("data-dsh-image-error", "false");
				return;
			}
			const frames = layer.querySelectorAll(".dsh-appearance-background-frame");
			if (frames.length < 2) return;
			const active = layer.querySelector(".dsh-appearance-background-frame[data-dsh-active='true']");
			const target = active === frames[0] ? frames[1] : frames[0];
			if (target.getAttribute("data-dsh-url") === url) {
				dshApApplyFit(target, fit);
				layer.setAttribute("data-dsh-has-image", "true");
				return;
			}
			const probe = new Image();
			probe.onload = () => {
				target.setAttribute("data-dsh-url", url);
				target.style.backgroundImage = "url(" + JSON.stringify(url) + ")";
				dshApApplyFit(target, fit);
				target.setAttribute("data-dsh-active", "true");
				if (active !== null) active.setAttribute("data-dsh-active", "false");
				layer.setAttribute("data-dsh-image-error", "false");
				layer.setAttribute("data-dsh-has-image", "true");
			};
			probe.onerror = () => {
				layer.setAttribute("data-dsh-image-error", "true");
				layer.setAttribute("data-dsh-has-image", "true");
			};
			probe.src = url;
		}
		function dshApApplyConfig(config, colorScheme) {
			dshApEnsureStyle();
			if (typeof document === "undefined" || document.body === null) return;
			const cfg = dshApNormalizeAppearanceConfig(config);
			const scheme = colorScheme === "dark" ? "dark" : "light";
			document.body.setAttribute("data-dsh-appearance", cfg.appearanceMode);
			const vars = dshApAppearanceCssVariables(cfg);
			for (const name of Object.keys(vars)) document.body.style.setProperty(name, vars[name]);
			if (cfg.appearanceMode !== "glass") {
				dshApPaintBackground(null, cfg.wallpapers[scheme].fit);
				return;
			}
			const asset = dshApSelectWallpaper(cfg, scheme);
			const url = asset === null ? null : dshApAssetUrls.get(asset.id) || null;
			dshApPaintBackground(url, cfg.wallpapers[scheme].fit);
		}
		function dshApDispatchChanged(source, config) {
			if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
			dshApRevision += 1;
			window.dispatchEvent(new CustomEvent("dsh:appearance:changed", { detail: {
				source: source,
				revision: dshApRevision,
				config: config
			} }));
		}
		function dshApReadDraft() {
			try {
				if (typeof localStorage === "undefined") return null;
				const raw = localStorage.getItem(DSH_AP_DRAFT_KEY);
				if (raw === null) return null;
				return dshApNormalizeAppearanceConfig(JSON.parse(raw));
			} catch (error) {
				return null;
			}
		}
		function dshApWriteDraft(config) {
			try {
				if (typeof localStorage === "undefined") return false;
				localStorage.setItem(DSH_AP_DRAFT_KEY, JSON.stringify(config));
				return true;
			} catch (error) {
				return false;
			}
		}
		function dshApSaveConfig() {
			const written = dshApWriteDraft(dshApCurrentConfig);
			if (dshApStoreActions !== null) dshApStoreActions.setNotice(written ? DSH_AP_COPY.saveOk : DSH_AP_COPY.draftPersistFailed);
			return dshApCurrentConfig;
		}
		function dshApOpenDb() {
			return new Promise((resolve, reject) => {
				if (typeof indexedDB === "undefined") {
					reject(new Error("indexedDB unavailable"));
					return;
				}
				const request = indexedDB.open(DSH_AP_DB_NAME, DSH_AP_DB_VERSION);
				request.onupgradeneeded = () => {
					const db = request.result;
					if (!db.objectStoreNames.contains(DSH_AP_DB_STORE)) db.createObjectStore(DSH_AP_DB_STORE, { keyPath: "id" });
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error || new Error("indexedDB open failed"));
			});
		}
		function dshApDbRun(mode, run) {
			return dshApOpenDb().then((db) => new Promise((resolve, reject) => {
				let request = null;
				try {
					const tx = db.transaction(DSH_AP_DB_STORE, mode);
					request = run(tx.objectStore(DSH_AP_DB_STORE));
					tx.oncomplete = () => {
						db.close();
						resolve(request === null || request === undefined ? undefined : request.result);
					};
					tx.onerror = () => {
						db.close();
						reject(tx.error || new Error("indexedDB transaction failed"));
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error || new Error("indexedDB transaction aborted"));
					};
				} catch (error) {
					db.close();
					reject(error);
				}
			}));
		}
		function dshApDbPut(record) {
			return dshApDbRun("readwrite", (store) => store.put(record));
		}
		function dshApDbDelete(id) {
			return dshApDbRun("readwrite", (store) => store.delete(id));
		}
		function dshApDbGetAll() {
			return dshApDbRun("readonly", (store) => store.getAll());
		}
`;

/**
 * 浏览器运行时（第二段）：状态更新、轮播调度、背景资源增删、store 与安装入口。
 *
 * 关键语义：
 *
 * - `dshApUpdate(config, source, persist)` 的 `persist` 是**手动改动才写草稿**。
 *   自动轮播每次切换都调 `persist=false`，符合 P15-4.3「用户手动切换才持久化当前选择，
 *   不是每次自动播放都写配置」。
 * - 轮播暂停条件之一是「本设置行已挂载」：这个 row 只在设置弹窗打开时才会渲染，
 *   所以「row 挂载中」就是「设置面板打开」的真实信号，不用去猜 portal 容器。
 * - `dshApHydrate` 会**双向对账**：IndexedDB 里多出来的记录（草稿元数据已删）直接清掉，
 *   元数据里多出来的资源（blob 已丢）从配置里剔除，避免界面显示一张打不开的背景。
 */
const DSH_AP_RUNTIME_STATE = String.raw`
		let dshApThemePreference = "system";
		let dshApThemeRevision = 0;
		function dshApUpdate(nextConfig, source, persist) {
			const config = dshApNormalizeAppearanceConfig(nextConfig);
			dshApCurrentConfig = config;
			if (persist === true) {
				const written = dshApWriteDraft(config);
				if (!written && dshApStoreActions !== null) dshApStoreActions.setNotice(DSH_AP_COPY.draftPersistFailed);
			}
			if (dshApStoreActions !== null) dshApStoreActions.setConfig(config);
			dshApApplyConfig(config, dshApCurrentColorScheme);
			dshApDispatchChanged(source, config);
			dshApScheduleCarousel();
			return config;
		}
		function dshApCarouselPaused() {
			if (dshApRowMounts > 0) return true;
			if (typeof document === "undefined") return true;
			if (document.visibilityState === "hidden") return true;
			const active = document.activeElement;
			if (active === null || active === undefined) return false;
			if (active.isContentEditable === true) return true;
			return active.tagName === "INPUT" || active.tagName === "TEXTAREA";
		}
		function dshApScheduleCarousel() {
			if (dshApTimer !== null) {
				clearInterval(dshApTimer);
				dshApTimer = null;
			}
			if (typeof setInterval !== "function") return;
			const config = dshApCurrentConfig;
			if (config.appearanceMode !== "glass") return;
			const entry = config.wallpapers[dshApCurrentColorScheme];
			if (entry.mode === "static") return;
			if (dshApSchemeAssets(config, dshApCurrentColorScheme).length < 2) return;
			dshApTimer = setInterval(() => {
				if (dshApCarouselPaused()) return;
				const nextId = dshApNextWallpaperId(dshApCurrentConfig, dshApCurrentColorScheme, Math.random());
				if (nextId === null) return;
				dshApUpdate(dshApSetSelected(dshApCurrentConfig, dshApCurrentColorScheme, nextId), "carousel", false);
			}, dshApCarouselIntervalMs(entry.intervalSec));
		}
		function dshApSetSelected(config, colorScheme, assetId) {
			const scheme = colorScheme === "dark" ? "dark" : "light";
			const wallpapers = Object.assign({}, config.wallpapers);
			wallpapers[scheme] = Object.assign({}, wallpapers[scheme], { selectedId: assetId });
			return Object.assign({}, config, { wallpapers: wallpapers });
		}
		function dshApPatchWallpaper(config, colorScheme, patch) {
			const scheme = colorScheme === "dark" ? "dark" : "light";
			const wallpapers = Object.assign({}, config.wallpapers);
			wallpapers[scheme] = Object.assign({}, wallpapers[scheme], patch);
			return Object.assign({}, config, { wallpapers: wallpapers });
		}
		function dshApTotalBytes(config) {
			return config.assets.reduce((sum, asset) => sum + asset.bytes, 0);
		}
		function dshApMeasureImage(url) {
			return new Promise((resolve) => {
				if (typeof Image !== "function") {
					resolve(null);
					return;
				}
				const probe = new Image();
				probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
				probe.onerror = () => resolve(null);
				probe.src = url;
			});
		}
		function dshApStoreAsset(file, scheme) {
			const now = new Date().toISOString();
			const meta = {
				id: dshApNextAssetId(),
				fileName: String(file.name || "background"),
				mime: String(file.type || "image/png"),
				bytes: Number(file.size || 0),
				scheme: scheme,
				role: "background",
				createdAt: now,
				updatedAt: now
			};
			const url = URL.createObjectURL(file);
			dshApAssetUrls.set(meta.id, url);
			return dshApMeasureImage(url).then((size) => {
				if (size !== null) {
					meta.width = size.width;
					meta.height = size.height;
				}
				const record = Object.assign({}, meta, { blob: file });
				return dshApDbPut(record).then(() => {
					dshApStorageMode = "indexeddb";
					return meta;
				}).catch(() => {
					dshApStorageMode = "objecturl";
					return meta;
				});
			});
		}
		function dshApAddFiles(fileList) {
			const files = Array.prototype.slice.call(fileList === null || fileList === undefined ? [] : fileList);
			if (files.length === 0) return Promise.resolve(dshApCurrentConfig);
			let total = dshApTotalBytes(dshApCurrentConfig);
			const accepted = [];
			const rejected = [];
			for (const file of files) {
				const check = dshApValidateBackgroundFile(file, total);
				if (check.ok !== true) {
					rejected.push(String(file.name || "") + "：" + check.message);
					continue;
				}
				total += Number(file.size || 0);
				accepted.push(file);
			}
			if (dshApStoreActions !== null) dshApStoreActions.setNotice(rejected.length === 0 ? "" : rejected.join("；"));
			if (accepted.length === 0) return Promise.resolve(dshApCurrentConfig);
			const scheme = dshApCurrentColorScheme;
			return Promise.all(accepted.map((file) => dshApStoreAsset(file, scheme))).then((metas) => {
				dshApPublishUrls();
				dshApPublishStorage();
				let next = Object.assign({}, dshApCurrentConfig, { assets: dshApCurrentConfig.assets.concat(metas) });
				if (next.wallpapers[scheme].selectedId === null && metas.length > 0) next = dshApSetSelected(next, scheme, metas[0].id);
				return dshApUpdate(next, "settings-background-add", true);
			});
		}
		function dshApRemoveAsset(assetId) {
			const assets = dshApCurrentConfig.assets.filter((asset) => asset.id !== assetId);
			const url = dshApAssetUrls.get(assetId);
			if (url !== undefined) {
				URL.revokeObjectURL(url);
				dshApAssetUrls.delete(assetId);
			}
			dshApDbDelete(assetId).catch(() => {});
			dshApPublishUrls();
			return dshApUpdate(Object.assign({}, dshApCurrentConfig, { assets: assets }), "settings-background-remove", true);
		}
		function dshApSetAssetScheme(assetId, scheme) {
			const now = new Date().toISOString();
			const assets = dshApCurrentConfig.assets.map((asset) => {
				if (asset.id !== assetId) return asset;
				return Object.assign({}, asset, { scheme: scheme, updatedAt: now });
			});
			dshApDbGetAll().then((records) => {
				for (const record of records === undefined ? [] : records) {
					if (record.id !== assetId) continue;
					dshApDbPut(Object.assign({}, record, { scheme: scheme, updatedAt: now })).catch(() => {});
				}
			}).catch(() => {});
			return dshApUpdate(Object.assign({}, dshApCurrentConfig, { assets: assets }), "settings-background-scheme", true);
		}
		function dshApHydrate(config) {
			return dshApDbGetAll().then((records) => {
				dshApStorageMode = "indexeddb";
				const known = {};
				for (const asset of config.assets) known[asset.id] = true;
				const now = Date.now();
				for (const record of records === undefined ? [] : records) {
					const createdAt = Date.parse(record.createdAt);
					const expired = Number.isFinite(createdAt) && now - createdAt > DSH_AP_LIMITS.draftAssetTtlMs;
					if (known[record.id] !== true || expired) {
						dshApDbDelete(record.id).catch(() => {});
						continue;
					}
					if (record.blob === null || record.blob === undefined) continue;
					dshApAssetUrls.set(record.id, URL.createObjectURL(record.blob));
				}
				const assets = config.assets.filter((asset) => dshApAssetUrls.has(asset.id));
				return Object.assign({}, config, { assets: assets });
			}).catch(() => {
				dshApStorageMode = "objecturl";
				return Object.assign({}, config, { assets: [] });
			});
		}
		const dshAppearanceStore = (0, _deepseek_ai_dsh_client_runtime_client.defineStore)({
			init: () => ({
				config: dshApNormalizeAppearanceConfig(null),
				colorScheme: "light",
				preference: "system",
				themeRevision: -1,
				storage: "unknown",
				storageMessage: DSH_AP_COPY.storageUnknown,
				notice: "",
				assetUrls: {}
			}),
			actions: {
				setConfig: (draft, config) => {
					draft.config = config;
				},
				syncTheme: (draft, preference, colorScheme, revision) => {
					if (revision <= draft.themeRevision) return;
					draft.preference = preference;
					draft.colorScheme = colorScheme === "dark" ? "dark" : "light";
					draft.themeRevision = revision;
				},
				setStorage: (draft, storage, message) => {
					draft.storage = storage;
					draft.storageMessage = message;
				},
				setNotice: (draft, notice) => {
					draft.notice = notice;
				},
				setAssetUrls: (draft, urls) => {
					draft.assetUrls = urls;
				}
			}
		});
		const dshApInjected = (actions) => {
			dshApStoreActions = actions;
			actions.setConfig(dshApCurrentConfig);
			actions.syncTheme(dshApThemePreference, dshApCurrentColorScheme, dshApThemeRevision);
			dshApPublishStorage();
			dshApPublishUrls();
			return { appearance: {
				setMode: (mode) => dshApUpdate(Object.assign({}, dshApCurrentConfig, { appearanceMode: mode }), "settings-mode", true),
				setGlass: (patch) => dshApUpdate(
					Object.assign({}, dshApCurrentConfig, { glass: Object.assign({}, dshApCurrentConfig.glass, patch) }),
					"settings-glass",
					true
				),
				setWallpaper: (scheme, patch) => dshApUpdate(dshApPatchWallpaper(dshApCurrentConfig, scheme, patch), "settings-wallpaper", true),
				selectAsset: (scheme, assetId) => dshApUpdate(dshApSetSelected(dshApCurrentConfig, scheme, assetId), "settings-wallpaper-select", true),
				setAssetScheme: (assetId, scheme) => dshApSetAssetScheme(assetId, scheme),
				addFiles: (fileList) => dshApAddFiles(fileList),
				removeAsset: (assetId) => dshApRemoveAsset(assetId),
				save: () => dshApSaveConfig(),
				reset: () => dshApUpdate(dshApNormalizeAppearanceConfig(null), "settings-reset", true)
			} };
		};
		function dshApInstall(ctx, theme) {
			dshApEnsureStyle();
			const draft = dshApReadDraft();
			dshApCurrentConfig = draft === null ? dshApNormalizeAppearanceConfig(null) : draft;
			const sync = (snapshot) => {
				const scheme = snapshot !== null && snapshot !== undefined && snapshot.active !== undefined ? snapshot.active.colorScheme : "light";
				dshApCurrentColorScheme = scheme === "dark" ? "dark" : "light";
				dshApThemePreference = snapshot.preference;
				dshApThemeRevision = snapshot.revision;
				if (dshApStoreActions !== null) dshApStoreActions.syncTheme(snapshot.preference, dshApCurrentColorScheme, snapshot.revision);
				dshApApplyConfig(dshApCurrentConfig, dshApCurrentColorScheme);
				dshApScheduleCarousel();
				dshApDispatchChanged("theme-change", dshApCurrentConfig);
			};
			ctx.on("theme/change", sync);
			sync(theme.getTheme());
			dshApHydrate(dshApCurrentConfig).then((hydrated) => {
				dshApPublishStorage();
				dshApPublishUrls();
				dshApUpdate(hydrated, "hydrate", false);
			}).catch(() => {
				dshApPublishStorage();
			});
			if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
				dshApScheduleCarousel();
			});
		}
`;

/**
 * 浏览器运行时（第三段）：设置页里的外观扩展行。
 *
 * 复用官方 `AppearanceRow.module.css` 的 `group` / `title` / `cubeRow` / `themeCube` / `selected`
 * 类名，所以这一行和官方「浅色 / 深色 / 跟随系统」在同一套间距、圆角与选中态里，不是外挂风格。
 * 用 `react` 的 `createElement`（而不是手写编译后的 `jsx` 调用），生成源码可读、也便于后续维护。
 */
const DSH_AP_RUNTIME_ROW = String.raw`
		function dshApSliderField(key, label, value, min, max, step, format, onChange) {
			return dshApH("label", { className: "dsh-ap-field", key: key }, [
				dshApH("span", { className: "dsh-ap-field-head", key: "head" }, [
					dshApH("span", { key: "label" }, label),
					dshApH("span", { "data-dsh-value": "true", key: "value" }, format(value))
				]),
				dshApH("input", {
					key: "input",
					type: "range",
					min: min,
					max: max,
					step: step,
					value: value,
					"aria-label": label,
					onChange: (event) => onChange(Number(event.target.value))
				})
			]);
		}
		function dshApSelectField(key, label, value, options, onChange) {
			return dshApH("label", { className: "dsh-ap-field", key: key }, [
				dshApH("span", { className: "dsh-ap-field-head", key: "head" }, [dshApH("span", { key: "label" }, label)]),
				dshApH("select", {
					key: "select",
					className: "dsh-ap-select",
					value: value,
					"aria-label": label,
					onChange: (event) => onChange(event.target.value)
				}, options.map((option) => dshApH("option", { value: String(option.value), key: String(option.value) }, option.label)))
			]);
		}
		function dshApSchemeLabel(scheme) {
			if (scheme === "light") return DSH_AP_COPY.assetSchemeLight;
			if (scheme === "dark") return DSH_AP_COPY.assetSchemeDark;
			return DSH_AP_COPY.assetSchemeBoth;
		}
		function dshApRenderThumb(asset, url, selected, api) {
			const size = asset.width !== undefined && asset.height !== undefined ? asset.width + "×" + asset.height : DSH_AP_COPY.backgroundUnavailable;
			return dshApH("div", {
				className: "dsh-ap-thumb",
				key: asset.id,
				"data-dsh-selected": selected ? "true" : "false"
			}, [
				dshApH("div", {
					key: "img",
					className: "dsh-ap-thumb-img",
					style: url === undefined ? undefined : { backgroundImage: "url(" + JSON.stringify(url) + ")" }
				}),
				dshApH("div", { className: "dsh-ap-thumb-meta", key: "meta" }, [
					dshApH("div", { className: "dsh-ap-thumb-name", title: asset.fileName, key: "name" }, asset.fileName),
					dshApH("div", { key: "size" }, dshApFormatBytesLabel(asset.bytes) + " · " + size)
				]),
				dshApH("div", { className: "dsh-ap-thumb-ops", key: "ops" }, [
					dshApH("button", {
						key: "use",
						type: "button",
						className: "dsh-ap-mini",
						disabled: selected,
						onClick: () => api.selectAsset(dshApCurrentColorScheme, asset.id)
					}, selected ? DSH_AP_COPY.assetInUse : DSH_AP_COPY.assetUse),
					dshApH("select", {
						key: "scheme",
						className: "dsh-ap-mini",
						value: asset.scheme,
						"aria-label": DSH_AP_COPY.assetSchemeBoth,
						onChange: (event) => api.setAssetScheme(asset.id, event.target.value)
					}, ["both", "light", "dark"].map((scheme) => dshApH("option", { value: scheme, key: scheme }, dshApSchemeLabel(scheme)))),
					dshApH("button", {
						key: "remove",
						type: "button",
						className: "dsh-ap-mini",
						onClick: () => api.removeAsset(asset.id)
					}, DSH_AP_COPY.assetRemove)
				])
			]);
		}
		function DshAppearanceGlassRow(props) {
			const config = props.useStore((state) => state.config);
			const colorScheme = props.useStore((state) => state.colorScheme);
			const storageMessage = props.useStore((state) => state.storageMessage);
			const notice = props.useStore((state) => state.notice);
			const assetUrls = props.useStore((state) => state.assetUrls);
			const api = props.appearance;
			const fileRef = dshApReact.useRef(null);
			dshApReact.useEffect(() => {
				dshApRowMounts += 1;
				dshApScheduleCarousel();
				return () => {
					dshApRowMounts -= 1;
					dshApScheduleCarousel();
				};
			}, []);
			const glass = config.appearanceMode === "glass";
			const alphas = dshApDeriveGlassAlphas(config.glass.panelAlpha);
			const wall = config.wallpapers[colorScheme];
			const modes = [
				{ id: "classic", label: DSH_AP_COPY.modeClassic, Icon: _deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16 },
				{ id: "glass", label: DSH_AP_COPY.modeGlass, Icon: _deepseek_ai_dsh_client_ui_primitives.IconEnhanceOutline16 }
			];
			const children = [
				dshApH("div", { className: AppearanceRow_module_css_default.title, key: "title" }, DSH_AP_COPY.title),
				dshApH("div", { className: "dsh-ap-sub", key: "subtitle" }, DSH_AP_COPY.subtitle),
				dshApH("div", { className: AppearanceRow_module_css_default.cubeRow, key: "modes" }, modes.map((mode) => dshApH("button", {
					key: mode.id,
					type: "button",
					className: clsx(AppearanceRow_module_css_default.themeCube, config.appearanceMode === mode.id && AppearanceRow_module_css_default.selected),
					"aria-pressed": config.appearanceMode === mode.id,
					"data-dsh-appearance-mode": mode.id,
					onClick: () => api.setMode(mode.id)
				}, [dshApH(mode.Icon, { key: "icon" }), mode.label])))
			];
			if (glass) {
				children.push(dshApH("div", { className: "dsh-ap-block", key: "glass" }, [
					dshApH("div", { className: "dsh-ap-legend", key: "legend" }, DSH_AP_COPY.glassSection),
					dshApH("div", { className: "dsh-ap-grid", key: "grid" }, [
						dshApSliderField("blur", DSH_AP_COPY.blur, config.glass.blurPx, DSH_AP_LIMITS.blurPx.min, DSH_AP_LIMITS.blurPx.max, 1, (value) => value + "px", (value) => api.setGlass({ blurPx: value })),
						dshApSliderField("panel", DSH_AP_COPY.panelAlpha, config.glass.panelAlpha, DSH_AP_LIMITS.panelAlpha.min, DSH_AP_LIMITS.panelAlpha.max, 0.01, (value) => value.toFixed(2), (value) => api.setGlass({ panelAlpha: value })),
						dshApSliderField("veil", DSH_AP_COPY.veilAlpha, config.glass.veilAlpha, DSH_AP_LIMITS.veilAlpha.min, DSH_AP_LIMITS.veilAlpha.max, 0.01, (value) => value.toFixed(2), (value) => api.setGlass({ veilAlpha: value })),
						dshApSliderField("border", DSH_AP_COPY.borderAlpha, config.glass.borderAlpha, DSH_AP_LIMITS.borderAlpha.min, DSH_AP_LIMITS.borderAlpha.max, 0.01, (value) => value.toFixed(2), (value) => api.setGlass({ borderAlpha: value }))
					]),
					dshApH("div", { className: "dsh-ap-legend", key: "derived-title" }, DSH_AP_COPY.derivedTitle),
					dshApH("div", { className: "dsh-ap-tags", key: "derived" }, [
						dshApH("span", { className: "dsh-ap-tag", key: "panel" }, DSH_AP_COPY.derivedPanel + " " + alphas.panel.toFixed(2)),
						dshApH("span", { className: "dsh-ap-tag", key: "code" }, DSH_AP_COPY.derivedCode + " " + alphas.code.toFixed(2)),
						dshApH("span", { className: "dsh-ap-tag", key: "input" }, DSH_AP_COPY.derivedInput + " " + alphas.input.toFixed(2)),
						dshApH("span", { className: "dsh-ap-tag", key: "solid" }, DSH_AP_COPY.derivedSolid + " " + alphas.solid.toFixed(2))
					]),
					dshApH("div", { className: "dsh-ap-sub", key: "derived-note" }, DSH_AP_COPY.derivedBlurNote)
				]));
			} else {
				children.push(dshApH("div", { className: "dsh-ap-sub", key: "classic-hint" }, DSH_AP_COPY.classicHint));
			}
			const assets = config.assets;
			const selectedAsset = dshApSelectWallpaper(config, colorScheme);
			const selectedId = selectedAsset === null ? null : selectedAsset.id;
			children.push(dshApH("div", { className: "dsh-ap-block", key: "background" }, [
				dshApH("div", { className: "dsh-ap-legend", key: "legend" }, DSH_AP_COPY.backgroundSection),
				dshApH("div", { className: "dsh-ap-sub", key: "scope" }, colorScheme === "dark" ? DSH_AP_COPY.backgroundScopeDark : DSH_AP_COPY.backgroundScopeLight),
				dshApH("div", { className: "dsh-ap-actions", key: "pick" }, [
					dshApH("button", {
						key: "button",
						type: "button",
						className: "dsh-ap-btn",
						onClick: () => {
							if (fileRef.current !== null) fileRef.current.click();
						}
					}, DSH_AP_COPY.pick),
					dshApH("input", {
						key: "input",
						ref: fileRef,
						type: "file",
						accept: DSH_AP_LIMITS.mimeTypes.join(","),
						multiple: true,
						style: { display: "none" },
						onChange: (event) => {
							const files = event.target.files;
							api.addFiles(files);
							event.target.value = "";
						}
					})
				]),
				assets.length === 0
					? dshApH("div", { className: "dsh-ap-empty", key: "empty" }, DSH_AP_COPY.assetsEmpty)
					: dshApH("div", { className: "dsh-ap-thumbs", key: "thumbs" }, assets.map((asset) => dshApRenderThumb(asset, assetUrls[asset.id], asset.id === selectedId, api))),
				dshApH("div", { className: "dsh-ap-grid", key: "grid" }, [
					dshApSelectField("fit", DSH_AP_COPY.fit, wall.fit, [
						{ value: "cover", label: DSH_AP_COPY.fitCover },
						{ value: "contain", label: DSH_AP_COPY.fitContain },
						{ value: "repeat", label: DSH_AP_COPY.fitRepeat }
					], (value) => api.setWallpaper(colorScheme, { fit: value })),
					dshApSelectField("mode", DSH_AP_COPY.playback, wall.mode, [
						{ value: "static", label: DSH_AP_COPY.playbackStatic },
						{ value: "sequential", label: DSH_AP_COPY.playbackSequential },
						{ value: "random", label: DSH_AP_COPY.playbackRandom }
					], (value) => api.setWallpaper(colorScheme, { mode: value })),
					dshApSelectField("interval", DSH_AP_COPY.interval, String(wall.intervalSec), DSH_AP_LIMITS.intervalPresets.map((preset) => ({
						value: preset,
						label: preset + " " + DSH_AP_COPY.intervalSuffix
					})), (value) => api.setWallpaper(colorScheme, { intervalSec: Number(value) }))
				]),
				dshApH("div", { className: "dsh-ap-sub", key: "interval-note" }, DSH_AP_COPY.intervalFloor),
				dshApH("div", { className: "dsh-ap-sub", key: "storage" }, storageMessage)
			]));
			if (notice !== "") children.push(dshApH("div", { className: "dsh-ap-notice", key: "notice" }, notice));
			children.push(dshApH("div", { className: "dsh-ap-actions", key: "footer" }, [
				dshApH("button", {
					key: "save",
					type: "button",
					className: "dsh-ap-btn",
					title: DSH_AP_COPY.saveDisabledReason,
					onClick: () => api.save()
				}, DSH_AP_COPY.saveDisabled),
				dshApH("button", {
					key: "reset",
					type: "button",
					className: "dsh-ap-btn",
					onClick: () => api.reset()
				}, DSH_AP_COPY.reset),
				dshApH("span", { className: "dsh-ap-sub", key: "reason" }, DSH_AP_COPY.saveDisabledReason)
			]));
			return dshApH("div", {
				className: AppearanceRow_module_css_default.group,
				"data-dsh-appearance-row": "true"
			}, children);
		}
`;

/** 把纯函数源码缩进到 bundle 内部的两层 tab，保持生成文件可读。 */
function dshApIndent(source) {
  return source
    .split("\n")
    .map((line) => (line === "" ? line : "\t\t" + line))
    .join("\n");
}

/** 注入进 `dsh-client-ui-theme` 模块 factory 的完整源码。 */
export const DSH_APPEARANCE_RUNTIME_SOURCE = [
  "\t\t//#region Plan_15 W1/W2 · DshAppearanceShell（外观扩展：经典 / 磨砂玻璃、磨砂参数、背景图与轮播）",
  "\t\tconst DSH_APPEARANCE_SHELL_ID = " + JSON.stringify(DSH_APPEARANCE_MARKER) + ";",
  "\t\tconst DSH_AP_LIMITS = " + JSON.stringify(DSH_AP_LIMITS) + ";",
  "\t\tconst DSH_AP_DEFAULTS = " + JSON.stringify(DSH_AP_DEFAULTS) + ";",
  "\t\tconst DSH_AP_COPY = " + JSON.stringify(DSH_AP_COPY) + ";",
  "\t\tconst DSH_AP_STYLE = " + JSON.stringify(DSH_APPEARANCE_STYLE) + ";",
  DSH_AP_PURE_FUNCTIONS.map((fn) => dshApIndent(String(fn))).join("\n"),
  DSH_AP_RUNTIME_DOM.trim(),
  DSH_AP_RUNTIME_STATE.trim(),
  DSH_AP_RUNTIME_ROW.trim(),
  "\t\t//#endregion"
].join("\n");

/** 运行时源码插入点：官方 `apply(ctx)` 之前（组件与 store 都要在 factory 作用域里）。 */
const DSH_AP_APPLY_ANCHOR = "\t\tfunction apply(ctx) {";

/** 官方 Appearance row 的注册段，逐字取自干净基线 `0.1.0-rc.6-oauth`。 */
const DSH_AP_INJECT_ANCHOR = [
  '\t\t\tctx.slots.inject("settings.general.item", () => ctx.slots.register({',
  '\t\t\t\tname: "settings.general.item",',
  '\t\t\t\tid: "appearance",',
  "\t\t\t\torder: 10,",
  "\t\t\t\tstore,",
  "\t\t\t\tlocale: SETTINGS_NS,",
  "\t\t\t\tinject: injected",
  "\t\t\t}, AppearanceRow));"
].join("\n");

/**
 * 追加的注册段。
 *
 * `order: 11` 让这一行稳定排在官方外观 row（`order: 10`）后面；`id` 必须与官方 `appearance` 不同，
 * 否则 list slot 会在同 priority 下直接抛错（干净基线 `dsh-client-ui-slots` 的 `register` 有显式检查）。
 * 这里**不传 `locale`**：本轮文案集中在 `DSH_AP_COPY` 常量里，不去改官方 `settings.theme` 字典。
 */
const DSH_AP_INJECT_APPEND = [
  "\t\t\tdshApInstall(ctx, theme);",
  '\t\t\tctx.slots.inject("settings.general.item", () => ctx.slots.register({',
  '\t\t\t\tname: "settings.general.item",',
  '\t\t\t\tid: "dsh-appearance-glass",',
  "\t\t\t\torder: 11,",
  "\t\t\t\tstore: dshAppearanceStore,",
  "\t\t\t\tinject: dshApInjected",
  "\t\t\t}, DshAppearanceGlassRow));"
].join("\n");

/**
 * 给 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 打上外观扩展补丁。
 *
 * 两处锚点都在干净基线里唯一出现，任一不匹配就直接抛错停止构建，不做模糊替换。
 * @param source - 干净基线的 theme client bundle 源码。
 * @returns 追加了外观扩展 row 的源码。
 */
export function patchAppearanceThemeSource(source) {
  assertNotAlreadyPatched(source, DSH_APPEARANCE_MARKER, "Plan_15 外观扩展（appearance-shell）");
  const withRuntime = replaceExactlyOnce(
    source,
    DSH_AP_APPLY_ANCHOR,
    DSH_APPEARANCE_RUNTIME_SOURCE + "\n" + DSH_AP_APPLY_ANCHOR,
    "Plan_15 外观扩展运行时插入点"
  );
  return replaceExactlyOnce(
    withRuntime,
    DSH_AP_INJECT_ANCHOR,
    DSH_AP_INJECT_ANCHOR + "\n" + DSH_AP_INJECT_APPEND,
    "Plan_15 外观扩展 settings row 注册点"
  );
}
