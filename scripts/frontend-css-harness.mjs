#!/usr/bin/env node
/**
 * frontend-css-harness.mjs — 活动轨迹样式验收页生成器（Stage 11 / G1）
 *
 * 存在的理由：手抄一份 CSS 去截图，等于自己骗自己。本脚本保证验收页里的样式
 * 与真正注入运行时的字符串是同一份：
 *   - 我方样式直接 import `ACTIVITY_TRACK_CSS`，不允许复制粘贴
 *   - 上游 ReasoningRow / ChatView 的 CSS 与哈希类名从真实 release bundle 抽取
 *   - design token 直接 link 真实 `dsh-client-ui-theme/lib/styles/design-platform.css`
 *   - DOM 结构按真实 `DisclosureRow` / `ReasoningRow` / `ChatNodeSeat` 的产出复刻
 *
 * 它只能验证静态样式（布局、重叠、溢出、渐隐、深浅色），不能替代真实候选验收：
 * 真实事件、流式增长、点击折叠必须在可见的 DSH renderer 上走一遍。
 *
 * 用法：
 *   node scripts/frontend-css-harness.mjs
 *   node scripts/frontend-css-harness.mjs --release <干净 release 根> --out <html 路径> --dark
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ACTIVITY_TRACK_CSS } from "../packages/dsh-runtime-patches/lib/transforms-frontend.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RELEASE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth";
const DEFAULT_OUT = "docs/evidence/stage11/frontend/g1/activity-track-harness.html";

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
const reasoningCss = extractModuleCss(conversationClient, "_thinkBody", "ReasoningRow.module.css");
const chatViewCss = extractModuleCss(conversationClient, "_flowItem", "ChatView.module.css");
const reasoningPrefix = extractPrefix(reasoningCss, "thinkBody", "ReasoningRow.module.css");
const chatViewPrefix = extractPrefix(chatViewCss, "flowItem", "ChatView.module.css");
const themeCssUrl = pathToFileURL(
  path.join(releaseRoot, "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css"),
).href;

const r = (name) => `${reasoningPrefix}_${name}`;
const c = (name) => `${chatViewPrefix}_${name}`;

const CHEVRON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 5.5 7 9l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const THINK_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.8 8.3 5 11.6 6l-3.3 1L7 10.2 5.7 7 2.4 6 5.7 5 7 1.8Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

const THINK_TAIL = [
  "主人要求的是「相同种类的操作可收叠展开」，所以我先去核对现有事件里到底有没有稳定的类别标记可用。",
  "找到了 <code>data-chat-semantic-kind</code>，取值是 think / code / tool，来源是节点结构而不是文案，可以放心当分组依据。",
  "但这个 release 里 <code>DisclosureRow</code> 的 CSS 是空 stub，行容器根本不是 flex，这才是计时标签压在摘要上的真实根因。",
  "所以我的样式必须把行布局补回来，而不是给计时加一个绝对定位去躲。",
  "组头耗时只认「第一项真实开始 → 最后一项真实结束」，任一缺失就写耗时未知，不拿别的项凑一个好看的数字。",
  "接下来把折叠态、展开态、运行中视窗三种形态各截一张，1440 与 768 都看一遍…",
].map((line) => `<p>${line}</p>`).join("");

/** 一条真实结构的思考行：DisclosureRow(row=[leading,title,collapsedContent]) + 展开体。 */
function reasoningRow({ running, open, summary, duration }) {
  const collapsed = running || !open
    ? `<span class="${r("separator")}" aria-hidden="true"></span>`
      + `<div data-think-summary class="${r("summary")}"${running ? ' data-follow-end' : ""}>${summary}</div>`
      + `<span data-activity-duration style="color:var(--dsw-alias-label-caption);flex:none;margin-left:8px;font-size:12px;line-height:20px">${duration}</span>`
    : "";
  const body = open
    ? `<div data-think-body class="${r("thinkBody")}">${THINK_TAIL}</div>`
    : "";
  return `<div class="${r("root")}" data-variant="think" data-state="${running ? "running" : "ok"}" data-chat-semantic-kind="think">
  <div>
    <div class="${r("row")}" data-disclosure-row data-expandable role="button" tabindex="0" aria-expanded="${open}">
      <span class="${r("leading")}">${open ? CHEVRON : THINK_ICON}</span>
      <span class="${r("title")}">${running ? "正在思考" : "思考"}</span>
      ${collapsed}
    </div>
    ${body}
  </div>
</div>`;
}

