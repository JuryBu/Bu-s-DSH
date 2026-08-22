/**
 * Plan_15 批次 W3 · 右侧工作区外壳 + 桌面标题栏规格 + 内置浏览器预留矩形。
 *
 * 规范依据 `plans_windsurf/frontend-spec.md` 的 P15-5 / P15-6 / P15-6.1 / P15-7 /
 * P15-9 / P15-9.1 / P15-10 / P15-11.2，以及 `ANSWERS_Plan15_R3.md` 的 Q73-Q75。
 *
 * 本模块只做工作区外壳与桥接层：真实文件、终端和内置浏览器由桌面壳注入的 C# bridge 接管。
 *
 * - 工作区根节点是 `document.body` 下的 `#dsh-workspace-shell`，状态走
 *   `body[data-dsh-workspace-open]` 与 `--dsh-workspace-width`，不挂 obfuscated class，
 *   也不是覆盖聊天区的 overlay。
 * - 标题栏只有 C# 注入 `titlebarMode === "custom"` 才自绘；缺 `window.__dshDesktop`
 *   或 `native-panel` 时**完全不渲染 DOM 标题栏、也不给页面顶部加 padding**，
 *   避免原生栏 + 网页空白栏双层占位。窗口命令一律 postMessage 给 C#，
 *   前端不假实现拖动/最小化/最大化/关闭。
 * - 内置浏览器不用 iframe：前端只负责 toolbar 与预留矩形，导航、真实 DOM、console 和元素拾取都走
 *   C# 第二个 WebView2。
 * - 终端与文件必须由桌面壳能力位显式开启；没有 bridge 时继续显示禁用说明，不造假数据。
 * - 元素/控制台回传只**接收** `dsh:browser:element-picked`，自己不拾取；composer
 *   事件按 kind 拆开派发，不写 textarea，也不复用 `dsh:composer:add-text`。
 *
 * 依赖边界（P15-11.2）：纯 DOM 实现，不 require 任何包、不碰 `fs`/`path`/`crypto`、
 * 不跨 feature UI 包引用，图标用 inline SVG。
 */

import { assertNotAlreadyPatched, replaceExactlyOnce } from "./replace-exactly.mjs";

/** 立即生效的右侧工作区 UI 状态 key（R3 Q73）。与官方左侧会话列表、外观草稿彻底隔离。 */
export const DSH_WORKSPACE_LOCAL_KEY = "dsh.rightWorkspace.view.v1";
/** Plan_15 早期候选误用过的官方工作区 key；只读迁移并在下次写入时清理 workspace 片段。 */
export const DSH_WORKSPACE_LEGACY_LOCAL_KEY = "dsh.workspace.view.v5";
/** Plan_15 早期候选误用过的外观 key；只读迁移并在下次写入时清理 workspace 片段。 */
export const DSH_WORKSPACE_APPEARANCE_LEGACY_LOCAL_KEY = "dsh.appearance.v1.local";

export const DSH_WORKSPACE_DEFAULT_WIDTH = 440;
export const DSH_WORKSPACE_MIN_WIDTH = 360;
/** 最大宽 `min(55vw, 720px)` 的两个分量（P15-6）。 */
export const DSH_WORKSPACE_MAX_WIDTH_PX = 720;
export const DSH_WORKSPACE_MAX_WIDTH_VW = 0.55;
/** 正文可用宽度低于该值就自动收起工作区；左侧会话栏无 collapse API，不去动它。 */
export const DSH_WORKSPACE_MIN_CHAT_WIDTH = 720;
export const DSH_WORKSPACE_TABS = ["files", "browser", "terminal"];
/** 拖拽把手键盘微调步长。 */
export const DSH_WORKSPACE_WIDTH_STEP = 16;

/** 桌面标题栏白名单命令（P15-5）；前端只转发，不自己实现窗口行为。 */
export const DSH_TITLEBAR_COMMANDS = ["minimize", "maximize", "restore", "close", "startDrag"];
export const DSH_TITLEBAR_DEFAULT_HEIGHT = 36;
export const DSH_DESKTOP_COMMAND_TYPE = "dsh.desktop.command";

export const DSH_EMBEDDED_BROWSER_MESSAGE_TYPE = "dsh.embeddedBrowser.setBounds";
export const DSH_EMBEDDED_BROWSER_NAVIGATE_TYPE = "dsh.embeddedBrowser.navigate";
export const DSH_EMBEDDED_BROWSER_HISTORY_TYPE = "dsh.embeddedBrowser.history";
export const DSH_EMBEDDED_BROWSER_PICK_TYPE = "dsh.embeddedBrowser.pickElement";
export const DSH_EMBEDDED_BROWSER_BOUNDS_EVENT = "dsh:embedded-browser:set-bounds";
export const DSH_BROWSER_STATE_EVENT = "dsh:browser:state";
export const DSH_TERMINAL_RUN_TYPE = "dsh.terminal.run";
export const DSH_TERMINAL_RESPONSE_TYPE = "dsh.terminal.response";
/** R3 Q74 冻结的四个 reason；其余触发源（含 toolbar 高度变化）归一到 `resize`。 */
export const DSH_EMBEDDED_BROWSER_REASONS = ["resize", "tab-change", "workspace-toggle", "window-state"];

/** P15-7：按 kind 拆开，禁止复用含义模糊的 `dsh:composer:add-text`。 */
export const DSH_COMPOSER_EVENTS = {
  "browser-element": "dsh:composer:add-browser-element",
  "console-errors": "dsh:composer:add-console-errors",
  "workspace-annotation": "dsh:composer:add-workspace-annotations",
  "file-selection": "dsh:composer:add-file-selection",
};
export const DSH_BROWSER_ELEMENT_PICKED_EVENT = "dsh:browser:element-picked";
/** R4 D2：C#/第二 WebView2 → 前端的控制台错误批次。 */
export const DSH_BROWSER_CONSOLE_ERRORS_EVENT = "dsh:browser:console-errors";
export const DSH_DESKTOP_READY_EVENT = "dsh:desktop:ready";
/** R4 D3：只负责唤醒 UI 重算；可用性真相是 `window.__dshComposerAccepts`。 */
export const DSH_COMPOSER_READY_EVENT = "dsh:composer:ready";

/** P15-7：console 只收 error/onerror/unhandledrejection，每页最多 20 条。 */
export const DSH_CONSOLE_ERROR_LIMIT = 20;
/** 元素预览截断：R4 D7 已确认这组数，下游可更早截断但不得放大。 */
export const DSH_ELEMENT_TEXT_PREVIEW_LIMIT = 2000;
export const DSH_ELEMENT_HTML_PREVIEW_LIMIT = 4000;
/** R4 D8：面板窄于此值时隐藏左列文件树，把宽度让给正文。 */
export const DSH_WORKSPACE_COMPACT_TREE_WIDTH = 420;

/** 中文优先、集中在一个常量对象里（P15-10），不引入新的 i18n 依赖。 */
export const DSH_WORKSPACE_COPY = {
  shellLabel: "工作区",
  toggleOpen: "打开工作区",
  toggleClose: "收起工作区",
  resizeLabel: "拖动调整工作区宽度",
  tabFiles: "文件",
  tabBrowser: "浏览器",
  tabTerminal: "终端",
  treeTitle: "文件树",
  treeEmptyTitle: "文件能力未连接",
  treeEmptyBody: "桌面壳会把真实工作区目录挂进这里，未连接时只显示空态。",
  filesEmptyTitle: "文件能力未连接",
  filesEmptyBody: "在桌面版里会列出真实工作区文件，支持预览、选区加入对话和受控编辑保存。",
  browserUrlLabel: "地址",
  browserUrlPlaceholder: "内置浏览器未连接",
  browserUrlReadyPlaceholder: "输入 URL",
  browserBack: "后退",
  browserForward: "前进",
  browserReload: "刷新",
  browserGo: "打开",
  browserStageTitle: "内置浏览器能力未连接",
  browserStageBody: "这块区域是给 C# 第二个 WebView2 预留的位置，前端不加载真实网页。",
  browserStageNote: "前端已按坐标契约上报矩形；真实画面由桌面壳覆盖绘制。",
  browserPickElement: "选择元素",
  browserPickedReady: "已选中元素，可加入对话",
  browserSendElement: "发送元素",
  browserConsoleErrors: "控制台错误",
  terminalTitle: "工作区终端",
  terminalBody: "在当前 DSH 工作区内执行短命令，输出会限制长度并带退出码。",
  terminalPlaceholder: "输入 PowerShell 命令，例如 Get-Location",
  terminalRun: "运行",
  terminalIdle: "还没有运行命令",
  terminalRunning: "正在运行…",
  terminalExit: "退出码",
  disabledNoDesktop: "当前没有桌面壳能力通道（缺 window.__dshDesktop）",
  disabledNoEmbeddedBrowser: "内置浏览器能力未开启（capabilities.embeddedBrowser 不为 true）",
  disabledNoComposerBridge: "composer 事件桥未就绪，暂不能回传",
  disabledNoTerminal: "桌面壳未开放真实终端能力",
  disabledNoFiles: "桌面壳未开放真实文件能力",
  titlebarTitle: "DeepSeek Harness",
  titlebarMinimize: "最小化",
  titlebarMaximize: "最大化",
  titlebarClose: "关闭",
};

/**
 * 把宽度夹到 `[360, min(55vw, 720)]`。
 *
 * 视口未知时按 720px 上限处理（等价于足够宽的视口），非法值回落到默认 440。
 * 上限低于下限时以下限为准——此时真正该做的是自动收起，由
 * `dshResolveWorkspaceVisibility` 决定，不在这里偷偷把面板压到 300px。
 * @param width - 期望宽度（px）。
 * @param viewportWidth - 视口宽度（px），可缺省。
 */
export function dshClampWorkspaceWidth(width, viewportWidth) {
  const viewport = typeof viewportWidth === "number" && Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : DSH_WORKSPACE_MAX_WIDTH_PX / DSH_WORKSPACE_MAX_WIDTH_VW;
  const upper = Math.max(
    DSH_WORKSPACE_MIN_WIDTH,
    Math.min(DSH_WORKSPACE_MAX_WIDTH_PX, Math.round(viewport * DSH_WORKSPACE_MAX_WIDTH_VW)),
  );
  const raw = typeof width === "number" && Number.isFinite(width) ? Math.round(width) : DSH_WORKSPACE_DEFAULT_WIDTH;
  return Math.min(upper, Math.max(DSH_WORKSPACE_MIN_WIDTH, raw));
}

/**
 * 读本地 workspace 片段。任何形状不符一律回落默认值，
 * 不猜测、不部分恢复。
 * @param raw - localStorage 原始字符串。
 */
