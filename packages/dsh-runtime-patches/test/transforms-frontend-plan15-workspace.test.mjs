import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DSH_BROWSER_CONSOLE_ERRORS_EVENT,
  DSH_COMPOSER_EVENTS,
  DSH_COMPOSER_READY_EVENT,
  DSH_WORKSPACE_COMPACT_TREE_WIDTH,
  DSH_CONSOLE_ERROR_LIMIT,
  DSH_EMBEDDED_BROWSER_BOUNDS_EVENT,
  DSH_EMBEDDED_BROWSER_MESSAGE_TYPE,
  DSH_WORKSPACE_DEFAULT_WIDTH,
  DSH_WORKSPACE_LOCAL_KEY,
  DSH_WORKSPACE_MAX_WIDTH_PX,
  DSH_WORKSPACE_MIN_WIDTH,
  DSH_WORKSPACE_SHELL_STYLE,
  dshBuildConsoleErrorsPayload,
  dshClampWorkspaceWidth,
  dshEmbeddedBrowserBoundsMessage,
  dshNormalizeBrowserElementPayload,
  dshReadWorkspaceLocalState,
  dshResolveTitlebarPlan,
  dshResolveWorkspaceCapabilities,
  dshResolveWorkspaceVisibility,
  dshWriteWorkspaceLocalState,
  patchWorkspaceShellSource,
} from "../lib/frontend/workspace-panel.mjs";
import { patchConversationUiSource } from "../lib/transforms.mjs";

/** 干净锚点基线；缺失时跳过依赖 release 的用例，不让没装 DSH 的环境直接失败。 */
const BASELINE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai";
const baselineAvailable = existsSync(BASELINE);

/** 无基线时也能验证锚点契约的最小 stub（与干净基线 apply 头部逐字节一致）。 */
const APPLY_STUB = [
  "\t\tfunction apply(ctx) {",
  "\t\t\tconst sessions = ctx.sessions;",
  "\t\t\tconst workspaces = ctx.workspaces;",
  "\t\t\tconst layout = ctx.layout;",
  "\t\t}",
].join("\n");

function conversationBaseline() {
  return readFileSync(path.join(BASELINE, "dsh-client-ui-conversation", "lib", "client.js"), "utf8");
}

