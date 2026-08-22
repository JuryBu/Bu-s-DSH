import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DSH_FILE_ADAPTER_KEY,
  DSH_FILE_ANNOTATION_EVENT,
  DSH_FILE_ANNOTATION_ITEM_LIMIT,
  DSH_FILE_ANNOTATION_MAX_ITEMS,
  DSH_FILE_ANNOTATION_PERSIST,
  DSH_FILE_ANNOTATION_STORAGE_KEY,
  DSH_FILE_ANNOTATION_TOTAL_LIMIT,
  DSH_FILE_CAPABILITY_KEYS,
  DSH_FILE_READ_MAX_BYTES,
  DSH_FILE_READ_MAX_LINES,
  DSH_FILE_RENDER_MAX_LINES,
  DSH_FILE_SELECTION_EVENT,
  DSH_FILE_SELECTION_TEXT_LIMIT,
  DSH_FILE_VIEWER_RUNTIME_SOURCE,
  DSH_FILE_VIEWER_STYLE,
  DSH_FILE_WRITE_ENABLED,
  dshAppendAnnotationDraft,
  dshBuildFileSelectionPayload,
  dshBuildWorkspaceAnnotationsPayload,
  dshFileCapabilityFlags,
  dshFileContentHash,
  dshFilterLoadedFileNodes,
  dshFlattenFileTree,
  dshFormatLineRange,
  dshGuessFileLanguage,
  dshIsBinaryFilePath,
  dshIsMarkdownPath,
  dshLineRangeFromPreviewSelection,
  dshLineNumberFromDomNode,
  dshLineRangeFromTextOffsets,
  dshLinesToText,
  dshNormalizeDirectoryListing,
  dshNormalizeFileNode,
  dshNormalizeReadResult,
  dshResolveFileCapabilities,
  dshResolveReadRequest,
  patchFileViewerSource,
} from "../lib/frontend/file-viewer.mjs";
import { DSH_COMPOSER_EVENTS, patchWorkspaceShellSource } from "../lib/frontend/workspace-panel.mjs";