export function dshReadWorkspaceLocalState(raw) {
  const fallback = { open: false, activeTab: "files", width: DSH_WORKSPACE_DEFAULT_WIDTH };
  if (typeof raw !== "string" || raw === "") return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
  const workspace = parsed.workspace;
  if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace)) return fallback;
  return {
    open: workspace.open === true,
    activeTab: DSH_WORKSPACE_TABS.includes(workspace.activeTab) ? workspace.activeTab : "files",
    width: dshClampWorkspaceWidth(workspace.width, void 0),
  };
}

/**
 * 写回 workspace 片段。workspace 使用独立 key，只保存右侧工作区自己的状态，
 * 不把官方左栏、外观草稿或早期候选误塞进来的字段继续带下去。
 * @param raw - 旧签名保留给调用方兼容，当前不再合并使用。
 * @param workspace - 当前 `{ open, activeTab, width }`。
 */
export function dshWriteWorkspaceLocalState(raw, workspace) {
  const next = workspace === null || typeof workspace !== "object" ? {} : workspace;
  return JSON.stringify({
    workspace: {
      open: next.open === true,
      activeTab: DSH_WORKSPACE_TABS.includes(next.activeTab) ? next.activeTab : "files",
      width: dshClampWorkspaceWidth(next.width, void 0),
    },
  });
}

/**
 * 解析标题栏形态（P15-5）。缺 `__dshDesktop` 或非 `custom` 一律 `native-panel`，
 * 且 `render === false`——不画 DOM 标题栏、不加顶部 padding。
 * @param desktop - `window.__dshDesktop`。
 */
export function dshResolveTitlebarPlan(desktop) {
  const bridge = desktop !== null && typeof desktop === "object" ? desktop : null;
  const rawHeight = bridge === null ? void 0 : bridge.titlebarHeight;
  const height = typeof rawHeight === "number" && Number.isFinite(rawHeight) && rawHeight > 0
    ? Math.round(rawHeight)
    : DSH_TITLEBAR_DEFAULT_HEIGHT;
  if (bridge === null) return { mode: "native-panel", render: false, height, reason: "no-desktop-bridge" };
  if (bridge.titlebarMode !== "custom") return { mode: "native-panel", render: false, height, reason: "native-panel" };
  /* R4 D5：要同时满足 capabilities.customTitlebar === true，否则仍按 native-panel。
     C# 未实现无边框拖动/最大化/边缘 resize 前，自绘标题栏会把窗口变成不可操作。 */
  const caps = bridge.capabilities !== null && typeof bridge.capabilities === "object" ? bridge.capabilities : null;
  if (caps === null || caps.customTitlebar !== true) {
    return { mode: "native-panel", render: false, height, reason: "custom-titlebar-capability-missing" };
  }
  return { mode: "custom", render: true, height, reason: "custom-titlebar" };
}

/**
 * 能力探测（P15-9）：先看 `capabilities`，缺能力直接 disabled 并给出原因，
 * 不靠调用失败才降级。
 * @param desktop - `window.__dshDesktop`。
 */
export function dshResolveWorkspaceCapabilities(desktop) {
  const bridge = desktop !== null && typeof desktop === "object" ? desktop : null;
  const caps = bridge !== null && bridge.capabilities !== null && typeof bridge.capabilities === "object"
    ? bridge.capabilities
    : null;
  return {
    hasDesktopBridge: bridge !== null,
    /* 没有桌面壳时（普通浏览器 / mock）工作区外壳仍可用，只有显式 false 才禁用。 */
    rightWorkspace: {
      enabled: caps === null ? true : caps.rightWorkspace !== false,
      reason: caps === null ? "no-desktop-bridge-assume-web" : "capability",
    },
    embeddedBrowser: {
      enabled: caps !== null && caps.embeddedBrowser === true,
      reason: bridge === null
        ? DSH_WORKSPACE_COPY.disabledNoDesktop
        : caps !== null && caps.embeddedBrowser === true ? "capability" : DSH_WORKSPACE_COPY.disabledNoEmbeddedBrowser,
    },
    customTitlebar: {
      enabled: caps !== null && caps.customTitlebar === true,
      reason: bridge === null ? DSH_WORKSPACE_COPY.disabledNoDesktop : "capability",
    },
    terminal: {
      enabled: caps !== null && caps.terminal === true,
      reason: bridge === null ? DSH_WORKSPACE_COPY.disabledNoDesktop : caps !== null && caps.terminal === true ? "capability" : DSH_WORKSPACE_COPY.disabledNoTerminal,
    },
    files: {
      enabled: caps !== null && caps.files === true,
      reason: bridge === null ? DSH_WORKSPACE_COPY.disabledNoDesktop : caps !== null && caps.files === true ? "capability" : DSH_WORKSPACE_COPY.disabledNoFiles,
    },
  };
}

/**
 * 决定工作区是否真的可见。窄屏（正文可用宽度 < 720px）自动收起，并记 `autoCollapsed`，
 * 视口变宽后可自动恢复；用户手动关闭时 `autoCollapsed` 为 false，不会被自动打开。
 * @param input - `{ viewportWidth, width, userOpen, capable }`。
 */
export function dshResolveWorkspaceVisibility(input) {
  const options = input !== null && typeof input === "object" ? input : {};
  const width = dshClampWorkspaceWidth(options.width, options.viewportWidth);
  const viewport = typeof options.viewportWidth === "number" && Number.isFinite(options.viewportWidth)
    ? options.viewportWidth
    : 0;
  if (options.capable === false) return { open: false, autoCollapsed: false, width, reason: "capability-missing" };
  if (options.userOpen !== true) return { open: false, autoCollapsed: false, width, reason: "user-closed" };
  if (viewport > 0 && viewport - width < DSH_WORKSPACE_MIN_CHAT_WIDTH) {
    return { open: false, autoCollapsed: true, width, reason: "narrow-viewport" };
  }
  return { open: true, autoCollapsed: false, width, reason: "open" };
}

/**
 * 组装 `dsh.embeddedBrowser.setBounds` 消息（P15-9.1）。矩形为空或零面积时
 * `visible` 强制 false——宁可让 C# 隐藏，也不给出一个错误位置的可见矩形。
 * @param rect - `getBoundingClientRect()` 结果或等价对象。
 * @param options - `{ visible, reason, devicePixelRatio }`。
 */
export function dshEmbeddedBrowserBoundsMessage(rect, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const reason = DSH_EMBEDDED_BROWSER_REASONS.includes(opts.reason) ? opts.reason : "resize";
  const dpr = typeof opts.devicePixelRatio === "number" && Number.isFinite(opts.devicePixelRatio) && opts.devicePixelRatio > 0
    ? opts.devicePixelRatio
    : 1;
  const box = rect !== null && typeof rect === "object" ? rect : null;
  const round = (value) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  const bounds = {
    left: round(box === null ? 0 : box.left),
    top: round(box === null ? 0 : box.top),
    width: Math.max(0, round(box === null ? 0 : box.width)),
    height: Math.max(0, round(box === null ? 0 : box.height)),
  };
  return {
    type: DSH_EMBEDDED_BROWSER_MESSAGE_TYPE,
    visible: opts.visible === true && bounds.width > 0 && bounds.height > 0,
    rect: bounds,
    devicePixelRatio: dpr,
    reason,
  };
}

/**
 * 规范化 C# 回传的拾取结果为 `DshBrowserElementPayload`（P15-7）。
 * 缺 `url` 或 `tagName` 一律返回 null，绝不补默认值冒充一条可发送的元素。
 * 默认不带 computed style 与截图，未知字段直接丢弃。
 * @param detail - `dsh:browser:element-picked` 的 detail。
 * @param nowIso - 缺 `pickedAt` 时使用的 ISO 时间。
 */
export function dshNormalizeBrowserElementPayload(detail, nowIso) {
  const source = detail !== null && typeof detail === "object" && !Array.isArray(detail) ? detail : null;
  if (source === null) return null;
  const text = (value, limit) => typeof value === "string" && value !== "" ? value.slice(0, limit) : void 0;
  const url = typeof source.url === "string" && source.url !== "" ? source.url : null;
  const tagName = typeof source.tagName === "string" && source.tagName !== "" ? source.tagName.toLowerCase() : null;
  if (url === null || tagName === null) return null;
  const pickedAt = typeof source.pickedAt === "string" && source.pickedAt !== ""
    ? source.pickedAt
    : typeof nowIso === "string" && nowIso !== "" ? nowIso : "";
  if (pickedAt === "") return null;
  const payload = {
    kind: "browser-element",
    url,
    tagName,
    textPreview: typeof source.textPreview === "string" ? source.textPreview.slice(0, DSH_ELEMENT_TEXT_PREVIEW_LIMIT) : "",
    pickedAt,
  };
  const title = text(source.title, 300);
  if (title !== void 0) payload.title = title;
  const selector = text(source.selector, 600);
  if (selector !== void 0) payload.selector = selector;
  const xpath = text(source.xpath, 600);
  if (xpath !== void 0) payload.xpath = xpath;
  const outerHtmlPreview = text(source.outerHtmlPreview, DSH_ELEMENT_HTML_PREVIEW_LIMIT);
  if (outerHtmlPreview !== void 0) payload.outerHtmlPreview = outerHtmlPreview;
  const rect = source.rect;
  if (rect !== null && typeof rect === "object") {
    const num = (value) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : void 0;
    const x = num(rect.x);
    const y = num(rect.y);
    const width = num(rect.width);
    const height = num(rect.height);
    if (x !== void 0 && y !== void 0 && width !== void 0 && height !== void 0) payload.rect = { x, y, width, height };
  }
  const attributes = source.attributes;
  if (attributes !== null && typeof attributes === "object" && !Array.isArray(attributes)) {
    const picked = {};
    for (const key of ["id", "class", "role", "ariaLabel"]) {
      const value = text(attributes[key], 300);
      if (value !== void 0) picked[key] = value;
    }
    if (Object.keys(picked).length > 0) payload.attributes = picked;
  }
  return payload;
}

/**
 * 组装控制台错误批次 payload。只取未发送过的条目，最多 20 条（P15-7），
 * 不收 `warn`；`total` 是缓冲区真实条数，不用截断后的数字冒充。
 * @param entries - 缓冲区条目 `{ message, stack?, source?, line?, column?, time, sent? }`。
 */
export function dshBuildConsoleErrorsPayload(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const pending = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || entry.sent === true) continue;
    if (typeof entry.message !== "string" || entry.message === "") continue;
    const item = { message: entry.message.slice(0, DSH_ELEMENT_TEXT_PREVIEW_LIMIT) };
    if (typeof entry.stack === "string" && entry.stack !== "") item.stack = entry.stack.slice(0, DSH_ELEMENT_HTML_PREVIEW_LIMIT);
    if (typeof entry.source === "string" && entry.source !== "") item.source = entry.source.slice(0, 600);
    if (typeof entry.line === "number" && Number.isFinite(entry.line)) item.line = Math.round(entry.line);
    if (typeof entry.column === "number" && Number.isFinite(entry.column)) item.column = Math.round(entry.column);
    if (typeof entry.time === "string" && entry.time !== "") item.time = entry.time;
    pending.push(item);
    if (pending.length >= DSH_CONSOLE_ERROR_LIMIT) break;
  }
  if (pending.length === 0) return null;
  return { kind: "console-errors", errors: pending, total: list.length };
}

