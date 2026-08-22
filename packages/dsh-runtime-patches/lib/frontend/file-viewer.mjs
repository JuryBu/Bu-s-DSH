/**
 * Plan_15 W4 · 右侧工作区「文件」标签页的文件树与分层文件查看器。
 *
 * 边界（与 W3 `workspace-panel.mjs` 的分工）：
 *   - W3 负责工作区外壳、标签栏、宽度、标题栏与内置浏览器占位；本文件只接管
 *     `.dsh-ws-tree` 左列与 `[data-dsh-ws-pane="files"]` 这一个面板的内部。
 *   - 本文件不修改 W3 的任何常量与 DOM 契约，只读它已经写好的 `data-dsh-compact-tree`。
 *
 * 诚实边界（能力探测先行，不靠调用失败才降级）：
 *   - 后端适配器缺席时，五个能力位（tree/read/write/search/watch）全部 false，
 *     界面显示禁用占位并写明原因，绝不用假数据冒充可用。
 *   - write 只在桌面壳提供 `writeFile` 真实适配器时放行；截断窗口、二进制文件
 *     或后端能力缺席时仍禁用保存，避免把半个文件写回磁盘。
 *
 * 渲染层：优先复用官方 `ReadBlock` / `MarkdownText`（见 `installDshFileViewer`
 * 内的能力探测），拿不到 React 时退回结构同构的原生 DOM 行，两种渲染器共用同一
 * 套「选中 → 行号」还原逻辑（{@link dshLineNumberFromDomNode}）。
 */

import { assertNotAlreadyPatched, replaceExactlyOnce } from "./replace-exactly.mjs";

/* ==================== 契约常量 ==================== */

/** 后端文件能力适配器挂载点；缺席即代表本轮没有文件后端。 */
export const DSH_FILE_ADAPTER_KEY = "__dshWorkspaceFiles";

/** 归一化后的五个能力位，顺序固定，便于报告与测试逐项核对。 */
export const DSH_FILE_CAPABILITY_KEYS = ["tree", "read", "write", "search", "watch"];

/**
 * 本轮写入总开关。
 *
 * 桌面壳已经开放受控写入适配器：前端仍只承认真实 `writeFile` 函数，并在渲染层
 * 禁止截断窗口保存。
 */
export const DSH_FILE_WRITE_ENABLED = true;

/** 单次读取窗口上限：行数与字节数同时受限，谁先到算谁。 */
export const DSH_FILE_READ_MAX_LINES = 500;
export const DSH_FILE_READ_MAX_BYTES = 262144;

/** 交给 `ReadBlock` 的折叠阈值（官方默认 16 行太小，文件视图给 100 行）。 */
export const DSH_FILE_RENDER_MAX_LINES = 100;

/** 单条选区带进对话的正文上限；超出截断并标注。 */
export const DSH_FILE_SELECTION_TEXT_LIMIT = 4000;

/** 批注草稿上限：条数、单条字数、总字数。 */
export const DSH_FILE_ANNOTATION_MAX_ITEMS = 10;
export const DSH_FILE_ANNOTATION_ITEM_LIMIT = 4000;
export const DSH_FILE_ANNOTATION_TOTAL_LIMIT = 12000;

/**
 * 批注草稿本轮只放内存。
 *
 * 落盘键位已经定好并与外观/工作区状态分开（{@link DSH_FILE_ANNOTATION_STORAGE_KEY}），
 * 但本轮不写：草稿的生命周期应该跟随会话而不是跟随浏览器，且落盘语义要等 Codex
 * 确认工作区标识后才稳定。
 */
export const DSH_FILE_ANNOTATION_PERSIST = false;

/** 批注草稿的独立存储键；绝不复用 `dsh.appearance.v1.local`。 */
export const DSH_FILE_ANNOTATION_STORAGE_KEY = "dsh.workspace.annotations.v1";

/** 派发给 composer 的事件名；监听器不存在时按钮 disabled，不自己找 textarea 写值。 */
export const DSH_FILE_SELECTION_EVENT = "dsh:composer:add-file-selection";
export const DSH_FILE_ANNOTATION_EVENT = "dsh:composer:add-workspace-annotations";

/** W3 已有的 composer 就绪广播；本文件只监听，不重复定义语义。 */
export const DSH_FILE_COMPOSER_READY_EVENT = "dsh:composer:ready";

/** W3 的桌面能力就绪广播；适配器可能晚于首屏挂载。 */
export const DSH_FILE_DESKTOP_READY_EVENT = "dsh:desktop:ready";

/** 面板过窄时 W3 会把左列文件树隐藏，这里据此把树移进抽屉。 */
export const DSH_FILE_COMPACT_TREE_ATTR = "data-dsh-compact-tree";

