/**
 * 把批次 B 差异卡的**真实注入源码**在 Node 里渲染成静态 HTML，供截图做视觉迭代。
 *
 * 关键点：组件不是在这里手抄一份 DOM，而是 `eval` 了
 * `transforms-frontend-tool.mjs` 真正要注入运行时的那份源码，
 * 用极简 jsx/react 桩件把它渲染成 HTML。所以预览里的类名、结构、
 * 行号、增删数字与真实运行时是同一份逻辑；只有 React 的状态被固定成
 * 各个场景的初始值。
 *
 * 配色用的是 DSH 自己的 `design-platform.css`（从干净基线 release 读取后内联），
 * 所以颜色也不是我编的。
 *
 * 用法：
 *   node scripts/Render-DiffCardMock.mjs
 *   node scripts/Render-DiffCardMock.mjs --out <html 路径>
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDiffCardRuntimeSource } from "../packages/dsh-runtime-patches/lib/transforms-frontend-tool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, "..");
const DESIGN_TOKENS = join(
  process.env.LOCALAPPDATA ?? "",
  "DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css",
);

/** 把注入源码 eval 出组件，附带最小 react / jsx 桩件。 */
function loadComponents(states) {
  const stateQueue = [...states];
  const react = {
    useState(init) {
      const initial = typeof init === "function" ? init() : init;
      const override = stateQueue.length > 0 ? stateQueue.shift() : undefined;
      return [override === undefined ? initial : override, () => {}];
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
  };
  const Fragment = Symbol("Fragment");
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const runtime = { jsx, jsxs: jsx, Fragment };
  const source = buildDiffCardRuntimeSource();
  const factory = new Function(
    "react",
    "react_jsx_runtime",
    "exportsOut",
    `${source}\nexportsOut.DshDiffCard = DshDiffCard;`,
  );
  const out = {};
  factory(react, runtime, out);
  return { ...out, Fragment };
}

const VOID_PROPS = new Set(["children", "key"]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

/** 把 jsx 节点树渲染成 HTML 字符串。 */
function render(node, Fragment) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (Array.isArray(node)) return node.map(child => render(child, Fragment)).join("");
  if (typeof node === "string" || typeof node === "number") return escapeHtml(node);
  const { type, props } = node;
  if (type === Fragment) return render(props.children, Fragment);
  if (typeof type === "function") return render(type(props), Fragment);
  const attrs = Object.entries(props)
    .filter(([name, value]) => !VOID_PROPS.has(name) && value !== undefined && value !== null && value !== false)
    .map(([name, value]) => {
      const attr = name === "className" ? "class" : name === "tabIndex" ? "tabindex" : name;
      return value === true ? ` ${attr}` : ` ${attr}="${escapeHtml(value)}"`;
    })
    .join("");
  return `<${type}${attrs}>${render(props.children, Fragment)}</${type}>`;
}

const numbered = count => Array.from({ length: count }, (_unused, index) => `第 ${index + 1} 行内容`);

const bigBefore = [
  ...numbered(40),
  "  const threshold = 0.68;",
  ...numbered(60).map(line => `${line} · 尾部`),
].join("\n");
const bigAfter = bigBefore.replace(
  "  const threshold = 0.68;",
  "  const threshold = 0.72;\n  const hardThreshold = 0.9;",
);

const longLine = "  const payload = { sessionId: \"session-a599653c-41f8-428e-9c1a\", generation: 4, "
  + "reason: \"background pre-compaction prepared and swapped in on the next request without blocking\", "
  + "thresholds: { soft: 0.68, hard: 0.9 } };";

const SCENARIOS = [
  {
    id: "write-create",
    label: "write 新建文件 · 成功落盘 · 真实行号",
    note: "oldText 为 null，内容从无到有，行号从 1 开始可信；单文件默认展开。本张卡额外强制显示了 hover 才出现的「复制 / 在编辑器中打开」。",
    states: [true],
    props: {
      diffs: [{
        path: "C:/Users/Stardust/Desktop/VC工具包/DeepSeek Harness/packages/dsh-runtime-patches/lib/transforms-frontend-tool.mjs",
        oldText: null,
        newText: ["export function dshDiffLines(text) {", "  if (text === null) return [];", longLine, "  return text.split(\"\\n\");", "}"].join("\n"),
      }],
      meta: { wholeFile: false, landed: true, groupLabel: "已写入", onOpenFile: () => {} },
    },
  },
  {
    id: "apply-patch-fold",
    label: "apply_patch 整份文件 · 上下文折叠 + 可点按钮",
    note: "整份 before/after 可推出真实行号；变化行上下各留 3 行，其余收进「⋯ 展开其余 N 行」按钮，每次多展开 50 行。",
    states: [true],
    props: {
      diffs: [{ path: "docs/context-architecture.md", oldText: bigBefore, newText: bigAfter }],
      meta: { wholeFile: true, landed: true, groupLabel: "已修改", onOpenFile: () => {} },
    },
  },
  {
    id: "edit-hunks",
    label: "edit 变更片段 · 行号未知 · 多 hunk",
    note: "后端 FileDiff 不带 hunk 起始行，所以行号列画 `·` 占位并在卡底说明，绝不用片段内序号冒充文件行号。",
    states: [true],
    props: {
      diffs: [
        {
          path: "packages/dsh-main-preset/lib/index.js",
          oldText: "const soft = 0.68;\nconst hard = 0.9;\nconst retry = 3;",
          newText: "const soft = 0.72;\nconst hard = 0.9;\nconst retry = 3;",
        },
        {
          path: "packages/dsh-main-preset/lib/index.js",
          oldText: "  return { soft, hard };\n}\n",
          newText: "  return { soft, hard, retry };\n}\n",
        },
      ],
      meta: { wholeFile: false, landed: true, groupLabel: "已编辑", onOpenFile: () => {} },
    },
  },
  {
    id: "multi-file",
    label: "apply_patch 多文件 · 组头合并统计",
    note: "组头 `已修改 3 个文件 · +A -B`，每个文件一行默认折叠，点开才看差异。",
    states: [],
    props: {
      diffs: [
        { path: "Task.md", oldText: "- [ ] 完成账户使用情况\n- [ ] 重做前端", newText: "- [x] 完成账户使用情况\n- [ ] 重做前端" },
        { path: "plans_windsurf/frontend-progress.md", oldText: null, newText: "## G2 · 文件差异卡\n\n实现完成。" },
        { path: "packages/dsh-runtime-patches/lib/transforms.mjs", oldText: "export { a };", newText: "export { a, b };" },
      ],
      meta: { wholeFile: true, landed: true, groupLabel: "已修改", onOpenFile: () => {} },
    },
  },
  {
    id: "running",
    label: "运行中 · ≈ 暂估灰色数字",
    note: "运行中只有调用侧参数，数字标成 `≈` 且走灰色，完成后由工具结果覆盖冻结。",
    states: [true],
    props: {
      diffs: [{
        path: "packages/dsh-context-status-ui/src/index.js",
        oldText: "const generation = 3;",
        newText: "const generation = 4;\nconst blocking = false;",
      }],
      meta: { wholeFile: false, landed: true, estimate: true, groupLabel: "已编辑" },
    },
  },
  {
    id: "not-landed",
    label: "失败 · 未落盘（数字划掉 + 左侧红边条 + 原因）",
    note: "补丁未匹配／事务回滚：徽标「未落盘」、增删数字变灰加删除线、下方给出模型侧原始报错。",
    states: [true],
    props: {
      diffs: [{
        path: "packages/dsh-runtime-patches/lib/transforms.mjs",
        oldText: "const soft = 0.68;",
        newText: "const soft = 0.72;\nconst hard = 0.9;",
      }],
      meta: {
        wholeFile: false,
        landed: false,
        groupLabel: "已编辑",
        reason: "apply_patch 写入失败，已恢复先前更新：更新文件上下文不匹配：packages/dsh-runtime-patches/lib/transforms.mjs",
        onOpenFile: () => {},
      },
    },
  },
  {
    id: "no-diff",
    label: "没有任何统计 · 只有失败原因（可空状态）",
    note: "事件里没有 diffs 时不编数字，只显示未落盘与原因。",
    states: [],
    props: {
      diffs: [],
      meta: {
        landed: false,
        subject: "3 个文件",
        reason: "apply_patch 校验阶段失败：更新文件不存在：docs/missing.md（未写入任何文件）",
      },
    },
  },
];

function main() {
  const outArg = process.argv.indexOf("--out");
  const outPath = outArg === -1
    ? join(workspaceRoot, "docs/evidence/stage11/frontend/mock/diff-card-preview.html")
    : process.argv[outArg + 1];

  let tokens = "";
  try {
    tokens = readFileSync(DESIGN_TOKENS, "utf8");
  } catch {
    console.warn(`[警告] 读不到 DSH design token：${DESIGN_TOKENS}；预览会退化成浏览器默认色。`);
  }

  const { DshDiffCard, Fragment } = loadComponents([]);
  const sections = SCENARIOS.map(scenario => {
    const { DshDiffCard: Card, Fragment: frag } = loadComponents(scenario.states);
    const html = render(Card(scenario.props), frag);
    return [
      `<section class="case" id="${scenario.id}">`,
      `<h2>${escapeHtml(scenario.label)}</h2>`,
      `<p class="note">${escapeHtml(scenario.note)}</p>`,
      `<div class="stage">${html}</div>`,
      "</section>",
    ].join("\n");
  }).join("\n");

  const css = readFileSync(
    join(workspaceRoot, "packages/dsh-runtime-patches/lib/transforms-frontend-tool.mjs"),
    "utf8",
  );
  void css;
  void DshDiffCard;
  void Fragment;

  const styleTag = extractInjectedCss();
  const dark = process.argv.includes("--dark");
  const bodyAttrs = dark ? " data-ds-dark-theme" : "";
  const titleSuffix = dark ? "（深色主题）" : "";

  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>批次 B 文件差异卡 · 真实组件源码预览</title>
<style>${tokens}</style>
<style>${styleTag}</style>
<style>
body{margin:0;padding:28px 32px 64px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
h1{font-size:19px;margin:0 0 6px}
.lead{color:var(--dsw-alias-label-tertiary);font-size:12.5px;margin:0 0 26px}
.case{margin:0 0 30px;max-width:920px}
.case h2{font-size:14px;font-weight:600;margin:0 0 4px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:6px 0 10px}
.stage{padding:4px 0}
/* 预览专用：第一张卡强制显示 hover 才出现的操作按钮，方便截图取证 */
#write-create .dshdiff-tools{opacity:1}
</style>
</head>
<body${bodyAttrs}>
<h1>批次 B　文件差异卡${titleSuffix}</h1>
<p class="lead">本页由 <code>scripts/Render-DiffCardMock.mjs</code> 直接渲染 <code>transforms-frontend-tool.mjs</code> 真正注入运行时的组件源码，配色取自 DSH 自己的 design token。只能验证静态样式，不能替代真实 renderer 验收。</p>
${sections}
</body>
</html>
`;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, page);
  console.log(`已写出 ${outPath}`);
}

/** 从注入源码里抠出样式文本（与运行时注入的是同一份字符串）。 */
function extractInjectedCss() {
  const source = buildDiffCardRuntimeSource();
  const match = /const dshDiffCss = (".*?");\n/su.exec(source);
  if (match === null) throw new Error("注入源码里找不到 dshDiffCss");
  return JSON.parse(match[1]);
}

main();