/**
 * 工作区外壳样式。命名空间 `dsh-ws-` / `dsh-workspace-*` / `dsh-desktop-titlebar-*`，
 * 全部默认值从现有 `--dsw-*` 派生（P15-2），经典外观不被污染，磨砂外观由 W1/W2
 * 的 `--dsh-glass-*` 整体接管。
 *
 * `.dsh-ws-body[hidden] { display: none }` 是硬要求（P15-6.1）：容器设了 `display:flex`
 * 会覆盖 HTML 的 `hidden`，导致三个 tab 面板同时渲染叠在一起——沙盘实测踩过。
 */
export const DSH_WORKSPACE_SHELL_STYLE = `
body{
--dsh-workspace-width:${DSH_WORKSPACE_DEFAULT_WIDTH}px;
--dsh-workspace-min-width:${DSH_WORKSPACE_MIN_WIDTH}px;
--dsh-workspace-max-width:min(${Math.round(DSH_WORKSPACE_MAX_WIDTH_VW * 1e4) / 100}vw, ${DSH_WORKSPACE_MAX_WIDTH_PX}px);
--dsh-workspace-tree-width:clamp(128px, 34%, 168px);
--dsh-workspace-bg:var(--dsh-glass-panel-bg, var(--dsw-alias-bg-layer-1));
--dsh-workspace-fg:var(--dsw-alias-label-primary);
--dsh-workspace-muted:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
--dsh-workspace-border:var(--dsh-glass-border, var(--dsw-alias-border-l2));
--dsh-workspace-accent:var(--dsw-alias-brand-primary, var(--dsw-static-deepseek-500));
--dsh-workspace-hover:var(--dsw-alias-interactive-bg-hover);
--dsh-workspace-stage-bg:var(--dsw-alias-bg-base);
--dsh-desktop-titlebar-height:${DSH_TITLEBAR_DEFAULT_HEIGHT}px;
--dsh-desktop-titlebar-bg:var(--dsh-glass-panel-bg, var(--dsw-alias-bg-layer-2));
--dsh-desktop-titlebar-fg:var(--dsw-alias-label-secondary);
}
#dsh-workspace-shell{position:fixed;top:0;right:0;bottom:0;z-index:40;display:none;flex-direction:column;box-sizing:border-box;width:var(--dsh-workspace-width);min-width:var(--dsh-workspace-min-width);max-width:var(--dsh-workspace-max-width);background:var(--dsh-workspace-bg);color:var(--dsh-workspace-fg);border-left:1px solid var(--dsh-workspace-border);backdrop-filter:var(--dsh-glass-backdrop, none)}
body[data-dsh-workspace-open="true"] #dsh-workspace-shell{display:flex}
html[data-dsh-desktop-titlebar="custom"] #dsh-workspace-shell{top:var(--dsh-desktop-titlebar-height)}
html[data-dsh-workspace-reflow="body-padding"] body[data-dsh-workspace-open="true"]{padding-inline-end:var(--dsh-workspace-width)}
html[data-dsh-desktop-titlebar="custom"] body{padding-top:var(--dsh-desktop-titlebar-height)}
#dsh-workspace-toggle{position:fixed;top:48px;right:12px;z-index:41;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsh-workspace-border);border-radius:8px;background:var(--dsh-workspace-bg);color:var(--dsh-workspace-muted);font-size:12px;line-height:26px;white-space:nowrap;cursor:pointer}
/* inline SVG 不设尺寸时默认 300x150，会把同一 flex 行里的文字挤成竖排——实测踩过。 */
#dsh-workspace-shell svg,#dsh-workspace-toggle svg,#dsh-desktop-titlebar svg{flex:0 0 auto;width:12px;height:12px}
#dsh-workspace-toggle:hover{background:var(--dsh-workspace-hover);color:var(--dsh-workspace-fg)}
#dsh-workspace-toggle[aria-pressed="true"]{color:var(--dsh-workspace-fg);border-color:var(--dsh-workspace-accent)}
html[data-dsh-desktop-titlebar="custom"] #dsh-workspace-toggle{top:calc(var(--dsh-desktop-titlebar-height) + 48px)}
body[data-dsh-workspace-open="true"] #dsh-workspace-toggle{display:none}
.dsh-ws-resize{position:absolute;top:0;left:-3px;bottom:0;width:6px;cursor:col-resize;background:transparent;border:0;padding:0}
.dsh-ws-resize:hover,.dsh-ws-resize:focus-visible{background:var(--dsh-workspace-accent);opacity:.35;outline:none}
.dsh-ws-nav{display:flex;align-items:center;gap:2px;flex:0 0 auto;padding:6px 8px;border-bottom:1px solid var(--dsh-workspace-border)}
.dsh-ws-tab{height:26px;padding:0 10px;border:0;border-radius:6px;background:none;color:var(--dsh-workspace-muted);font-size:12px;cursor:pointer}
.dsh-ws-tab:hover:not([disabled]){background:var(--dsh-workspace-hover);color:var(--dsh-workspace-fg)}
.dsh-ws-tab[aria-selected="true"]{background:var(--dsh-workspace-hover);color:var(--dsh-workspace-fg);box-shadow:inset 0 -2px 0 var(--dsh-workspace-accent)}
.dsh-ws-tab[disabled]{opacity:.45;cursor:not-allowed}
.dsh-ws-nav-spacer{flex:1}
.dsh-ws-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:none;color:var(--dsh-workspace-muted);cursor:pointer}
.dsh-ws-iconbtn:hover{background:var(--dsh-workspace-hover);color:var(--dsh-workspace-fg)}
.dsh-ws-main{display:flex;flex:1;min-height:0}
.dsh-ws-tree{flex:0 0 auto;width:var(--dsh-workspace-tree-width);min-width:0;overflow:auto;padding:8px;border-right:1px solid var(--dsh-workspace-border);font-size:12px;color:var(--dsh-workspace-muted)}
.dsh-ws-tree-title{display:block;margin-bottom:6px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.8}
#dsh-workspace-shell[data-dsh-compact-tree="true"] .dsh-ws-tree{display:none}
#dsh-workspace-shell[data-dsh-workspace-tab="browser"] .dsh-ws-tree,#dsh-workspace-shell[data-dsh-workspace-tab="terminal"] .dsh-ws-tree{display:none}
.dsh-ws-col{display:flex;flex-direction:column;flex:1;min-width:0}
.dsh-ws-body{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
.dsh-ws-body[hidden]{display:none}
.dsh-ws-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1;padding:18px;text-align:center;color:var(--dsh-workspace-muted);font-size:12px}
.dsh-ws-empty[hidden]{display:none}
.dsh-ws-empty strong{color:var(--dsh-workspace-fg);font-size:13px;font-weight:600}
.dsh-ws-empty code{font-family:"Cascadia Code",ui-monospace,monospace;font-size:11px}
.dsh-browser-bar{display:flex;align-items:center;gap:4px;flex:0 0 auto;padding:6px 8px;border-bottom:1px solid var(--dsh-workspace-border)}
.dsh-browser-nav{width:24px;height:24px;border:0;border-radius:6px;background:none;color:var(--dsh-workspace-muted);cursor:pointer}
.dsh-browser-nav[disabled]{opacity:.4;cursor:not-allowed}
.dsh-browser-go{width:auto;padding:0 8px;font-size:12px}
.dsh-browser-url{flex:1;min-width:0;height:24px;padding:0 8px;border:1px solid var(--dsh-workspace-border);border-radius:6px;background:var(--dsh-glass-input-bg, transparent);color:var(--dsh-workspace-fg);font-size:12px}
.dsh-browser-url[disabled]{opacity:.6;cursor:not-allowed}
.dsh-browser-stage{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;margin:8px;border:1px dashed var(--dsh-workspace-border);border-radius:8px;background:var(--dsh-workspace-stage-bg);overflow:hidden}
.dsh-browser-stage[data-dsh-browser-reserved="true"]{background-image:repeating-linear-gradient(135deg,transparent 0 9px,var(--dsh-workspace-hover) 9px 10px)}
.dsh-browser-stage[data-dsh-browser-reserved="false"]{border-style:solid;background:transparent}
.dsh-browser-stage[data-dsh-browser-reserved="false"] .dsh-ws-empty{display:none}
.dsh-devtoolbar{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:0 0 auto;padding:6px 8px;border-top:1px solid var(--dsh-workspace-border)}
.dsh-devtoolbar button{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:1px solid var(--dsh-workspace-border);border-radius:6px;background:none;color:var(--dsh-workspace-muted);font-size:12px;cursor:pointer}
.dsh-devtoolbar button:hover:not([disabled]){background:var(--dsh-workspace-hover);color:var(--dsh-workspace-fg)}
.dsh-devtoolbar button[disabled]{opacity:.45;cursor:not-allowed}
.dsh-terminal-pane{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;padding:8px}
.dsh-terminal-log{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsh-workspace-border);border-radius:8px;background:var(--dsh-workspace-stage-bg);padding:10px;font:12px/1.55 "Cascadia Code",ui-monospace,monospace;white-space:pre-wrap;color:var(--dsh-workspace-fg)}
.dsh-terminal-log[data-empty="true"]{display:flex;align-items:center;justify-content:center;color:var(--dsh-workspace-muted);font-family:inherit}
.dsh-terminal-row{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.dsh-terminal-input{flex:1;min-width:0;height:28px;padding:0 9px;border:1px solid var(--dsh-workspace-border);border-radius:7px;background:var(--dsh-glass-input-bg, transparent);color:var(--dsh-workspace-fg);font:12px "Cascadia Code",ui-monospace,monospace}
.dsh-terminal-input[disabled]{opacity:.6;cursor:not-allowed}
.dsh-terminal-run{height:28px;padding:0 12px;border:1px solid var(--dsh-workspace-border);border-radius:7px;background:none;color:var(--dsh-workspace-fg);font-size:12px;cursor:pointer}
.dsh-terminal-run:hover:not([disabled]){background:var(--dsh-workspace-hover)}
.dsh-terminal-run[disabled]{opacity:.45;cursor:not-allowed}
#dsh-desktop-titlebar{position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;align-items:center;height:var(--dsh-desktop-titlebar-height);padding-left:12px;background:var(--dsh-desktop-titlebar-bg);color:var(--dsh-desktop-titlebar-fg);border-bottom:1px solid var(--dsh-workspace-border);-webkit-app-region:drag}
.dsh-titlebar-title{flex:1;font-size:12px;pointer-events:none}
.dsh-titlebar-btn{width:44px;height:var(--dsh-desktop-titlebar-height);border:0;background:none;color:inherit;font-size:12px;cursor:pointer;-webkit-app-region:no-drag}
.dsh-titlebar-btn:hover{background:var(--dsh-workspace-hover)}
.dsh-titlebar-btn[data-dsh-titlebar-command="close"]:hover{background:#e81123;color:#fff}
@media (prefers-reduced-motion:reduce){#dsh-workspace-shell{transition:none}}
`;

