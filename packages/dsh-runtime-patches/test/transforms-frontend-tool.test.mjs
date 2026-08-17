import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DSH_DIFF_CSS,
  dshDiffAlign,
  dshDiffBaseName,
  dshDiffCopyText,
  dshDiffFold,
  dshDiffLines,
  dshDiffModel,
  dshDiffNumber,
  dshParsePatchFiles,
  patchToolDiffCardSource,
} from "../lib/transforms-frontend-tool.mjs";

test("行切分把结尾换行当终止符而不是空行", () => {
  assert.deepEqual(dshDiffLines(""), []);
  assert.deepEqual(dshDiffLines(null), []);
  assert.deepEqual(dshDiffLines("a\n"), ["a"]);
  assert.deepEqual(dshDiffLines("a\n\nb"), ["a", "", "b"]);
});

test("对齐只把真正变化的行标成增删，上下文保持 ctx", () => {
  const { ops, degraded } = dshDiffAlign(["a", "b", "c"], ["a", "B", "c"]);
  assert.equal(degraded, false);
  assert.deepEqual(ops, [
    { kind: "ctx", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "B" },
    { kind: "ctx", text: "c" },
  ]);
});

test("对齐能识别中段插入，不把整段判成重写", () => {
  const { ops } = dshDiffAlign(["a", "d"], ["a", "b", "c", "d"]);
  assert.deepEqual(ops.map(op => op.kind), ["ctx", "add", "add", "ctx"]);
});

test("新建文件（旧侧为 null）全部算新增", () => {
  const { ops } = dshDiffAlign(dshDiffLines(null), ["x", "y"]);
  assert.deepEqual(ops, [
    { kind: "add", text: "x" },
    { kind: "add", text: "y" },
  ]);
});

test("行号只在 absolute 档位给出，unknown 档位一律为 null", () => {
  const ops = [
    { kind: "ctx", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "B" },
    { kind: "ctx", text: "c" },
  ];
  assert.deepEqual(dshDiffNumber(ops, "absolute").map(row => row.no), [1, 2, 2, 3]);
  assert.deepEqual(dshDiffNumber(ops, "unknown").map(row => row.no), [null, null, null, null]);
});

test("上下文折叠：变化行上下各留 3 行，其余收进 fold 区块", () => {
  const rows = dshDiffNumber(
    [
      ...Array.from({ length: 20 }, (_unused, index) => ({ kind: "ctx", text: `l${index}` })),
      { kind: "add", text: "new" },
      ...Array.from({ length: 20 }, (_unused, index) => ({ kind: "ctx", text: `r${index}` })),
    ],
    "absolute",
  );
  const blocks = dshDiffFold(rows);
  assert.equal(blocks.filter(block => block.kind === "fold").length, 2);
  assert.equal(blocks.filter(block => block.kind === "line").length, 7);
  assert.equal(blocks[0].rows.length, 17);
});

test("整份文件写入的增删数只统计真正变化的行，而不是两侧行数相加", () => {
  const before = Array.from({ length: 400 }, (_unused, index) => `line ${index}`).join("\n");
  const after = before.replace("line 200", "line 200 changed");
  const model = dshDiffModel([{ path: "a/b/Task.md", oldText: before, newText: after }], { wholeFile: true });
  assert.equal(model.added, 1);
  assert.equal(model.removed, 1);
  assert.equal(model.files.length, 1);
  assert.equal(model.files[0].name, "Task.md");
  assert.equal(model.files[0].numbering, "absolute");
  // 400 行文件里只露出变化行加上下各 3 行
  assert.equal(model.files[0].blocks.filter(block => block.kind === "line").length, 8);
});

