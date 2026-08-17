#!/usr/bin/env node
/**
 * frontend-edit-shell-harness.mjs — 编辑重发外壳样式验收页生成器（Stage 11 / G3）
 *
 * 与 G1 的 `frontend-css-harness.mjs` 同一条原则：**不手抄样式**。
 *   - 我方样式直接 import `EDIT_RESEND_SHELL_STYLE`，与运行时注入的是同一份字符串
 *   - 上游 InputBar / MessageItem / MessageIconActions / PermissionSelect 的 CSS 与哈希类名
 *     从真实 release bundle 抽取
 *   - design token 直接 link 真实 `design-platform.css`
 *   - DOM 按真实 `InputBar` 的 card → attachments → scroll/grow/input → row(tools/trailing)
 *     结构复刻（baseline `client.js:3727-3939`）
 *
 * 诚实边界（务必与截图一并阅读）：
 *   - **模型选择器与模式选择器在真实运行时是主输入框那两份真实控件**（模型走
 *     `renderSlot("conversation.input.model")`，模式是 `PermissionSelect` + `/permission`）。
 *     本预览页没有插件运行时，所以这两处是**镜像 DOM**，只借真实 CSS 呈现体量与位置。
 *   - 本页只能验证静态布局（重叠、溢出、回折、禁用态对比、深浅色），
 *     点击、Esc、粘贴加图、真实模型切换必须在可见 renderer 上另行验收。
 *
 * 用法：
 *   node scripts/frontend-edit-shell-harness.mjs
 *   node scripts/frontend-edit-shell-harness.mjs --dark --out docs/evidence/stage11/frontend/g3/edit-shell-harness-dark.html
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EDIT_RESEND_SHELL_STYLE } from "../packages/dsh-runtime-patches/lib/transforms-frontend.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RELEASE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth";
const DEFAULT_OUT = "docs/evidence/stage11/frontend/g3/edit-shell-harness.html";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith("--") ? true : next;
    if (out[key] !== true) i += 1;
  }
  return out;
}

/** 抽出 bundle 里某个 CSS module 的字面量，marker 必须只命中一次。 */
function extractModuleCss(source, marker, label) {
  const matches = [...source.matchAll(/const css\$\d+ = "((?:[^"\\]|\\.)*)";/g)]
    .map((match) => JSON.parse(`"${match[1]}"`))
    .filter((css) => css.includes(marker));
  if (matches.length !== 1) {
    throw new Error(`${label} 的 CSS 在真实 release 中命中 ${matches.length} 次，结构已变化，停止生成验收页`);
  }
  return matches[0];
}

/** 从抽出的 CSS 里回读哈希前缀，避免手写类名与 bundle 漂移。 */
function extractPrefix(css, className, label) {
  const found = /\.([A-Za-z0-9_-]+)_/.exec(new RegExp(`\\.([A-Za-z0-9_-]+)_${className}\\b`).exec(css)?.[0] ?? "");
  if (found === null) throw new Error(`${label} 的哈希类名前缀未找到，结构已变化，停止生成验收页`);
  return found[1];
}

const args = parseArgs(process.argv);
const releaseRoot = typeof args.release === "string" ? args.release : DEFAULT_RELEASE;
const outPath = path.resolve(workspaceRoot, typeof args.out === "string" ? args.out : DEFAULT_OUT);

const conversationClient = await readFile(
  path.join(releaseRoot, "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"),
  "utf8",
);
const inputBarCss = extractModuleCss(conversationClient, "_cardWorkspaceTrigger", "InputBar.module.css");
const messageItemCss = extractModuleCss(conversationClient, "_userStack", "MessageItem.module.css");
const iconActionsCss = extractModuleCss(conversationClient, "_runTimeDot", "MessageIconActions.module.css");
const permissionCss = extractModuleCss(conversationClient, "_triggerLabel", "PermissionSelect.module.css");
const chatViewCss = extractModuleCss(conversationClient, "_flowItem", "ChatView.module.css");

const ib = (name) => `${extractPrefix(inputBarCss, "cardWorkspaceTrigger", "InputBar.module.css")}_${name}`;
const mi = (name) => `${extractPrefix(messageItemCss, "userStack", "MessageItem.module.css")}_${name}`;
const ia = (name) => `${extractPrefix(iconActionsCss, "runTimeDot", "MessageIconActions.module.css")}_${name}`;
const ps = (name) => `${extractPrefix(permissionCss, "triggerLabel", "PermissionSelect.module.css")}_${name}`;
const cv = (name) => `${extractPrefix(chatViewCss, "flowItem", "ChatView.module.css")}_${name}`;

const themeCssUrl = pathToFileURL(
  path.join(releaseRoot, "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css"),
).href;

