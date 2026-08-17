/**
 * 批次 B：文件差异卡的前端展示层补丁（窗口 G2）。
 *
 * 只改 `@deepseek-ai/dsh-client-ui-tool/lib/client.js` 的展示层，不碰任何后端语义。
 * 锚点字符串全部抠自干净基线 `%LOCALAPPDATA%\DeepSeekHarness\app\releases\0.1.0-rc.6-oauth`。
 *
 * 设计依据：`plans_windsurf/frontend-spec.md` 第 5 章。
 *
 * 数据事实（读干净基线源码确认，不是推测）：
 * - `FileDiff` 只有 `{ path, oldText, newText }`，**没有行号**。
 * - `write`/`edit` 完成态的 `diffs` 是 `computeHunkDiffs` 产出的带 3 行上下文的 hunk，
 *   上下文行同时出现在 `oldText` 与 `newText` 里；hunk 的绝对起始行被后端丢掉了，
 *   所以这两种情况**无法**反推真实行号。
 * - `write` 新建文件时 `presentationMeta.diffs` 为空数组，`presentResult` 回退成
 *   `[{ oldText: null, newText: 全文 }]`；`oldText === null` 表示「从无到有」，行号从 1 开始可信。
 * - `apply_patch`（`@stardust/dsh-tool-apply-patch`）完成态给的是**整份** before/after，
 *   行号从 1 开始可信；但它的 `presentCall()` 不带 `diffs`，所以运行中没有暂估数字，
 *   只能从补丁正文里解析出文件清单。
 *
 * 因此行号列有两档：`absolute`（真实行号）与 `unknown`（渲染 `·` 占位，绝不编造）。
 */

/** 变化行上下各保留的上下文行数。 */
export const DSH_DIFF_CONTEXT = 3;
/** 「展开其余 N 行」每次多展开的行数。 */
export const DSH_DIFF_REVEAL_STEP = 50;
/** LCS 动态规划的规模上限；超过后退化为「旧侧全删 + 新侧全增」，避免大文件卡住 UI 线程。 */
export const DSH_DIFF_LCS_BUDGET = 1_200_000;

/**
 * 把一侧文本切成内容行。空文本是零行；结尾单个换行是行终止符而不是额外空行
 * （与基线 `contentLines` 一致，保持和 TUI 同一套行切分口径）。
 * @param {string | null} text 旧侧或新侧文本。
 * @returns {string[]} 内容行。
 */
export function dshDiffLines(text) {
  if (text === null || text === undefined || text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/**
 * 逐行对齐两侧文本，区分未变化上下文 / 删除 / 新增。
 *
 * 先剥掉公共前后缀再对中段做 LCS，绝大多数编辑的中段只有几行，代价可忽略。
 * 中段规模超过 {@link DSH_DIFF_LCS_BUDGET} 时退化为整段删除加整段新增，
 * 结果仍然真实（只是不再区分中段里的未变化行），并通过 `degraded` 标记出来。
 *
 * @param {string[]} oldLines 旧侧行。
 * @param {string[]} newLines 新侧行。
 * @returns {{ ops: Array<{ kind: 'ctx' | 'del' | 'add', text: string }>, degraded: boolean }}
 */
export function dshDiffAlign(oldLines, newLines) {
  const ops = [];
  let head = 0;
  const maxHead = Math.min(oldLines.length, newLines.length);
  while (head < maxHead && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < maxHead - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1;

  for (let i = 0; i < head; i += 1) ops.push({ kind: "ctx", text: oldLines[i] });

  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);
  let degraded = false;

  if (oldMid.length === 0 || newMid.length === 0) {
    for (const text of oldMid) ops.push({ kind: "del", text });
    for (const text of newMid) ops.push({ kind: "add", text });
  } else if (oldMid.length * newMid.length > DSH_DIFF_LCS_BUDGET) {
    degraded = true;
    for (const text of oldMid) ops.push({ kind: "del", text });
    for (const text of newMid) ops.push({ kind: "add", text });
  } else {
    const n = oldMid.length;
    const m = newMid.length;
    const width = m + 1;
    const table = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = oldMid[i] === newMid[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldMid[i] === newMid[j]) {
        ops.push({ kind: "ctx", text: oldMid[i] });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push({ kind: "del", text: oldMid[i] });
        i += 1;
      } else {
        ops.push({ kind: "add", text: newMid[j] });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: "del", text: oldMid[i] });
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: "add", text: newMid[j] });
      j += 1;
    }
  }

  for (let i = 0; i < tail; i += 1) {
    ops.push({ kind: "ctx", text: oldLines[oldLines.length - tail + i] });
  }
  return { ops, degraded };
}

/**
 * 把一个 hunk 的对齐结果编号。`absolute` 时按真实行号连续编号，`unknown` 时行号一律为 null，
 * 由渲染层画 `·` 占位——绝不用 hunk 内相对序号冒充文件行号。
 * @param {Array<{ kind: string, text: string }>} ops 对齐结果。
 * @param {'absolute' | 'unknown'} numbering 编号档位。
 * @returns {Array<{ kind: string, text: string, no: number | null }>}
 */