test("write/edit 的 hunk 没有起始行，行号档位必须是 unknown", () => {
  const model = dshDiffModel([{
    path: "packages/x/lib/index.js",
    oldText: "ctx1\nctx2\nctx3\nold\nctx4\nctx5\nctx6",
    newText: "ctx1\nctx2\nctx3\nnew\nctx4\nctx5\nctx6",
  }]);
  assert.equal(model.files[0].numbering, "unknown");
  assert.equal(model.added, 1);
  assert.equal(model.removed, 1);
  for (const block of model.files[0].blocks) {
    if (block.kind === "line") assert.equal(block.row.no, null);
  }
});

test("同一路径的多个 hunk 合成一个文件条目并插入 gap", () => {
  const hunk = { path: "a.txt", oldText: "x", newText: "y" };
  const model = dshDiffModel([hunk, { ...hunk, oldText: "p", newText: "q" }]);
  assert.equal(model.files.length, 1);
  assert.equal(model.files[0].blocks.filter(block => block.kind === "gap").length, 1);
  assert.equal(model.added, 2);
  assert.equal(model.removed, 2);
});

test("多文件保持出现顺序并各自统计", () => {
  const model = dshDiffModel([
    { path: "a.txt", oldText: null, newText: "1\n2" },
    { path: "b/c.txt", oldText: "1", newText: "2" },
  ], { wholeFile: true });
  assert.deepEqual(model.files.map(file => file.name), ["a.txt", "c.txt"]);
  assert.equal(model.added, 3);
  assert.equal(model.removed, 1);
});

test("超大改动退化为整段删除加整段新增，并标记 degraded", () => {
  const oldLines = Array.from({ length: 1200 }, (_unused, index) => `a${index}`);
  const newLines = Array.from({ length: 1200 }, (_unused, index) => `b${index}`);
  const { degraded, ops } = dshDiffAlign(oldLines, newLines);
  assert.equal(degraded, true);
  assert.equal(ops.filter(op => op.kind === "del").length, 1200);
  assert.equal(ops.filter(op => op.kind === "add").length, 1200);
});

test("复制文本带 -/+/空格前缀，并且包含被折叠的行", () => {
  const before = Array.from({ length: 30 }, (_unused, index) => `line ${index}`).join("\n");
  const after = before.replace("line 15", "line 15 changed");
  const model = dshDiffModel([{ path: "a.txt", oldText: before, newText: after }], { wholeFile: true });
  const text = dshDiffCopyText(model.files);
  assert.equal(text.split("\n").length, 31);
  assert.ok(text.includes("- line 15"));
  assert.ok(text.includes("+ line 15 changed"));
  assert.ok(text.includes("  line 0"));
});

test("文件名取最后一段，兼容反斜杠", () => {
  assert.equal(dshDiffBaseName("a/b/c.md"), "c.md");
  assert.equal(dshDiffBaseName("C:\\x\\y\\z.mjs"), "z.mjs");
  assert.equal(dshDiffBaseName("solo.txt"), "solo.txt");
});

test("补丁正文解析出真实文件清单", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: packages/a/lib/index.js",
    "@@",
    "-old",
    "+new",
    "*** Add File: docs/new.md",
    "+hello",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(dshParsePatchFiles(patch), [
    { path: "packages/a/lib/index.js", operation: "update" },
    { path: "docs/new.md", operation: "create" },
  ]);
  assert.deepEqual(dshParsePatchFiles(""), []);
});

test("样式只新增三个 dsh-diff 语义变量", () => {
  const declared = [...DSH_DIFF_CSS.matchAll(/--dsh-[a-z-]+(?=\s*:)/gu)].map(match => match[0]);
  assert.deepEqual([...new Set(declared)].sort(), [
    "--dsh-diff-add-bg",
    "--dsh-diff-del-bg",
    "--dsh-diff-stale-fg",
  ]);
});