function assertSyntaxOk(name, source) {
  const dir = path.join(tmpdir(), "dsh-frontend-plan15-workspace");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  writeFileSync(file, source, "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/* ==================== 宽度契约（440 / 360 / min(55vw,720)） ==================== */

test("宽度默认 440、下限 360、上限 min(55vw, 720px)", () => {
  assert.equal(DSH_WORKSPACE_DEFAULT_WIDTH, 440);
  assert.equal(DSH_WORKSPACE_MIN_WIDTH, 360);
  assert.equal(DSH_WORKSPACE_MAX_WIDTH_PX, 720);
  assert.equal(dshClampWorkspaceWidth(440, 1920), 440);
  assert.equal(dshClampWorkspaceWidth(100, 1920), 360);
  assert.equal(dshClampWorkspaceWidth(5000, 1920), 720);
  /* 55vw 生效：1000px 视口的上限是 550px，不是 720px。 */
  assert.equal(dshClampWorkspaceWidth(700, 1000), 550);
  /* 上限低于下限时不偷偷压到 300px，交给自动收起处理。 */
  assert.equal(dshClampWorkspaceWidth(440, 600), 360);
  assert.equal(dshClampWorkspaceWidth(Number.NaN, 1920), 440);
  assert.equal(dshClampWorkspaceWidth("440", 1920), 440);
});

/* ==================== 本地状态：写 .local，不写 .draft ==================== */

test("持久化 key 是 dsh.appearance.v1.local，不是外观草稿", () => {
  assert.equal(DSH_WORKSPACE_LOCAL_KEY, "dsh.appearance.v1.local");
  assert.ok(!DSH_WORKSPACE_LOCAL_KEY.endsWith(".draft"));
});

test("readWorkspaceLocalState 形状不符一律回落默认值", () => {
  const fallback = { open: false, activeTab: "files", width: 440 };
  assert.deepEqual(dshReadWorkspaceLocalState(null), fallback);
  assert.deepEqual(dshReadWorkspaceLocalState("{"), fallback);
  assert.deepEqual(dshReadWorkspaceLocalState("[]"), fallback);
  assert.deepEqual(dshReadWorkspaceLocalState(JSON.stringify({ workspace: null })), fallback);
  assert.deepEqual(dshReadWorkspaceLocalState(JSON.stringify({ workspace: { open: "yes", activeTab: "sql", width: 9e9 } })), {
    open: false,
    activeTab: "files",
    width: 720,
  });
  assert.deepEqual(dshReadWorkspaceLocalState(JSON.stringify({ workspace: { open: true, activeTab: "browser", width: 512 } })), {
    open: true,
    activeTab: "browser",
    width: 512,
  });
});

test("写回 local 时保留同 key 下 W1/W2 的其它字段", () => {
  const raw = JSON.stringify({ appearance: { mode: "glass" }, workspace: { open: false, activeTab: "files", width: 440 } });
  const next = JSON.parse(dshWriteWorkspaceLocalState(raw, { open: true, activeTab: "terminal", width: 480 }));
  assert.deepEqual(next.appearance, { mode: "glass" });
  assert.deepEqual(next.workspace, { open: true, activeTab: "terminal", width: 480 });
  /* 原始内容损坏时只重建 workspace，不抛错。 */
  assert.deepEqual(JSON.parse(dshWriteWorkspaceLocalState("not-json", { open: true, activeTab: "x", width: 1 })).workspace, {
    open: true,
    activeTab: "files",
    width: 360,
  });
});

/* ==================== 标题栏：缺桥或 native-panel 一律不渲染 ==================== */

test("没有 __dshDesktop 或 native-panel 时不渲染 DOM 标题栏", () => {
  assert.deepEqual(dshResolveTitlebarPlan(void 0), { mode: "native-panel", render: false, height: 36, reason: "no-desktop-bridge" });
  assert.equal(dshResolveTitlebarPlan({ titlebarMode: "native-panel" }).render, false);
  /* chromeMode: "web-chrome" 已在 R4 D5 正式废弃，只认 titlebarMode。 */
  assert.equal(dshResolveTitlebarPlan({ chromeMode: "web-chrome" }).render, false);
  const custom = dshResolveTitlebarPlan({ titlebarMode: "custom", titlebarHeight: 32, capabilities: { customTitlebar: true } });
  assert.deepEqual(custom, { mode: "custom", render: true, height: 32, reason: "custom-titlebar" });
});

test("R4 D5：capabilities.customTitlebar 不为 true 时仍按 native-panel", () => {
  /* C# 没实现无边框拖动/最大化/边缘 resize 前自绘会让窗口不可操作，宁可不画。 */
  for (const bridge of [
    { titlebarMode: "custom" },
    { titlebarMode: "custom", capabilities: null },
    { titlebarMode: "custom", capabilities: {} },
    { titlebarMode: "custom", capabilities: { customTitlebar: "true" } },
    { titlebarMode: "custom", capabilities: { customTitlebar: false } },
  ]) {
    const plan = dshResolveTitlebarPlan(bridge);
    assert.equal(plan.render, false);
    assert.equal(plan.mode, "native-panel");
    assert.equal(plan.reason, "custom-titlebar-capability-missing");
  }
});

/* ==================== 能力探测：缺能力直接禁用并写明原因 ==================== */

test("embeddedBrowser 只认严格 true，终端与文件本轮恒禁用", () => {
  const none = dshResolveWorkspaceCapabilities(void 0);
  assert.equal(none.hasDesktopBridge, false);
  assert.equal(none.embeddedBrowser.enabled, false);
  assert.equal(none.terminal.enabled, false);
  assert.equal(none.files.enabled, false);
  /* 普通浏览器/mock 下外壳仍可用，只有显式 false 才禁用。 */
  assert.equal(none.rightWorkspace.enabled, true);
  assert.equal(dshResolveWorkspaceCapabilities({ capabilities: { rightWorkspace: false } }).rightWorkspace.enabled, false);
  assert.equal(dshResolveWorkspaceCapabilities({ capabilities: { embeddedBrowser: "true" } }).embeddedBrowser.enabled, false);
  const ready = dshResolveWorkspaceCapabilities({ capabilities: { embeddedBrowser: true } });
  assert.equal(ready.embeddedBrowser.enabled, true);
  assert.equal(ready.terminal.enabled, false);
  assert.ok(none.embeddedBrowser.reason.length > 0);
});

/* ==================== 窄屏自动收起 ==================== */

test("正文可用宽度低于 720px 自动收起，视口变宽后可恢复", () => {
  const wide = dshResolveWorkspaceVisibility({ viewportWidth: 1440, width: 440, userOpen: true, capable: true });
  assert.deepEqual(wide, { open: true, autoCollapsed: false, width: 440, reason: "open" });
  const narrow = dshResolveWorkspaceVisibility({ viewportWidth: 1100, width: 440, userOpen: true, capable: true });
  assert.equal(narrow.open, false);
  assert.equal(narrow.autoCollapsed, true);
  assert.equal(narrow.reason, "narrow-viewport");
  /* 1160 = 720 正文 + 440 面板，刚好不收起。 */
  assert.equal(dshResolveWorkspaceVisibility({ viewportWidth: 1160, width: 440, userOpen: true, capable: true }).open, true);
  /* 用户手动关闭不是自动收起，视口变宽也不会被自动打开。 */
  const closed = dshResolveWorkspaceVisibility({ viewportWidth: 1920, width: 440, userOpen: false, capable: true });
  assert.equal(closed.autoCollapsed, false);
  assert.equal(closed.reason, "user-closed");
  assert.equal(dshResolveWorkspaceVisibility({ viewportWidth: 1920, width: 440, userOpen: true, capable: false }).reason, "capability-missing");
});

/* ==================== 内置浏览器坐标契约（P15-9.1） ==================== */

test("setBounds 消息形状与 reason 白名单", () => {
  const message = dshEmbeddedBrowserBoundsMessage({ left: 10.4, top: 20.6, width: 400.2, height: 300.8 }, {
    visible: true,
    reason: "tab-change",
    devicePixelRatio: 1.5,
  });
  assert.deepEqual(message, {
    type: DSH_EMBEDDED_BROWSER_MESSAGE_TYPE,
    visible: true,
    rect: { left: 10, top: 21, width: 400, height: 301 },
    devicePixelRatio: 1.5,
    reason: "tab-change",
  });
  assert.equal(DSH_EMBEDDED_BROWSER_MESSAGE_TYPE, "dsh.embeddedBrowser.setBounds");
  assert.equal(DSH_EMBEDDED_BROWSER_BOUNDS_EVENT, "dsh:embedded-browser:set-bounds");
  /* 未知 reason 归一到 resize，不透传乱值给 C#。 */
  assert.equal(dshEmbeddedBrowserBoundsMessage(null, { reason: "toolbar-resize" }).reason, "resize");
  /* 空矩形或零面积一律 visible:false，宁可让 C# 隐藏也不给错位置。 */
  assert.equal(dshEmbeddedBrowserBoundsMessage(null, { visible: true, reason: "resize" }).visible, false);
  assert.equal(dshEmbeddedBrowserBoundsMessage({ left: 0, top: 0, width: 0, height: 10 }, { visible: true }).visible, false);
  assert.equal(dshEmbeddedBrowserBoundsMessage(null, {}).devicePixelRatio, 1);
});

/* ==================== 元素回传与 console 批次 ==================== */

test("元素 payload 缺 url/tagName 一律 null，不补默认值冒充可发送", () => {
  assert.equal(dshNormalizeBrowserElementPayload(null, "t"), null);
  assert.equal(dshNormalizeBrowserElementPayload({ tagName: "div" }, "t"), null);
  assert.equal(dshNormalizeBrowserElementPayload({ url: "http://x/" }, "t"), null);
  const payload = dshNormalizeBrowserElementPayload({
    url: "http://127.0.0.1:5183/mock.html",
    tagName: "BUTTON",
    title: "沙盘",
    selector: "#btnPick",
    textPreview: "发送元素",
    rect: { x: 1.4, y: 2.6, width: 30, height: 24 },
    attributes: { id: "btnPick", class: "dsh-dev-pick", nope: "drop-me" },
    screenshot: "should-be-dropped",
  }, "2026-08-21T06:00:00.000Z");
  assert.equal(payload.kind, "browser-element");
  assert.equal(payload.tagName, "button");
  assert.equal(payload.pickedAt, "2026-08-21T06:00:00.000Z");
  assert.deepEqual(payload.rect, { x: 1, y: 3, width: 30, height: 24 });
  assert.deepEqual(payload.attributes, { id: "btnPick", class: "dsh-dev-pick" });
  assert.equal("screenshot" in payload, false);
  assert.equal("computedStyle" in payload, false);
});

test("console 批次只取未发送条目、上限 20，total 是真实条数", () => {
  assert.equal(DSH_CONSOLE_ERROR_LIMIT, 20);
  assert.equal(dshBuildConsoleErrorsPayload([]), null);
  assert.equal(dshBuildConsoleErrorsPayload([{ message: "x", sent: true }]), null);
  const entries = Array.from({ length: 25 }, (_, index) => ({ message: `err-${index}`, time: "2026-08-21T06:00:00.000Z" }));
  const payload = dshBuildConsoleErrorsPayload(entries);
  assert.equal(payload.kind, "console-errors");
  assert.equal(payload.errors.length, 20);
  assert.equal(payload.total, 25);
  assert.equal(payload.errors[0].message, "err-0");
});

test("R4 D2/D3：新冻结的事件名，且 composer 就绪不再走 __dshComposerBridge", () => {
  assert.equal(DSH_BROWSER_CONSOLE_ERRORS_EVENT, "dsh:browser:console-errors");
  assert.equal(DSH_COMPOSER_READY_EVENT, "dsh:composer:ready");
  const patched = patchWorkspaceShellSource(APPLY_STUB);
  /* 函数是同步真相：__dshComposerAccepts 必须在，退化字段必须彻底删掉。 */
  assert.ok(patched.includes("window.__dshComposerAccepts"));
  assert.equal(patched.includes("__dshComposerBridge"), false);
  /* ready 事件只负责唤醒一次重算，不当可用性真相。 */
  assert.ok(patched.includes("const onComposerReady = () => syncToolbars();"));
  assert.ok(patched.includes("window.addEventListener(DSH_COMPOSER_READY_EVENT, onComposerReady);"));
  /* reset 清空旧 buffer + 未发送上限，两条都要在注入的运行时里。 */
  assert.ok(patched.includes("if (detail.reset === true) consoleErrors.length = 0;"));
  assert.ok(patched.includes("if (unsent > DSH_CONSOLE_ERROR_LIMIT) consoleErrors.splice(index, 1);"));
  /* 只接 error 三类：模块不得自己挂 console/warn 采集。 */
  for (const name of ["console.warn", "addEventListener(\"error\"", "unhandledrejection", "console.error ="]) {
    assert.equal(patched.includes(name), false, `不应自采 ${name}`);
  }
  /* 两个监听器都要在 teardown 里摘掉。 */
  assert.ok(patched.includes("window.removeEventListener(DSH_BROWSER_CONSOLE_ERRORS_EVENT, onConsoleErrors);"));
  assert.ok(patched.includes("window.removeEventListener(DSH_COMPOSER_READY_EVENT, onComposerReady);"));
});

test("R4 D8：compact tree 阈值 420，样式与 render 都按同一个属性走", () => {
  assert.equal(DSH_WORKSPACE_COMPACT_TREE_WIDTH, 420);
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes("--dsh-workspace-tree-width:clamp(128px, 34%, 168px)"));
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes('#dsh-workspace-shell[data-dsh-compact-tree="true"] .dsh-ws-tree{display:none}'));
  const patched = patchWorkspaceShellSource(APPLY_STUB);
  assert.ok(patched.includes('shell.dataset.dshCompactTree = state.width < DSH_WORKSPACE_COMPACT_TREE_WIDTH ? "true" : "false";'));
  /* R4 D1/D9：让位开关与 toggle 三条定位规则不得写死消失。 */
  assert.ok(patched.includes('html.dataset.dshWorkspaceReflow = "body-padding"'));
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes('html[data-dsh-workspace-reflow="body-padding"] body[data-dsh-workspace-open="true"]{padding-inline-end:var(--dsh-workspace-width)}'));
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes("#dsh-workspace-toggle{position:fixed;top:10px;right:12px"));
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes('html[data-dsh-desktop-titlebar="custom"] #dsh-workspace-toggle{top:calc(var(--dsh-desktop-titlebar-height) + 10px)}'));
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes('body[data-dsh-workspace-open="true"] #dsh-workspace-toggle{right:calc(var(--dsh-workspace-width) + 12px)}'));
});