const ICON_COPY = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 3.5H4.5a1 1 0 0 0-1 1v6" stroke="currentColor" stroke-width="1.2"/></svg>';
const ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.4 2.9a1.4 1.4 0 0 1 2 2L6 12.3l-2.8.8.8-2.8 7.4-7.4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor"/></svg>';
const ICON_SHIELD = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2 12.6 3.6v4c0 3-2.1 5.1-4.6 6.2C5.5 12.7 3.4 10.6 3.4 7.6v-4L8 2.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_BOLT = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9 1.8 4.2 9h3.1l-.9 5.2L11.8 7H8.6L9 1.8Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/></svg>';
const CHEV_DOWN = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 5.5 7 9l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

const MESSAGE_TEXT = "你看看咱们 UI 这种，相同种类的操作可收叠展开。折叠态只显示一行纯文本感的摘要，展开态才是完整 Markdown 是什么意思，没听懂。";

/** 静止态：真实 MessageItem 结构 + MessageIconActions 按钮行（复制 + 铅笔）。 */
function idleRow({ forceHover }) {
  return `<div class="${mi("userRow")}${forceHover ? " forcehover" : ""}" data-time-hover-root>
  <div class="${mi("userStack")}">
    <div class="${mi("bubble")}">${MESSAGE_TEXT}</div>
  </div>
  <div class="${ia("actions")}">
    <span class="${ia("timeStart")}">15:42</span>
    <button type="button" class="${ia("action")}" aria-label="复制">${ICON_COPY}</button>
    <button type="button" class="${ia("action")}" data-dsh-msg-action="edit" aria-label="编辑并重新发送">${ICON_EDIT}</button>
  </div>
</div>`;
}

/** 镜像的模式/模型触发器：借真实 PermissionSelect trigger 样式呈现体量。 */
function seatMirror({ icon, label, sub }) {
  return `<button type="button" class="${ps("trigger")}" data-mirror>
  <span class="${ps("triggerIcon")}" aria-hidden="true">${icon}</span>
  <span class="${ps("triggerLabel")}">${label}${sub === undefined ? "" : ` <span style="color:var(--dsw-alias-label-caption)">${sub}</span>`}</span>
  <span class="${ps("chevron")}" aria-hidden="true">${CHEV_DOWN}</span>
</button>`;
}

/** 编辑态卡片：结构与真实 InputBar 一致，类名同源。 */
function editShell({ blocked, chips = [], gallery = false, effects = null, text = MESSAGE_TEXT }) {
  const chipRow = chips.length === 0
    ? ""
    : `<div class="dsh-er-chips">${chips.map((chip) => `<span class="dsh-er-chip">
      <img src="data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><rect width="22" height="22" fill="${chip.tint}"/></svg>`)}" alt="" aria-hidden="true">
      <span title="${chip.name}">${chip.name}</span>
      <button type="button" class="dsh-er-chipdrop" aria-label="移除 ${chip.name}">${ICON_CLOSE}</button>
    </span>`).join("")}</div>`;
  const galleryRow = gallery
    ? `<div class="dsh-er-gallery"><div style="display:flex;gap:6px">${["#c9d4e4", "#e4d5c9"].map((tint) => `<span style="display:block;width:56px;height:56px;border-radius:10px;background:${tint}"></span>`).join("")}</div></div>`
    : "";
  const effectRows = effects === null
    ? ""
    : `<button type="button" class="dsh-er-effects" aria-expanded="true"><span class="dsh-er-chev" aria-hidden="true"></span>不会被撤销的外部副作用（${effects.length}）</button>
    <ul class="dsh-er-efflist">${effects.map((row) => `<li><em>${row.label}</em>${row.detail === undefined ? "" : ` · ${row.detail}`}</li>`).join("")}</ul>`;
  return `<div data-dsh-edit-shell>
  <div class="${ib("card")}" data-dsh-edit-card>
    ${galleryRow}
    ${chipRow}
    <div class="${ib("scroll")}" data-dsh-edit-scroll>
      <div class="${ib("grow")}">
        <div aria-hidden="true" class="${ib("backdrop")}">${text}</div>
        <textarea class="${ib("input")}" rows="2" aria-label="编辑这条消息">${text}</textarea>
        <div aria-hidden="true" class="${ib("mirror")}" data-dsh-edit-mirror>${text}
</div>
      </div>
    </div>
    <div class="${ib("row")}">
      <div class="${ib("tools")}">
        <button type="button" class="${ib("add")}" disabled aria-label="命令">${ICON_PLUS}</button>
        <div class="${ib("modes")}">${seatMirror({ icon: ICON_SHIELD, label: "Workspace Write" })}</div>
      </div>
      <div class="${ib("trailing")}">
        ${seatMirror({ icon: ICON_BOLT, label: "GLM-5.2 200K", sub: "极高" })}
        <button type="button" class="dsh-er-cancel">取消</button>
        <button type="button" class="${ib("primary")}"${blocked ? " disabled" : ""} aria-label="重新发送">${ICON_SEND}</button>
      </div>
    </div>
  </div>
  <div class="dsh-er-foot">
    <div class="dsh-er-note" data-dsh-edit-branch-note><i aria-hidden="true">⚠</i><span>发送后将从这条消息之前的状态创建新分支；Sandbox 执行、外部网站与远端提交等副作用不会被撤销。</span></div>
    ${effectRows}
    ${blocked ? '<div class="dsh-er-block" data-dsh-edit-capability="absent">重发接口尚未接入：可以编辑与取消，发送要等后端分支能力就绪。</div>' : ""}
  </div>
</div>`;
}