test("补丁对同一份源码只能应用一次", () => {
  const source = [
    "\t\tconst VARIANT_TITLES = {",
    "\t\t\tsearch: \"Search\",",
    "\t\t\tread: \"Read\",",
    "\t\t\tbash: \"Bash\",",
    "\t\t\twrite: \"Write\",",
    "\t\t\tedit: \"Edit\",",
    "\t\t\tcode: \"Code\",",
    "\t\t\tothers: \"Tool call\"",
    "\t\t};",
    "\t\t//#region lib/types/client/tool/components/ToolRow.js",
    "\t\t\t\t\t\t}) : diffBody !== null ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {",
    "\t\t\t\t\t\t\t...diffBody.card,",
    "\t\t\t\t\t\t\tmaxLines: 8,",
    "\t\t\t\t\t\t\tclassName: ToolRow_module_css_default.diffBody",
    "\t\t\t\t\t\t})",
    "\t\t\t\t\t\tfileLink ? (0, react_jsx_runtime.jsx)(\"button\", {",
    "\t\t\t\t\t\t\ttype: \"button\",",
    "\t\t\t\t\t\t\tclassName: ToolRow_module_css_default.fileLink,",
    "\t\t\t\t\t\t\tonClick: openFile,",
    "\t\t\tconst diff = diffCardModel(block);",
    "\t\t\tif (diff !== null) return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {",
    "\t\t\t\t...diff.card,",
    "\t\t\t\tclassName: ToolDetails_module_css_default.cardBody",
    "\t\t\t});",
    "\t\tfunction FileMutationRow({ toolName, block, cwd, openFile, inspect, t }) {",
    "\t\t\treturn (0, react_jsx_runtime.jsx)(ToolRow, {",
    "\t\t\t\tt",
    "\t\t\t});",
    "\t\t}",
    "\t\t/**",
    "\t\t* The file-mutation rows as a plain registrant plugin following the chat",
    "\t\t* toolview declaration across independent activation and reload lifetimes.",
    "\t\t*/",
    "\t\t\t\t\tyield ctx.slots.register({",
    "\t\t\t\t\t\tname: \"tool.call.toolview\",",
    "\t\t\t\t\t\tkey: \"write\",",
    "\t\t\t\t\t\tlocale: CONVERSATION_NS",
    "\t\t\t\t\t}, FileMutationRow);",
  ].join("\n");
  const once = patchToolDiffCardSource(source);
  assert.ok(once.includes("DshDiffCard"));
  assert.ok(once.includes("key: \"apply_patch\""));
  assert.throws(() => patchToolDiffCardSource(once), /锚点/u);
});

test("G5：工具行标题中文化，中文界面里不留 Tool call / Code 这类英文字面量", { skip: baselineSkip() }, () => {
  // 这组标题是上游注明的 design literal，不走 locale，所以只能在展示层替换。
  const source = readFileSync(baselinePath(), "utf8");
  const patched = patchToolDiffCardSource(source);
  assert.ok(patched.includes('others: "工具调用"'));
  assert.ok(patched.includes('code: "代码"'));
  assert.ok(patched.includes('read: "读取"'));
  assert.doesNotMatch(patched, /others: "Tool call"/u);
  assert.doesNotMatch(patched, /code: "Code"/u);
  // 不许新增变体：仍然是上游那 7 个键。
  const block = /const VARIANT_TITLES = \{([^}]*)\}/u.exec(patched)[1];
  assert.equal(block.split(",").length, 7);
});

test("对干净基线应用后仍是合法 JavaScript，且没有残留 DiffBlock 渲染", { skip: baselineSkip() }, () => {
  const source = readFileSync(baselinePath(), "utf8");
  const patched = patchToolDiffCardSource(source);
  assert.equal((patched.match(/primitives\.DiffBlock/gu) ?? []).length, 0);
  assert.ok(patched.includes("DshDiffFileCard"));
  assert.ok(patched.includes("key: \"apply_patch\""));
  const file = join(mkdtempSync(join(tmpdir(), "dsh-g2-")), "client.js");
  writeFileSync(file, patched);
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

/** 干净锚点基线；缺失时跳过而不是假通过。 */
function baselinePath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return join(
    local,
    "DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js",
  );
}

function baselineSkip() {
  return existsSync(baselinePath()) ? false : "缺少干净基线 release，跳过真实源码应用检查";
}