const WORKSPACE_LOGIC_SOURCE = [
  dshClampWorkspaceWidth,
  dshReadWorkspaceLocalState,
  dshWriteWorkspaceLocalState,
  dshResolveTitlebarPlan,
  dshResolveWorkspaceCapabilities,
  dshResolveWorkspaceVisibility,
  dshEmbeddedBrowserBoundsMessage,
  dshNormalizeBrowserElementPayload,
  dshBuildConsoleErrorsPayload,
]
  .map((fn) => fn.toString().split("\n").map((line) => `\t\t${line}`).join("\n"))
  .join("\n");

const WORKSPACE_CONSTANT_SOURCE = [
  ["DSH_WORKSPACE_LOCAL_KEY", DSH_WORKSPACE_LOCAL_KEY],
  ["DSH_WORKSPACE_LEGACY_LOCAL_KEY", DSH_WORKSPACE_LEGACY_LOCAL_KEY],
  ["DSH_WORKSPACE_APPEARANCE_LEGACY_LOCAL_KEY", DSH_WORKSPACE_APPEARANCE_LEGACY_LOCAL_KEY],
  ["DSH_WORKSPACE_DEFAULT_WIDTH", DSH_WORKSPACE_DEFAULT_WIDTH],
  ["DSH_WORKSPACE_MIN_WIDTH", DSH_WORKSPACE_MIN_WIDTH],
  ["DSH_WORKSPACE_MAX_WIDTH_PX", DSH_WORKSPACE_MAX_WIDTH_PX],
  ["DSH_WORKSPACE_MAX_WIDTH_VW", DSH_WORKSPACE_MAX_WIDTH_VW],
  ["DSH_WORKSPACE_MIN_CHAT_WIDTH", DSH_WORKSPACE_MIN_CHAT_WIDTH],
  ["DSH_WORKSPACE_TABS", DSH_WORKSPACE_TABS],
  ["DSH_WORKSPACE_WIDTH_STEP", DSH_WORKSPACE_WIDTH_STEP],
  ["DSH_TITLEBAR_COMMANDS", DSH_TITLEBAR_COMMANDS],
  ["DSH_TITLEBAR_DEFAULT_HEIGHT", DSH_TITLEBAR_DEFAULT_HEIGHT],
  ["DSH_DESKTOP_COMMAND_TYPE", DSH_DESKTOP_COMMAND_TYPE],
  ["DSH_EMBEDDED_BROWSER_MESSAGE_TYPE", DSH_EMBEDDED_BROWSER_MESSAGE_TYPE],
  ["DSH_EMBEDDED_BROWSER_NAVIGATE_TYPE", DSH_EMBEDDED_BROWSER_NAVIGATE_TYPE],
  ["DSH_EMBEDDED_BROWSER_HISTORY_TYPE", DSH_EMBEDDED_BROWSER_HISTORY_TYPE],
  ["DSH_EMBEDDED_BROWSER_PICK_TYPE", DSH_EMBEDDED_BROWSER_PICK_TYPE],
  ["DSH_EMBEDDED_BROWSER_BOUNDS_EVENT", DSH_EMBEDDED_BROWSER_BOUNDS_EVENT],
  ["DSH_BROWSER_STATE_EVENT", DSH_BROWSER_STATE_EVENT],
  ["DSH_TERMINAL_RUN_TYPE", DSH_TERMINAL_RUN_TYPE],
  ["DSH_TERMINAL_RESPONSE_TYPE", DSH_TERMINAL_RESPONSE_TYPE],
  ["DSH_EMBEDDED_BROWSER_REASONS", DSH_EMBEDDED_BROWSER_REASONS],
  ["DSH_COMPOSER_EVENTS", DSH_COMPOSER_EVENTS],
  ["DSH_BROWSER_ELEMENT_PICKED_EVENT", DSH_BROWSER_ELEMENT_PICKED_EVENT],
  ["DSH_BROWSER_CONSOLE_ERRORS_EVENT", DSH_BROWSER_CONSOLE_ERRORS_EVENT],
  ["DSH_DESKTOP_READY_EVENT", DSH_DESKTOP_READY_EVENT],
  ["DSH_COMPOSER_READY_EVENT", DSH_COMPOSER_READY_EVENT],
  ["DSH_WORKSPACE_COMPACT_TREE_WIDTH", DSH_WORKSPACE_COMPACT_TREE_WIDTH],
  ["DSH_CONSOLE_ERROR_LIMIT", DSH_CONSOLE_ERROR_LIMIT],
  ["DSH_ELEMENT_TEXT_PREVIEW_LIMIT", DSH_ELEMENT_TEXT_PREVIEW_LIMIT],
  ["DSH_ELEMENT_HTML_PREVIEW_LIMIT", DSH_ELEMENT_HTML_PREVIEW_LIMIT],
  ["DSH_WORKSPACE_COPY", DSH_WORKSPACE_COPY],
  ["DSH_WORKSPACE_SHELL_STYLE", DSH_WORKSPACE_SHELL_STYLE],
]
  .map(([name, value]) => `\t\tconst ${name} = ${JSON.stringify(value)};`)
  .join("\n");

/**
 * 注入到对话 bundle 的工作区运行时。
 *
 * 纯 DOM 实现，不用 React：工作区根节点直接挂在 `document.body` 下，与官方 React 树
 * 互不干涉，也就不会被官方重渲染覆盖。`installDshWorkspaceShell` 返回 teardown，
 * 由 `ctx.effect` 托管，HMR/卸载时能干净移除。
 */