export function dshDiffNumber(ops, numbering) {
  let oldNo = 0;
  let newNo = 0;
  return ops.map(op => {
    if (op.kind === "del") {
      oldNo += 1;
      return { ...op, no: numbering === "absolute" ? oldNo : null };
    }
    if (op.kind === "add") {
      newNo += 1;
      return { ...op, no: numbering === "absolute" ? newNo : null };
    }
    oldNo += 1;
    newNo += 1;
    return { ...op, no: numbering === "absolute" ? newNo : null };
  });
}

/**
 * 把变化行之外的行折成可展开区块：变化行上下各留 {@link DSH_DIFF_CONTEXT} 行，
 * 其余连续未变化行收进 `fold` 区块，由 UI 每次多展开 {@link DSH_DIFF_REVEAL_STEP} 行。
 * @param {Array<{ kind: string, text: string, no: number | null }>} rows 已编号的行。
 * @returns {Array<{ kind: 'line', row: object } | { kind: 'fold', rows: object[] }>}
 */
export function dshDiffFold(rows) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === "ctx") return;
    for (let i = index - DSH_DIFF_CONTEXT; i <= index + DSH_DIFF_CONTEXT; i += 1) {
      if (i >= 0 && i < rows.length) keep[i] = true;
    }
  });
  const blocks = [];
  let pending = [];
  const flush = () => {
    if (pending.length === 0) return;
    blocks.push({ kind: "fold", rows: pending });
    pending = [];
  };
  rows.forEach((row, index) => {
    if (keep[index]) {
      flush();
      blocks.push({ kind: "line", row });
      return;
    }
    pending.push(row);
  });
  flush();
  return blocks;
}

/**
 * 由 `card:'diff'` 的 hunk 列表推导整张卡的渲染模型。
 *
 * 同一路径的多个 hunk 合成一个文件条目，hunk 之间插入 `⋯` 间隔行。
 * `+N -N` 只统计真正变化的行——不把两侧重复出现的上下文行算成一增一删
 * （基线 `buildRows` 就是这么算的，才会出现整文件写入时 `+365 -790` 的虚高数字）。
 *
 * @param {Array<{ path: string, oldText: string | null, newText: string }>} diffs hunk 列表。
 * @param {{ wholeFile?: boolean }} [options] `wholeFile` 表示每个 hunk 是整份文件文本
 *   （目前只有 `apply_patch` 满足），此时行号可信。
 * @returns {{ files: Array<object>, added: number, removed: number, degraded: boolean }}
 */
export function dshDiffModel(diffs, options) {
  const wholeFile = options?.wholeFile === true;
  const order = [];
  const byPath = new Map();
  let added = 0;
  let removed = 0;
  let degraded = false;

  for (const diff of diffs) {
    // 行号可信的两种情形：整份文件文本，或「从无到有」（oldText === null）。
    const numbering = wholeFile || diff.oldText === null ? "absolute" : "unknown";
    const aligned = dshDiffAlign(dshDiffLines(diff.oldText), dshDiffLines(diff.newText));
    if (aligned.degraded) degraded = true;
    const rows = dshDiffNumber(aligned.ops, numbering);
    let fileAdded = 0;
    let fileRemoved = 0;
    for (const row of rows) {
      if (row.kind === "add") fileAdded += 1;
      else if (row.kind === "del") fileRemoved += 1;
    }
    added += fileAdded;
    removed += fileRemoved;

    let entry = byPath.get(diff.path);
    if (entry === undefined) {
      entry = {
        path: diff.path,
        name: dshDiffBaseName(diff.path),
        numbering,
        added: 0,
        removed: 0,
        blocks: [],
      };
      byPath.set(diff.path, entry);
      order.push(entry);
    } else {
      entry.blocks.push({ kind: "gap" });
      // 同一文件里只要有一个 hunk 位置未知，整个文件的行号就不可信。
      if (numbering === "unknown") entry.numbering = "unknown";
    }
    entry.added += fileAdded;
    entry.removed += fileRemoved;
    for (const block of dshDiffFold(rows)) entry.blocks.push(block);
  }

  return { files: order, added, removed, degraded };
}

/**
 * 取路径最后一段作为显示用文件名（完整路径只放悬浮提示和展开后的头部）。
 * @param {string} path 模型侧原样路径。
 * @returns {string} 文件名。
 */