/**
 * 一条真实结构的工具行：callRow 上的行内栅格来自主线补丁，计时列宽由本样式统一。
 *
 * 行容器**故意不写行内 flex**：上游 `DisclosureRow` 的 CSS 是空 stub，行布局必须由
 * 注入样式补回来。写行内 flex 会让预览页自证通过而掩盖真实缺陷（窄屏标题竖排断字、
 * 分隔点飘到行顶、长摘要不省略号而换行）。
 */
function toolRow({ name, summary, duration, error = false }) {
  return `<div class="${c("callRow")}" data-chat-call-id="${name}" style="display:grid;grid-template-columns:minmax(0, 1fr) auto;align-items:start;column-gap:8px">
  <div class="${r("root")}" data-variant="tool" data-state="${error ? "error" : "ok"}">
    <div class="${r("row")}" data-disclosure-row>
      <span class="${r("leading")}">${THINK_ICON}</span>
      <span class="${r("title")}">${name}</span>
      <span class="${r("separator")}" aria-hidden="true"></span>
      <span class="${r("summary")}"${error ? " data-error" : ""}>${summary}</span>
    </div>
  </div>
  <span data-tool-activity-duration style="justify-self:end;white-space:nowrap;color:var(--dsw-alias-label-caption);font-size:12px;line-height:20px">${duration}</span>
</div>`;
}

/** 我方分组壳：类名与 data 属性必须和注入组件一致。 */
function group({ kind, title, count, duration, open, children, labelSource = "derived" }) {
  return `<div class="dsh-a-group" data-activity-group="${kind}" data-chat-semantic-kind="${kind}" data-activity-label-source="${labelSource}"${open ? " data-open" : ""}>
  <div class="dsh-a-ghead" role="button" tabindex="0" aria-expanded="${open}">
    <span class="dsh-a-chev" aria-hidden="true"></span>
    <span class="dsh-a-gtitle"><b>${title}</b><span class="dsh-a-gcount">${count}</span>${labelSource === "model" ? '<span class="dsh-a-gtag">模型标注</span>' : ""}</span>
    <span class="dsh-a-gmeta">${duration}</span>
  </div>
  ${open ? `<div class="dsh-a-gbody">${children}</div>` : ""}
</div>`;
}

const toolChildren = [
  toolRow({ name: "smart_search", summary: '"patchToolActivityPresentationSource"', duration: "1秒" }),
  toolRow({ name: "sandbox_exec", summary: "node --check lib/transforms.mjs", duration: "2秒" }),
  toolRow({ name: "sandbox_batch", summary: "3 个任务并行", duration: "3秒" }),
  toolRow({ name: "web_fetch_screenshot", summary: "file:///…/activity-track-harness.html", duration: "1秒" }),
].join("");

const thinkChildren = [
  reasoningRow({ running: false, open: false, summary: "<strong>确认中文提示规则加载器</strong>", duration: "5秒" }),
  reasoningRow({ running: false, open: false, summary: "提取运行状态注入的 19–129 行", duration: "4秒" }),
  reasoningRow({ running: false, open: false, summary: "核对 <code>candidate28</code> 打包内容", duration: "3秒" }),
].join("");