/** 干净锚点基线；缺失时跳过依赖 release 的用例，不让没装 DSH 的环境直接失败。 */
const BASELINE =
  process.env.DSH_PLAN15_BASELINE_ROOT ||
  (process.env.LOCALAPPDATA
    ? path.join(
        process.env.LOCALAPPDATA,
        "DeepSeekHarness",
        "app",
        "releases",
        "0.1.0-rc.6-oauth",
        "node_modules",
        "@deepseek-ai",
      )
    : "");
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
  const dir = path.join(tmpdir(), "dsh-frontend-plan15-file-viewer");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  writeFileSync(file, source, "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

/* ==================== 能力探测：缺能力必须 disabled 且有原因 ==================== */

test("没有 adapter 时五个能力位全 false，且每个都有非空原因", () => {
  for (const missing of [undefined, null, "nope", 42]) {
    const caps = dshResolveFileCapabilities(missing);
    assert.equal(caps.hasAdapter, false);
    assert.deepEqual(dshFileCapabilityFlags(caps), { tree: false, read: false, write: false, search: false, watch: false });
    for (const key of DSH_FILE_CAPABILITY_KEYS) {
      assert.notEqual(caps[key].reason, "", `${key} 缺原因`);
    }
  }
});

test("只承认函数：声明 true 但没有方法一律按不可用处理", () => {
  const caps = dshResolveFileCapabilities({ tree: true, read: true, search: true, watch: true });
  assert.deepEqual(dshFileCapabilityFlags(caps), { tree: false, read: false, write: false, search: false, watch: false });
  assert.match(caps.tree.reason, /目录列举/);
  assert.match(caps.read.reason, /文件读取/);
});

test("部分能力可用时只点亮对应位，其余仍写明原因", () => {
  const caps = dshResolveFileCapabilities({ listDirectory: () => [], readFile: () => ({}) });
  assert.deepEqual(dshFileCapabilityFlags(caps), { tree: true, read: true, write: false, search: false, watch: false });
  assert.equal(caps.tree.reason, "");
  assert.equal(caps.read.reason, "");
  assert.match(caps.search.reason, /搜索/);
  assert.match(caps.watch.reason, /变更/);
});

test("write 只在真实 writeFile 适配器存在时放行", () => {
  assert.equal(DSH_FILE_WRITE_ENABLED, true);
  const caps = dshResolveFileCapabilities({ listDirectory: () => [], readFile: () => ({}), writeFile: () => true });
  assert.equal(caps.write.enabled, true);
  assert.equal(caps.write.reason, "");
  const missingWrite = dshResolveFileCapabilities({ listDirectory: () => [], readFile: () => ({}) });
  assert.equal(missingWrite.write.enabled, false);
  assert.match(missingWrite.write.reason, /写入/);
});

/* ==================== 目录归一化 ==================== */

test("缺 path 的目录项直接丢弃，不留点不开的死行", () => {
  assert.equal(dshNormalizeFileNode(null), null);
  assert.equal(dshNormalizeFileNode({ name: "a.ts" }), null);
  assert.equal(dshNormalizeFileNode({ path: "   " }), null);
});

test("目录项归一化：kind / name / binary 有兜底，后端结论优先", () => {
  assert.deepEqual(dshNormalizeFileNode({ path: "/w/src", type: "directory" }), {
    path: "/w/src", name: "src", kind: "directory", size: null, binary: false, ignored: false, symlink: false,
  });
  /* 扩展名兜底判定二进制。 */
  assert.equal(dshNormalizeFileNode({ path: "/w/a.png" }).binary, true);
  /* 后端明说不是二进制就听后端的。 */
  assert.equal(dshNormalizeFileNode({ path: "/w/a.png", binary: false }).binary, false);
});

test("目录先于文件、同类按名称排序，且透传 nextCursor 与截断标记", () => {
  const listing = dshNormalizeDirectoryListing({
    entries: [
      { path: "/w/z.ts" },
      { path: "/w/b", kind: "directory" },
      { path: "/w/a.ts" },
      { path: "/w/a", kind: "directory" },
      null,
    ],
    nextCursor: "c1",
  }, "/w");
  assert.deepEqual(listing.entries.map((node) => node.name), ["a", "b", "a.ts", "z.ts"]);
  assert.equal(listing.nextCursor, "c1");
  assert.equal(listing.truncated, true);
  /* 裸数组也认。 */
  assert.equal(dshNormalizeDirectoryListing([{ path: "/w/a.ts" }], "/w").entries.length, 1);
  assert.equal(dshNormalizeDirectoryListing(undefined, "/w").entries.length, 0);
});

/* ==================== 读取窗口 ==================== */

test("读取窗口最多 500 行，非法起点回落到 1", () => {
  assert.deepEqual(dshResolveReadRequest({}), { startLine: 1, endLine: 500, maxLines: 500, maxBytes: DSH_FILE_READ_MAX_BYTES });
  assert.equal(dshResolveReadRequest({ startLine: 0 }).startLine, 1);
  assert.equal(dshResolveReadRequest({ startLine: -9 }).startLine, 1);
  assert.equal(dshResolveReadRequest({ startLine: 10, endLine: 5 }).endLine, 509);
  assert.equal(dshResolveReadRequest({ startLine: 1, endLine: 9999 }).endLine, DSH_FILE_READ_MAX_LINES);
});

test("后端超发时前端再夹一次，并如实标记 truncated 与 nextStartLine", () => {
  const request = dshResolveReadRequest({ startLine: 1 });
  const lines = [];
  for (let index = 1; index <= 900; index += 1) lines.push({ number: index, text: "x" });
  const read = dshNormalizeReadResult({ lines }, request);
  assert.equal(read.lines.length, DSH_FILE_READ_MAX_LINES);
  assert.equal(read.truncated, true);
  assert.equal(read.startLine, 1);
  assert.equal(read.endLine, 500);
  assert.equal(read.nextStartLine, 501);
});

test("纯 text 形状按请求起点编号，末尾换行不算一行", () => {
  const request = dshResolveReadRequest({ startLine: 7 });
  const read = dshNormalizeReadResult({ text: "a\nb\nc\n", totalLines: 9 }, request);
  assert.deepEqual(read.lines, [
    { number: 7, text: "a" },
    { number: 8, text: "b" },
    { number: 9, text: "c" },
  ]);
  assert.equal(read.totalLinesKnown, true);
  assert.equal(read.nextStartLine, null);
  assert.equal(dshLinesToText(read.lines), "a\nb\nc");
});

test("Markdown 预览选区能从可见文本反推源码行号", () => {
  const lines = [
    { number: 6, text: "## 君は言った" },
    { number: 7, text: "結果也很清楚：系统内存 81% 压力 green，`10-discussion.md` 和 `40-tool-routing.md`" },
    { number: 8, text: "- 这就是主人想要的效果吧" },
  ];
  assert.deepEqual(dshLineRangeFromPreviewSelection(lines, "君は言った"), { startLine: 6, endLine: 6 });
  assert.deepEqual(dshLineRangeFromPreviewSelection(lines, "10-discussion.md"), { startLine: 7, endLine: 7 });
  assert.deepEqual(dshLineRangeFromPreviewSelection(lines, "这就是主人想要的效果吧"), { startLine: 8, endLine: 8 });
  assert.equal(dshLineRangeFromPreviewSelection(lines, "不存在的文字"), null);
});

test("总行数未知时不补零、不假装读完：标记 totalLinesKnown=false", () => {
  const request = dshResolveReadRequest({ startLine: 1 });
  const read = dshNormalizeReadResult({ text: "a\nb" }, request);
  assert.equal(read.totalLinesKnown, false);
  assert.equal(read.totalLines, 2);
  assert.equal(read.nextStartLine, null);
  /* 后端自己说截断了，就必须给出下一段起点。 */
  assert.equal(dshNormalizeReadResult({ text: "a\nb", truncated: true }, request).nextStartLine, 3);
});

test("字节上限先到时按字节截断", () => {
  const request = dshResolveReadRequest({ startLine: 1 });
  const big = "x".repeat(200000);
  const read = dshNormalizeReadResult({ lines: [{ number: 1, text: big }, { number: 2, text: big }, { number: 3, text: big }] }, request);
  assert.ok(read.byteLength <= DSH_FILE_READ_MAX_BYTES + big.length + 1);
  assert.ok(read.lines.length < 3);
  assert.equal(read.truncated, true);
});

/* ==================== 语言与二进制判定 ==================== */

test("扩展名兜底语言与二进制判定", () => {
  assert.equal(dshGuessFileLanguage("/w/a.ts"), "typescript");
  assert.equal(dshGuessFileLanguage("/w/a.mjs"), "javascript");
  assert.equal(dshGuessFileLanguage("/w/LICENSE"), "");
  assert.equal(dshGuessFileLanguage("/w/a.unknownext"), "");
  assert.equal(dshIsBinaryFilePath("C:\\w\\a.PNG"), true);
  assert.equal(dshIsBinaryFilePath("/w/a.ts"), false);
  assert.equal(dshIsMarkdownPath("/w/README.md"), true);
  assert.equal(dshIsMarkdownPath("/w/a.ts"), false);
});

/* ==================== 选中到行号：两种渲染器共用一份逻辑 ==================== */

/** 自绘行：`div[data-dsh-fv-line] > [span(aria-hidden 行号), span(内容)]`。 */
function fakeSelfDrawnRow(lineNumber) {
  const gutter = { getAttribute: (name) => (name === "aria-hidden" ? "true" : null), textContent: String(lineNumber), children: { length: 0 } };
  const content = { getAttribute: () => null, textContent: "code", children: { length: 0 } };
  const row = {
    getAttribute: (name) => (name === "data-dsh-fv-line" ? String(lineNumber) : null),
    children: { length: 2, 0: gutter, 1: content },
    parentElement: null,
  };
  gutter.parentElement = row;
  content.parentElement = row;
  return { row, content };
}

/** 官方 ReadBlock 行：类名混淆，只有结构可依赖，没有 data 属性。 */
function fakeReadBlockRow(lineNumber) {
  const gutter = { getAttribute: (name) => (name === "aria-hidden" ? "true" : null), textContent: String(lineNumber), children: { length: 0 } };
  const content = { getAttribute: () => null, textContent: "code", children: { length: 0 } };
  const row = { getAttribute: () => null, children: { length: 2, 0: gutter, 1: content }, parentElement: null };
  gutter.parentElement = row;
  content.parentElement = row;
  return { row, content };
}

test("自绘行按 data-dsh-fv-line 还原行号", () => {
  const { content } = fakeSelfDrawnRow(7);
  assert.equal(dshLineNumberFromDomNode({ parentElement: content }), 7);
});

test("官方 ReadBlock 行按结构还原行号，不依赖混淆类名", () => {
  const { content } = fakeReadBlockRow(42);
  assert.equal(dshLineNumberFromDomNode({ parentElement: content }), 42);
});

test("到达上界或结构不符时返回 null，不猜行号", () => {
  const stop = { getAttribute: () => null, children: { length: 0 }, parentElement: null };
  const orphan = { getAttribute: () => null, children: { length: 0 }, parentElement: stop };
  assert.equal(dshLineNumberFromDomNode(orphan, stop), null);
  assert.equal(dshLineNumberFromDomNode(null), null);
  /* 两个子元素但第一个不是 aria-hidden 行号，不能当成行。 */
  const a = { getAttribute: () => null, textContent: "x", children: { length: 0 } };
  const b = { getAttribute: () => null, textContent: "y", children: { length: 0 } };
  const row = { getAttribute: () => null, children: { length: 2, 0: a, 1: b }, parentElement: null };
  a.parentElement = row;
  assert.equal(dshLineNumberFromDomNode(a), null);
});

test("编辑态按字符偏移换算行号，末尾换行不多算一行", () => {
  const text = "aa\nbb\ncc\ndd";
  assert.deepEqual(dshLineRangeFromTextOffsets(text, 0, 2, 1), { startLine: 1, endLine: 1 });
  assert.deepEqual(dshLineRangeFromTextOffsets(text, 3, 8, 1), { startLine: 2, endLine: 3 });
  /* 选区吃掉行尾换行时不把下一行算进来。 */
  assert.deepEqual(dshLineRangeFromTextOffsets(text, 3, 6, 1), { startLine: 2, endLine: 2 });
  /* 窗口起点不是 1 时整体平移。 */
  assert.deepEqual(dshLineRangeFromTextOffsets(text, 3, 8, 101), { startLine: 102, endLine: 103 });
});

/* ==================== 选区载荷 ==================== */

test("缺路径或缺行号时构造不出载荷，宁可按钮 disabled", () => {
  assert.equal(dshBuildFileSelectionPayload({ path: "", text: "x", startLine: 1 }), null);
  assert.equal(dshBuildFileSelectionPayload({ path: "/w/a.ts", text: "", startLine: 1 }), null);
  assert.equal(dshBuildFileSelectionPayload({ path: "/w/a.ts", text: "x", startLine: null }), null);
  assert.equal(dshBuildFileSelectionPayload({ path: "/w/a.ts", text: "x", startLine: 0 }), null);
});

test("选区载荷带路径、行范围、语言、revision 与内容哈希", () => {
  const payload = dshBuildFileSelectionPayload({
    path: "/w/a.ts", text: "const a = 1;", startLine: 7, endLine: 9, revision: "r1",
  });
  assert.equal(payload.kind, "workspace-file");
  assert.equal(payload.lineRange, "L7-L9");
  assert.equal(payload.lang, "typescript");
  assert.equal(payload.revision, "r1");
  assert.equal(payload.truncated, false);
  assert.equal(payload.contentHash, dshFileContentHash("const a = 1;"));
  assert.notEqual(dshFileContentHash("a"), dshFileContentHash("b"));
  /* endLine 缺失或倒挂时退回单行，不产出非法区间。 */
  assert.equal(dshBuildFileSelectionPayload({ path: "/w/a.ts", text: "x", startLine: 5, endLine: 2 }).endLine, 5);
  assert.equal(dshFormatLineRange(5, 5), "L5");
});

test("超长选区截断到 4000 字并标注，不静默发全文", () => {
  const payload = dshBuildFileSelectionPayload({ path: "/w/a.ts", text: "y".repeat(5000), startLine: 1 });
  assert.equal(payload.text.length, DSH_FILE_SELECTION_TEXT_LIMIT);
  assert.equal(payload.truncated, true);
  /* 哈希对应的是实际发出去的那段，不是原文。 */
  assert.equal(payload.contentHash, dshFileContentHash("y".repeat(DSH_FILE_SELECTION_TEXT_LIMIT)));
});

/* ==================== 批注草稿上限 ==================== */

function draft(annotation) {
  return { ...dshBuildFileSelectionPayload({ path: "/w/a.ts", text: "x", startLine: 1 }), annotation };
}

test("批注草稿最多 10 条", () => {
  let drafts = [];
  for (let index = 0; index < DSH_FILE_ANNOTATION_MAX_ITEMS; index += 1) {
    const result = dshAppendAnnotationDraft(drafts, draft(""));
    assert.equal(result.ok, true);
    drafts = result.drafts;
  }
  const overflow = dshAppendAnnotationDraft(drafts, draft(""));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.drafts.length, DSH_FILE_ANNOTATION_MAX_ITEMS);
  assert.match(overflow.error, /最多 10 条/);
});