test("composer 事件名按 kind 拆开，禁止复用 add-text", () => {
  assert.deepEqual(DSH_COMPOSER_EVENTS, {
    "browser-element": "dsh:composer:add-browser-element",
    "console-errors": "dsh:composer:add-console-errors",
    "workspace-annotation": "dsh:composer:add-workspace-annotations",
    "file-selection": "dsh:composer:add-file-selection",
  });
  assert.equal(Object.values(DSH_COMPOSER_EVENTS).includes("dsh:composer:add-text"), false);
});

/* ==================== 样式硬要求（P15-6.1 沙盘踩过的坑） ==================== */

test("tab 面板补了 [hidden] 规则，且只用 --dsh-workspace-* / --dsh-desktop-titlebar-* 命名空间", () => {
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes("body{\n--dsh-workspace-width:"));
  assert.equal(DSH_WORKSPACE_SHELL_STYLE.includes(":root{\n--dsh-workspace-width:"), false);
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes(".dsh-ws-body[hidden]{display:none}"));
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes("--dsh-workspace-max-width:min(55vw, 720px)"));
  const declared = [...DSH_WORKSPACE_SHELL_STYLE.matchAll(/(--dsh-[a-z0-9-]+):/g)].map((match) => match[1]);
  for (const name of declared) {
    assert.ok(
      name.startsWith("--dsh-workspace-") || name.startsWith("--dsh-desktop-titlebar-"),
      `声明了命名空间外的变量：${name}`,
    );
  }
  /* 默认值必须从现有 --dsw-* 派生。 */
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes("var(--dsw-alias-bg-layer-1)"));
  assert.ok(DSH_WORKSPACE_SHELL_STYLE.includes("var(--dsw-alias-border-l2)"));
});