export function dshDiffBaseName(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * 复制用文本：与卡片所见一致的 `-`/`+`/上下文前缀，多文件时保留路径头，
 * 折叠区块也一并写入剪贴板（读者要的是这次变更，不是当前露出的那几行）。
 * @param {Array<object>} files {@link dshDiffModel} 的文件条目。
 * @returns {string} 纯文本差异。
 */
export function dshDiffCopyText(files) {
  const out = [];
  for (const file of files) {
    if (files.length > 1) out.push(file.path);
    for (const block of file.blocks) {
      if (block.kind === "gap") {
        out.push("⋯");
        continue;
      }
      const rows = block.kind === "fold" ? block.rows : [block.row];
      for (const row of rows) {
        out.push(`${row.kind === "del" ? "-" : row.kind === "add" ? "+" : " "} ${row.text}`);
      }
    }
  }
  return out.join("\n");
}

/**
 * 从 `apply_patch` 的补丁正文里解析文件清单。这是对真实调用参数的确定性解析，
 * 不是从模型文字里猜——`apply_patch` 的 `presentCall()` 不带 `diffs`，
 * 运行中只能靠这个知道在动哪些文件；解析不出来就返回空数组，界面显示未知。
 * @param {string} patch 补丁正文。
 * @returns {Array<{ path: string, operation: 'create' | 'update' }>} 文件清单。
 */
export function dshParsePatchFiles(patch) {
  if (typeof patch !== "string" || patch === "") return [];
  const files = [];
  for (const line of patch.split("\n")) {
    const add = /^\*\*\*\s+Add File:\s*(.+?)\s*$/u.exec(line);
    if (add !== null) {
      files.push({ path: add[1], operation: "create" });
      continue;
    }
    const update = /^\*\*\*\s+Update File:\s*(.+?)\s*$/u.exec(line);
    if (update !== null) files.push({ path: update[1], operation: "update" });
  }
  return files;
}

/**
 * 差异卡样式。三个新增语义变量按 `frontend-spec.md` 第 1 章命名，其余配色全部复用
 * DSH 现有 design token；深色由 DSH 自己的 `body[data-ds-dark-theme]` 选择器切换。
 */
export const DSH_DIFF_CSS = [
  "body{--dsh-diff-add-bg:var(--dsw-static-green-100);--dsh-diff-del-bg:var(--dsw-static-red-100);--dsh-diff-stale-fg:var(--dsw-alias-label-caption)}",
  "body[data-ds-dark-theme]{--dsh-diff-add-bg:color-mix(in srgb,var(--dsw-static-green-900) 58%,var(--dsw-alias-bg-base));--dsh-diff-del-bg:color-mix(in srgb,var(--dsw-static-red-900) 46%,var(--dsw-alias-bg-base))}",
  // 上游缺陷补偿：primitives 的 `DisclosureRow.module.css` 是空 stub（`\0dsh-css-stub`），
  // 行容器拿不到 `display:flex`，于是 ToolRow 自己的 `.summary{flex:auto}` 从来没生效，
  // 折叠行里的增删统计也就无法右对齐。这里只按 `data-disclosure-row` 这个稳定属性
  // 和真实 `data-tool` 值补回行布局，不碰 primitives。
  "[data-tool=write] [data-disclosure-row],[data-tool=edit] [data-disclosure-row],[data-tool=apply_patch] [data-disclosure-row]{display:flex;align-items:center;min-width:0}",
  // 卡宽不撞满可用宽度（主人 2026-08-16 14:54）：右边界取在原来单文件卡 `+N -N` 的位置。
  ".dshdiff{display:flex;flex-direction:column;gap:6px;margin:4px 0 4px 4px;min-width:0;max-width:780px}",
  ".dshdiff-group{display:flex;align-items:center;gap:8px;padding:0 2px 2px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:20px}",
  ".dshdiff-group>span:first-child{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dshdiff[data-multi=true]{gap:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}",
  ".dshdiff[data-multi=true] .dshdiff-group{padding:6px 10px;background:var(--dsw-alias-bg-layer)}",
  ".dshdiff[data-multi=true] .dshdiff-card{border:0;border-radius:0;border-top:1px solid var(--dsw-alias-border-l1)}",
  ".dshdiff[data-multi=true] .dshdiff-card[data-landed=false]{border-left:3px solid var(--dsw-alias-state-error-primary)}",
  ".dshdiff[data-multi=true] .dshdiff-card>.dshdiff-head{background:0 0}",
  ".dshdiff[data-multi=true] .dshdiff-card>.dshdiff-head:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
  ".dshdiff-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base);min-width:0;max-width:100%}",
  ".dshdiff-card[data-landed=false]{border-left:3px solid var(--dsw-alias-state-error-primary)}",
  ".dshdiff,.dshdiff *{box-sizing:border-box}",
  ".dshdiff-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border:0;margin:0;background:var(--dsw-alias-bg-layer);font:inherit;text-align:left;cursor:pointer;min-width:0}",
  ".dshdiff-head:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
  ".dshdiff-head[data-static=true]{cursor:default}",
  ".dshdiff-icon{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}",
  ".dshdiff-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:20px}",
  // 统计永远排最后（order:4），不让 hover 才出现的操作按钮占位把数字挤走；
  // 这样组头与每个文件行的 `+N -N` 在同一条竖线上。右推靠文件名 `flex:1 1 auto` 完成，
  // 不用 margin-left:auto（多个 auto 边距会平分剩余空间，反而拆开按钮与数字）。
  ".dshdiff-stat{flex:none;order:4;display:inline-flex;gap:6px;font-family:\"Cascadia Code\",\"Cascadia Mono\",Consolas,\"Courier New\",monospace;font-size:12.5px;font-variant-numeric:tabular-nums;line-height:20px}",
  ".dshdiff-add{color:var(--dsw-alias-state-success-primary)}",
  ".dshdiff-del{color:var(--dsw-alias-state-error-primary)}",
  ".dshdiff-stat[data-stale=true]{color:var(--dsh-diff-stale-fg);text-decoration:line-through}",
  ".dshdiff-stat[data-stale=true] .dshdiff-add,.dshdiff-stat[data-stale=true] .dshdiff-del{color:inherit}",
  ".dshdiff-stat[data-estimate=true]{color:var(--dsh-diff-stale-fg)}",
  ".dshdiff-stat[data-estimate=true] .dshdiff-add,.dshdiff-stat[data-estimate=true] .dshdiff-del{color:inherit}",
  ".dshdiff-badge{flex:none;order:3;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:999px;padding:0 7px;font-size:11.5px;line-height:17px;white-space:nowrap}",
  ".dshdiff-chev{flex:none;position:relative;width:14px;height:18px;color:var(--dsw-alias-label-tertiary)}",
  ".dshdiff-chev:before{content:\"\";position:absolute;left:4px;top:6px;width:5px;height:5px;border-right:1.4px solid currentColor;border-bottom:1.4px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}",
  ".dshdiff-chev[data-open=true]:before{left:3px;top:5px;transform:rotate(45deg)}",
  ".dshdiff-tools{flex:none;order:2;display:inline-flex;gap:2px;opacity:0;transition:opacity .1s}",
  ".dshdiff-card:hover .dshdiff-tools,.dshdiff-tools:focus-within{opacity:1}",
  ".dshdiff-tool{border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:6px;padding:2px 6px;font:inherit;font-size:11.5px;line-height:17px;white-space:nowrap}",
  ".dshdiff-tool:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
  ".dshdiff-body{border-top:1px solid var(--dsw-alias-border-l1);overflow-x:auto;overflow-y:auto;max-height:420px;min-width:0;max-width:100%}",
  ".dshdiff-rows{display:grid;grid-template-columns:52px minmax(max-content,1fr);min-width:max-content;font:var(--dsw-font-markdown-code-block-small);font-family:\"Cascadia Code\",\"Cascadia Mono\",Consolas,\"Courier New\",monospace;line-height:20px}",
  ".dshdiff-no{text-align:right;padding:0 10px 0 0;white-space:pre;user-select:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}",
  ".dshdiff-text{padding:0 12px;white-space:pre;color:var(--dsw-alias-label-secondary)}",
  ".dshdiff-no[data-kind=add]{background:color-mix(in srgb,var(--dsh-diff-add-bg) 52%,var(--dsw-alias-state-success-primary));color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 70%,var(--dsw-alias-label-primary))}",
  ".dshdiff-text[data-kind=add]{background:var(--dsh-diff-add-bg);color:var(--dsw-alias-label-primary)}",
  ".dshdiff-no[data-kind=del]{background:color-mix(in srgb,var(--dsh-diff-del-bg) 70%,var(--dsw-alias-state-error-primary));color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 70%,var(--dsw-alias-label-primary))}",
  ".dshdiff-text[data-kind=del]{background:var(--dsh-diff-del-bg);color:var(--dsw-alias-label-primary)}",
  ".dshdiff-gap{grid-column:1/-1;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);height:0;margin:3px 0}",
  ".dshdiff-fold{grid-column:1/-1;border:0;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module);color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:12px;line-height:22px;text-align:left;padding:0 12px}",
  ".dshdiff-fold:hover{color:var(--dsw-alias-state-business-primary)}",
  ".dshdiff-note{padding:4px 10px 5px;color:var(--dsw-alias-label-caption);font-size:11.5px;line-height:17px;border-top:1px solid var(--dsw-alias-border-l2)}",
  ".dshdiff-reason{padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-module);color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}",
].join("\n");

/** 注入运行时时一并带上的纯函数（按依赖顺序）。 */
const RUNTIME_FUNCTIONS = [
  dshDiffLines,
  dshDiffAlign,
  dshDiffNumber,
  dshDiffFold,
  dshDiffBaseName,
  dshDiffModel,
  dshDiffCopyText,
  dshParsePatchFiles,
];

/** 差异卡 React 组件源码。刻意不使用模板字符串，避免注入时的转义地狱。 */
const DIFF_CARD_COMPONENT_SOURCE = `
		const dshJsx = react_jsx_runtime.jsx;
		const dshJsxs = react_jsx_runtime.jsxs;
		const dshFrag = react_jsx_runtime.Fragment;
		function dshWriteClipboard(text) {
			try {
				return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
			} catch {
				return Promise.resolve(false);
			}
		}
		function DshDiffStat({ added, removed, estimate, stale }) {
			return dshJsxs("span", {
				className: "dshdiff-stat",
				"data-estimate": estimate === true ? "true" : void 0,
				"data-stale": stale === true ? "true" : void 0,
				title: estimate === true ? "运行中的暂估，完成后由工具结果覆盖" : void 0,
				children: [dshJsx("span", {
					className: "dshdiff-add",
					children: (estimate === true ? "≈+" : "+") + String(added)
				}), dshJsx("span", {
					className: "dshdiff-del",
					children: "-" + String(removed)
				})]
			});
		}
		function DshDiffFileCard({ file, meta, defaultOpen }) {
			const [open, setOpen] = react.useState(defaultOpen === true);
			const [reveal, setReveal] = react.useState({});
			const landed = meta.landed !== false;
			const rows = [];
			file.blocks.forEach(function (block, blockIndex) {
				if (block.kind === "gap") {
					rows.push(dshJsx("span", {
						className: "dshdiff-gap",
						"aria-hidden": true
					}, "gap" + String(blockIndex)));
					return;
				}
				if (block.kind === "fold") {
					const shown = reveal[blockIndex] === void 0 ? 0 : reveal[blockIndex];
					block.rows.slice(0, shown).forEach(function (row, rowIndex) {
						rows.push(dshJsxs(dshFrag, {
							children: [dshJsx("span", {
								className: "dshdiff-no",
								"data-kind": row.kind,
								"aria-hidden": true,
								children: row.no === null ? "·" : String(row.no)
							}), dshJsx("span", {
								className: "dshdiff-text",
								"data-kind": row.kind,
								children: row.text
							})]
						}, "f" + String(blockIndex) + ":" + String(rowIndex)));
					});
					const rest = block.rows.length - shown;
					if (rest > 0) rows.push(dshJsx("button", {
						type: "button",
						className: "dshdiff-fold",
						onClick: function (event) {
							event.stopPropagation();
							setReveal(function (prev) {
								const next = { ...prev };
								next[blockIndex] = shown + ${String(DSH_DIFF_REVEAL_STEP)};
								return next;
							});
						},
						children: "⋯ 展开其余 " + String(rest) + " 行"
					}, "fold" + String(blockIndex)));
					return;
				}
				const row = block.row;
				rows.push(dshJsxs(dshFrag, {
					children: [dshJsx("span", {
						className: "dshdiff-no",
						"data-kind": row.kind,
						"aria-hidden": true,
						children: row.no === null ? "·" : String(row.no)
					}), dshJsx("span", {
						className: "dshdiff-text",
						"data-kind": row.kind,
						children: row.text
					})]
				}, "l" + String(blockIndex)));
			});
			const copy = function (event) {
				event.stopPropagation();
				dshWriteClipboard(dshDiffCopyText([file]));
			};
			const openInEditor = function (event) {
				event.stopPropagation();
				if (meta.onOpenFile !== void 0) meta.onOpenFile(file.path);
			};
			const toggle = function () {
				setOpen(function (value) { return !value; });
			};
			return dshJsxs("div", {
				className: "dshdiff-card",
				"data-landed": landed ? "true" : "false",
				children: [dshJsxs("div", {
					className: "dshdiff-head",
					role: "button",
					tabIndex: 0,
					title: file.path,
					"aria-expanded": open,
					onClick: toggle,
					onKeyDown: function (event) {
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						toggle();
					},
					children: [
						dshJsx("span", {
							className: "dshdiff-chev",
							"data-open": open ? "true" : "false",
							"aria-hidden": true
						}),
						dshJsx("span", { className: "dshdiff-name", children: file.name }),
						dshJsx(DshDiffStat, {
							added: file.added,
							removed: file.removed,
							estimate: meta.estimate === true,
							stale: !landed
						}),
						landed ? null : dshJsx("span", { className: "dshdiff-badge", children: "未落盘" }),
						dshJsxs("span", {
							className: "dshdiff-tools",
							children: [dshJsx("button", {
								type: "button",
								className: "dshdiff-tool",
								onClick: copy,
								children: "复制"
							}), meta.onOpenFile === void 0 ? null : dshJsx("button", {
								type: "button",
								className: "dshdiff-tool",
								onClick: openInEditor,
								children: "在编辑器中打开"
							})]
						})
					]
				}), open && rows.length > 0 ? dshJsx("div", {
					className: "dshdiff-body",
					children: dshJsx("div", { className: "dshdiff-rows", children: rows })
				}) : null, open && file.numbering === "unknown" ? dshJsx("div", {
					className: "dshdiff-note",
					children: "· 行号未知：本次事件只带了变更片段，未提供片段在文件中的起始行"
				}) : null, meta.attachReason === true && typeof meta.reason === "string" && meta.reason !== "" ? dshJsx("div", {
					className: "dshdiff-reason",
					children: meta.reason
				}) : null]
			});
		}
		function DshDiffCard({ diffs, meta }) {
			const cardMeta = meta === void 0 || meta === null ? {} : meta;
			const model = react.useMemo(function () {
				if (cardMeta.model !== void 0 && cardMeta.model !== null) return cardMeta.model;
				return dshDiffModel(Array.isArray(diffs) ? diffs : [], { wholeFile: cardMeta.wholeFile === true });
			}, [diffs, cardMeta.model, cardMeta.wholeFile]);
			const landed = cardMeta.landed !== false;
			const reason = typeof cardMeta.reason === "string" && cardMeta.reason !== "" ? cardMeta.reason : null;
			if (model.files.length === 0) {
				if (reason === null) return null;
				return dshJsx("div", {
					className: "dshdiff",
					children: dshJsxs("div", {
						className: "dshdiff-card",
						"data-landed": landed ? "true" : "false",
						children: [dshJsxs("div", {
							className: "dshdiff-head",
							"data-static": "true",
							children: [dshJsx("span", {
								className: "dshdiff-name",
								children: cardMeta.subject === void 0 ? "文件未被修改" : cardMeta.subject
							}), landed ? null : dshJsx("span", { className: "dshdiff-badge", children: "未落盘" })]
						}), dshJsx("div", { className: "dshdiff-reason", children: reason })]
					})
				});
			}
			const multi = model.files.length > 1;
			return dshJsxs("div", {
				className: "dshdiff",
				"data-multi": multi ? "true" : void 0,
				children: [multi ? dshJsxs("div", {
					className: "dshdiff-group",
					children: [dshJsx("span", {
						children: (cardMeta.groupLabel === void 0 ? "已修改" : cardMeta.groupLabel) + " " + String(model.files.length) + " 个文件"
					}), dshJsx(DshDiffStat, {
						added: model.added,
						removed: model.removed,
						estimate: cardMeta.estimate === true,
						stale: !landed
					})]
				}) : null, model.files.map(function (file) {
					return dshJsx(DshDiffFileCard, {
						file,
						meta: multi ? cardMeta : { ...cardMeta, attachReason: true },
						defaultOpen: !multi
					}, file.path);
				}), reason === null || !multi ? null : dshJsx("div", {
					className: "dshdiff-card",
					"data-landed": landed ? "true" : "false",
					children: dshJsx("div", { className: "dshdiff-reason", children: reason })
				})]
			});
		}
`;

/**
 * 由行模型推导差异卡的注入源码：纯函数用 `toString()` 原样带过去，
 * 保证工作区里被单测覆盖的实现与运行时执行的是同一份代码。
 * @returns {string} 注入的 region 源码。
 */
export function buildDiffCardRuntimeSource() {
  const constants = [
    `\t\tconst DSH_DIFF_CONTEXT = ${DSH_DIFF_CONTEXT};`,
    `\t\tconst DSH_DIFF_LCS_BUDGET = ${DSH_DIFF_LCS_BUDGET};`,
  ].join("\n");
  const functions = RUNTIME_FUNCTIONS
    .map(fn => fn.toString().split("\n").map(line => `\t\t${line}`).join("\n"))
    .join("\n");
  const style = [
    `\t\tconst dshDiffCss = ${JSON.stringify(DSH_DIFF_CSS)};`,
    `\t\tconst dshDiffCssTag = "@deepseek-ai/dsh-client-ui-tool/stardust-diff-card.css";`,
    `\t\tif (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(dshDiffCssTag) + "]") === null) {`,
    `\t\t\tconst tag = document.createElement("style");`,
    `\t\t\ttag.dataset.plugin = "@deepseek-ai/dsh-client-ui-tool";`,
    `\t\t\ttag.dataset.pluginCss = dshDiffCssTag;`,
    `\t\t\ttag.textContent = dshDiffCss;`,
    `\t\t\tdocument.head.appendChild(tag);`,
    `\t\t}`,
  ].join("\n");
  return [
    "\t\t//#region stardust: 文件差异卡（前端展示层，批次 B）",
    constants,
    functions,
    style,
    DIFF_CARD_COMPONENT_SOURCE.replace(/^\n/u, "").replace(/\n$/u, ""),
    "\t\t//#endregion",
  ].join("\n");
}

/**
 * 精确一次替换。与 `transforms.mjs` 同语义：命中 0 次或多次一律抛错，
 * 避免锚点漂移后静默产出半个补丁。
 * @param {string} source 源码。
 * @param {string} before 锚点。
 * @param {string} after 替换结果。
 * @param {string} label 中文标签，失败时用于定位。
 * @returns {string} 替换后的源码。
 */
function replaceExactlyOnce(source, before, after, label) {
  const parts = source.split(before);
  if (parts.length !== 2) {
    throw new Error(`补丁锚点未精确命中一次：${label}（命中 ${parts.length - 1} 次）`);
  }
  return parts.join(after);
}

/** 文件变更行：替换基线 `FileMutationRow`，并把 `apply_patch` 也接进同一张卡。 */
const FILE_MUTATION_ROW_SOURCE = `		function dshMutationLabels(toolName) {
			if (toolName === "write") return {
				running: "正在写入",
				done: "已写入",
				failed: "写入未完成",
				group: "已写入"
			};
			if (toolName === "apply_patch") return {
				running: "正在应用补丁",
				done: "已应用补丁",
				failed: "补丁未应用",
				group: "已修改"
			};
			return {
				running: "正在编辑",
				done: "已编辑",
				failed: "编辑未完成",
				group: "已编辑"
			};
		}
		/** 由真实调用参数派生「打算做的改动」：运行中的暂估、以及失败时被划掉的数字都来自这里。 */
		function dshIntendedDiffs(toolName, argsRaw) {
			const parsed = parseArgs(argsRaw);
			if (typeof parsed !== "object" || parsed === null) return [];
			const path = pickString(parsed, ["file_path", "path"]);
			if (path === void 0) return [];
			if (toolName === "write") {
				if (typeof parsed.content !== "string") return [];
				return [{
					path,
					oldText: null,
					newText: parsed.content
				}];
			}
			if (toolName === "edit") {
				if (typeof parsed.old_string !== "string" || typeof parsed.new_string !== "string") return [];
				return [{
					path,
					oldText: parsed.old_string === "" ? null : parsed.old_string,
					newText: parsed.new_string
				}];
			}
			return [];
		}
		/** apply_patch 运行中没有 diffs，只能从补丁正文解析出真实文件清单。 */
		function dshPatchPaths(argsRaw) {
			const parsed = parseArgs(argsRaw);
			if (typeof parsed !== "object" || parsed === null || typeof parsed.patch !== "string") return [];
			return dshParsePatchFiles(parsed.patch).map(function (file) { return file.path; });
		}
		function FileMutationRow({ toolName, block, cwd, openFile, inspect, t }) {
			const base = toolRowModel(toolName, block, cwd);
			const done = "kind" in block;
			const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? "";
			const labels = dshMutationLabels(toolName);
			const landed = base.state === "ok";
			const settled = diffCardModel(block);
			const diffs = landed && settled !== null ? settled.card.diffs : dshIntendedDiffs(toolName, argsRaw);
			const wholeFile = toolName === "apply_patch";
			const model = react.useMemo(function () {
				return dshDiffModel(diffs, { wholeFile });
			}, [diffs, wholeFile]);
			const fallbackPaths = toolName === "apply_patch" && model.files.length === 0 ? dshPatchPaths(argsRaw) : [];
			const paths = model.files.length > 0 ? model.files.map(function (file) { return file.path; }) : fallbackPaths;
			const summary = paths.length === 1
				? dshDiffBaseName(paths[0])
				: paths.length > 1 ? String(paths.length) + " 个文件" : relativizeToCwd(base.summary, cwd);
			const reason = base.state === "ok" ? null : base.output;
			const hasCard = model.files.length > 0 || reason !== null;
			const stat = model.files.length === 0 ? null : (0, react_jsx_runtime.jsx)(DshDiffStat, {
				added: model.added,
				removed: model.removed,
				estimate: base.state === "running",
				stale: !landed
			});
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: base.variant,
				toolName,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 14 }),
				title: base.state === "running" ? labels.running : landed ? labels.done : labels.failed,
				summary,
				summarySuffix: stat,
				body: null,
				output: hasCard ? null : base.output,
				errorSummary: null,
				diff: hasCard ? {
					card: { diffs },
					meta: {
						model,
						wholeFile,
						landed,
						estimate: base.state === "running",
						groupLabel: labels.group,
						subject: summary,
						reason,
						onOpenFile: paths.length === 1 && openFile !== void 0 ? openFile : void 0
					}
				} : null,
				state: base.state,
				filePath: paths.length === 1 ? paths[0] : void 0,
				onOpenFile: openFile,
				inspect
			});
		}`;

/**
 * 把文件差异卡打进工具展示包。
 *
 * 四处改动：注入差异卡运行时、把 `ToolRow` 的 `DiffBlock` 换成 `DshDiffCard`、
 * 给折叠行的路径链接补上完整路径悬浮提示、重写 `FileMutationRow` 并注册 `apply_patch`。
 *
 * @param {string} source `@deepseek-ai/dsh-client-ui-tool/lib/client.js` 的干净源码。
 * @returns {string} 打好补丁的源码。
 */
export function patchToolDiffCardSource(source) {
  let result = source;

  // G5 真实验收发现：中文界面里工具行标题全是英文（`Code`、`Tool call`、`Read`…）。
  // 这一组是上游自己注明的「design literals, not translatable copy」，不走 locale，
  // 属纯展示字面量，因此在展示层直接改成中文动词，与规范 14.7 的口径一致；
  // 只翻译上游已经确认存在的 7 个变体，不新增变体、不按工具名猜中文。
  result = replaceExactlyOnce(
    result,
    `\t\tconst VARIANT_TITLES = {
\t\t\tsearch: "Search",
\t\t\tread: "Read",
\t\t\tbash: "Bash",
\t\t\twrite: "Write",
\t\t\tedit: "Edit",
\t\t\tcode: "Code",
\t\t\tothers: "Tool call"
\t\t};`,
    `\t\tconst VARIANT_TITLES = {
\t\t\tsearch: "搜索",
\t\t\tread: "读取",
\t\t\tbash: "终端",
\t\t\twrite: "写入",
\t\t\tedit: "编辑",
\t\t\tcode: "代码",
\t\t\tothers: "工具调用"
\t\t};`,
    "工具行标题中文化",
  );

  result = replaceExactlyOnce(
    result,
    `\t\t//#region lib/types/client/tool/components/ToolRow.js`,
    `${buildDiffCardRuntimeSource()}
\t\t//#region lib/types/client/tool/components/ToolRow.js`,
    "差异卡运行时注入",
  );

  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t}) : diffBody !== null ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {
\t\t\t\t\t\t\t...diffBody.card,
\t\t\t\t\t\t\tmaxLines: 8,
\t\t\t\t\t\t\tclassName: ToolRow_module_css_default.diffBody
\t\t\t\t\t\t})`,
    `\t\t\t\t\t\t}) : diffBody !== null ? (0, react_jsx_runtime.jsx)(DshDiffCard, {
\t\t\t\t\t\t\t...diffBody.card,
\t\t\t\t\t\t\tmeta: diffBody.meta ?? null
\t\t\t\t\t\t})`,
    "差异卡替换 DiffBlock",
  );

  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\tfileLink ? (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\tclassName: ToolRow_module_css_default.fileLink,
\t\t\t\t\t\t\tonClick: openFile,`,
    `\t\t\t\t\t\tfileLink ? (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\tclassName: ToolRow_module_css_default.fileLink,
\t\t\t\t\t\t\ttitle: filePath,
\t\t\t\t\t\t\tonClick: openFile,`,
    "折叠行完整路径悬浮提示",
  );

  result = replaceExactlyOnce(
    result,
    `\t\t\tconst diff = diffCardModel(block);
\t\t\tif (diff !== null) return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {
\t\t\t\t...diff.card,
\t\t\t\tclassName: ToolDetails_module_css_default.cardBody
\t\t\t});`,
    `\t\t\tconst diff = diffCardModel(block);
\t\t\tif (diff !== null) {
\t\t\t\tconst diffToolName = "kind" in block ? block.call?.name ?? "" : block.name;
\t\t\t\treturn (0, react_jsx_runtime.jsx)(DshDiffCard, {
\t\t\t\t\t...diff.card,
\t\t\t\t\tmeta: {
\t\t\t\t\t\twholeFile: diffToolName === "apply_patch",
\t\t\t\t\t\tlanded: !("kind" in block) || !block.isError,
\t\t\t\t\t\testimate: !("kind" in block),
\t\t\t\t\t\tgroupLabel: "已修改"
\t\t\t\t\t}
\t\t\t\t});
\t\t\t}`,
    "详情面板差异卡替换",
  );

  const rowStart = `\t\tfunction FileMutationRow({ toolName, block, cwd, openFile, inspect, t }) {`;
  const rowEnd = `\t\t\t});
\t\t}
\t\t/**
\t\t* The file-mutation rows as a plain registrant plugin following the chat
\t\t* toolview declaration across independent activation and reload lifetimes.
\t\t*/`;
  const startAt = result.indexOf(rowStart);
  if (startAt === -1) throw new Error("补丁锚点未命中：FileMutationRow 起点");
  const endAt = result.indexOf(rowEnd, startAt);
  if (endAt === -1) throw new Error("补丁锚点未命中：FileMutationRow 终点");
  if (result.indexOf(rowStart, startAt + rowStart.length) !== -1) {
    throw new Error("补丁锚点重复命中：FileMutationRow 起点");
  }
  result = `${result.slice(0, startAt)}${FILE_MUTATION_ROW_SOURCE}\n${result.slice(endAt + `\t\t\t});\n\t\t}\n`.length)}`;

  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\tyield ctx.slots.register({
\t\t\t\t\t\tname: "tool.call.toolview",
\t\t\t\t\t\tkey: "write",
\t\t\t\t\t\tlocale: CONVERSATION_NS
\t\t\t\t\t}, FileMutationRow);`,
    `\t\t\t\t\tyield ctx.slots.register({
\t\t\t\t\t\tname: "tool.call.toolview",
\t\t\t\t\t\tkey: "write",
\t\t\t\t\t\tlocale: CONVERSATION_NS
\t\t\t\t\t}, FileMutationRow);
\t\t\t\t\tyield ctx.slots.register({
\t\t\t\t\t\tname: "tool.call.toolview",
\t\t\t\t\t\tkey: "apply_patch",
\t\t\t\t\t\tlocale: CONVERSATION_NS
\t\t\t\t\t}, FileMutationRow);`,
    "注册 apply_patch 文件变更行",
  );

  return result;
}