const WORKSPACE_RUNTIME_SOURCE = `${WORKSPACE_CONSTANT_SOURCE}
${WORKSPACE_LOGIC_SOURCE}
\t\tfunction dshWorkspaceSvg(doc, path) {
\t\t\tconst svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
\t\t\tsvg.setAttribute("viewBox", "0 0 16 16");
\t\t\tsvg.setAttribute("aria-hidden", "true");
\t\t\tconst node = doc.createElementNS("http://www.w3.org/2000/svg", "path");
\t\t\tnode.setAttribute("d", path);
\t\t\tnode.setAttribute("fill", "currentColor");
\t\t\tsvg.appendChild(node);
\t\t\treturn svg;
\t\t}
	\t\tfunction dshWorkspaceReadLocalRaw() {
	\t\t\ttry {
	\t\t\t\tconst current = window.localStorage?.getItem(DSH_WORKSPACE_LOCAL_KEY) ?? null;
	\t\t\t\tif (current !== null && current !== "") return current;
	\t\t\t\treturn window.localStorage?.getItem(DSH_WORKSPACE_LEGACY_LOCAL_KEY) ?? null;
	\t\t\t} catch {
	\t\t\t\treturn null;
	\t\t\t}
\t\t}
\t\tfunction dshWorkspaceRawHasWorkspace(raw) {
\t\t\tif (raw === null || raw === undefined || raw === "") return false;
\t\t\ttry {
\t\t\t\tconst parsed = JSON.parse(String(raw));
\t\t\t\treturn parsed !== null && typeof parsed === "object" && parsed.workspace !== null && typeof parsed.workspace === "object";
\t\t\t} catch {
\t\t\t\treturn false;
\t\t\t}
\t\t}
\t\tfunction dshWorkspaceExtractRaw(raw) {
\t\t\tif (!dshWorkspaceRawHasWorkspace(raw)) return null;
\t\t\ttry {
\t\t\t\tconst parsed = JSON.parse(String(raw));
\t\t\t\treturn dshWriteWorkspaceLocalState(null, parsed.workspace);
\t\t\t} catch {
\t\t\t\treturn null;
\t\t\t}
\t\t}
\t\tfunction dshWorkspaceReadLocalRaw() {
\t\t\ttry {
\t\t\t\tconst current = window.localStorage?.getItem(DSH_WORKSPACE_LOCAL_KEY) ?? null;
\t\t\t\tconst normalizedCurrent = dshWorkspaceExtractRaw(current);
\t\t\t\tif (normalizedCurrent !== null) return normalizedCurrent;
\t\t\t\tfor (const key of [DSH_WORKSPACE_LEGACY_LOCAL_KEY, DSH_WORKSPACE_APPEARANCE_LEGACY_LOCAL_KEY]) {
\t\t\t\t\tconst raw = window.localStorage?.getItem(key) ?? null;
\t\t\t\t\tconst normalized = dshWorkspaceExtractRaw(raw);
\t\t\t\t\tif (normalized !== null) return normalized;
\t\t\t\t}
\t\t\t\treturn null;
\t\t\t} catch {
\t\t\t\treturn null;
\t\t\t}
\t\t}
\t\tfunction dshWorkspacePruneLegacyLocalRaw() {
\t\t\tfor (const key of [DSH_WORKSPACE_LEGACY_LOCAL_KEY, DSH_WORKSPACE_APPEARANCE_LEGACY_LOCAL_KEY]) {
\t\t\t\ttry {
\t\t\t\t\tconst raw = window.localStorage?.getItem(key) ?? null;
\t\t\t\t\tif (!dshWorkspaceRawHasWorkspace(raw)) continue;
\t\t\t\t\tconst parsed = JSON.parse(String(raw));
\t\t\t\t\tdelete parsed.workspace;
\t\t\t\t\tif (Object.keys(parsed).length === 0) {
\t\t\t\t\t\twindow.localStorage?.removeItem(key);
\t\t\t\t\t} else {
\t\t\t\t\t\twindow.localStorage?.setItem(key, JSON.stringify(parsed));
\t\t\t\t\t}
\t\t\t\t} catch {
\t\t\t\t\t/* 旧候选污染清不掉也不能影响真实工作区。 */
\t\t\t\t}
\t\t\t}
\t\t}
\t\tfunction dshWorkspaceWriteLocalRaw(workspace) {
\t\t\ttry {
\t\t\t\twindow.localStorage?.setItem(DSH_WORKSPACE_LOCAL_KEY, dshWriteWorkspaceLocalState(null, workspace));
\t\t\t\tdshWorkspacePruneLegacyLocalRaw();
\t\t\t} catch {
\t\t\t\t/* 隐私模式或配额满：本地状态丢了不影响功能，不弹错。 */
\t\t\t}
\t\t}
\t\tfunction dshWorkspaceComposerReady(kind) {
\t\t\t/* P15-7.2：函数是同步真相，没有它就一律当不可用。DOM 事件无法探测监听器存在。 */
\t\t\tconst accepts = window.__dshComposerAccepts;
\t\t\tif (typeof accepts !== "function") return false;
\t\t\treturn accepts(kind) === true;
\t\t}
\t\tfunction dshWorkspaceDesktopCommand(command) {
\t\t\tif (!DSH_TITLEBAR_COMMANDS.includes(command)) return false;
\t\t\tconst post = window.chrome?.webview?.postMessage;
\t\t\tif (typeof post !== "function") return false;
\t\t\tpost.call(window.chrome.webview, { type: DSH_DESKTOP_COMMAND_TYPE, command });
\t\t\treturn true;
\t\t}
\t\tfunction dshWorkspacePostMessage(message) {
\t\t\tconst post = window.chrome?.webview?.postMessage;
\t\t\tif (typeof post !== "function") return false;
\t\t\tpost.call(window.chrome.webview, message);
\t\t\treturn true;
\t\t}
\t\t/**
\t\t* 装载右侧工作区外壳、可隐藏的自绘标题栏与内置浏览器预留矩形。
\t\t* 返回 teardown，交给 ctx.effect 托管。
\t\t*/
\t\tfunction installDshWorkspaceShell() {
\t\t\tif (typeof document === "undefined" || document.body === null) return () => {};
\t\t\tif (document.getElementById("dsh-workspace-shell") !== null) return () => {};
\t\t\tconst doc = document;
\t\t\tconst body = doc.body;
\t\t\tconst html = doc.documentElement;
\t\t\tconst state = { userOpen: false, open: false, width: DSH_WORKSPACE_DEFAULT_WIDTH, activeTab: "files", autoCollapsed: false };
\t\t\tlet capabilities = dshResolveWorkspaceCapabilities(window.__dshDesktop);
\t\t\tlet titlebarPlan = dshResolveTitlebarPlan(window.__dshDesktop);
\t\t\tconst pickedElements = [];
\t\t\tconst consoleErrors = [];
\t\t\tconst terminalRequests = new Map();
\t\t\tlet browserState = { url: "", title: "", canGoBack: false, canGoForward: false, phase: "idle" };
\t\t\tlet terminalSeq = 1;
\t\t\tconst disposers = [];
\t\t\tconst storedRaw = dshWorkspaceReadLocalRaw();
\t\t\tconst stored = dshReadWorkspaceLocalState(storedRaw);
\t\t\tif (storedRaw !== null) {
\t\t\t\tdshWorkspaceWriteLocalRaw(stored);
\t\t\t} else {
\t\t\t\tdshWorkspacePruneLegacyLocalRaw();
\t\t\t}
\t\t\tstate.userOpen = stored.open;
\t\t\tstate.width = stored.width;
\t\t\tstate.activeTab = stored.activeTab;

\t\t\tconst style = doc.createElement("style");
\t\t\tstyle.id = "dsh-workspace-style";
\t\t\tstyle.setAttribute("data-dsh-frontend", "plan15-workspace");
\t\t\tstyle.textContent = DSH_WORKSPACE_SHELL_STYLE;
\t\t\tdoc.head.appendChild(style);

\t\t\tconst shell = doc.createElement("aside");
\t\t\tshell.id = "dsh-workspace-shell";
\t\t\tshell.setAttribute("aria-label", DSH_WORKSPACE_COPY.shellLabel);

\t\t\tconst handle = doc.createElement("button");
\t\t\thandle.type = "button";
\t\t\thandle.className = "dsh-ws-resize";
\t\t\thandle.setAttribute("aria-label", DSH_WORKSPACE_COPY.resizeLabel);
\t\t\thandle.setAttribute("aria-orientation", "vertical");
\t\t\tshell.appendChild(handle);

\t\t\tconst nav = doc.createElement("div");
\t\t\tnav.className = "dsh-ws-nav";
\t\t\tconst tabLabels = {
\t\t\t\tfiles: DSH_WORKSPACE_COPY.tabFiles,
\t\t\t\tbrowser: DSH_WORKSPACE_COPY.tabBrowser,
\t\t\t\tterminal: DSH_WORKSPACE_COPY.tabTerminal
\t\t\t};
\t\t\tconst tabs = new Map();
\t\t\tfor (const id of DSH_WORKSPACE_TABS) {
\t\t\t\tconst tab = doc.createElement("button");
\t\t\t\ttab.type = "button";
\t\t\t\ttab.className = "dsh-ws-tab";
\t\t\t\ttab.dataset.dshWsTab = id;
\t\t\t\ttab.textContent = tabLabels[id];
\t\t\t\ttab.setAttribute("role", "tab");
\t\t\t\ttab.setAttribute("aria-selected", "false");
\t\t\t\tnav.appendChild(tab);
\t\t\t\ttabs.set(id, tab);
\t\t\t}
\t\t\tconst spacer = doc.createElement("span");
\t\t\tspacer.className = "dsh-ws-nav-spacer";
\t\t\tnav.appendChild(spacer);
\t\t\tconst closeButton = doc.createElement("button");
\t\t\tcloseButton.type = "button";
\t\t\tcloseButton.className = "dsh-ws-iconbtn";
\t\t\tcloseButton.setAttribute("aria-label", DSH_WORKSPACE_COPY.toggleClose);
\t\t\tcloseButton.appendChild(dshWorkspaceSvg(doc, "M4.6 3.5 8 6.9l3.4-3.4 1.1 1.1L9.1 8l3.4 3.4-1.1 1.1L8 9.1l-3.4 3.4-1.1-1.1L6.9 8 3.5 4.6z"));
\t\t\tnav.appendChild(closeButton);
\t\t\tshell.appendChild(nav);

\t\t\tconst main = doc.createElement("div");
\t\t\tmain.className = "dsh-ws-main";
\t\t\t/* 文件树固定在左列，正文/浏览器/终端在最右列（P15-6，不照搬 Codex 布局）。 */
\t\t\tconst tree = doc.createElement("div");
\t\t\ttree.className = "dsh-ws-tree";
\t\t\ttree.dataset.dshWsTree = "placeholder";
\t\t\tconst treeTitle = doc.createElement("span");
\t\t\ttreeTitle.className = "dsh-ws-tree-title";
\t\t\ttreeTitle.textContent = DSH_WORKSPACE_COPY.treeTitle;
\t\t\tconst treeBody = doc.createElement("div");
\t\t\ttreeBody.textContent = DSH_WORKSPACE_COPY.treeEmptyBody;
\t\t\ttree.append(treeTitle, treeBody);
\t\t\tmain.appendChild(tree);

\t\t\tconst column = doc.createElement("div");
\t\t\tcolumn.className = "dsh-ws-col";
\t\t\tconst panes = new Map();
\t\t\tfor (const id of DSH_WORKSPACE_TABS) {
\t\t\t\tconst pane = doc.createElement("div");
\t\t\t\tpane.className = "dsh-ws-body";
\t\t\t\tpane.dataset.dshWsPane = id;
\t\t\t\tpane.hidden = true;
\t\t\t\tcolumn.appendChild(pane);
\t\t\t\tpanes.set(id, pane);
\t\t\t}
\t\t\tmain.appendChild(column);
\t\t\tshell.appendChild(main);

\t\t\tconst emptyBlock = (title, lines) => {
\t\t\t\tconst wrap = doc.createElement("div");
\t\t\t\twrap.className = "dsh-ws-empty";
\t\t\t\tconst strong = doc.createElement("strong");
\t\t\t\tstrong.textContent = title;
\t\t\t\twrap.appendChild(strong);
\t\t\t\tfor (const line of lines) {
\t\t\t\t\tconst span = doc.createElement("span");
\t\t\t\t\tspan.textContent = line;
\t\t\t\t\twrap.appendChild(span);
\t\t\t\t}
\t\t\t\treturn wrap;
\t\t\t};
\t\t\tpanes.get("files").appendChild(emptyBlock(DSH_WORKSPACE_COPY.filesEmptyTitle, [DSH_WORKSPACE_COPY.filesEmptyBody, capabilities.files.reason]));
\t\t\tconst terminalPane = panes.get("terminal");
\t\t\tconst terminalWrap = doc.createElement("div");
\t\t\tterminalWrap.className = "dsh-terminal-pane";
\t\t\tconst terminalLog = doc.createElement("pre");
\t\t\tterminalLog.className = "dsh-terminal-log";
\t\t\tterminalLog.dataset.empty = "true";
\t\t\tterminalLog.textContent = capabilities.terminal.enabled === true ? DSH_WORKSPACE_COPY.terminalIdle : capabilities.terminal.reason;
\t\t\tconst terminalRow = doc.createElement("div");
\t\t\tterminalRow.className = "dsh-terminal-row";
\t\t\tconst terminalInput = doc.createElement("input");
\t\t\tterminalInput.type = "text";
\t\t\tterminalInput.className = "dsh-terminal-input";
\t\t\tterminalInput.placeholder = DSH_WORKSPACE_COPY.terminalPlaceholder;
\t\t\tconst terminalRun = doc.createElement("button");
\t\t\tterminalRun.type = "button";
\t\t\tterminalRun.className = "dsh-terminal-run";
\t\t\tterminalRun.textContent = DSH_WORKSPACE_COPY.terminalRun;
\t\t\tterminalRow.append(terminalInput, terminalRun);
\t\t\tterminalWrap.append(terminalLog, terminalRow);
\t\t\tterminalPane.appendChild(terminalWrap);

\t\t\tconst browserPane = panes.get("browser");
\t\t\tconst browserBar = doc.createElement("div");
\t\t\tbrowserBar.className = "dsh-browser-bar";
\t\t\tconst navButtons = [];
\t\t\tfor (const spec of [["back", DSH_WORKSPACE_COPY.browserBack, "M10 3.2 5.2 8l4.8 4.8 1.1-1.1L7.4 8l3.7-3.7z"], ["forward", DSH_WORKSPACE_COPY.browserForward, "M6 3.2 4.9 4.3 8.6 8l-3.7 3.7L6 12.8 10.8 8z"], ["reload", DSH_WORKSPACE_COPY.browserReload, "M8 3.2a4.8 4.8 0 1 0 4.6 6.1h-1.6A3.3 3.3 0 1 1 8 4.7v2l2.9-2.4L8 1.9z"]]) {
\t\t\t\tconst button = doc.createElement("button");
\t\t\t\tbutton.type = "button";
\t\t\t\tbutton.className = "dsh-browser-nav";
\t\t\t\tbutton.dataset.dshBrowserNav = spec[0];
\t\t\t\tbutton.setAttribute("aria-label", spec[1]);
\t\t\t\tbutton.appendChild(dshWorkspaceSvg(doc, spec[2]));
\t\t\t\tbrowserBar.appendChild(button);
\t\t\t\tnavButtons.push(button);
\t\t\t}
\t\t\tconst urlInput = doc.createElement("input");
\t\t\turlInput.type = "text";
\t\t\turlInput.className = "dsh-browser-url";
\t\t\turlInput.setAttribute("aria-label", DSH_WORKSPACE_COPY.browserUrlLabel);
\t\t\turlInput.placeholder = DSH_WORKSPACE_COPY.browserUrlPlaceholder;
\t\t\tbrowserBar.appendChild(urlInput);
\t\t\tconst browserGo = doc.createElement("button");
\t\t\tbrowserGo.type = "button";
\t\t\tbrowserGo.className = "dsh-browser-nav dsh-browser-go";
\t\t\tbrowserGo.dataset.dshBrowserGo = "true";
\t\t\tbrowserGo.textContent = DSH_WORKSPACE_COPY.browserGo;
\t\t\tbrowserGo.setAttribute("aria-label", DSH_WORKSPACE_COPY.browserGo);
\t\t\tbrowserBar.appendChild(browserGo);
\t\t\tbrowserPane.appendChild(browserBar);

\t\t\t/* 预留矩形：前端不画真实网页，只上报坐标，由 C# 第二个 WebView2 覆盖（P15-9.1）。 */
\t\t\tconst stage = doc.createElement("div");
\t\t\tstage.className = "dsh-browser-stage";
\t\t\tstage.dataset.dshEmbeddedBrowserStage = "reserved";
\t\t\tstage.dataset.dshBrowserReserved = "true";
\t\t\tconst browserEmpty = emptyBlock(DSH_WORKSPACE_COPY.browserStageTitle, [DSH_WORKSPACE_COPY.browserStageBody, DSH_WORKSPACE_COPY.browserStageNote]);
\t\t\tconst browserReason = doc.createElement("span");
\t\t\tbrowserReason.dataset.dshBrowserReason = "true";
\t\t\tbrowserEmpty.appendChild(browserReason);
\t\t\tstage.appendChild(browserEmpty);
\t\t\tconst devToolbar = doc.createElement("div");
\t\t\tdevToolbar.className = "dsh-devtoolbar";
\t\t\tdevToolbar.dataset.dshBrowserToolbar = "true";
\t\t\tconst sendElement = doc.createElement("button");
\t\t\tsendElement.type = "button";
\t\t\tsendElement.dataset.dshBrowserAction = "send-element";
\t\t\tsendElement.appendChild(dshWorkspaceSvg(doc, "M3 1.6v10.2l2.7-2.5 1.7 4.1 1.9-.8-1.7-4h3.6z"));
\t\t\tconst sendElementLabel = doc.createElement("span");
\t\t\tsendElement.appendChild(sendElementLabel);
\t\t\tconst sendErrors = doc.createElement("button");
\t\t\tsendErrors.type = "button";
\t\t\tsendErrors.dataset.dshBrowserAction = "send-console-errors";
\t\t\tconst sendErrorsLabel = doc.createElement("span");
\t\t\tsendErrors.appendChild(sendErrorsLabel);
\t\t\tdevToolbar.append(sendElement, sendErrors);
\t\t\tstage.appendChild(devToolbar);
\t\t\tbrowserPane.appendChild(stage);

\t\t\tconst toggle = doc.createElement("button");
\t\t\ttoggle.type = "button";
\t\t\ttoggle.id = "dsh-workspace-toggle";
\t\t\ttoggle.setAttribute("aria-pressed", "false");
\t\t\ttoggle.setAttribute("aria-controls", "dsh-workspace-shell");
\t\t\tconst toggleLabel = doc.createElement("span");
\t\t\ttoggleLabel.textContent = DSH_WORKSPACE_COPY.shellLabel;
\t\t\ttoggle.append(dshWorkspaceSvg(doc, "M2.5 2.5h11v11h-11zm6 1.2v8.6h3.8V3.7z"), toggleLabel);

\t\t\tbody.appendChild(shell);
\t\t\tbody.appendChild(toggle);

\t\t\tlet titlebar = null;
\t\t\tconst syncTitlebarButtons = () => {
\t\t\t\tif (titlebar === null) return;
\t\t\t\tconst maximizeButton = titlebar.querySelector("[data-dsh-titlebar-role='toggle-maximize']");
\t\t\t\tif (!(maximizeButton instanceof HTMLButtonElement)) return;
\t\t\t\tconst bridge = window.__dshDesktop !== null && typeof window.__dshDesktop === "object" ? window.__dshDesktop : {};
\t\t\t\tconst maximized = bridge.isMaximized === true || bridge.windowState === "maximized";
\t\t\t\tmaximizeButton.dataset.dshTitlebarCommand = maximized ? "restore" : "maximize";
\t\t\t\tmaximizeButton.setAttribute("aria-label", maximized ? "还原" : DSH_WORKSPACE_COPY.titlebarMaximize);
\t\t\t\tmaximizeButton.textContent = maximized ? "\\u2750" : "\\u25A1";
\t\t\t};
\t\t\tconst renderTitlebar = () => {
\t\t\t\tif (titlebarPlan.render !== true) {
\t\t\t\t\t/* native-panel：不画标题栏、不加顶部 padding，避免双层占位。 */
\t\t\t\t\tif (titlebar !== null) titlebar.remove();
\t\t\t\t\ttitlebar = null;
\t\t\t\t\tdelete html.dataset.dshDesktopTitlebar;
\t\t\t\t\tbody.style.removeProperty("--dsh-desktop-titlebar-height");
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\thtml.dataset.dshDesktopTitlebar = "custom";
\t\t\t\tbody.style.setProperty("--dsh-desktop-titlebar-height", titlebarPlan.height + "px");
\t\t\t\tif (titlebar !== null) {
\t\t\t\t\tsyncTitlebarButtons();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\ttitlebar = doc.createElement("div");
\t\t\t\ttitlebar.id = "dsh-desktop-titlebar";
\t\t\t\tconst title = doc.createElement("span");
\t\t\t\ttitle.className = "dsh-titlebar-title";
\t\t\t\ttitle.textContent = DSH_WORKSPACE_COPY.titlebarTitle;
\t\t\t\ttitlebar.appendChild(title);
\t\t\t\tfor (const spec of [["minimize", DSH_WORKSPACE_COPY.titlebarMinimize, "\\u2013"], ["maximize", DSH_WORKSPACE_COPY.titlebarMaximize, "\\u25A1"], ["close", DSH_WORKSPACE_COPY.titlebarClose, "\\u2715"]]) {
\t\t\t\t\tconst button = doc.createElement("button");
\t\t\t\t\tbutton.type = "button";
\t\t\t\t\tbutton.className = "dsh-titlebar-btn";
\t\t\t\t\tbutton.dataset.dshTitlebarCommand = spec[0];
\t\t\t\t\tif (spec[0] === "maximize") button.dataset.dshTitlebarRole = "toggle-maximize";
\t\t\t\t\tbutton.setAttribute("aria-label", spec[1]);
\t\t\t\t\tbutton.textContent = spec[2];
\t\t\t\t\ttitlebar.appendChild(button);
\t\t\t\t}
\t\t\t\ttitlebar.addEventListener("click", (event) => {
\t\t\t\t\tconst target = event.target instanceof Element ? event.target.closest("[data-dsh-titlebar-command]") : null;
\t\t\t\t\tif (target === null) return;
\t\t\t\t\t/* 窗口行为的唯一真相源是 C#，前端只转发白名单命令。 */
\t\t\t\t\tdshWorkspaceDesktopCommand(target.dataset.dshTitlebarCommand);
\t\t\t\t});
\t\t\t\ttitlebar.addEventListener("pointerdown", (event) => {
\t\t\t\t\tif (event.target instanceof Element && event.target.closest("[data-dsh-titlebar-command]") !== null) return;
\t\t\t\t\tdshWorkspaceDesktopCommand("startDrag");
\t\t\t\t});
\t\t\t\tbody.appendChild(titlebar);
\t\t\t\tsyncTitlebarButtons();
\t\t\t};

\t\t\tlet boundsFrame = 0;
\t\t\tlet boundsReason = "resize";
\t\t\tconst publishBounds = (reason) => {
\t\t\t\tconst visible = state.open === true && state.activeTab === "browser";
\t\t\t\tconst message = dshEmbeddedBrowserBoundsMessage(visible ? stage.getBoundingClientRect() : null, {
\t\t\t\t\tvisible,
\t\t\t\t\treason,
\t\t\t\t\tdevicePixelRatio: window.devicePixelRatio
\t\t\t\t});
\t\t\t\tconst post = window.chrome?.webview?.postMessage;
\t\t\t\tif (typeof post === "function") post.call(window.chrome.webview, message);
\t\t\t\twindow.dispatchEvent(new CustomEvent(DSH_EMBEDDED_BROWSER_BOUNDS_EVENT, { detail: message }));
\t\t\t};
\t\t\t/* 同一帧内合帧上报时保留更具体的 reason：ResizeObserver 的 resize 不能盖掉 tab-change / workspace-toggle。 */
\t\t\tconst reasonRank = { "resize": 0, "window-state": 1, "tab-change": 2, "workspace-toggle": 3 };
\t\t\tconst scheduleBounds = (reason) => {
\t\t\t\tif (boundsFrame === 0 || (reasonRank[reason] ?? 0) > (reasonRank[boundsReason] ?? 0)) boundsReason = reason;
\t\t\t\tif (boundsFrame !== 0) return;
\t\t\t\tboundsFrame = window.requestAnimationFrame(() => {
\t\t\t\t\tboundsFrame = 0;
\t\t\t\t\tpublishBounds(boundsReason);
\t\t\t\t});
\t\t\t};

\t\t\tconst syncToolbars = () => {
\t\t\t\tconst browserEnabled = capabilities.embeddedBrowser.enabled === true;
\t\t\t\tfor (const button of navButtons) {
\t\t\t\t\tconst nav = button.dataset.dshBrowserNav;
\t\t\t\t\tbutton.disabled = !browserEnabled
\t\t\t\t\t\t|| (nav === "back" && browserState.canGoBack !== true)
\t\t\t\t\t\t|| (nav === "forward" && browserState.canGoForward !== true);
\t\t\t\t\tbutton.title = browserEnabled ? "" : capabilities.embeddedBrowser.reason;
\t\t\t\t}
\t\t\t\turlInput.disabled = !browserEnabled;
\t\t\t\turlInput.placeholder = browserEnabled ? DSH_WORKSPACE_COPY.browserUrlReadyPlaceholder : DSH_WORKSPACE_COPY.browserUrlPlaceholder;
\t\t\t\tbrowserGo.disabled = !browserEnabled || urlInput.value.trim() === "";
\t\t\t\tbrowserGo.title = browserEnabled ? "" : capabilities.embeddedBrowser.reason;
\t\t\t\tconst composerElementReady = dshWorkspaceComposerReady("browser-element");
\t\t\t\tconst composerErrorsReady = dshWorkspaceComposerReady("console-errors");
\t\t\t\tconst unsentErrors = consoleErrors.filter((entry) => entry.sent !== true).length;
\t\t\t\tsendElementLabel.textContent = pickedElements.length > 0
\t\t\t\t\t? DSH_WORKSPACE_COPY.browserSendElement + " (" + pickedElements.length + ")"
\t\t\t\t\t: DSH_WORKSPACE_COPY.browserPickElement;
\t\t\t\tsendErrorsLabel.textContent = DSH_WORKSPACE_COPY.browserConsoleErrors + " (" + unsentErrors + ")";
\t\t\t\t/* 能力探测先行：缺能力或缺 composer 桥直接 disabled 并写明原因，不假装可用。 */
\t\t\t\tsendElement.disabled = !browserEnabled || (pickedElements.length > 0 && !composerElementReady);
\t\t\t\tsendErrors.disabled = !browserEnabled || !composerErrorsReady || unsentErrors === 0;
\t\t\t\tsendElement.title = browserEnabled
\t\t\t\t\t? (pickedElements.length > 0 && !composerElementReady ? DSH_WORKSPACE_COPY.disabledNoComposerBridge : DSH_WORKSPACE_COPY.browserPickedReady)
\t\t\t\t\t: capabilities.embeddedBrowser.reason;
\t\t\t\tsendErrors.title = browserEnabled
\t\t\t\t\t? (composerErrorsReady ? "" : DSH_WORKSPACE_COPY.disabledNoComposerBridge)
\t\t\t\t\t: capabilities.embeddedBrowser.reason;
\t\t\t\tstage.dataset.dshBrowserReserved = browserEnabled ? "false" : "true";
\t\t\t\tbrowserEmpty.hidden = browserEnabled;
\t\t\t\t/* 能力可用时不显示内部原因串，避免把 capability 这种标记漏给用户看。 */
\t\t\t\tbrowserReason.textContent = browserEnabled ? "" : capabilities.embeddedBrowser.reason;
\t\t\t\tterminalInput.disabled = capabilities.terminal.enabled !== true;
\t\t\t\tterminalInput.title = capabilities.terminal.enabled === true ? "" : capabilities.terminal.reason;
\t\t\t\tterminalRun.disabled = capabilities.terminal.enabled !== true || terminalInput.value.trim() === "" || terminalRequests.size > 0;
\t\t\t\tterminalRun.title = capabilities.terminal.enabled === true ? "" : capabilities.terminal.reason;
\t\t\t};

\t\t\tconst render = (reason) => {
\t\t\t\tconst resolved = dshResolveWorkspaceVisibility({
\t\t\t\t\tviewportWidth: window.innerWidth,
\t\t\t\t\twidth: state.width,
\t\t\t\t\tuserOpen: state.userOpen,
\t\t\t\t\tcapable: capabilities.rightWorkspace.enabled
\t\t\t\t});
\t\t\t\tstate.width = resolved.width;
\t\t\t\tstate.open = resolved.open;
\t\t\t\tstate.autoCollapsed = resolved.autoCollapsed;
\t\t\t\tbody.style.setProperty("--dsh-workspace-width", state.width + "px");
\t\t\t\tif (html.dataset.dshWorkspaceReflow === undefined) html.dataset.dshWorkspaceReflow = "body-padding";
\t\t\t\tbody.dataset.dshWorkspaceOpen = state.open ? "true" : "false";
\t\t\t\tshell.dataset.dshWorkspaceReason = resolved.reason;
\t\t\t\tshell.dataset.dshWorkspaceTab = state.activeTab;
\t\t\t\t/* R4 D8：窄面板隐藏左列文件树，把宽度让给正文；W4 沿用同一个属性。 */
\t\t\t\tshell.dataset.dshCompactTree = state.width < DSH_WORKSPACE_COMPACT_TREE_WIDTH ? "true" : "false";
\t\t\t\ttoggle.setAttribute("aria-pressed", state.open ? "true" : "false");
\t\t\t\ttoggle.setAttribute("aria-label", state.open ? DSH_WORKSPACE_COPY.toggleClose : DSH_WORKSPACE_COPY.toggleOpen);
\t\t\t\ttoggle.disabled = capabilities.rightWorkspace.enabled !== true;
\t\t\t\tfor (const [id, tab] of tabs) {
\t\t\t\t\ttab.setAttribute("aria-selected", id === state.activeTab ? "true" : "false");
\t\t\t\t}
\t\t\t\tfor (const [id, pane] of panes) {
\t\t\t\t\tpane.hidden = id !== state.activeTab;
\t\t\t\t}
\t\t\t\tsyncToolbars();
\t\t\t\tscheduleBounds(reason);
\t\t\t};

\t\t\tconst persist = () => {
\t\t\t\tdshWorkspaceWriteLocalRaw({ open: state.userOpen, activeTab: state.activeTab, width: state.width });
\t\t\t};

\t\t\tconst onToggle = () => {
\t\t\t\tstate.userOpen = !state.userOpen;
\t\t\t\trender("workspace-toggle");
\t\t\t\tpersist();
\t\t\t};
\t\t\ttoggle.addEventListener("click", onToggle);
\t\t\tcloseButton.addEventListener("click", () => {
\t\t\t\tstate.userOpen = false;
\t\t\t\trender("workspace-toggle");
\t\t\t\tpersist();
\t\t\t});
\t\t\tnav.addEventListener("click", (event) => {
\t\t\t\tconst target = event.target instanceof Element ? event.target.closest("[data-dsh-ws-tab]") : null;
\t\t\t\tif (target === null) return;
\t\t\t\tconst id = target.dataset.dshWsTab;
\t\t\t\tif (!DSH_WORKSPACE_TABS.includes(id) || id === state.activeTab) return;
\t\t\t\tstate.activeTab = id;
\t\t\t\trender("tab-change");
\t\t\t\tpersist();
\t\t\t});

\t\t\tlet dragPointer = null;
\t\t\thandle.addEventListener("pointerdown", (event) => {
\t\t\t\tdragPointer = event.pointerId;
\t\t\t\thandle.setPointerCapture?.(event.pointerId);
\t\t\t\tevent.preventDefault();
\t\t\t});
\t\t\thandle.addEventListener("pointermove", (event) => {
\t\t\t\tif (dragPointer !== event.pointerId) return;
\t\t\t\tstate.width = dshClampWorkspaceWidth(window.innerWidth - event.clientX, window.innerWidth);
\t\t\t\trender("resize");
\t\t\t});
\t\t\tconst endDrag = (event) => {
\t\t\t\tif (dragPointer !== event.pointerId) return;
\t\t\t\tdragPointer = null;
\t\t\t\thandle.releasePointerCapture?.(event.pointerId);
\t\t\t\tpersist();
\t\t\t};
\t\t\thandle.addEventListener("pointerup", endDrag);
\t\t\thandle.addEventListener("pointercancel", endDrag);
\t\t\thandle.addEventListener("keydown", (event) => {
\t\t\t\tconst delta = event.key === "ArrowLeft" ? DSH_WORKSPACE_WIDTH_STEP : event.key === "ArrowRight" ? -DSH_WORKSPACE_WIDTH_STEP : 0;
\t\t\t\tif (delta === 0) return;
\t\t\t\tevent.preventDefault();
\t\t\t\tstate.width = dshClampWorkspaceWidth(state.width + delta, window.innerWidth);
\t\t\t\trender("resize");
\t\t\t\tpersist();
\t\t\t});

\t\t\tconst onResize = () => render("resize");
\t\t\twindow.addEventListener("resize", onResize);
\t\t\tconst onWindowState = () => render("window-state");
\t\t\twindow.addEventListener("visibilitychange", onWindowState);
\t\t\tdoc.addEventListener("visibilitychange", onWindowState);

\t\t\tconst onDesktopReady = () => {
\t\t\t\tcapabilities = dshResolveWorkspaceCapabilities(window.__dshDesktop);
\t\t\t\ttitlebarPlan = dshResolveTitlebarPlan(window.__dshDesktop);
\t\t\t\trenderTitlebar();
\t\t\t\trender("window-state");
\t\t\t};
\t\t\twindow.addEventListener(DSH_DESKTOP_READY_EVENT, onDesktopReady);

\t\t\tconst onElementPicked = (event) => {
\t\t\t\tconst payload = dshNormalizeBrowserElementPayload(event?.detail, new Date().toISOString());
\t\t\t\tif (payload === null) return;
\t\t\t\tpickedElements.push(payload);
\t\t\t\tsyncToolbars();
\t\t\t};
\t\t\twindow.addEventListener(DSH_BROWSER_ELEMENT_PICKED_EVENT, onElementPicked);

\t\t\t/* R4 D2：C#/第二 WebView2 送来的控制台错误批次（P15-7.1）。前端只收不采。 */
\t\t\tconst onConsoleErrors = (event) => {
\t\t\t\tconst detail = event?.detail;
\t\t\t\tif (detail === null || typeof detail !== "object") return;
\t\t\t\t/* reset 表示导航或刷新，旧 buffer 直接清空，避免把上一页错误算到新页上。 */
\t\t\t\tif (detail.reset === true) consoleErrors.length = 0;
\t\t\t\tconst entries = Array.isArray(detail.entries) ? detail.entries : [];
\t\t\t\tconst fallbackSource = typeof detail.url === "string" && detail.url !== "" ? detail.url : void 0;
\t\t\t\tfor (const entry of entries) {
\t\t\t\t\tif (entry === null || typeof entry !== "object") continue;
\t\t\t\t\tif (typeof entry.message !== "string" || entry.message === "") continue;
\t\t\t\t\tconsoleErrors.push({
\t\t\t\t\t\tmessage: entry.message,
\t\t\t\t\t\tstack: typeof entry.stack === "string" && entry.stack !== "" ? entry.stack : void 0,
\t\t\t\t\t\tsource: typeof entry.source === "string" && entry.source !== "" ? entry.source : fallbackSource,
\t\t\t\t\t\tline: typeof entry.line === "number" && Number.isFinite(entry.line) ? entry.line : void 0,
\t\t\t\t\t\tcolumn: typeof entry.column === "number" && Number.isFinite(entry.column) ? entry.column : void 0,
\t\t\t\t\t\ttime: typeof entry.time === "string" && entry.time !== "" ? entry.time : new Date().toISOString(),
\t\t\t\t\t\tsent: false
\t\t\t\t\t});
\t\t\t\t}
\t\t\t\t/* 未发送条目最多保留 20 条（P15-7.1）：从旧到新溢出，避免无上限增长。 */
\t\t\t\tlet unsent = 0;
\t\t\t\tfor (let index = consoleErrors.length - 1; index >= 0; index -= 1) {
\t\t\t\t\tif (consoleErrors[index].sent === true) continue;
\t\t\t\t\tunsent += 1;
\t\t\t\t\tif (unsent > DSH_CONSOLE_ERROR_LIMIT) consoleErrors.splice(index, 1);
\t\t\t\t}
\t\t\t\tsyncToolbars();
\t\t\t};
\t\t\twindow.addEventListener(DSH_BROWSER_CONSOLE_ERRORS_EVENT, onConsoleErrors);

\t\t\tconst onBrowserState = (event) => {
\t\t\t\tconst detail = event?.detail;
\t\t\t\tif (detail === null || typeof detail !== "object") return;
\t\t\t\tbrowserState = {
\t\t\t\t\turl: typeof detail.url === "string" ? detail.url : "",
\t\t\t\t\ttitle: typeof detail.title === "string" ? detail.title : "",
\t\t\t\t\tcanGoBack: detail.canGoBack === true,
\t\t\t\t\tcanGoForward: detail.canGoForward === true,
\t\t\t\t\tphase: typeof detail.phase === "string" ? detail.phase : "idle"
\t\t\t\t};
\t\t\t\tif (doc.activeElement !== urlInput && browserState.url !== "") urlInput.value = browserState.url;
\t\t\t\tsyncToolbars();
\t\t\t};
\t\t\twindow.addEventListener(DSH_BROWSER_STATE_EVENT, onBrowserState);

\t\t\tconst navigateBrowser = () => {
\t\t\t\tconst url = urlInput.value.trim();
\t\t\t\tif (url === "" || capabilities.embeddedBrowser.enabled !== true) return;
\t\t\t\tbrowserState = { ...browserState, url, phase: "loading" };
\t\t\t\tdshWorkspacePostMessage({ type: DSH_EMBEDDED_BROWSER_NAVIGATE_TYPE, url });
\t\t\t\tsyncToolbars();
\t\t\t};
\t\t\tbrowserGo.addEventListener("click", navigateBrowser);
\t\t\turlInput.addEventListener("input", syncToolbars);
\t\t\turlInput.addEventListener("keydown", (event) => {
\t\t\t\tif (event.key !== "Enter") return;
\t\t\t\tevent.preventDefault();
\t\t\t\tnavigateBrowser();
\t\t\t});
\t\t\tfor (const button of navButtons) {
\t\t\t\tbutton.addEventListener("click", () => {
\t\t\t\t\tif (button.disabled || capabilities.embeddedBrowser.enabled !== true) return;
\t\t\t\t\tdshWorkspacePostMessage({ type: DSH_EMBEDDED_BROWSER_HISTORY_TYPE, action: button.dataset.dshBrowserNav });
\t\t\t\t});
\t\t\t}

\t\t\tconst appendTerminalLog = (text, kind) => {
\t\t\t\tif (terminalLog.dataset.empty === "true") {
\t\t\t\t\tterminalLog.textContent = "";
\t\t\t\t\tterminalLog.dataset.empty = "false";
\t\t\t\t}
\t\t\t\tconst prefix = kind === "command" ? "> " : kind === "error" ? "! " : "";
\t\t\t\tterminalLog.textContent += (terminalLog.textContent === "" ? "" : "\\n") + prefix + String(text ?? "");
\t\t\t\tterminalLog.scrollTop = terminalLog.scrollHeight;
\t\t\t};
\t\t\tconst runTerminalCommand = () => {
\t\t\t\tconst command = terminalInput.value.trim();
\t\t\t\tif (command === "" || capabilities.terminal.enabled !== true || terminalRequests.size > 0) return;
\t\t\t\tconst id = "dsh-terminal-" + Date.now().toString(36) + "-" + (terminalSeq++).toString(36);
\t\t\t\tterminalRequests.set(id, { command, startedAt: Date.now() });
\t\t\t\tappendTerminalLog(command, "command");
\t\t\t\tterminalInput.value = "";
\t\t\t\tdshWorkspacePostMessage({ type: DSH_TERMINAL_RUN_TYPE, id, command });
\t\t\t\tsyncToolbars();
\t\t\t};
\t\t\tterminalRun.addEventListener("click", runTerminalCommand);
\t\t\tterminalInput.addEventListener("input", syncToolbars);
\t\t\tterminalInput.addEventListener("keydown", (event) => {
\t\t\t\tif (event.key !== "Enter") return;
\t\t\t\tevent.preventDefault();
\t\t\t\trunTerminalCommand();
\t\t\t});
\t\t\tconst onChromeMessage = (event) => {
\t\t\t\tconst data = event?.data;
\t\t\t\tif (data === null || typeof data !== "object" || data.type !== DSH_TERMINAL_RESPONSE_TYPE) return;
\t\t\t\tif (!terminalRequests.has(data.id)) return;
\t\t\t\tterminalRequests.delete(data.id);
\t\t\t\tif (data.ok === true && data.result !== null && typeof data.result === "object") {
\t\t\t\t\tif (typeof data.result.stdout === "string" && data.result.stdout !== "") appendTerminalLog(data.result.stdout.trimEnd(), "output");
\t\t\t\t\tif (typeof data.result.stderr === "string" && data.result.stderr !== "") appendTerminalLog(data.result.stderr.trimEnd(), "error");
\t\t\t\t\tappendTerminalLog(DSH_WORKSPACE_COPY.terminalExit + " " + String(data.result.exitCode ?? "?"), "output");
\t\t\t\t} else {
\t\t\t\t\tappendTerminalLog(String(data.error || "终端命令失败"), "error");
\t\t\t\t}
\t\t\t\tsyncToolbars();
\t\t\t};
\t\t\twindow.chrome?.webview?.addEventListener?.("message", onChromeMessage);

\t\t\t/* R4 D3：composer 接好后只唤醒一次重算，不把事件当成可用性真相。 */
\t\t\tconst onComposerReady = () => syncToolbars();
\t\t\twindow.addEventListener(DSH_COMPOSER_READY_EVENT, onComposerReady);

\t\t\tsendElement.addEventListener("click", () => {
\t\t\t\tconst payload = pickedElements[pickedElements.length - 1];
\t\t\t\tif (payload === undefined) {
\t\t\t\t\tdshWorkspacePostMessage({ type: DSH_EMBEDDED_BROWSER_PICK_TYPE });
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\t/* 不写 textarea，只派发事件（P15-7）。 */
\t\t\t\twindow.dispatchEvent(new CustomEvent(DSH_COMPOSER_EVENTS["browser-element"], { detail: payload }));
\t\t\t\tpickedElements.length = 0;
\t\t\t\tsyncToolbars();
\t\t\t});
\t\t\tsendErrors.addEventListener("click", () => {
\t\t\t\tconst payload = dshBuildConsoleErrorsPayload(consoleErrors);
\t\t\t\tif (payload === null) return;
\t\t\t\twindow.dispatchEvent(new CustomEvent(DSH_COMPOSER_EVENTS["console-errors"], { detail: payload }));
\t\t\t\tfor (const entry of consoleErrors) entry.sent = true;
\t\t\t\tsyncToolbars();
\t\t\t});

\t\t\tlet toolbarObserver = null;
\t\t\tif (typeof window.ResizeObserver === "function") {
\t\t\t\ttoolbarObserver = new window.ResizeObserver(() => scheduleBounds("resize"));
\t\t\t\ttoolbarObserver.observe(devToolbar);
\t\t\t\ttoolbarObserver.observe(stage);
\t\t\t}

\t\t\trenderTitlebar();
\t\t\trender("workspace-toggle");

\t\t\tdisposers.push(() => {
\t\t\t\twindow.removeEventListener("resize", onResize);
\t\t\t\twindow.removeEventListener("visibilitychange", onWindowState);
\t\t\t\tdoc.removeEventListener("visibilitychange", onWindowState);
\t\t\t\twindow.removeEventListener(DSH_DESKTOP_READY_EVENT, onDesktopReady);
\t\t\t\twindow.removeEventListener(DSH_BROWSER_ELEMENT_PICKED_EVENT, onElementPicked);
\t\t\t\twindow.removeEventListener(DSH_BROWSER_CONSOLE_ERRORS_EVENT, onConsoleErrors);
\t\t\t\twindow.removeEventListener(DSH_BROWSER_STATE_EVENT, onBrowserState);
\t\t\t\twindow.removeEventListener(DSH_COMPOSER_READY_EVENT, onComposerReady);
\t\t\t\twindow.chrome?.webview?.removeEventListener?.("message", onChromeMessage);
\t\t\t\ttoolbarObserver?.disconnect();
\t\t\t\tif (boundsFrame !== 0) window.cancelAnimationFrame(boundsFrame);
\t\t\t\tshell.remove();
\t\t\t\ttoggle.remove();
\t\t\t\ttitlebar?.remove();
\t\t\t\tstyle.remove();
\t\t\t\tdelete body.dataset.dshWorkspaceOpen;
\t\t\t\tdelete html.dataset.dshWorkspaceReflow;
\t\t\t\tdelete html.dataset.dshDesktopTitlebar;
\t\t\t\tbody.style.removeProperty("--dsh-workspace-width");
\t\t\t\tbody.style.removeProperty("--dsh-desktop-titlebar-height");
\t\t\t});
\t\t\treturn () => {
\t\t\t\tfor (const dispose of disposers.splice(0)) dispose();
\t\t\t};
\t\t}
`;