/* ==================== 锚点与幂等 ==================== */

test("锚点在 stub 上唯一命中，重复 patch 抛 already patched", () => {
  const patched = patchWorkspaceShellSource(APPLY_STUB);
  assert.ok(patched.includes("function installDshWorkspaceShell("));
  assert.ok(patched.includes(`ctx.effect(() => installDshWorkspaceShell(), "ui-conversation: dsh plan15 workspace shell");`));
  assert.throws(() => patchWorkspaceShellSource(patched), /已存在于源码中/);
  assert.throws(() => patchWorkspaceShellSource("function apply(ctx) {}"), /停止修改候选版本/);
  assert.throws(() => patchWorkspaceShellSource(`${APPLY_STUB}\n${APPLY_STUB}`), /停止修改候选版本/);
});

test("干净基线上锚点唯一命中，产物语法有效且含契约标记", { skip: baselineAvailable ? false : "缺少干净基线 release" }, () => {
  const source = conversationBaseline();
  assert.equal(occurrences(source, "\t\tfunction apply(ctx) {\n\t\t\tconst sessions = ctx.sessions;\n\t\t\tconst workspaces = ctx.workspaces;"), 1);
  assert.equal(occurrences(source, "installDshWorkspaceShell"), 0, "锚点必须取自未打补丁的干净基线");
  const patched = patchWorkspaceShellSource(source);
  assertSyntaxOk("workspace-only", patched);
  assert.equal(occurrences(patched, "dsh.embeddedBrowser.setBounds"), 1);
  assert.ok(occurrences(patched, "dsh-workspace-shell") >= 1);
  assert.ok(patched.includes("dsh:embedded-browser:set-bounds"));
  assert.ok(patched.includes(".dsh-ws-body[hidden]{display:none}"));
  /* 不做成 overlay：面板是 fixed 工作台并给正文让位，不是盖在聊天区上的浮层。 */
  assert.ok(!patched.includes("dsh-workspace-overlay"));
});

test("patchConversationUiSource 主链已包含 W3/W4，组合后语法有效且各标志恰好一次", { skip: baselineAvailable ? false : "缺少干净基线 release" }, () => {
  const source = conversationBaseline();
  const full = patchConversationUiSource(source);
  assertSyntaxOk("stage11-with-workspace", full);
  for (const marker of ["function ActivityGroup", "function StardustCompactionStatus", "function DshTurnProcessCollapse"]) {
    assert.equal(occurrences(full, marker), 1, `${marker} 必须恰好一次`);
  }
  assert.equal(occurrences(full, "function installDshWorkspaceShell("), 1);
  assert.equal(occurrences(full, "function installDshFileViewer("), 1);
  assert.throws(() => patchWorkspaceShellSource(full), /已存在于源码中/);
});