test("单条 4000 字、总量 12000 字两道闸都拦得住", () => {
  const single = dshAppendAnnotationDraft([], draft("z".repeat(DSH_FILE_ANNOTATION_ITEM_LIMIT + 1)));
  assert.equal(single.ok, false);
  assert.match(single.error, /单条批注/);

  let drafts = [];
  for (let index = 0; index < 3; index += 1) drafts = dshAppendAnnotationDraft(drafts, draft("z".repeat(4000))).drafts;
  assert.equal(drafts.length, 3);
  const total = dshAppendAnnotationDraft(drafts, draft("z"));
  assert.equal(total.ok, false);
  assert.match(total.error, /总量/);
  assert.equal(DSH_FILE_ANNOTATION_TOTAL_LIMIT, 12000);
});

test("空草稿打不出载荷；非空时逐条带上行范围与批注", () => {
  assert.equal(dshBuildWorkspaceAnnotationsPayload([]), null);
  assert.equal(dshBuildWorkspaceAnnotationsPayload(null), null);
  const payload = dshBuildWorkspaceAnnotationsPayload([draft("看这里")]);
  assert.equal(payload.kind, "workspace-file-annotations");
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].annotation, "看这里");
  assert.equal(payload.items[0].lineRange, "L1");
});

/* ==================== 事件与存储键：不污染既有链路 ==================== */