const sections = [
  {
    id: "g1-collapsed",
    label: "完成即折叠（主人 08/16 决定）：只剩一行灰色组头，单项活动不包组",
    html: `<div class="${c("column")}" data-chat-flow>
      ${group({ kind: "tool", title: "使用 Sandbox 与 web-fetcher", count: "5 次调用", duration: "8秒", open: false })}
      ${group({ kind: "think", title: "思考", count: "3 项", duration: "12分07秒", open: false })}
      ${toolRow({ name: "run_code", summary: "精读全局 Rules 加载与人格注入实现", duration: "2秒" })}
      ${toolRow({ name: "web_inspect", summary: "超时 30000ms", duration: "30秒", error: true })}
      ${group({ kind: "tool", title: "读取文件", count: "4 次", duration: "耗时未知", open: false })}
    </div>`,
  },
  {
    id: "g1-expanded",
    label: "展开态：组内左竖线串联，每项保留自己的时间与顺序",
    html: `<div class="${c("column")}" data-chat-flow>
      ${group({ kind: "tool", title: "使用 Sandbox 与 web-fetcher", count: "4 次调用", duration: "8秒", open: true, children: toolChildren })}
      ${group({ kind: "think", title: "思考", count: "3 项", duration: "12秒", open: true, children: thinkChildren })}
    </div>`,
  },
  {
    id: "g1-think-running",
    label: "运行中思考：252px 固定视窗只露尾部数行，顶部按真实容器背景渐隐，组头计时仍在",
    html: `<div class="${c("column")}" data-chat-flow>
      ${reasoningRow({ running: true, open: true, summary: "正在核对 DisclosureRow 的行布局", duration: "9分07秒" })}
    </div>`,
  },
  {
    id: "g1-think-done",
    label: "结束瞬间：视窗收起为一行摘要，Markdown 只保留行内语法且强制单行",
    html: `<div class="${c("column")}" data-chat-flow>
      ${reasoningRow({ running: false, open: false, summary: "<strong>核对 candidate28 打包内容</strong>：先查 <code>rules.js</code>，再查 <code>index.js</code>，确认 Rules 真的进了包，这一行必须省略号收尾而不是换行", duration: "9分07秒" })}
      ${reasoningRow({ running: false, open: true, summary: "展开后才是完整 Markdown", duration: "9分07秒" })}
    </div>`,
  },
  {
    id: "g1-narrow-stress",
    label: "窄屏压力（G5 补）：长 MCP 工具名 + 长路径 + 错误行。标题分类本身永不竖排换行，超长才省略号；分隔点垂直居中",
    html: `<div class="${c("column")}" data-chat-flow>
      ${toolRow({ name: "mcp__web-fetcher__web_fetch_screenshot", summary: "file:///C:/Users/Stardust/Desktop/VC工具包/DeepSeek Harness/docs/evidence/stage11/frontend/mock/design-demo.html", duration: "1分07秒" })}
      ${toolRow({ name: "mcp__sandbox__sandbox_batch", summary: "3 个任务并行 · node --check packages/dsh-runtime-patches/lib/transforms.mjs", duration: "12秒" })}
      ${toolRow({ name: "web_inspect", summary: "Navigation timeout of 30000 ms exceeded while waiting for selector", duration: "30秒", error: true })}
      ${reasoningRow({ running: false, open: false, summary: "确认 <code>DisclosureRow</code> 的空 stub 是标题竖排断字的真实根因", duration: "9分07秒" })}
    </div>`,
  },
  {
    id: "g1-model-label",
    label: "未来兼容：后端给出 activityLabel 时组头换成模型标注，组件不变",
    html: `<div class="${c("column")}" data-chat-flow>
      ${group({ kind: "tool", title: "查找前端相关代码壳说明", count: "4 步", duration: "11秒", open: true, labelSource: "model", children: toolChildren })}
    </div>`,
  },
];

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 活动轨迹样式验收页（G1）</title>
<link rel="stylesheet" href="${themeCssUrl}">
<style>/* 上游 ReasoningRow.module.css（自真实 release 抽取） */
${reasoningCss}</style>
<style>/* 上游 ChatView.module.css（自真实 release 抽取） */
${chatViewCss}</style>
<style>/* 本窗口注入的活动轨迹样式（与运行时同一份字符串） */
${ACTIVITY_TRACK_CSS}</style>
<style>
body{margin:0;padding:24px 32px 56px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:18px;margin:0 0 4px}
.note{color:var(--dsw-alias-label-tertiary);font-size:12.5px;margin:0 0 20px}
.case{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 16px;margin:0 0 16px;max-width:860px;background:var(--dsw-alias-bg-layer-1)}
.case > .cap{color:var(--dsw-alias-label-caption);font-size:11.5px;margin:0 0 10px}
.themebar{display:flex;gap:8px;margin:0 0 18px}
.themebar button{font:inherit;font-size:12.5px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer}
</style>
</head>
<body${args.dark === true ? " data-ds-dark-theme" : ""}>
<h1>DSH 活动轨迹样式验收页（G1）</h1>
<p class="note">样式与 DOM 均取自真实 release 与真实注入字符串，仅验证静态布局：重叠、溢出、单行省略、渐隐、深浅色。真实事件与点击折叠必须在可见 renderer 上另行验收。</p>
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
process.stdout.write(`活动轨迹验收页已生成：${outPath}\n`);