const sections = [
  {
    id: "D-edit-idle",
    label: "静止态（默认）：操作行 hover 才显现，所以这张图里气泡下方应当是空的",
    html: `<div class="${cv("column")}">${idleRow({ forceHover: false })}</div>`,
  },
  {
    id: "D-edit-idle-hover",
    label: "静止态（验收页强制模拟 hover）：复制图标右侧就是铅笔，同一行、同一套按钮样式",
    html: `<div class="${cv("column")}">${idleRow({ forceHover: true })}</div>`,
  },
  {
    id: "D-edit-blocked",
    label: "编辑态 · 后端未就绪：全宽卡片 + 编辑态高亮，发送禁用并写明原因；模式与模型位置为镜像 DOM",
    html: `<div class="${cv("column")}">${editShell({ blocked: true })}</div>`,
  },
  {
    id: "D-edit-ready",
    label: "编辑态 · 能力就绪：发送可用；原消息图片走 ImageGallery，粘贴/拖入的新图是可删 chip；副作用清单只有后端给了才出现",
    html: `<div class="${cv("column")}">${editShell({
      blocked: false,
      gallery: true,
      chips: [
        { name: "07-dsh-flat-model-menu.png", tint: "#dfe6f2" },
        { name: "剪贴板图片", tint: "#f1e3df" },
      ],
      effects: [
        { label: "Sandbox 已执行 3 条命令", detail: "文件系统改动不回滚" },
        { label: "远端提交", detail: "origin/main 已推送" },
      ],
    })}</div>`,
  },
];

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 编辑重发外壳样式验收页（G3）</title>
<link rel="stylesheet" href="${themeCssUrl}">
<style>/* 上游 InputBar.module.css（自真实 release 抽取） */
${inputBarCss}</style>
<style>/* 上游 MessageItem.module.css */
${messageItemCss}</style>
<style>/* 上游 MessageIconActions.module.css */
${iconActionsCss}</style>
<style>/* 上游 PermissionSelect.module.css */
${permissionCss}</style>
<style>/* 上游 ChatView.module.css */
${chatViewCss}</style>
<style>/* 本窗口注入的编辑重发样式（与运行时同一份字符串） */
${EDIT_RESEND_SHELL_STYLE}</style>
<style>
/* 验收页专用：真实运行时这条规则由 dshEnsureMessageActionHoverStyle() 用真实哈希类名注入 */
@media (hover:hover){.${mi("userRow")} .${ia("action")}{opacity:0;transition:opacity 80ms}.${mi("userRow")}:hover .${ia("action")},.${mi("userRow")}:focus-within .${ia("action")}{opacity:1}}
.${mi("userRow")}.forcehover .${ia("action")},.${mi("userRow")}.forcehover .${ia("timeStart")}{opacity:1}
body{margin:0;padding:24px 32px 56px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  --dsh-composer-card-max-width:760px;--dsh-composer-side-clearance:0px;--dsh-chat-content-width:760px}
h1{font-size:18px;margin:0 0 4px}
.note{color:var(--dsw-alias-label-tertiary);font-size:12.5px;margin:0 0 20px;max-width:860px}
.case{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 16px;margin:0 0 16px;max-width:860px;background:var(--dsw-alias-bg-layer-1)}
.case > .cap{color:var(--dsw-alias-label-caption);font-size:11.5px;margin:0 0 10px}
.themebar{display:flex;gap:8px;margin:0 0 18px}
.themebar button{font:inherit;font-size:12.5px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer}
[data-mirror]{cursor:default}
</style>
</head>
<body${args.dark === true ? " data-ds-dark-theme" : ""}>
<h1>DSH 编辑重发外壳样式验收页（G3 · 批次 D）</h1>
<p class="note">样式与 DOM 类名全部取自真实 release 与真实注入字符串。<b>模式与模型触发器是镜像 DOM</b>：真实运行时它们是主输入框那两份真实控件（模型走 <code>renderSlot("conversation.input.model")</code>，模式走 <code>PermissionSelect</code> + <code>/permission</code>），本页没有插件运行时。只验证静态布局与禁用态对比；点击、Esc、粘贴加图、真实模型切换必须在可见 renderer 上另行验收。</p>
<div class="themebar">
  <button type="button" onclick="document.body.removeAttribute('data-ds-dark-theme')">浅色</button>
  <button type="button" onclick="document.body.setAttribute('data-ds-dark-theme','')">深色</button>
</div>
${sections.map((section) => `<div class="case" id="${section.id}"><p class="cap">${section.label}</p>${section.html}</div>`).join("\n")}
</body>
</html>
`;

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, html, "utf8");
process.stdout.write(`编辑重发验收页已生成：${outPath}\n`);