test("批注事件与 W3 的 workspace-annotation 是同一个名字，选区事件是独立的新名字", () => {
  assert.equal(DSH_FILE_ANNOTATION_EVENT, DSH_COMPOSER_EVENTS["workspace-annotation"]);
  assert.equal(DSH_FILE_SELECTION_EVENT, DSH_COMPOSER_EVENTS["file-selection"]);
  /* 绝不复用含义模糊的 add-text，也不复用回复批注链路。 */
  assert.notEqual(DSH_FILE_SELECTION_EVENT, "dsh:composer:add-text");
});

test("批注草稿本轮只放内存，存储键与外观/工作区状态完全分开", () => {
  assert.equal(DSH_FILE_ANNOTATION_PERSIST, false);
  assert.equal(DSH_FILE_ANNOTATION_STORAGE_KEY, "dsh.workspace.annotations.v1");
  assert.notEqual(DSH_FILE_ANNOTATION_STORAGE_KEY, "dsh.appearance.v1.local");
  assert.ok(!DSH_FILE_ANNOTATION_STORAGE_KEY.startsWith("dsh.appearance"));
});

/* ==================== 树展平与本地过滤 ==================== */

test("未加载的目录留 loading 行，不假装是空目录", () => {
  const children = new Map([["/w", [{ path: "/w/src", name: "src", kind: "directory" }]]]);
  const rows = dshFlattenFileTree("/w", children, new Set(["/w/src"]), new Set(["/w/src"]));
  assert.deepEqual(rows.map((row) => row.kind), ["node", "loading"]);
  /* 既没加载也不在加载中时，只画目录行本身。 */
  assert.deepEqual(dshFlattenFileTree("/w", children, new Set(["/w/src"]), new Set()).map((row) => row.kind), ["node"]);
});