/**
 * 对话界面前端展示补丁（Plan_15 W3）· 注入右侧工作区外壳运行时。
 *
 * 锚点取自干净基线 `0.1.0-rc.6-oauth` 唯一的 `apply(ctx)` 头部，Stage 11 的
 * G1/G3/G4/G6 都没有碰过这一段，因此与它们的锚点互不重叠、组合顺序无关。
 * 装载交给 `ctx.effect` 托管，卸载/HMR 时能整体移除，不留残余属性与 CSS 变量。
 * @param source - `dsh-client-ui-conversation/lib/client.js` 源码。
 * @returns 追加了工作区外壳运行时与装载点的源码。
 */
export function patchWorkspaceShellSource(source) {
  assertNotAlreadyPatched(source, "function installDshWorkspaceShell(", "Plan 15 右侧工作区外壳");
  return replaceExactlyOnce(
    source,
    `\t\tfunction apply(ctx) {
\t\t\tconst sessions = ctx.sessions;
\t\t\tconst workspaces = ctx.workspaces;`,
    `${WORKSPACE_RUNTIME_SOURCE}\t\tfunction apply(ctx) {
\t\t\tconst sessions = ctx.sessions;
\t\t\tconst workspaces = ctx.workspaces;
\t\t\tctx.effect(() => installDshWorkspaceShell(), "ui-conversation: dsh plan15 workspace shell");`,
    "Plan 15 右侧工作区外壳装载点",
  );
}