/** 扩展名 → shiki 语言 id；后端给了 `lang` 以后端为准，这里只是兜底。 */
export const DSH_FILE_LANGUAGE_BY_EXTENSION = {
  bash: "shellscript",
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  php: "php",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shellscript",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  txt: "",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

/** 明确不做文本预览的扩展名；后端说了 binary 以后端为准。 */
export const DSH_FILE_BINARY_EXTENSIONS = [
  "7z", "bin", "bmp", "class", "dll", "exe", "gif", "gz", "ico", "jpeg", "jpg",
  "mp3", "mp4", "node", "pdf", "png", "so", "tar", "ttf", "wasm", "webp",
  "woff", "woff2", "zip", "zst",
];

/** 走 Markdown 预览的扩展名。 */
export const DSH_FILE_MARKDOWN_EXTENSIONS = ["md", "markdown", "mdx"];

/** 中文文案集中在一个对象里，不引入新的 i18n 依赖。 */
export const DSH_FILE_VIEWER_COPY = {
  treeTitle: "文件",
  treeFilterPlaceholder: "过滤已加载的文件",
  treeSearchPlaceholder: "搜索工作区文件",
  treeLoading: "正在读取目录…",
  treeEmpty: "这个目录是空的",
  treeNoMatch: "没有匹配的已加载文件",
  treeDisabledTitle: "文件树不可用",
  treeOpenDrawer: "文件树",
  treeCloseDrawer: "收起文件树",
  viewerEmptyTitle: "未打开文件",
  viewerEmptyBody: "在左侧文件树里选一个文件，这里会显示带行号的内容。",
  viewerLoading: "正在读取文件…",
  viewerBinaryTitle: "二进制文件不做预览",
  viewerBinaryBody: "这个文件不是文本，本轮不提供十六进制或图片预览。",
  viewerReadFailed: "读取失败",
  viewerRetry: "重试",
  modeCode: "源码",
  modePreview: "预览",
  modeEdit: "编辑",
  saveLabel: "保存",
  revertLabel: "放弃修改",
  dirtyBadge: "未保存",
  prevWindow: "上一段",
  nextWindow: "下一段",
  addSelection: "加入对话",
  addSelectionWithNote: "评论并加入对话",
  annotationPlaceholder: "写下对这段代码的说明，会和选区一起进入对话",
  annotationSend: "全部加入对话",
  annotationClear: "清空草稿",
  annotationEmpty: "还没有批注草稿",
  annotationRemove: "删除这条",
  reasonNoAdapter: "未检测到工作区文件后端（window." + DSH_FILE_ADAPTER_KEY + " 缺席），本轮只显示占位",
  reasonNoTree: "后端未开放目录列举能力",
  reasonNoRead: "后端未开放文件读取能力",
  reasonNoWrite: "桌面壳未开放文件写入能力，编辑内容不会落盘",
  reasonTruncatedNoWrite: "当前只读取了文件的一段，为避免覆盖未加载内容，截断窗口不能保存",
  saveFailed: "保存失败",
  saveOk: "已保存到磁盘",
  reasonNoSearch: "后端未开放文件搜索能力，已退回「过滤已加载文件」",
  reasonNoWatch: "后端未开放文件变更订阅，内容可能已过期",
  reasonNoComposer: "对话输入框尚未接好（缺少 composer 事件监听器）",
  reasonPreviewNoLine: "预览模式无法定位行号，切到「源码」后可加入对话",
  reasonNothingSelected: "先在正文里选中一段内容",
  staleHint: "不监听变更",
  staleHintTitle: "当前后端未提供 watch 能力，文件在磁盘上被改动时这里不会自动刷新",
  truncatedHint: "已按窗口上限截断",
  encodingUnknown: "编码未知",
  sizeUnknown: "大小未知",
  totalUnknown: "总行数未知",
  annotationLimitItems: "批注草稿最多 " + DSH_FILE_ANNOTATION_MAX_ITEMS + " 条",
  annotationLimitItem: "单条批注最多 " + DSH_FILE_ANNOTATION_ITEM_LIMIT + " 字",
  annotationLimitTotal: "批注草稿总量最多 " + DSH_FILE_ANNOTATION_TOTAL_LIMIT + " 字",
};

/* ==================== 纯逻辑（可单测，注入后同名可用） ==================== */

/** 取小写扩展名；没有扩展名返回空串。 */
export function dshFileExtension(filePath) {
  if (typeof filePath !== "string") return "";
  const normalized = filePath.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 取文件名（含扩展名）。 */
export function dshFileBaseName(filePath) {
  if (typeof filePath !== "string" || filePath === "") return "";
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

/** 扩展名兜底语言；未知返回空串（交给 ReadBlock 走无高亮路径）。 */
export function dshGuessFileLanguage(filePath) {
  const extension = dshFileExtension(filePath);
  if (extension === "") return "";
  const mapped = DSH_FILE_LANGUAGE_BY_EXTENSION[extension];
  return typeof mapped === "string" ? mapped : "";
}

/** 是否按二进制处理（只按扩展名兜底，后端结论优先）。 */
export function dshIsBinaryFilePath(filePath) {
  const extension = dshFileExtension(filePath);
  return extension !== "" && DSH_FILE_BINARY_EXTENSIONS.includes(extension);
}

/** 是否走 Markdown 预览。 */
export function dshIsMarkdownPath(filePath) {
  const extension = dshFileExtension(filePath);
  return extension !== "" && DSH_FILE_MARKDOWN_EXTENSIONS.includes(extension);
}

/**
 * 能力探测。
 *
 * 只承认**函数**：适配器声明 `read: true` 但没有 `readFile` 方法一律按不可用处理，
 * 避免「声明可用、调用即炸」。write 额外受 {@link DSH_FILE_WRITE_ENABLED} 硬门控。
 * @param adapter - `window.__dshWorkspaceFiles`。
 * @returns 五个能力位与各自的禁用原因，缺能力时 reason 必定非空。
 */
export function dshResolveFileCapabilities(adapter) {
  const has = (name) => adapter !== null && typeof adapter === "object" && typeof adapter[name] === "function";
  const hasAdapter = adapter !== null && typeof adapter === "object";
  const missing = DSH_FILE_VIEWER_COPY.reasonNoAdapter;
  const gate = (enabled, reason) => ({
    enabled: hasAdapter && enabled,
    reason: hasAdapter ? (enabled ? "" : reason) : missing,
  });
  const writeSupported = has("writeFile") && DSH_FILE_WRITE_ENABLED;
  return {
    hasAdapter,
    tree: gate(has("listDirectory"), DSH_FILE_VIEWER_COPY.reasonNoTree),
    read: gate(has("readFile"), DSH_FILE_VIEWER_COPY.reasonNoRead),
    write: {
      enabled: writeSupported,
      reason: writeSupported ? "" : DSH_FILE_VIEWER_COPY.reasonNoWrite,
    },
    search: gate(has("search"), DSH_FILE_VIEWER_COPY.reasonNoSearch),
    watch: gate(has("watch"), DSH_FILE_VIEWER_COPY.reasonNoWatch),
  };
}

/** 能力位摊平成五个布尔值，方便报告与断言逐项核对。 */
export function dshFileCapabilityFlags(capabilities) {
  const flags = {};
  for (const key of DSH_FILE_CAPABILITY_KEYS) {
    flags[key] = capabilities?.[key]?.enabled === true;
  }
  return flags;
}

/**
 * 归一化一个目录项。
 *
 * 形状不符一律丢弃（返回 null），不猜测缺失字段：没有 path 的节点无法定位，
 * 留在树里只会变成点不开的死行。
 */
export function dshNormalizeFileNode(node) {
  if (node === null || typeof node !== "object") return null;
  const rawPath = typeof node.path === "string" ? node.path.trim() : "";
  if (rawPath === "") return null;
  const kind = node.kind === "directory" || node.type === "directory" ? "directory" : "file";
  const name = typeof node.name === "string" && node.name !== "" ? node.name : dshFileBaseName(rawPath);
  const size = typeof node.size === "number" && Number.isFinite(node.size) && node.size >= 0 ? node.size : null;
  return {
    path: rawPath,
    name,
    kind,
    size,
    /* 后端明说 binary 就听后端的，没说才用扩展名兜底。 */
    binary: typeof node.binary === "boolean" ? node.binary : kind === "file" && dshIsBinaryFilePath(rawPath),
    ignored: node.ignored === true,
    symlink: node.symlink === true,
  };
}

/** 目录先于文件、同类按名称本地化排序，保证每次展开顺序稳定。 */
export function dshSortFileNodes(nodes) {
  return [...nodes].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

/**
 * 归一化 `listDirectory` 的返回。
 * @param result - 后端返回，允许是数组或 `{entries, nextCursor}`。
 * @param requestPath - 请求的目录路径，用于回填。
 */
export function dshNormalizeDirectoryListing(result, requestPath) {
  const rawEntries = Array.isArray(result) ? result : Array.isArray(result?.entries) ? result.entries : [];
  const entries = [];
  for (const raw of rawEntries) {
    const node = dshNormalizeFileNode(raw);
    if (node !== null) entries.push(node);
  }
  const nextCursor = typeof result?.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : null;
  return {
    path: typeof result?.path === "string" && result.path !== "" ? result.path : String(requestPath ?? ""),
    entries: dshSortFileNodes(entries),
    nextCursor,
    truncated: result?.truncated === true || nextCursor !== null,
  };
}

/**
 * 计算一次读取请求的窗口。
 *
 * 前端自己也夹一遍上限，不指望后端守规矩：窗口最多 500 行 / 256 KiB。
 */
export function dshResolveReadRequest(options) {
  const rawStart = Number.parseInt(String(options?.startLine ?? 1), 10);
  const startLine = Number.isInteger(rawStart) && rawStart > 0 ? rawStart : 1;
  const rawEnd = Number.parseInt(String(options?.endLine ?? Number.NaN), 10);
  const wanted = Number.isInteger(rawEnd) && rawEnd >= startLine ? rawEnd : startLine + DSH_FILE_READ_MAX_LINES - 1;
  const endLine = Math.min(wanted, startLine + DSH_FILE_READ_MAX_LINES - 1);
  return {
    startLine,
    endLine,
    maxLines: DSH_FILE_READ_MAX_LINES,
    maxBytes: DSH_FILE_READ_MAX_BYTES,
  };
}

/** UTF-16 字符串的近似字节数；只用于展示与上限判断，不做精确编码。 */
export function dshApproximateByteLength(text) {
  if (typeof text !== "string") return 0;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * 归一化 `readFile` 的返回。
 *
 * 兼容两种形状：`{lines:[{number,text}]}` 与 `{text}`；后者按请求起始行编号。
 * 后端超发时前端再夹一次 500 行 / 256 KiB，并如实标记 `truncated`。
 */
export function dshNormalizeReadResult(result, request) {
  const startLine = request?.startLine ?? 1;
  const lines = [];
  if (Array.isArray(result?.lines)) {
    for (const raw of result.lines) {
      if (raw === null || typeof raw !== "object") continue;
      const text = typeof raw.text === "string" ? raw.text : "";
      const parsed = Number.parseInt(String(raw.number ?? Number.NaN), 10);
      lines.push({ number: Number.isInteger(parsed) && parsed > 0 ? parsed : startLine + lines.length, text });
    }
  } else if (typeof result?.text === "string") {
    const parts = result.text.split("\n");
    /* 末尾换行会切出一个空串，它不是真实的一行。 */
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    for (let index = 0; index < parts.length; index += 1) {
      lines.push({ number: startLine + index, text: parts[index] });
    }
  }

  let truncated = result?.truncated === true;
  let capped = lines;
  if (capped.length > DSH_FILE_READ_MAX_LINES) {
    capped = capped.slice(0, DSH_FILE_READ_MAX_LINES);
    truncated = true;
  }
  let bytes = 0;
  for (let index = 0; index < capped.length; index += 1) {
    bytes += dshApproximateByteLength(capped[index].text) + 1;
    if (bytes > DSH_FILE_READ_MAX_BYTES) {
      capped = capped.slice(0, index);
      truncated = true;
      break;
    }
  }

  const rawTotal = Number.parseInt(String(result?.totalLines ?? Number.NaN), 10);
  const lastLine = capped.length === 0 ? startLine - 1 : capped[capped.length - 1].number;
  const totalLines = Number.isInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null;
  const hasMore = totalLines === null ? truncated : lastLine < totalLines;
  return {
    lines: capped,
    startLine: capped.length === 0 ? startLine : capped[0].number,
    endLine: lastLine,
    /* ReadBlock 的「显示 N / M 行」需要一个数；总行数未知时用已知下界，并另行标注未知。 */
    totalLines: totalLines ?? lastLine,
    totalLinesKnown: totalLines !== null,
    truncated,
    nextStartLine: hasMore ? lastLine + 1 : null,
    byteLength: bytes,
    encoding: typeof result?.encoding === "string" && result.encoding !== "" ? result.encoding : null,
    revision: typeof result?.revision === "string" && result.revision !== "" ? result.revision : null,
    binary: result?.binary === true,
    lang: typeof result?.lang === "string" && result.lang !== "" ? result.lang : null,
  };
}

/** 把归一化的行数组拼回纯文本（编辑器与选区取值共用）。 */
export function dshLinesToText(lines) {
  if (!Array.isArray(lines)) return "";
  return lines.map((line) => (typeof line?.text === "string" ? line.text : "")).join("\n");
}

/** 选区匹配用的轻量规范化：真实 UI 里换行、连续空格、NBSP 都不该影响定位。 */
export function dshSelectionSearchText(value) {
  return String(value ?? "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Markdown 预览会去掉标题符、反引号等装饰；这里只做保守脱壳，避免把源码语义改掉。 */
export function dshMarkdownPreviewLineText(text) {
  const tick = String.fromCharCode(96);
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(new RegExp(tick + "([^" + tick + "]+)" + tick, "gu"), "$1")
    .replace(/^(\s{0,3})(#{1,6}\s+|[-*+]\s+|>\s?|\d+\.\s+)/u, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/_([^_]+)_/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/<[^>]+>/gu, "");
}

/** Markdown 预览 DOM 没有源码行号时，用可见文本回到原始行号。 */
export function dshLineRangeFromPreviewSelection(lines, selectedText) {
  if (!Array.isArray(lines)) return null;
  const target = dshSelectionSearchText(selectedText);
  if (target === "") return null;
  const normalized = lines.map((line) => ({
    number: Number.isInteger(line?.number) && line.number > 0 ? line.number : null,
    text: dshSelectionSearchText(dshMarkdownPreviewLineText(line?.text))
  }));
  for (const line of normalized) {
    if (line.text.includes(target) && Number.isInteger(line.number) && line.number > 0) {
      return { startLine: line.number, endLine: line.number };
    }
  }
  for (let start = 0; start < normalized.length; start += 1) {
    let combined = "";
    for (let end = start; end < normalized.length; end += 1) {
      combined = dshSelectionSearchText((combined === "" ? "" : combined + " ") + normalized[end].text);
      if (combined.includes(target)) {
        const startLine = normalized[start].number;
        const endLine = normalized[end].number ?? startLine;
        if (Number.isInteger(startLine) && startLine > 0) return { startLine, endLine: Math.max(startLine, endLine ?? startLine) };
      }
      if (combined.length > target.length + 512) break;
    }
  }
  return null;
}

/**
 * djb2 字符串哈希（十六进制）。
 *
 * 只用于「同一段内容有没有变过」的弱校验，不做安全用途，所以不引入 `node:crypto`
 * 也不用 WebCrypto（后者是异步的，会把同步的选区构造链路整个染成异步）。
 */
export function dshFileContentHash(text) {
  const value = typeof text === "string" ? text : "";
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
    hash = hash >>> 0;
  }
  return "djb2-" + hash.toString(16).padStart(8, "0");
}

/** `L7` / `L7-L12` 的行范围标签。 */
export function dshFormatLineRange(startLine, endLine) {
  if (!Number.isInteger(startLine) || startLine <= 0) return "";
  if (!Number.isInteger(endLine) || endLine <= startLine) return "L" + startLine;
  return "L" + startLine + "-L" + endLine;
}

/** 人类可读体积。 */
export function dshFormatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return DSH_FILE_VIEWER_COPY.sizeUnknown;
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * 从 DOM 节点回溯出文件行号。
 *
 * 两条路径共用同一份逻辑，所以官方 `ReadBlock` 与降级 DOM 行可以互换：
 *   1. 自绘行带 `data-dsh-fv-line="N"`，直接读属性；
 *   2. 官方 `ReadBlock` 的行是 `div > [span[aria-hidden](行号), span(内容)]`，
 *      按**结构**取第一个子元素的文本，不依赖任何混淆类名。
 * @param node - 选区端点节点（可能是文本节点）。
 * @param stop - 回溯上界，通常是查看器根节点；到达即放弃。
 * @returns 1 起的行号，取不到返回 null。
 */
export function dshLineNumberFromDomNode(node, stop) {
  let current = node ?? null;
  let guard = 0;
  while (current !== null && current !== undefined && guard < 64) {
    guard += 1;
    const element = typeof current.getAttribute === "function" ? current : (current.parentElement ?? null);
    if (element === null || element === undefined) return null;
    if (stop !== undefined && stop !== null && element === stop) return null;
    const own = element.getAttribute("data-dsh-fv-line");
    const parsedOwn = own === null || own === undefined ? Number.NaN : Number.parseInt(own, 10);
    if (Number.isInteger(parsedOwn) && parsedOwn > 0) return parsedOwn;
    const children = element.children;
    if (children !== null && children !== undefined && children.length === 2) {
      const gutter = children[0];
      if (gutter !== null && gutter !== undefined && typeof gutter.getAttribute === "function" && gutter.getAttribute("aria-hidden") !== null) {
        const parsedGutter = Number.parseInt(String(gutter.textContent ?? "").trim(), 10);
        if (Number.isInteger(parsedGutter) && parsedGutter > 0) return parsedGutter;
      }
    }
    current = element.parentElement ?? null;
  }
  return null;
}

/**
 * textarea 里按字符偏移换算行号（编辑态选区用）。
 * @param text - 编辑器全文。
 * @param start - 选区起点偏移。
 * @param end - 选区终点偏移。
 * @param baseLine - 编辑器第一行对应的文件行号。
 */
export function dshLineRangeFromTextOffsets(text, start, end, baseLine) {
  const source = typeof text === "string" ? text : "";
  const base = Number.isInteger(baseLine) && baseLine > 0 ? baseLine : 1;
  const from = Math.max(0, Math.min(source.length, Number.isInteger(start) ? start : 0));
  const to = Math.max(from, Math.min(source.length, Number.isInteger(end) ? end : from));
  const startLine = base + source.slice(0, from).split("\n").length - 1;
  const inner = source.slice(from, to);
  let endLine = startLine + inner.split("\n").length - 1;
  if (inner !== "" && inner.endsWith("\n")) endLine -= 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

/**
 * 构造「选中内容加入对话」的载荷。
 *
 * 缺路径或缺行号一律返回 null——宁可按钮 disabled，也不发一条定位不到的引用。
 */
export function dshBuildFileSelectionPayload(input) {
  const filePath = typeof input?.path === "string" ? input.path.trim() : "";
  const text = typeof input?.text === "string" ? input.text : "";
  const startLine = Number.parseInt(String(input?.startLine ?? Number.NaN), 10);
  const endLine = Number.parseInt(String(input?.endLine ?? Number.NaN), 10);
  if (filePath === "" || text === "" || !Number.isInteger(startLine) || startLine <= 0) return null;
  const resolvedEnd = Number.isInteger(endLine) && endLine >= startLine ? endLine : startLine;
  const truncated = text.length > DSH_FILE_SELECTION_TEXT_LIMIT;
  const body = truncated ? text.slice(0, DSH_FILE_SELECTION_TEXT_LIMIT) : text;
  return {
    kind: "workspace-file",
    path: filePath,
    startLine,
    endLine: resolvedEnd,
    lineRange: dshFormatLineRange(startLine, resolvedEnd),
    text: body,
    truncated,
    lang: typeof input?.lang === "string" && input.lang !== "" ? input.lang : dshGuessFileLanguage(filePath),
    revision: typeof input?.revision === "string" && input.revision !== "" ? input.revision : null,
    contentHash: dshFileContentHash(body),
    annotation: typeof input?.annotation === "string" && input.annotation !== "" ? input.annotation : null,
    capturedAt: typeof input?.capturedAt === "string" && input.capturedAt !== "" ? input.capturedAt : null,
  };
}

/**
 * 追加一条批注草稿并做上限校验。
 * @returns `{ok, drafts, error}`；`ok=false` 时 `drafts` 原样返回，`error` 是中文提示。
 */
export function dshAppendAnnotationDraft(drafts, item) {
  const list = Array.isArray(drafts) ? drafts : [];
  if (item === null || typeof item !== "object") return { ok: false, drafts: list, error: DSH_FILE_VIEWER_COPY.reasonNothingSelected };
  if (list.length >= DSH_FILE_ANNOTATION_MAX_ITEMS) {
    return { ok: false, drafts: list, error: DSH_FILE_VIEWER_COPY.annotationLimitItems };
  }
  const annotation = typeof item.annotation === "string" ? item.annotation : "";
  if (annotation.length > DSH_FILE_ANNOTATION_ITEM_LIMIT) {
    return { ok: false, drafts: list, error: DSH_FILE_VIEWER_COPY.annotationLimitItem };
  }
  const used = list.reduce((sum, entry) => sum + (typeof entry?.annotation === "string" ? entry.annotation.length : 0), 0);
  if (used + annotation.length > DSH_FILE_ANNOTATION_TOTAL_LIMIT) {
    return { ok: false, drafts: list, error: DSH_FILE_VIEWER_COPY.annotationLimitTotal };
  }
  return { ok: true, drafts: [...list, item], error: "" };
}

/** 把草稿打包成一条 composer 事件载荷；空草稿返回 null。 */
export function dshBuildWorkspaceAnnotationsPayload(drafts) {
  const list = Array.isArray(drafts) ? drafts.filter((item) => item !== null && typeof item === "object") : [];
  if (list.length === 0) return null;
  return {
    kind: "workspace-file-annotations",
    count: list.length,
    items: list.map((item) => ({
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      lineRange: item.lineRange,
      text: item.text,
      truncated: item.truncated === true,
      lang: item.lang ?? null,
      revision: item.revision ?? null,
      contentHash: item.contentHash ?? null,
      annotation: item.annotation ?? null,
    })),
  };
}

/** 后端没有搜索能力时的本地兜底：只过滤已经加载进内存的节点。 */
export function dshFilterLoadedFileNodes(nodes, query) {
  const list = Array.isArray(nodes) ? nodes : [];
  const keyword = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (keyword === "") return list;
  return list.filter((node) => {
    const name = typeof node?.name === "string" ? node.name.toLowerCase() : "";
    const filePath = typeof node?.path === "string" ? node.path.toLowerCase() : "";
    return name.includes(keyword) || filePath.includes(keyword);
  });
}

/**
 * 把「目录 → 子节点」的懒加载表展平成一维渲染行。
 *
 * 只展开 `expanded` 里已经确认展开、且子节点已加载的目录；没加载的目录留一个
 * `loading` 行，不假装它是空目录。
 * @param rootPath - 根目录路径。
 * @param childrenByPath - 目录路径 → 已归一化子节点数组。
 * @param expanded - 已展开的目录路径集合（需要有 `has`）。
 * @param loadingPaths - 正在加载的目录路径集合（需要有 `has`）。
 */
export function dshFlattenFileTree(rootPath, childrenByPath, expanded, loadingPaths) {
  const rows = [];
  const seen = new Set();
  const childrenOf = (dirPath) => {
    if (childrenByPath instanceof Map) return childrenByPath.get(dirPath);
    return childrenByPath?.[dirPath];
  };
  const walk = (dirPath, depth) => {
    if (seen.has(dirPath) || depth > 32) return;
    seen.add(dirPath);
    const children = childrenOf(dirPath);
    if (children === undefined || children === null) {
      if (loadingPaths?.has?.(dirPath) === true) rows.push({ kind: "loading", path: dirPath, depth });
      return;
    }
    if (children.length === 0) {
      rows.push({ kind: "empty", path: dirPath, depth });
      return;
    }
    for (const node of children) {
      const open = node.kind === "directory" && expanded?.has?.(node.path) === true;
      rows.push({ kind: "node", node, depth, open });
      if (open) walk(node.path, depth + 1);
    }
  };
  walk(String(rootPath ?? ""), 0);
  return rows;
}

/* ==================== 注入样式 ==================== */

/**
 * 文件查看器样式。
 *
 * 变量全部落在 `--dsh-workspace-file-*` 命名空间下，且**声明在 `body` 上**——
 * 干净基线把 `--dsw-alias-*` 声明在 `body`，写在 `:root` 上取不到值（W1 已踩过）。
 */
export const DSH_FILE_VIEWER_STYLE = [
  "body{",
  "--dsh-workspace-file-fg:var(--dsw-alias-label-primary);",
  "--dsh-workspace-file-muted:var(--dsw-alias-label-caption);",
  "--dsh-workspace-file-border:var(--dsw-alias-border-l2);",
  "--dsh-workspace-file-accent:var(--dsw-static-deepseek-500);",
  "--dsh-workspace-file-row-hover:var(--dsw-alias-interactive-bg-hover);",
  "--dsh-workspace-file-row-active:var(--dsw-alias-bg-layer-2);",
  /* 48px / 14px / 22px 三个数值抄自官方 ReadBlock 的真实 CSS（_gutter/_line），
     不是拍脑袋定的：降级渲染器与官方主渲染器必须逐像素对齐，否则两条路径切换会跳动。 */
  "--dsh-workspace-file-gutter:48px;",
  "--dsh-workspace-file-gutter-gap:14px;",
  "--dsh-workspace-file-line:22px;",
  "--dsh-workspace-file-indent:14px;",
  "--dsh-workspace-file-mono:'Cascadia Code',Consolas,'Courier New',monospace;",
  "}",
  ".dsh-fv-tree{display:flex;flex-direction:column;min-height:0;height:100%;gap:6px}",
  ".dsh-fv-tree-head{display:flex;align-items:center;gap:6px;padding:0 2px}",
  /* 不写 flex:none 会被输入框挤成竖排——harness 1440 截图实测。 */
  ".dsh-fv-tree-head strong{flex:none;white-space:nowrap;font-size:12px;font-weight:600;color:var(--dsh-workspace-file-muted)}",
  ".dsh-fv-filter{flex:1 1 auto;min-width:0;box-sizing:border-box;height:26px;padding:0 8px;border:1px solid var(--dsh-workspace-file-border);border-radius:8px;background:transparent;color:inherit;font:12px/24px inherit;outline:none}",
  ".dsh-fv-filter:focus{border-color:var(--dsh-workspace-file-accent)}",
  ".dsh-fv-filter:disabled{opacity:.5;cursor:not-allowed}",
  ".dsh-fv-tree-list{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}",
  ".dsh-fv-node{display:flex;align-items:center;gap:4px;width:100%;box-sizing:border-box;min-height:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsh-workspace-file-fg);font:12.5px/24px inherit;text-align:left;cursor:pointer}",
  ".dsh-fv-node:hover{background:var(--dsh-workspace-file-row-hover)}",
  '.dsh-fv-node[aria-current="true"]{background:var(--dsh-workspace-file-row-active);font-weight:600}',
  ".dsh-fv-node[data-dsh-fv-ignored]{opacity:.55}",
  ".dsh-fv-node span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dsh-fv-caret{flex:none;width:12px;height:12px;color:var(--dsh-workspace-file-muted);transition:transform .12s ease}",
  '.dsh-fv-node[aria-expanded="true"] .dsh-fv-caret{transform:rotate(90deg)}',
  ".dsh-fv-icon{flex:none;width:14px;height:14px;color:var(--dsh-workspace-file-muted)}",
  ".dsh-fv-tree-note{padding:6px 8px;color:var(--dsh-workspace-file-muted);font-size:12px;line-height:18px}",
  /* 必须带上 .dsh-fv-btn 提权：单独的 .dsh-fv-drawer-toggle 会被后面的 .dsh-fv-btn 覆盖掉。 */
  ".dsh-fv-btn.dsh-fv-drawer-toggle{display:none}",
  '#dsh-workspace-shell[data-dsh-compact-tree="true"] .dsh-fv-btn.dsh-fv-drawer-toggle{display:inline-flex}',
  ".dsh-fv-drawer{display:none;flex-direction:column;gap:6px;max-height:44vh;margin-bottom:8px;padding:8px;border:1px solid var(--dsh-workspace-file-border);border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}",
  '.dsh-fv-pane[data-dsh-fv-drawer="open"] .dsh-fv-drawer{display:flex}',
  ".dsh-fv-pane{display:flex;flex-direction:column;min-height:0;height:100%;gap:8px}",
  /* 编辑态多两个按钮时一行放不下，不换行会把「保存」切出面板——harness 实测。 */
  ".dsh-fv-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}",
  /* direction:rtl 让省略号出现在开头（留住文件名），配合运行时加的 LTR 标记，
     否则路径开头的 / 会被双向算法甩到结尾，显示成「…dow.ts/」。 */
  ".dsh-fv-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;font:12px/20px var(--dsh-workspace-file-mono);color:var(--dsh-workspace-file-muted)}",
  ".dsh-fv-btn{display:inline-flex;align-items:center;gap:4px;flex:none;height:24px;padding:0 8px;border:1px solid var(--dsh-workspace-file-border);border-radius:8px;background:transparent;color:var(--dsh-workspace-file-fg);font:12px/22px inherit;cursor:pointer}",
  ".dsh-fv-btn:hover:not(:disabled){background:var(--dsh-workspace-file-row-hover)}",
  ".dsh-fv-btn:disabled{opacity:.45;cursor:not-allowed}",
  '.dsh-fv-btn[aria-pressed="true"]{border-color:var(--dsh-workspace-file-accent);color:var(--dsh-workspace-file-accent)}',
  ".dsh-fv-btn[data-primary]{border-color:var(--dsh-workspace-file-accent);background:var(--dsh-workspace-file-accent);color:#fff}",
  /* 主按钮一旦 disabled 就必须退回幽灵态：只降透明度的话 45% 的蓝仍然读起来像可点，
     与「不可用的东西不能看起来可用」冲突（主线 W4 复核第 3 条）。 */
  ".dsh-fv-btn[data-primary]:disabled{border-color:var(--dsh-workspace-file-border);background:transparent;color:var(--dsh-workspace-file-muted);opacity:.7}",
  ".dsh-fv-modes{display:inline-flex;gap:4px;flex:none}",
  ".dsh-fv-notice{display:flex;flex-wrap:wrap;gap:6px;font-size:11.5px;line-height:18px;color:var(--dsh-workspace-file-muted)}",
  ".dsh-fv-notice b{padding:0 6px;border:1px solid var(--dsh-workspace-file-border);border-radius:999px;font-weight:400}",
  /* 红色只留给真实失败。能力缺口（write/watch 本轮就没打算做）用默认的中性徽章，
     否则每开一个文件都顶一个红框，会把「本轮范围外」误读成「出错了」。 */
  '.dsh-fv-notice b[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d92d20);border-color:currentColor}',
  ".dsh-fv-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}",
  ".dsh-fv-empty{display:flex;flex-direction:column;gap:6px;padding:18px 14px;color:var(--dsh-workspace-file-muted);font-size:12.5px;line-height:19px}",
  ".dsh-fv-empty strong{color:var(--dsh-workspace-file-fg);font-size:13px}",
  /* 约定式容器是 column flex，不写 align-self 会把重试按钮拉满整行。 */
  ".dsh-fv-empty .dsh-fv-btn{align-self:flex-start}",
  /* 长行是横向滚动，不是折行。三条理由：Plan_15 第 6 章明写「横向滚动」；
     官方 ReadBlock 的 _body 就是 overflow-x:auto、_line 就是 white-space:pre；
     折行会让一个行号对应多个视觉行，选中跨折行时行号语义变糊。
     横向滚动条挂在 .dsh-fv-fallback 自己身上（对应官方 _body），
     纵向滚动仍归外层 .dsh-fv-body，与官方的分工一致。 */
  ".dsh-fv-fallback{margin:0;padding:12px 0;border-radius:12px;background:var(--dsw-alias-markdown-code-block,transparent);font:12px/var(--dsh-workspace-file-line) var(--dsh-workspace-file-mono);overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain}",
  ".dsh-fv-fallback>div{display:flex;min-height:var(--dsh-workspace-file-line);line-height:var(--dsh-workspace-file-line);white-space:pre}",
  ".dsh-fv-fallback>div>span:first-child{flex:none;box-sizing:border-box;width:var(--dsh-workspace-file-gutter);padding-right:var(--dsh-workspace-file-gutter-gap);text-align:right;color:var(--dsh-workspace-file-muted);user-select:none;font-variant-numeric:tabular-nums}",
  /* 这里绝不能写 min-width:0：那会解除 flex 项的自动最小尺寸，
     让 white-space:pre 的长行被压缩裁掉而不是撑出滚动条。 */
  ".dsh-fv-fallback>div>span:last-child{flex:none}",
  ".dsh-fv-editor{display:flex;min-height:0;height:100%;font:12px/20px var(--dsh-workspace-file-mono)}",
  ".dsh-fv-editor-gutter{flex:none;width:var(--dsh-workspace-file-gutter);padding:8px 8px 8px 0;text-align:right;color:var(--dsh-workspace-file-muted);user-select:none;white-space:pre;font-variant-numeric:tabular-nums}",
  ".dsh-fv-editor textarea{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:8px;border:0;border-left:1px solid var(--dsh-workspace-file-border);background:transparent;color:inherit;font:inherit;resize:none;outline:none;white-space:pre;overflow:auto}",
  ".dsh-fv-foot{display:flex;align-items:center;column-gap:8px;row-gap:4px;flex-wrap:wrap;font-size:11.5px;line-height:20px;color:var(--dsh-workspace-file-muted)}",
  ".dsh-fv-foot .dsh-fv-spacer{flex:1 1 auto}",
  ".dsh-fv-foot>span:first-child{flex:0 1 auto;min-width:0;overflow-wrap:anywhere}",
  /* 「上一段 / 下一段」必须作为一个整体换行：直接摊在 wrap 容器里时，
     信息行一长就只把「下一段」挤到下一行，整条工具条破相（主线 W4 复核第 2 条）。 */
  ".dsh-fv-foot-nav{display:inline-flex;align-items:center;gap:6px;flex:none}",
  ".dsh-fv-selbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--dsh-workspace-file-border)}",
  ".dsh-fv-selbar-range{font:11.5px/20px var(--dsh-workspace-file-mono);color:var(--dsh-workspace-file-muted)}",
  ".dsh-fv-drafts{display:flex;flex-direction:column;gap:8px;max-height:34vh;overflow:auto;overscroll-behavior:contain}",
  ".dsh-fv-draft{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--dsh-workspace-file-border);border-radius:10px}",
  ".dsh-fv-draft-head{display:flex;align-items:center;gap:6px;font:11.5px/18px var(--dsh-workspace-file-mono);color:var(--dsh-workspace-file-muted)}",
  ".dsh-fv-draft-head span:first-child{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dsh-fv-draft-quote{max-height:66px;overflow:auto;margin:0;padding:6px 8px;border-radius:8px;background:var(--dsh-workspace-file-row-active);font:11.5px/18px var(--dsh-workspace-file-mono);white-space:pre-wrap;overflow-wrap:anywhere}",
  ".dsh-fv-draft textarea{box-sizing:border-box;width:100%;min-height:52px;resize:vertical;padding:6px 8px;border:1px solid var(--dsh-workspace-file-border);border-radius:8px;background:transparent;color:inherit;font:12px/18px inherit;outline:none}",
  ".dsh-fv-draft textarea:focus{border-color:var(--dsh-workspace-file-accent)}",
  ".dsh-fv-error{color:var(--dsw-alias-state-error-primary,#d92d20)}",
  /* display:flex / inline-flex 会盖掉 hidden 的 UA 样式，必须显式归零。 */
  ".dsh-fv-btn[hidden],.dsh-fv-notice[hidden],.dsh-fv-drafts[hidden],.dsh-fv-selbar[hidden],.dsh-fv-tree[hidden],.dsh-fv-foot-nav[hidden]{display:none}",
  "@media (prefers-reduced-motion:reduce){.dsh-fv-caret{transition:none}}",
].join("");

/* ==================== 运行时装载 ==================== */

const DSH_FILE_VIEWER_LOGIC_SOURCE = [
  dshFileExtension,
  dshFileBaseName,
  dshGuessFileLanguage,
  dshIsBinaryFilePath,
  dshIsMarkdownPath,
  dshResolveFileCapabilities,
  dshFileCapabilityFlags,
  dshNormalizeFileNode,
  dshSortFileNodes,
  dshNormalizeDirectoryListing,
  dshResolveReadRequest,
  dshApproximateByteLength,
  dshNormalizeReadResult,
  dshLinesToText,
  dshSelectionSearchText,
  dshMarkdownPreviewLineText,
  dshLineRangeFromPreviewSelection,
  dshFileContentHash,
  dshFormatLineRange,
  dshFormatBytes,
  dshLineNumberFromDomNode,
  dshLineRangeFromTextOffsets,
  dshBuildFileSelectionPayload,
  dshAppendAnnotationDraft,
  dshBuildWorkspaceAnnotationsPayload,
  dshFilterLoadedFileNodes,
  dshFlattenFileTree,
]
  .map((fn) => fn.toString().split("\n").map((line) => "\t\t" + line).join("\n"))
  .join("\n");

const DSH_FILE_VIEWER_CONSTANT_SOURCE = [
  ["DSH_FILE_ADAPTER_KEY", DSH_FILE_ADAPTER_KEY],
  ["DSH_FILE_CAPABILITY_KEYS", DSH_FILE_CAPABILITY_KEYS],
  ["DSH_FILE_WRITE_ENABLED", DSH_FILE_WRITE_ENABLED],
  ["DSH_FILE_READ_MAX_LINES", DSH_FILE_READ_MAX_LINES],
  ["DSH_FILE_READ_MAX_BYTES", DSH_FILE_READ_MAX_BYTES],
  ["DSH_FILE_RENDER_MAX_LINES", DSH_FILE_RENDER_MAX_LINES],
  ["DSH_FILE_SELECTION_TEXT_LIMIT", DSH_FILE_SELECTION_TEXT_LIMIT],
  ["DSH_FILE_ANNOTATION_MAX_ITEMS", DSH_FILE_ANNOTATION_MAX_ITEMS],
  ["DSH_FILE_ANNOTATION_ITEM_LIMIT", DSH_FILE_ANNOTATION_ITEM_LIMIT],
  ["DSH_FILE_ANNOTATION_TOTAL_LIMIT", DSH_FILE_ANNOTATION_TOTAL_LIMIT],
  ["DSH_FILE_ANNOTATION_PERSIST", DSH_FILE_ANNOTATION_PERSIST],
  ["DSH_FILE_ANNOTATION_STORAGE_KEY", DSH_FILE_ANNOTATION_STORAGE_KEY],
  ["DSH_FILE_SELECTION_EVENT", DSH_FILE_SELECTION_EVENT],
  ["DSH_FILE_ANNOTATION_EVENT", DSH_FILE_ANNOTATION_EVENT],
  ["DSH_FILE_COMPOSER_READY_EVENT", DSH_FILE_COMPOSER_READY_EVENT],
  ["DSH_FILE_DESKTOP_READY_EVENT", DSH_FILE_DESKTOP_READY_EVENT],
  ["DSH_FILE_COMPACT_TREE_ATTR", DSH_FILE_COMPACT_TREE_ATTR],
  ["DSH_FILE_LANGUAGE_BY_EXTENSION", DSH_FILE_LANGUAGE_BY_EXTENSION],
  ["DSH_FILE_BINARY_EXTENSIONS", DSH_FILE_BINARY_EXTENSIONS],
  ["DSH_FILE_MARKDOWN_EXTENSIONS", DSH_FILE_MARKDOWN_EXTENSIONS],
  ["DSH_FILE_VIEWER_COPY", DSH_FILE_VIEWER_COPY],
  ["DSH_FILE_VIEWER_STYLE", DSH_FILE_VIEWER_STYLE],
]
  .map(([name, value]) => "\t\tconst " + name + " = " + JSON.stringify(value) + ";")
  .join("\n");

/**
 * 注入到对话 bundle 的文件查看器运行时。
 *
 * 模板内**不得出现反引号**（会提前终止模板并把注入源码切碎，W3 已因此吞过文件），
 * 所有字符串拼接一律用 `+`。
 */
export const DSH_FILE_VIEWER_RUNTIME_SOURCE = `${DSH_FILE_VIEWER_CONSTANT_SOURCE}
${DSH_FILE_VIEWER_LOGIC_SOURCE}
\t\t/** 可选依赖：拿不到就退回原生 DOM 渲染，不抛错、不假装可用。 */
\t\tfunction dshFvRequireOptional(id) {
\t\t\ttry {
\t\t\t\treturn require(id);
\t\t\t} catch (error) {
\t\t\t\treturn null;
\t\t\t}
\t\t}
\t\tconst DSH_FV_REACT = typeof react === "undefined" ? null : react;
\t\tconst DSH_FV_PRIMITIVES = typeof _deepseek_ai_dsh_client_ui_primitives === "undefined" ? null : _deepseek_ai_dsh_client_ui_primitives;
\t\t/* react-dom/client 是 loader 的 static seed module，makeRequire 不校验 graph，所以这里能拿到。 */
\t\tconst DSH_FV_REACT_DOM = DSH_FV_REACT === null ? null : dshFvRequireOptional("react-dom/client");
\t\t/* codeLabels 必须是稳定引用：MarkdownText 用它判定要不要重建流式渲染器。 */
\t\tconst DSH_FV_CODE_LABELS = Object.freeze({ copyLabel: "复制", copiedLabel: "复制成功" });
\t\t/**
\t\t* 渲染器选择。
\t\t* primitives = 官方 ReadBlock / MarkdownText（独立 React root；primitives 全包 0 处
\t\t* createContext/useContext，主题只走 body 上的 --dsw-* 变量继承，所以独立根安全）。
\t\t* dom = 结构同构的原生行，选中到行号的还原逻辑与官方路径完全共用。
\t\t*/
\t\tfunction dshFvRenderer() {
\t\t\tif (DSH_FV_REACT === null || DSH_FV_REACT_DOM === null) return "dom";
\t\t\tif (typeof DSH_FV_REACT_DOM.createRoot !== "function") return "dom";
\t\t\tif (DSH_FV_PRIMITIVES === null) return "dom";
\t\t\tif (typeof DSH_FV_PRIMITIVES.ReadBlock !== "function") return "dom";
\t\t\tif (DSH_FV_PRIMITIVES.MarkdownText === null || DSH_FV_PRIMITIVES.MarkdownText === undefined) return "dom";
\t\t\treturn "primitives";
\t\t}
\t\tfunction dshFvComposerReady(kind) {
\t\t\t/* 与 W3 同一条真相：函数式探测，DOM 事件无法探测监听器是否存在。 */
\t\t\tconst accepts = window.__dshComposerAccepts;
\t\t\tif (typeof accepts !== "function") return false;
\t\t\treturn accepts(kind) === true;
\t\t}
\t\tfunction dshFvAdapter() {
\t\t\tconst adapter = window[DSH_FILE_ADAPTER_KEY];
\t\t\treturn adapter === null || typeof adapter !== "object" ? null : adapter;
\t\t}
\t\tfunction dshFvErrorText(error) {
\t\t\tif (error === null || error === undefined) return "未知错误";
\t\t\tif (typeof error === "string") return error;
\t\t\tconst message = error.message;
\t\t\treturn typeof message === "string" && message !== "" ? message : String(error);
\t\t}
\t\t/**
\t\t* 装载文件树与分层文件查看器。
\t\t* 只接管 W3 外壳里的 .dsh-ws-tree 与 files 面板，不改 W3 的任何契约。
\t\t* 返回 teardown，交给 ctx.effect 托管。
\t\t*/
\t\tfunction installDshFileViewer() {
\t\t\tif (typeof document === "undefined" || document.body === null) return () => {};
\t\t\tconst doc = document;
\t\t\tlet teardown = null;
\t\t\tlet observer = null;
\t\t\tconst attach = () => {
\t\t\t\tconst shell = doc.getElementById("dsh-workspace-shell");
\t\t\t\tif (shell === null) return false;
\t\t\t\tconst treeHost = shell.querySelector(".dsh-ws-tree");
\t\t\t\tconst pane = shell.querySelector('[data-dsh-ws-pane="files"]');
\t\t\t\tif (treeHost === null || pane === null) return false;
\t\t\t\tif (pane.dataset.dshFvMounted === "true") return true;
\t\t\t\tteardown = dshFvMount(doc, shell, treeHost, pane);
\t\t\t\treturn true;
\t\t\t};
\t\t\tif (!attach()) {
\t\t\t\t/* W3 外壳可能晚于本补丁装载；等它出现再接管，不轮询。 */
\t\t\t\tobserver = new MutationObserver(() => {
\t\t\t\t\tif (!attach()) return;
\t\t\t\t\tobserver.disconnect();
\t\t\t\t\tobserver = null;
\t\t\t\t});
\t\t\t\tobserver.observe(doc.body, { childList: true, subtree: true });
\t\t\t}
\t\t\treturn () => {
\t\t\t\tobserver?.disconnect();
\t\t\t\tobserver = null;
\t\t\t\tif (teardown !== null) teardown();
\t\t\t\tteardown = null;
\t\t\t};
\t\t}
\t\tfunction dshFvMount(doc, shell, treeHost, pane) {
\t\t\tconst disposers = [];
\t\t\tconst renderer = dshFvRenderer();
\t\t\tconst el = (tag, className, text) => {
\t\t\t\tconst node = doc.createElement(tag);
\t\t\t\tif (className !== undefined && className !== null) node.className = className;
\t\t\t\tif (text !== undefined && text !== null) node.textContent = text;
\t\t\t\treturn node;
\t\t\t};
\t\t\tconst button = (label, className) => {
\t\t\t\tconst node = doc.createElement("button");
\t\t\t\tnode.type = "button";
\t\t\t\tnode.className = className === undefined ? "dsh-fv-btn" : className;
\t\t\t\tnode.textContent = label;
\t\t\t\treturn node;
\t\t\t};

\t\t\tif (doc.querySelector('style[data-dsh-frontend="file-viewer"]') === null) {
\t\t\t\tconst tag = doc.createElement("style");
\t\t\t\ttag.dataset.dshFrontend = "file-viewer";
\t\t\t\ttag.textContent = DSH_FILE_VIEWER_STYLE;
\t\t\t\tdoc.head.appendChild(tag);
\t\t\t\tdisposers.push(() => tag.remove());
\t\t\t}

\t\t\tconst state = {
\t\t\t\tcaps: dshResolveFileCapabilities(dshFvAdapter()),
\t\t\t\trootPath: "",
\t\t\t\tchildren: new Map(),
\t\t\t\texpanded: new Set(),
\t\t\t\tloadingDirs: new Set(),
\t\t\t\tcurrentPath: null,
\t\t\t\tcurrentBinary: false,
\t\t\t\tread: null,
\t\t\t\treadError: null,
\t\t\t\treading: false,
\t\t\t\tsaving: false,
\t\t\t\tmode: "code",
\t\t\t\tdraftText: null,
\t\t\t\tdirty: false,
\t\t\t\tfilter: "",
\t\t\t\tselection: null,
\t\t\t\tdrafts: [],
\t\t\t\tdraftError: "",
\t\t\t\tnotice: "",
\t\t\t\trequestToken: 0
\t\t\t};
\t\t\tlet unwatch = null;

\t\t\t/* ---------- 左列：文件树 ---------- */
\t\t\ttreeHost.textContent = "";
\t\t\tconst treeRoot = el("div", "dsh-fv-tree");
\t\t\tconst treeHead = el("div", "dsh-fv-tree-head");
\t\t\ttreeHead.appendChild(el("strong", null, DSH_FILE_VIEWER_COPY.treeTitle));
\t\t\tconst filterInput = doc.createElement("input");
\t\t\tfilterInput.type = "text";
\t\t\tfilterInput.className = "dsh-fv-filter";
\t\t\ttreeHead.appendChild(filterInput);
\t\t\tconst treeList = el("div", "dsh-fv-tree-list");
\t\t\tconst treeNote = el("div", "dsh-fv-tree-note");
\t\t\ttreeRoot.append(treeHead, treeList, treeNote);
\t\t\ttreeHost.appendChild(treeRoot);

\t\t\t/* ---------- 右列：查看器 ---------- */
\t\t\tpane.dataset.dshFvMounted = "true";
\t\t\tpane.classList.add("dsh-fv-pane");
\t\t\t/* 接管 W3 的占位：占位的存在意义就是等 W4 把真实查看器放进来。 */
\t\t\tpane.textContent = "";
\t\t\tconst drawer = el("div", "dsh-fv-drawer");
\t\t\tconst head = el("div", "dsh-fv-head");
\t\t\tconst drawerToggle = button(DSH_FILE_VIEWER_COPY.treeOpenDrawer, "dsh-fv-btn dsh-fv-drawer-toggle");
\t\t\tdrawerToggle.setAttribute("aria-expanded", "false");
\t\t\tconst pathLabel = el("div", "dsh-fv-path");
\t\t\tconst modes = el("div", "dsh-fv-modes");
\t\t\tconst modeButtons = new Map();
\t\t\tfor (const spec of [["code", DSH_FILE_VIEWER_COPY.modeCode], ["preview", DSH_FILE_VIEWER_COPY.modePreview], ["edit", DSH_FILE_VIEWER_COPY.modeEdit]]) {
\t\t\t\tconst node = button(spec[1]);
\t\t\t\tnode.dataset.dshFvMode = spec[0];
\t\t\t\tnode.setAttribute("aria-pressed", "false");
\t\t\t\tmodes.appendChild(node);
\t\t\t\tmodeButtons.set(spec[0], node);
\t\t\t}
\t\t\tconst revertButton = button(DSH_FILE_VIEWER_COPY.revertLabel);
\t\t\tconst saveButton = button(DSH_FILE_VIEWER_COPY.saveLabel);
\t\t\tsaveButton.dataset.primary = "true";
\t\t\thead.append(drawerToggle, pathLabel, modes, revertButton, saveButton);
\t\t\tconst notice = el("div", "dsh-fv-notice");
\t\t\tconst bodyBox = el("div", "dsh-fv-body");
\t\t\tconst plainHost = el("div", "dsh-fv-plain");
\t\t\tbodyBox.appendChild(plainHost);
\t\t\tlet reactHost = null;
\t\t\tlet reactRoot = null;
\t\t\tif (renderer === "primitives") {
\t\t\t\treactHost = el("div", "dsh-fv-react");
\t\t\t\treactHost.hidden = true;
\t\t\t\tbodyBox.appendChild(reactHost);
\t\t\t\t/* root 只 create 一次，后续更新一律走 render()，避免泄漏与重复挂载警告。 */
\t\t\t\treactRoot = DSH_FV_REACT_DOM.createRoot(reactHost);
\t\t\t}
\t\t\tconst selectionBar = el("div", "dsh-fv-selbar");
\t\t\tconst selectionRange = el("span", "dsh-fv-selbar-range");
\t\t\tconst addButton = button(DSH_FILE_VIEWER_COPY.addSelection);
\t\t\tconst annotateButton = button(DSH_FILE_VIEWER_COPY.addSelectionWithNote);
\t\t\tselectionBar.append(selectionRange, addButton, annotateButton);
\t\t\tconst draftList = el("div", "dsh-fv-drafts");
\t\t\tconst draftBar = el("div", "dsh-fv-selbar");
\t\t\tconst draftError = el("span", "dsh-fv-selbar-range dsh-fv-error");
\t\t\tconst sendDraftsButton = button(DSH_FILE_VIEWER_COPY.annotationSend);
\t\t\tsendDraftsButton.dataset.primary = "true";
\t\t\tconst clearDraftsButton = button(DSH_FILE_VIEWER_COPY.annotationClear);
\t\t\tdraftBar.append(draftError, clearDraftsButton, sendDraftsButton);
\t\t\tconst foot = el("div", "dsh-fv-foot");
\t\t\tconst footInfo = el("span");
\t\t\tconst footSpacer = el("span", "dsh-fv-spacer");
\t\t\tconst footNav = el("div", "dsh-fv-foot-nav");
\t\t\tconst prevButton = button(DSH_FILE_VIEWER_COPY.prevWindow);
\t\t\tconst nextButton = button(DSH_FILE_VIEWER_COPY.nextWindow);
\t\t\tfootNav.append(prevButton, nextButton);
\t\t\tfoot.append(footInfo, footSpacer, footNav);
\t\t\tpane.append(drawer, head, notice, bodyBox, selectionBar, draftList, draftBar, foot);

\t\t\t/* ---------- 渲染 ---------- */
\t\t\tconst caret = () => {
\t\t\t\tconst svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
\t\t\t\tsvg.setAttribute("viewBox", "0 0 16 16");
\t\t\t\tsvg.setAttribute("class", "dsh-fv-caret");
\t\t\t\tsvg.setAttribute("aria-hidden", "true");
\t\t\t\tconst path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
\t\t\t\tpath.setAttribute("fill", "currentColor");
\t\t\t\tpath.setAttribute("d", "M6 3.6 10.4 8 6 12.4l-1-1L8.4 8 5 4.6z");
\t\t\t\tsvg.appendChild(path);
\t\t\t\treturn svg;
\t\t\t};
\t\t\tconst renderTree = () => {
\t\t\t\ttreeList.textContent = "";
\t\t\t\ttreeNote.textContent = "";
\t\t\t\tfilterInput.disabled = state.caps.tree.enabled !== true;
\t\t\t\tfilterInput.placeholder = state.caps.search.enabled === true
\t\t\t\t\t? DSH_FILE_VIEWER_COPY.treeSearchPlaceholder
\t\t\t\t\t: DSH_FILE_VIEWER_COPY.treeFilterPlaceholder;
\t\t\t\tif (state.caps.tree.enabled !== true) {
\t\t\t\t\tconst empty = el("div", "dsh-fv-empty");
\t\t\t\t\tempty.appendChild(el("strong", null, DSH_FILE_VIEWER_COPY.treeDisabledTitle));
\t\t\t\t\tempty.appendChild(el("span", null, state.caps.tree.reason));
\t\t\t\t\ttreeList.appendChild(empty);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tconst rows = dshFlattenFileTree(state.rootPath, state.children, state.expanded, state.loadingDirs);
\t\t\t\tconst keyword = state.filter.trim();
\t\t\t\tconst visible = keyword === ""
\t\t\t\t\t? rows
\t\t\t\t\t: dshFilterLoadedFileNodes(rows.filter((row) => row.kind === "node").map((row) => row.node), keyword)
\t\t\t\t\t\t.map((node) => ({ kind: "node", node, depth: 0, open: false }));
\t\t\t\tif (visible.length === 0) {
\t\t\t\t\ttreeNote.textContent = keyword === "" ? DSH_FILE_VIEWER_COPY.treeEmpty : DSH_FILE_VIEWER_COPY.treeNoMatch;
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tfor (const row of visible) {
\t\t\t\t\tif (row.kind === "loading") {
\t\t\t\t\t\tconst node = el("div", "dsh-fv-tree-note", DSH_FILE_VIEWER_COPY.treeLoading);
\t\t\t\t\t\tnode.style.paddingLeft = (row.depth * 14 + 8) + "px";
\t\t\t\t\t\ttreeList.appendChild(node);
\t\t\t\t\t\tcontinue;
\t\t\t\t\t}
\t\t\t\t\tif (row.kind === "empty") {
\t\t\t\t\t\tconst node = el("div", "dsh-fv-tree-note", DSH_FILE_VIEWER_COPY.treeEmpty);
\t\t\t\t\t\tnode.style.paddingLeft = (row.depth * 14 + 8) + "px";
\t\t\t\t\t\ttreeList.appendChild(node);
\t\t\t\t\t\tcontinue;
\t\t\t\t\t}
\t\t\t\t\tconst item = doc.createElement("button");
\t\t\t\t\titem.type = "button";
\t\t\t\t\titem.className = "dsh-fv-node";
\t\t\t\t\titem.dataset.dshFvPath = row.node.path;
\t\t\t\t\titem.dataset.dshFvKind = row.node.kind;
\t\t\t\t\tif (row.node.ignored) item.dataset.dshFvIgnored = "true";
\t\t\t\t\titem.style.paddingLeft = (row.depth * 14 + 6) + "px";
\t\t\t\t\titem.setAttribute("aria-current", row.node.path === state.currentPath ? "true" : "false");
\t\t\t\t\tif (row.node.kind === "directory") {
\t\t\t\t\t\titem.setAttribute("aria-expanded", row.open ? "true" : "false");
\t\t\t\t\t\titem.appendChild(caret());
\t\t\t\t\t} else {
\t\t\t\t\t\tconst spacer = el("span", "dsh-fv-caret");
\t\t\t\t\t\tspacer.setAttribute("aria-hidden", "true");
\t\t\t\t\t\titem.appendChild(spacer);
\t\t\t\t\t}
\t\t\t\t\titem.appendChild(el("span", null, row.node.name));
\t\t\t\t\ttreeList.appendChild(item);
\t\t\t\t}
\t\t\t};

\t\t\tconst renderNotice = () => {
\t\t\t\tnotice.textContent = "";
\t\t\t\tconst badges = [];
\t\t\t\tif (state.read !== null && state.read.truncated) badges.push([DSH_FILE_VIEWER_COPY.truncatedHint, "info"]);
\t\t\t\tif (state.mode === "edit") badges.push([state.caps.write.reason, "info"]);
\t\t\t\tif (state.notice !== "") badges.push([state.notice, "error"]);
\t\t\t\tfor (const badge of badges) {
\t\t\t\t\tconst node = el("b", null, badge[0]);
\t\t\t\t\tnode.dataset.tone = badge[1];
\t\t\t\t\tnotice.appendChild(node);
\t\t\t\t}
\t\t\t\tnotice.hidden = badges.length === 0;
\t\t\t};

\t\t\tconst buildPlainBody = () => {
\t\t\t\tplainHost.textContent = "";
\t\t\t\tif (state.caps.read.enabled !== true) {
\t\t\t\t\tconst empty = el("div", "dsh-fv-empty");
\t\t\t\t\tempty.appendChild(el("strong", null, DSH_FILE_VIEWER_COPY.viewerEmptyTitle));
\t\t\t\t\tempty.appendChild(el("span", null, state.caps.read.reason));
\t\t\t\t\tplainHost.appendChild(empty);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (state.currentPath === null) {
\t\t\t\t\tconst empty = el("div", "dsh-fv-empty");
\t\t\t\t\tempty.appendChild(el("strong", null, DSH_FILE_VIEWER_COPY.viewerEmptyTitle));
\t\t\t\t\tempty.appendChild(el("span", null, DSH_FILE_VIEWER_COPY.viewerEmptyBody));
\t\t\t\t\tplainHost.appendChild(empty);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (state.currentBinary) {
\t\t\t\t\tconst empty = el("div", "dsh-fv-empty");
\t\t\t\t\tempty.appendChild(el("strong", null, DSH_FILE_VIEWER_COPY.viewerBinaryTitle));
\t\t\t\t\tempty.appendChild(el("span", null, DSH_FILE_VIEWER_COPY.viewerBinaryBody));
\t\t\t\t\tplainHost.appendChild(empty);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (state.reading) {
\t\t\t\t\tplainHost.appendChild(el("div", "dsh-fv-empty", DSH_FILE_VIEWER_COPY.viewerLoading));
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (state.readError !== null) {
\t\t\t\t\tconst empty = el("div", "dsh-fv-empty");
\t\t\t\t\tempty.appendChild(el("strong", null, DSH_FILE_VIEWER_COPY.viewerReadFailed));
\t\t\t\t\tempty.appendChild(el("span", "dsh-fv-error", state.readError));
\t\t\t\t\tconst retry = button(DSH_FILE_VIEWER_COPY.viewerRetry);
\t\t\t\t\tretry.addEventListener("click", () => openFile(state.currentPath, state.read?.startLine ?? 1, state.currentBinary));
\t\t\t\t\tempty.appendChild(retry);
\t\t\t\t\tplainHost.appendChild(empty);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (state.read === null) return;
\t\t\t\tif (state.mode === "edit") {
\t\t\t\t\tbuildEditor();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\t/* 降级渲染器：结构与官方 ReadBlock 同构（data-read + 行号 span 在前），
\t\t\t\t   这样将来换回官方组件时选中到行号的还原逻辑一行都不用改。 */
\t\t\t\tconst block = el("div", "dsh-fv-fallback");
\t\t\t\tblock.setAttribute("data-read", "");
\t\t\t\tfor (const line of state.read.lines) {
\t\t\t\t\tconst row = el("div");
\t\t\t\t\trow.dataset.dshFvLine = String(line.number);
\t\t\t\t\tconst gutter = el("span", null, String(line.number));
\t\t\t\t\tgutter.setAttribute("aria-hidden", "true");
\t\t\t\t\tconst content = el("span", null, line.text);
\t\t\t\t\trow.append(gutter, content);
\t\t\t\t\tblock.appendChild(row);
\t\t\t\t}
\t\t\t\tplainHost.appendChild(block);
\t\t\t};

\t\t\tconst buildEditor = () => {
\t\t\t\tconst wrap = el("div", "dsh-fv-editor");
\t\t\t\tconst gutter = el("div", "dsh-fv-editor-gutter");
\t\t\t\tconst textarea = doc.createElement("textarea");
\t\t\t\ttextarea.spellcheck = false;
\t\t\t\ttextarea.value = state.draftText ?? dshLinesToText(state.read.lines);
\t\t\t\tconst syncGutter = () => {
\t\t\t\t\tconst count = textarea.value.split("\\n").length;
\t\t\t\t\tconst numbers = [];
\t\t\t\t\tfor (let index = 0; index < count; index += 1) numbers.push(String(state.read.startLine + index));
\t\t\t\t\tgutter.textContent = numbers.join("\\n");
\t\t\t\t};
\t\t\t\tconst syncSelection = () => {
\t\t\t\t\tconst start = textarea.selectionStart;
\t\t\t\t\tconst end = textarea.selectionEnd;
\t\t\t\t\tif (start === end) {
\t\t\t\t\t\tstate.selection = null;
\t\t\t\t\t\trenderChrome();
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tconst range = dshLineRangeFromTextOffsets(textarea.value, start, end, state.read.startLine);
\t\t\t\t\tstate.selection = { text: textarea.value.slice(start, end), startLine: range.startLine, endLine: range.endLine };
\t\t\t\t\trenderChrome();
\t\t\t\t};
\t\t\t\ttextarea.addEventListener("input", () => {
\t\t\t\t\tstate.draftText = textarea.value;
\t\t\t\t\tstate.dirty = state.draftText !== dshLinesToText(state.read.lines);
\t\t\t\t\tsyncGutter();
\t\t\t\t\trenderChrome();
\t\t\t\t});
\t\t\t\tfor (const name of ["select", "keyup", "mouseup", "blur"]) textarea.addEventListener(name, syncSelection);
\t\t\t\ttextarea.addEventListener("scroll", () => {
\t\t\t\t\tgutter.style.transform = "translateY(" + (-textarea.scrollTop) + "px)";
\t\t\t\t});
\t\t\t\tsyncGutter();
\t\t\t\twrap.append(gutter, textarea);
\t\t\t\tplainHost.appendChild(wrap);
\t\t\t};

\t\t\tlet lastPlainKey = null;
\t\t\tconst renderBody = () => {
\t\t\t\tconst usable = state.read !== null && state.readError === null && !state.reading && !state.currentBinary;
\t\t\t\tconst useReact = renderer === "primitives" && usable && state.mode !== "edit" && state.caps.read.enabled === true;
\t\t\t\tif (reactHost !== null) reactHost.hidden = !useReact;
\t\t\t\tplainHost.hidden = useReact;
\t\t\t\tif (useReact) {
\t\t\t\t\tif (plainHost.childNodes.length > 0) {
\t\t\t\t\t\tplainHost.textContent = "";
\t\t\t\t\t\tlastPlainKey = null;
\t\t\t\t\t}
\t\t\t\t\tconst markdown = state.mode === "preview" && dshIsMarkdownPath(state.currentPath);
\t\t\t\t\tconst element = markdown
\t\t\t\t\t\t? DSH_FV_REACT.createElement(DSH_FV_PRIMITIVES.MarkdownText, {
\t\t\t\t\t\t\ttext: dshLinesToText(state.read.lines),
\t\t\t\t\t\t\tstreaming: false,
\t\t\t\t\t\t\tcodeLabels: DSH_FV_CODE_LABELS
\t\t\t\t\t\t})
\t\t\t\t\t\t: DSH_FV_REACT.createElement(DSH_FV_PRIMITIVES.ReadBlock, {
\t\t\t\t\t\t\tlabel: state.currentPath,
\t\t\t\t\t\t\tlines: state.read.lines,
\t\t\t\t\t\t\ttotalLines: state.read.totalLines,
\t\t\t\t\t\t\tlang: (state.read.lang ?? dshGuessFileLanguage(state.currentPath)) || void 0,
\t\t\t\t\t\t\tmaxLines: DSH_FILE_RENDER_MAX_LINES
\t\t\t\t\t\t});
\t\t\t\t\treactRoot.render(element);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (reactRoot !== null) reactRoot.render(null);
\t\t\t\t/* 编辑器只在身份变化时重建，否则每次 input 都会丢焦点。 */
\t\t\t\tconst key = [state.mode, state.currentPath ?? "", state.read?.startLine ?? 0, state.readError ?? "", state.reading ? "1" : "0", state.currentBinary ? "b" : "t", state.caps.read.enabled ? "r" : "x"].join("|");
\t\t\t\tif (key === lastPlainKey) return;
\t\t\t\tlastPlainKey = key;
\t\t\t\tbuildPlainBody();
\t\t\t};

\t\t\tconst renderDrafts = () => {
\t\t\t\tdraftList.textContent = "";
\t\t\t\tdraftError.textContent = state.draftError;
\t\t\t\tif (state.drafts.length === 0) {
\t\t\t\t\tdraftList.appendChild(el("div", "dsh-fv-tree-note", DSH_FILE_VIEWER_COPY.annotationEmpty));
\t\t\t\t} else {
\t\t\t\t\tfor (let index = 0; index < state.drafts.length; index += 1) {
\t\t\t\t\t\tconst draft = state.drafts[index];
\t\t\t\t\t\tconst card = el("div", "dsh-fv-draft");
\t\t\t\t\t\tconst cardHead = el("div", "dsh-fv-draft-head");
\t\t\t\t\t\tcardHead.appendChild(el("span", null, draft.path));
\t\t\t\t\t\tcardHead.appendChild(el("span", null, draft.lineRange));
\t\t\t\t\t\tconst remove = button("×");
\t\t\t\t\t\tremove.setAttribute("aria-label", DSH_FILE_VIEWER_COPY.annotationRemove);
\t\t\t\t\t\tremove.addEventListener("click", () => {
\t\t\t\t\t\t\tstate.drafts.splice(index, 1);
\t\t\t\t\t\t\tstate.draftError = "";
\t\t\t\t\t\t\trenderDrafts();
\t\t\t\t\t\t\trenderChrome();
\t\t\t\t\t\t});
\t\t\t\t\t\tcardHead.appendChild(remove);
\t\t\t\t\t\tconst quote = el("pre", "dsh-fv-draft-quote", draft.text);
\t\t\t\t\t\tconst input = doc.createElement("textarea");
\t\t\t\t\t\tinput.value = draft.annotation ?? "";
\t\t\t\t\t\tinput.placeholder = DSH_FILE_VIEWER_COPY.annotationPlaceholder;
\t\t\t\t\t\tinput.maxLength = DSH_FILE_ANNOTATION_ITEM_LIMIT;
\t\t\t\t\t\tinput.dataset.dshFvDraft = String(index);
\t\t\t\t\t\tinput.addEventListener("input", () => {
\t\t\t\t\t\t\tdraft.annotation = input.value;
\t\t\t\t\t\t\trenderChrome();
\t\t\t\t\t\t});
\t\t\t\t\t\tcard.append(cardHead, quote, input);
\t\t\t\t\t\tdraftList.appendChild(card);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tdraftList.hidden = false;
\t\t\t};

\t\t\tconst renderChrome = () => {
\t\t\t\t/* 容器是 rtl（为了把省略号放在开头），路径本身必须用 LTR 嵌入包住。 */
\t\t\t\tpathLabel.textContent = state.currentPath === null ? "" : "\\u202A" + state.currentPath + "\\u202C";
\t\t\t\tpathLabel.title = state.currentPath ?? "";
\t\t\t\tconst hasFile = state.read !== null && state.readError === null && !state.currentBinary;
\t\t\t\tconst markdownFile = state.currentPath !== null && dshIsMarkdownPath(state.currentPath);
\t\t\t\tfor (const [mode, node] of modeButtons) {
\t\t\t\t\tnode.setAttribute("aria-pressed", state.mode === mode ? "true" : "false");
\t\t\t\t\tnode.disabled = !hasFile || (mode === "preview" && !markdownFile);
\t\t\t\t\tnode.title = mode === "preview" && !markdownFile && hasFile ? "只有 Markdown 文件有预览" : "";
\t\t\t\t}
\t\t\t\trevertButton.hidden = state.mode !== "edit";
\t\t\t\tsaveButton.hidden = state.mode !== "edit";
\t\t\t\trevertButton.disabled = !state.dirty || state.saving;
\t\t\t\tconst saveBlockedByTruncation = state.read !== null && state.read.truncated === true;
\t\t\t\tsaveButton.disabled = state.caps.write.enabled !== true || !state.dirty || state.saving || saveBlockedByTruncation;
\t\t\t\tsaveButton.title = saveBlockedByTruncation ? DSH_FILE_VIEWER_COPY.reasonTruncatedNoWrite : state.caps.write.reason;
\t\t\t\tif (state.dirty) saveButton.textContent = DSH_FILE_VIEWER_COPY.saveLabel + "（" + DSH_FILE_VIEWER_COPY.dirtyBadge + "）";
\t\t\t\telse saveButton.textContent = DSH_FILE_VIEWER_COPY.saveLabel;

\t\t\t\tconst selection = state.selection;
\t\t\t\tconst lineKnown = selection !== null && Number.isInteger(selection.startLine) && selection.startLine > 0;
\t\t\t\tconst selectionReady = dshFvComposerReady("file-selection");
\t\t\t\tconst annotationReady = dshFvComposerReady("workspace-annotation");
\t\t\t\tselectionRange.textContent = selection === null
\t\t\t\t\t? DSH_FILE_VIEWER_COPY.reasonNothingSelected
\t\t\t\t\t: lineKnown
\t\t\t\t\t\t? dshFormatLineRange(selection.startLine, selection.endLine) + " · " + selection.text.length + " 字"
\t\t\t\t\t\t: DSH_FILE_VIEWER_COPY.reasonPreviewNoLine;
\t\t\t\taddButton.disabled = !lineKnown || !selectionReady;
\t\t\t\taddButton.title = !lineKnown ? selectionRange.textContent : (selectionReady ? "" : DSH_FILE_VIEWER_COPY.reasonNoComposer);
\t\t\t\tannotateButton.disabled = !lineKnown || state.drafts.length >= DSH_FILE_ANNOTATION_MAX_ITEMS;
\t\t\t\tannotateButton.title = state.drafts.length >= DSH_FILE_ANNOTATION_MAX_ITEMS ? DSH_FILE_VIEWER_COPY.annotationLimitItems : "";
\t\t\t\tsendDraftsButton.disabled = state.drafts.length === 0 || !annotationReady;
\t\t\t\tsendDraftsButton.title = annotationReady ? "" : DSH_FILE_VIEWER_COPY.reasonNoComposer;
\t\t\t\tclearDraftsButton.disabled = state.drafts.length === 0;

\t\t\t\tconst read = state.read;
\t\t\t\tif (read === null) {
\t\t\t\t\tfootInfo.textContent = "";
\t\t\t\t\tfootInfo.title = "";
\t\t\t\t} else {
\t\t\t\t\tconst footParts = [
\t\t\t\t\t\tdshFormatLineRange(read.startLine, read.endLine),
\t\t\t\t\t\tread.totalLinesKnown ? "共 " + read.totalLines + " 行" : DSH_FILE_VIEWER_COPY.totalUnknown,
\t\t\t\t\t\tdshFormatBytes(read.byteLength),
\t\t\t\t\t\tread.encoding ?? DSH_FILE_VIEWER_COPY.encodingUnknown
\t\t\t\t\t];
\t\t\t\t\t/* 能力缺口写在信息行里，语气与「编码未知」一致，鼠标悬停给出完整原因。 */
\t\t\t\t\tif (state.caps.watch.enabled !== true) footParts.push(DSH_FILE_VIEWER_COPY.staleHint);
\t\t\t\t\tfootInfo.textContent = footParts.join(" · ");
\t\t\t\t\tfootInfo.title = state.caps.watch.enabled !== true ? DSH_FILE_VIEWER_COPY.staleHintTitle : "";
\t\t\t\t}
\t\t\t\tprevButton.disabled = read === null || read.startLine <= 1;
\t\t\t\tnextButton.disabled = read === null || read.nextStartLine === null;
\t\t\t\tfootNav.hidden = read === null;
\t\t\t\trenderNotice();
\t\t\t};

\t\t\tconst render = () => {
\t\t\t\trenderTree();
\t\t\t\trenderBody();
\t\t\t\trenderChrome();
\t\t\t};

\t\t\t/* ---------- 数据 ---------- */
\t\t\tconst loadDirectory = (dirPath) => {
\t\t\t\tconst adapter = dshFvAdapter();
\t\t\t\tif (adapter === null || state.caps.tree.enabled !== true) return;
\t\t\t\tif (state.loadingDirs.has(dirPath)) return;
\t\t\t\tstate.loadingDirs.add(dirPath);
\t\t\t\trenderTree();
\t\t\t\tPromise.resolve(adapter.listDirectory(dirPath, { cursor: null }))
\t\t\t\t\t.then((result) => {
\t\t\t\t\t\tconst listing = dshNormalizeDirectoryListing(result, dirPath);
\t\t\t\t\t\tstate.children.set(dirPath, listing.entries);
\t\t\t\t\t\tstate.notice = listing.truncated ? DSH_FILE_VIEWER_COPY.truncatedHint : state.notice;
\t\t\t\t\t})
\t\t\t\t\t.catch((error) => {
\t\t\t\t\t\tstate.children.set(dirPath, []);
\t\t\t\t\t\tstate.notice = DSH_FILE_VIEWER_COPY.viewerReadFailed + "：" + dshFvErrorText(error);
\t\t\t\t\t})
\t\t\t\t\t.finally(() => {
\t\t\t\t\t\tstate.loadingDirs.delete(dirPath);
\t\t\t\t\t\trenderTree();
\t\t\t\t\t\trenderChrome();
\t\t\t\t\t});
\t\t\t};

\t\t\tconst stopWatch = () => {
\t\t\t\tif (typeof unwatch === "function") unwatch();
\t\t\t\tunwatch = null;
\t\t\t};
\t\t\tconst startWatch = (filePath) => {
\t\t\t\tstopWatch();
\t\t\t\tconst adapter = dshFvAdapter();
\t\t\t\tif (adapter === null || state.caps.watch.enabled !== true) return;
\t\t\t\ttry {
\t\t\t\t\tconst handle = adapter.watch(filePath, () => {
\t\t\t\t\t\tif (state.currentPath !== filePath || state.dirty) return;
\t\t\t\t\t\topenFile(filePath, state.read?.startLine ?? 1, state.currentBinary);
\t\t\t\t\t});
\t\t\t\t\tunwatch = typeof handle === "function" ? handle : null;
\t\t\t\t} catch (error) {
\t\t\t\t\tunwatch = null;
\t\t\t\t}
\t\t\t};

\t\t\tconst openFile = (filePath, startLine, binary) => {
\t\t\t\tif (typeof filePath !== "string" || filePath === "") return;
\t\t\t\tconst token = state.requestToken + 1;
\t\t\t\tstate.requestToken = token;
\t\t\t\tstate.currentPath = filePath;
\t\t\t\tstate.currentBinary = binary === true || dshIsBinaryFilePath(filePath);
\t\t\t\tstate.read = null;
\t\t\t\tstate.readError = null;
\t\t\t\tstate.selection = null;
\t\t\t\tstate.draftText = null;
\t\t\t\tstate.dirty = false;
\t\t\t\tstate.notice = "";
\t\t\t\tstate.mode = dshIsMarkdownPath(filePath) ? "preview" : "code";
\t\t\t\tconst adapter = dshFvAdapter();
\t\t\t\tif (state.currentBinary || adapter === null || state.caps.read.enabled !== true) {
\t\t\t\t\tstate.reading = false;
\t\t\t\t\trender();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tstate.reading = true;
\t\t\t\trender();
\t\t\t\tconst request = dshResolveReadRequest({ startLine });
\t\t\t\tPromise.resolve(adapter.readFile(filePath, request))
\t\t\t\t\t.then((result) => {
\t\t\t\t\t\tif (state.requestToken !== token) return;
\t\t\t\t\t\tconst normalized = dshNormalizeReadResult(result, request);
\t\t\t\t\t\tstate.read = normalized;
\t\t\t\t\t\tstate.currentBinary = normalized.binary;
\t\t\t\t\t})
\t\t\t\t\t.catch((error) => {
\t\t\t\t\t\tif (state.requestToken !== token) return;
\t\t\t\t\t\tstate.readError = dshFvErrorText(error);
\t\t\t\t\t})
\t\t\t\t\t.finally(() => {
\t\t\t\t\t\tif (state.requestToken !== token) return;
\t\t\t\t\t\tstate.reading = false;
\t\t\t\t\t\trender();
\t\t\t\t\t\tstartWatch(filePath);
\t\t\t\t\t});
\t\t\t};

\t\t\t/* ---------- 交互 ---------- */
\t\t\tconst onTreeClick = (event) => {
\t\t\t\tconst target = event.target instanceof Element ? event.target.closest("[data-dsh-fv-path]") : null;
\t\t\t\tif (target === null) return;
\t\t\t\tconst filePath = target.dataset.dshFvPath;
\t\t\t\tif (target.dataset.dshFvKind === "directory") {
\t\t\t\t\tif (state.expanded.has(filePath)) state.expanded.delete(filePath);
\t\t\t\t\telse {
\t\t\t\t\t\tstate.expanded.add(filePath);
\t\t\t\t\t\tif (!state.children.has(filePath)) loadDirectory(filePath);
\t\t\t\t\t}
\t\t\t\t\trenderTree();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\topenFile(filePath, 1, false);
\t\t\t};
\t\t\ttreeList.addEventListener("click", onTreeClick);
\t\t\tfilterInput.addEventListener("input", () => {
\t\t\t\tstate.filter = filterInput.value;
\t\t\t\trenderTree();
\t\t\t});
\t\t\tdrawerToggle.addEventListener("click", () => {
\t\t\t\tconst open = pane.dataset.dshFvDrawer === "open";
\t\t\t\tpane.dataset.dshFvDrawer = open ? "closed" : "open";
\t\t\t\tdrawerToggle.setAttribute("aria-expanded", open ? "false" : "true");
\t\t\t\tdrawerToggle.textContent = open ? DSH_FILE_VIEWER_COPY.treeOpenDrawer : DSH_FILE_VIEWER_COPY.treeCloseDrawer;
\t\t\t});
\t\t\tmodes.addEventListener("click", (event) => {
\t\t\t\tconst target = event.target instanceof Element ? event.target.closest("[data-dsh-fv-mode]") : null;
\t\t\t\tif (target === null || target.disabled) return;
\t\t\t\tstate.mode = target.dataset.dshFvMode;
\t\t\t\tstate.selection = null;
\t\t\t\trenderBody();
\t\t\t\trenderChrome();
\t\t\t});
\t\t\trevertButton.addEventListener("click", () => {
\t\t\t\tstate.draftText = null;
\t\t\t\tstate.dirty = false;
\t\t\t\tlastPlainKey = null;
\t\t\t\trenderBody();
\t\t\t\trenderChrome();
\t\t\t});
\t\t\tsaveButton.addEventListener("click", () => {
\t\t\t\tif (saveButton.disabled || state.currentPath === null || state.read === null) return;
\t\t\t\tconst adapter = dshFvAdapter();
\t\t\t\tif (adapter === null || typeof adapter.writeFile !== "function") return;
\t\t\t\tconst text = state.draftText ?? dshLinesToText(state.read.lines);
\t\t\t\tstate.saving = true;
\t\t\t\tstate.notice = "";
\t\t\t\trenderChrome();
\t\t\t\tPromise.resolve(adapter.writeFile(state.currentPath, text, { revision: state.read.revision ?? null }))
\t\t\t\t\t.then(() => {
\t\t\t\t\t\tstate.dirty = false;
\t\t\t\t\t\tstate.draftText = null;
\t\t\t\t\t\tstate.notice = DSH_FILE_VIEWER_COPY.saveOk;
\t\t\t\t\t\tlastPlainKey = null;
\t\t\t\t\t\topenFile(state.currentPath, state.read.startLine, false);
\t\t\t\t\t})
\t\t\t\t\t.catch((error) => {
\t\t\t\t\t\tstate.notice = DSH_FILE_VIEWER_COPY.saveFailed + "：" + dshFvErrorText(error);
\t\t\t\t\t\trender();
\t\t\t\t\t})
\t\t\t\t\t.finally(() => {
\t\t\t\t\t\tstate.saving = false;
\t\t\t\t\t\trenderChrome();
\t\t\t\t\t});
\t\t\t});
\t\t\tprevButton.addEventListener("click", () => {
\t\t\t\tif (state.read === null) return;
\t\t\t\topenFile(state.currentPath, Math.max(1, state.read.startLine - DSH_FILE_READ_MAX_LINES), state.currentBinary);
\t\t\t});
\t\t\tnextButton.addEventListener("click", () => {
\t\t\t\tif (state.read === null || state.read.nextStartLine === null) return;
\t\t\t\topenFile(state.currentPath, state.read.nextStartLine, state.currentBinary);
\t\t\t});

\t\t\tconst currentSelectionPayload = (annotation) => dshBuildFileSelectionPayload({
\t\t\t\tpath: state.currentPath,
\t\t\t\ttext: state.selection?.text ?? "",
\t\t\t\tstartLine: state.selection?.startLine ?? Number.NaN,
\t\t\t\tendLine: state.selection?.endLine ?? Number.NaN,
\t\t\t\tlang: state.read?.lang ?? dshGuessFileLanguage(state.currentPath ?? ""),
\t\t\t\trevision: state.read?.revision ?? null,
\t\t\t\tannotation,
\t\t\t\tcapturedAt: new Date().toISOString()
\t\t\t});
\t\t\taddButton.addEventListener("click", () => {
\t\t\t\tconst payload = currentSelectionPayload(null);
\t\t\t\tif (payload === null) return;
\t\t\t\t/* 只派发事件，不去找底部 textarea 写值（P15-7）。 */
\t\t\t\twindow.dispatchEvent(new CustomEvent(DSH_FILE_SELECTION_EVENT, { detail: payload }));
\t\t\t\tstate.selection = null;
\t\t\t\trenderChrome();
\t\t\t});
\t\t\tannotateButton.addEventListener("click", () => {
\t\t\t\tconst payload = currentSelectionPayload("");
\t\t\t\tif (payload === null) return;
\t\t\t\tconst result = dshAppendAnnotationDraft(state.drafts, payload);
\t\t\t\tstate.draftError = result.error;
\t\t\t\tif (result.ok) {
\t\t\t\t\tstate.drafts = result.drafts;
\t\t\t\t\tstate.selection = null;
\t\t\t\t}
\t\t\t\trenderDrafts();
\t\t\t\trenderChrome();
\t\t\t\tconst last = draftList.querySelector("[data-dsh-fv-draft]:last-of-type textarea, .dsh-fv-draft:last-of-type textarea");
\t\t\t\tlast?.focus?.();
\t\t\t});
\t\t\tclearDraftsButton.addEventListener("click", () => {
\t\t\t\tstate.drafts = [];
\t\t\t\tstate.draftError = "";
\t\t\t\trenderDrafts();
\t\t\t\trenderChrome();
\t\t\t});
\t\t\tsendDraftsButton.addEventListener("click", () => {
\t\t\t\tconst payload = dshBuildWorkspaceAnnotationsPayload(state.drafts);
\t\t\t\tif (payload === null) return;
\t\t\t\twindow.dispatchEvent(new CustomEvent(DSH_FILE_ANNOTATION_EVENT, { detail: payload }));
\t\t\t\tstate.drafts = [];
\t\t\t\tstate.draftError = "";
\t\t\t\trenderDrafts();
\t\t\t\trenderChrome();
\t\t\t});

\t\t\tconst onSelectionChange = () => {
\t\t\t\tif (state.mode === "edit") return;
\t\t\t\tconst selection = doc.getSelection();
\t\t\t\tif (selection === null || selection.rangeCount === 0) return;
\t\t\t\tconst range = selection.getRangeAt(0);
\t\t\t\tif (!bodyBox.contains(range.commonAncestorContainer)) return;
\t\t\t\tconst text = selection.toString();
\t\t\t\tif (text === "") {
\t\t\t\t\tstate.selection = null;
\t\t\t\t\trenderChrome();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tlet startLine = dshLineNumberFromDomNode(range.startContainer, bodyBox);
\t\t\t\tlet endLine = dshLineNumberFromDomNode(range.endContainer, bodyBox);
\t\t\t\tif ((startLine === null || startLine === undefined) && state.mode === "preview") {
\t\t\t\t\tconst previewRange = dshLineRangeFromPreviewSelection(state.read.lines, text);
\t\t\t\t\tstartLine = previewRange?.startLine ?? null;
\t\t\t\t\tendLine = previewRange?.endLine ?? startLine;
\t\t\t\t}
\t\t\t\tstate.selection = { text, startLine, endLine: endLine ?? startLine };
\t\t\t\trenderChrome();
\t\t\t};
\t\t\tdoc.addEventListener("selectionchange", onSelectionChange);

\t\t\t/* 能力可能晚到：桌面壳就绪、composer 接好之后都重新探测一次。 */
\t\t\tconst reprobe = () => {
\t\t\t\tconst before = JSON.stringify(dshFileCapabilityFlags(state.caps));
\t\t\t\tconst beforeRoot = state.rootPath;
\t\t\t\tconst nextAdapter = dshFvAdapter();
\t\t\t\tconst nextRoot = dshResolveFileCapabilities(nextAdapter).rootPath;
\t\t\t\tstate.caps = dshResolveFileCapabilities(nextAdapter);
\t\t\t\tif (JSON.stringify(dshFileCapabilityFlags(state.caps)) !== before || nextRoot !== beforeRoot) {
\t\t\t\t\tlastPlainKey = null;
\t\t\t\t\tbootstrap();
\t\t\t\t}
\t\t\t\trender();
\t\t\t};
\t\t\twindow.addEventListener(DSH_FILE_DESKTOP_READY_EVENT, reprobe);
\t\t\twindow.addEventListener(DSH_FILE_COMPOSER_READY_EVENT, renderChrome);

\t\t\t/* 面板宽度跨过 W3 的 compact 阈值时，把整棵树在左列与抽屉之间搬家。 */
\t\t\tconst syncCompact = () => {
\t\t\t\tconst compact = shell.dataset.dshCompactTree === "true";
\t\t\t\tconst host = compact ? drawer : treeHost;
\t\t\t\tif (treeRoot.parentElement !== host) host.appendChild(treeRoot);
\t\t\t\tif (!compact) {
\t\t\t\t\tpane.dataset.dshFvDrawer = "closed";
\t\t\t\t\tdrawerToggle.setAttribute("aria-expanded", "false");
\t\t\t\t\tdrawerToggle.textContent = DSH_FILE_VIEWER_COPY.treeOpenDrawer;
\t\t\t\t}
\t\t\t};
\t\t\tconst compactObserver = new MutationObserver(syncCompact);
\t\t\tcompactObserver.observe(shell, { attributes: true, attributeFilter: [DSH_FILE_COMPACT_TREE_ATTR] });

\t\t\tconst bootstrap = () => {
\t\t\t\tconst adapter = dshFvAdapter();
\t\t\t\tstate.rootPath = typeof adapter?.rootPath === "string" ? adapter.rootPath : "";
\t\t\t\tstate.children = new Map();
\t\t\t\tstate.expanded = new Set();
\t\t\t\tif (state.caps.tree.enabled === true) loadDirectory(state.rootPath);
\t\t\t};

\t\t\tsyncCompact();
\t\t\tbootstrap();
\t\t\trenderDrafts();
\t\t\trender();

\t\t\tdisposers.push(() => {
\t\t\t\tcompactObserver.disconnect();
\t\t\t\tdoc.removeEventListener("selectionchange", onSelectionChange);
\t\t\t\twindow.removeEventListener(DSH_FILE_DESKTOP_READY_EVENT, reprobe);
\t\t\t\twindow.removeEventListener(DSH_FILE_COMPOSER_READY_EVENT, renderChrome);
\t\t\t\ttreeList.removeEventListener("click", onTreeClick);
\t\t\t\tstopWatch();
\t\t\t\t/* React 不允许在渲染周期内同步 unmount，推到微任务里。 */
\t\t\t\tif (reactRoot !== null) {
\t\t\t\t\tconst root = reactRoot;
\t\t\t\t\treactRoot = null;
\t\t\t\t\tqueueMicrotask(() => root.unmount());
\t\t\t\t}
\t\t\t\ttreeRoot.remove();
\t\t\t\tpane.textContent = "";
\t\t\t\tpane.classList.remove("dsh-fv-pane");
\t\t\t\tdelete pane.dataset.dshFvMounted;
\t\t\t\tdelete pane.dataset.dshFvDrawer;
\t\t\t});
\t\t\treturn () => {
\t\t\t\tfor (const dispose of disposers.splice(0)) dispose();
\t\t\t};
\t\t}
`;

/**
 * 对话界面前端展示补丁（Plan_15 W4）· 注入文件树与文件查看器运行时。
 *
 * 锚点与 W3 取同一段干净基线的 `apply(ctx)` 头部：W3 的替换保留了这三行原文，
 * 所以两个补丁**与执行顺序无关**，任一顺序下锚点都恰好命中一次。
 * @param source - `dsh-client-ui-conversation/lib/client.js` 源码。
 * @returns 追加了文件查看器运行时与装载点的源码。
 */
export function patchFileViewerSource(source) {
  assertNotAlreadyPatched(source, "function installDshFileViewer(", "Plan 15 文件查看器");
  return replaceExactlyOnce(
    source,
    `\t\tfunction apply(ctx) {
\t\t\tconst sessions = ctx.sessions;
\t\t\tconst workspaces = ctx.workspaces;`,
    `${DSH_FILE_VIEWER_RUNTIME_SOURCE}\t\tfunction apply(ctx) {
\t\t\tconst sessions = ctx.sessions;
\t\t\tconst workspaces = ctx.workspaces;
\t\t\tctx.effect(() => installDshFileViewer(), "ui-conversation: dsh plan15 file viewer");`,
    "Plan 15 文件查看器装载点",
  );
}