test("展开的目录才递归，空目录画空态", () => {
  const children = new Map([
    ["/w", [{ path: "/w/src", name: "src", kind: "directory" }, { path: "/w/a.ts", name: "a.ts", kind: "file" }]],
    ["/w/src", []],
  ]);
  assert.deepEqual(dshFlattenFileTree("/w", children, new Set(), new Set()).map((row) => row.kind), ["node", "node"]);
  assert.deepEqual(dshFlattenFileTree("/w", children, new Set(["/w/src"]), new Set()).map((row) => row.kind), ["node", "empty", "node"]);
});

test("本地过滤只作用于已加载节点，大小写不敏感", () => {
  const nodes = [{ name: "App.tsx", path: "/w/src/App.tsx" }, { name: "b.ts", path: "/w/src/b.ts" }];
  assert.equal(dshFilterLoadedFileNodes(nodes, "app").length, 1);
  assert.equal(dshFilterLoadedFileNodes(nodes, "/src/").length, 2);
  assert.equal(dshFilterLoadedFileNodes(nodes, "").length, 2);
});

/* ==================== 注入卫生与锚点契约 ==================== */

test("注入源码卫生：无裸反引号、无未转义 ${、不碰 Node 内建与本地存储", () => {
  assert.equal((DSH_FILE_VIEWER_RUNTIME_SOURCE.match(/`/g) ?? []).length, 0);
  assert.equal((DSH_FILE_VIEWER_RUNTIME_SOURCE.match(/\$\{/g) ?? []).length, 0);
  for (const banned of ["node:fs", "node:path", "node:crypto", "localStorage", "sessionStorage", "innerHTML"]) {
    assert.equal(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes(banned), false, `注入源码不该出现 ${banned}`);
  }
  /* 唯一的动态依赖是 loader 的 static seed module。 */
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes('dshFvRequireOptional("react-dom/client")'));
});

test("样式变量只落在 --dsh-workspace-file-* 命名空间，且声明在 body 而不是 :root", () => {
  assert.ok(DSH_FILE_VIEWER_STYLE.startsWith("body{"));
  assert.equal(DSH_FILE_VIEWER_STYLE.includes(":root"), false);
  for (const match of DSH_FILE_VIEWER_STYLE.matchAll(/(--dsh-[a-z-]+)\s*:/g)) {
    assert.ok(match[1].startsWith("--dsh-workspace-file-"), `越界变量 ${match[1]}`);
  }
});

test("ReadBlock 折叠阈值落在 80-120 行区间", () => {
  assert.ok(DSH_FILE_RENDER_MAX_LINES >= 80 && DSH_FILE_RENDER_MAX_LINES <= 120);
});

test("适配器挂载点是约定的 window.__dshWorkspaceFiles", () => {
  assert.equal(DSH_FILE_ADAPTER_KEY, "__dshWorkspaceFiles");
});

test("锚点在 stub 上恰好命中一次，并挂上 ctx.effect", () => {
  const patched = patchFileViewerSource(APPLY_STUB);
  assert.equal(patched.split("installDshFileViewer(").length - 1, 2);
  assert.ok(patched.includes('ctx.effect(() => installDshFileViewer(), "ui-conversation: dsh plan15 file viewer");'));
});

test("拒绝对已打补丁的源码重复注入", () => {
  const patched = patchFileViewerSource(APPLY_STUB);
  assert.throws(() => patchFileViewerSource(patched), /拒绝重复注入/);
});

test("与 W3 组合：两种执行顺序都能命中锚点且语法正确", { skip: !baselineAvailable }, () => {
  const source = conversationBaseline();
  assertSyntaxOk("w4-only", patchFileViewerSource(source));
  assertSyntaxOk("w3-then-w4", patchFileViewerSource(patchWorkspaceShellSource(source)));
  assertSyntaxOk("w4-then-w3", patchWorkspaceShellSource(patchFileViewerSource(source)));
});

test("干净基线里 apply 锚点唯一，不会误伤别处", { skip: !baselineAvailable }, () => {
  const source = conversationBaseline();
  const anchor = "\t\tfunction apply(ctx) {\n\t\t\tconst sessions = ctx.sessions;\n\t\t\tconst workspaces = ctx.workspaces;";
  assert.equal(source.split(anchor).length - 1, 1);
});

/* ==================== 主线 W4 复核反馈的回归用例 ==================== */

/**
 * 官方 ReadBlock 用 shiki 高亮时，一行的内容 span 里还会再套一层 token span。
 * 选区端点通常落在最内层的文本节点上，行号还原必须能从任意深度回溯上来。
 */
test("高亮把一行切成多个 token span 时，选区仍能还原到正确行号", () => {
  const gutter = { getAttribute: (name) => (name === "aria-hidden" ? "true" : null), textContent: "137", children: { length: 0 } };
  const token = { getAttribute: () => null, textContent: "createHighlighter", children: { length: 0 } };
  const content = { getAttribute: () => null, textContent: "import { createHighlighter }", children: { length: 1, 0: token } };
  const row = { getAttribute: () => null, children: { length: 2, 0: gutter, 1: content }, parentElement: null };
  gutter.parentElement = row;
  content.parentElement = row;
  token.parentElement = content;
  /* 文本节点 -> token span -> content span -> row，四层都要走通。 */
  assert.equal(dshLineNumberFromDomNode({ parentElement: token }), 137);
  assert.equal(dshLineNumberFromDomNode(token), 137);
});

test("降级渲染是横向滚动而不是折行（Plan_15 第 6 章 + 官方 ReadBlock 行为）", () => {
  const line = /\.dsh-fv-fallback>div\{([^}]*)\}/.exec(DSH_FILE_VIEWER_STYLE);
  assert.ok(line, "缺少降级行样式");
  assert.ok(line[1].includes("white-space:pre"), "行必须 white-space:pre");
  assert.equal(/white-space:pre-(wrap|line)/.test(line[1]), false, "行不得折行");

  const block = /\.dsh-fv-fallback\{([^}]*)\}/.exec(DSH_FILE_VIEWER_STYLE);
  assert.ok(block, "缺少降级块样式");
  assert.ok(block[1].includes("overflow-x:auto"), "长行必须由横向滚动条承载");

  /* min-width:0 会解除 flex 自动最小尺寸，让长行被压扁裁掉而不是撑出滚动条。 */
  const content = /\.dsh-fv-fallback>div>span:last-child\{([^}]*)\}/.exec(DSH_FILE_VIEWER_STYLE);
  assert.ok(content, "缺少降级内容样式");
  assert.equal(content[1].includes("min-width:0"), false, "内容 span 不得写 min-width:0");
  assert.equal(/overflow-wrap|word-break/.test(content[1]), false, "内容 span 不得强制断词");
});

test("底部分页按钮成组，信息行再长也不会只把「下一段」挤下去", () => {
  assert.ok(DSH_FILE_VIEWER_STYLE.includes(".dsh-fv-foot-nav{"));
  const nav = /\.dsh-fv-foot-nav\{([^}]*)\}/.exec(DSH_FILE_VIEWER_STYLE);
  assert.ok(nav[1].includes("flex:none"), "导航组自身不参与压缩");
  assert.ok(DSH_FILE_VIEWER_STYLE.includes(".dsh-fv-foot-nav[hidden]"), "隐藏时要显式归零 display");
  /* 两个按钮必须挂进同一个组，而不是各自摊在 wrap 容器里。 */
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("footNav.append(prevButton, nextButton);"));
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("foot.append(footInfo, footSpacer, footNav);"));
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("footNav.hidden = read === null;"));
});

test("主按钮 disabled 时必须退出蓝色主态，不能只降透明度", () => {
  const rule = /\.dsh-fv-btn\[data-primary\]:disabled\{([^}]*)\}/.exec(DSH_FILE_VIEWER_STYLE);
  assert.ok(rule, "缺少 disabled 主按钮规则");
  assert.ok(rule[1].includes("background:transparent"), "disabled 时不得保留主色底");
  assert.equal(rule[1].includes("--dsh-workspace-file-accent"), false, "disabled 时不得再用强调色");
  /* 规则必须排在主态之后，否则被覆盖回蓝色。 */
  assert.ok(
    DSH_FILE_VIEWER_STYLE.indexOf("[data-primary]:disabled") > DSH_FILE_VIEWER_STYLE.indexOf('[data-primary]{'),
    "disabled 规则必须写在主态规则之后",
  );
});

test("watch 缺失是能力缺口不是错误：不进红色警告，改走底部信息行", () => {
  /* 红色只留给 error 语气。 */
  assert.ok(DSH_FILE_VIEWER_STYLE.includes('b[data-tone="error"]'));
  assert.equal(DSH_FILE_VIEWER_STYLE.includes('b[data-tone="warn"]'), false, "warn 语气已废弃，避免能力缺口被画成红框");

  const notice = /const renderNotice = \(\) => \{([\s\S]*?)\n\t+\};/.exec(DSH_FILE_VIEWER_RUNTIME_SOURCE);
  assert.ok(notice, "找不到 renderNotice");
  assert.equal(notice[1].includes("staleHint"), false, "watch 提示不该再进 notice 徽章区");
  assert.equal(notice[1].includes('"warn"'), false, "notice 不该再产出 warn 语气");
  assert.ok(notice[1].includes('badges.push([state.notice, "error"]'), "真实失败仍要红色");

  /* 改为并进文件信息行，并用 title 给出完整原因。 */
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("footParts.push(DSH_FILE_VIEWER_COPY.staleHint)"));
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("DSH_FILE_VIEWER_COPY.staleHintTitle"));
});

test("运行时包含 Markdown 预览选区定位与 rootPath 变化重探测", () => {
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("dshLineRangeFromPreviewSelection"));
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes('state.mode === "preview"'));
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("const beforeRoot = state.rootPath;"));
  assert.ok(DSH_FILE_VIEWER_RUNTIME_SOURCE.includes("nextRoot !== beforeRoot"));
});

test("降级渲染的行高与行号槽宽度与官方 ReadBlock 的真实 CSS 对齐", { skip: !baselineAvailable }, () => {
  const dist = path.join(BASELINE, "dsh-web-frontend", "dist", "assets");
  const cssFile = readdirSync(dist).find((name) => name.startsWith("index-") && name.endsWith(".css"));
  assert.ok(cssFile, "找不到前端样式包");
  const css = readFileSync(path.join(dist, cssFile), "utf8");

  /* 官方行：white-space:pre；官方正文容器：overflow-x:auto。这两条是本轮改动的依据，
     哪天官方改成折行，这个用例会红，提醒我们重新对齐而不是各走各的。 */
  const officialLine = /\._line_[a-z0-9]+_\d+\{([^}]*)\}/.exec(css);
  assert.ok(officialLine, "找不到官方 ReadBlock 行样式");
  assert.ok(officialLine[1].includes("white-space:pre"), "官方行已不是 pre，降级渲染需重新对齐");

  const gutterWidth = /--dsl-read-gutter: *(\d+)px/.exec(css);
  const lineHeight = /--dsl-read-line-height: *(\d+)px/.exec(css);
  assert.ok(gutterWidth && lineHeight, "找不到官方 ReadBlock 的度量变量");
  assert.ok(
    DSH_FILE_VIEWER_STYLE.includes(`--dsh-workspace-file-gutter:${gutterWidth[1]}px;`),
    `行号槽宽度应与官方一致（官方 ${gutterWidth[1]}px）`,
  );
  assert.ok(
    DSH_FILE_VIEWER_STYLE.includes(`--dsh-workspace-file-line:${lineHeight[1]}px;`),
    `行高应与官方一致（官方 ${lineHeight[1]}px）`,
  );
});

test("浏览器实际拿到的 primitives 来自前端包，且 react-dom/client 在 seed 表里", { skip: !baselineAvailable }, () => {
  const dist = path.join(BASELINE, "dsh-web-frontend", "dist", "assets");
  const jsFile = readdirSync(dist).find((name) => name.startsWith("index-") && name.endsWith(".js"));
  assert.ok(jsFile, "找不到前端脚本包");
  const js = readFileSync(path.join(dist, jsFile), "utf8");
  const seed = /return\{react:[^}]*"@deepseek-ai\/dsh-client-ui-primitives":[^,}]+[^}]*\}/.exec(js);
  assert.ok(seed, "seed 表里没有 primitives，注入代码 require 不到官方组件");
  assert.ok(seed[0].includes('"react-dom/client"'), "seed 表里没有 react-dom/client，独立 React root 无法创建");

  /* node_modules 下那份 primitives 的 CSS module 是空 stub，只有前端包这份带真实类名。
     这条断言把「官方组件有没有样式」钉死在证据上，避免下次又靠印象判断。 */
  const nodeCopy = readFileSync(path.join(BASELINE, "dsh-client-ui-primitives", "lib", "index.js"), "utf8");
  assert.ok(nodeCopy.includes("var ReadBlock_module_css_default = {};"), "node_modules 那份不再是空 stub，结论需重新核");
  assert.ok(/_gutter_[a-z0-9]+_\d+/.test(js), "前端包里应有编译后的 ReadBlock 类名");
});

test("官方 ReadBlock / MarkdownText 在浏览器 primitives 里确实导出，且全包没有 React Context", { skip: !baselineAvailable }, () => {
  const primitives = readFileSync(path.join(BASELINE, "dsh-client-ui-primitives", "lib", "index.js"), "utf8");
  assert.ok(primitives.includes("function ReadBlock("));
  assert.ok(primitives.includes("const MarkdownText = memo("));
  /* 独立 React root 能安全挂载的前提：整包没有 Context，主题只走 body 上的 CSS 变量。 */
  for (const banned of ["createContext", "useContext", "Provider"]) {
    assert.equal(primitives.includes(banned), false, `primitives 出现 ${banned}，独立 root 不再安全`);
  }
});
