/**
 * 批次 D（窗口 G3）：编辑上一条用户消息的外壳。
 *
 * 设计要点与真实依据（干净基线 `0.1.0-rc.6-oauth` 的 `dsh-client-ui-conversation/lib/client.js`）：
 *
 * 1. **编辑态就是主输入框搬到消息位置**（主人 2026-08-16 16:17 明确）。
 *    模型选择器与模式选择器都是「主输入框那一份真实控件」，不是仿制外观：
 *    - `conversation.input.model` 槽位由 `conversation.composer.bar` 独家声明
 *      （baseline `client.js:9632`），槽位不允许二次声明
 *      （`dsh-client-ui-slots/lib/index.js:94` 直接抛错），所以聊天节点自己
 *      **不能**再声明一份。
 *    - 但 `boundRenderSlot` 返回的是自包含元素，只校验「声明它的 entry 还活着」
 *      与「key 已声明」（`dsh-client-web-react/lib/index.js:487-497`），
 *      **没有「必须画在本 entry 子树内」的限制**。
 *    - 因此 InputBar 把自己拿到的 `renderSlot` / `command` 绑定发布到模块内总线，
 *      消息位置的编辑器取来用：模型选择器渲染出来的是同一个 `ModelSelect`，
 *      改模型就是改会话模型，与主输入框显示的是同一份状态。
 * 2. **`＋` 是命令菜单，不是附件上传**（`client.js:3835-3845`，词条 `input.commands` = 「命令」）。
 *    它的 `toggleCommandMenu` 把候选词插入**主草稿**（`shell.snapshot.draft` + `draftRev`），
 *    在编辑器里点它会把 `/compact` 写进底部输入框而不是这里，所以按钮保留位置但禁用，
 *    等 Codex 给编辑器草稿目标后再启用。真实加图通道只有粘贴与拖拽（`client.js:3542-3623`）。
 * 3. **附件走本地态**。真实 `addImages` 加的是「下一条新消息」的草稿图池，
 *    粘贴到编辑器却出现在底部输入框会错位，所以新增图片留在编辑器内，
 *    随 `editResend.submit` 一起交给后端。
 * 4. **能力探测**：只有 `editResend.submit` 是函数才允许发送；否则按钮禁用并写明原因。
 *    禁止用前端截断消息列表伪装完成，禁止宣称回滚不可补偿的副作用。
 */

import { assertNotAlreadyPatched, replaceExactlyOnce } from "./replace-exactly.mjs";

/* ==================== 纯逻辑（可单测，注入后同名可用） ==================== */

/**
 * 发送按钮状态。
 * @param input - `backendReady` 后端重发能力是否存在；`text` 当前文本；
 *   `originalText` 原始文本；`addedCount` 新增附件数；`attachmentChanged` 任意图片变更数；
 *   `sourceSeqReady` 是否已有稳定的消息编号；`sending` 是否正在提交。
 * @returns `{disabled, reason}`，`reason` 取 `backend` / `source_seq` / `sending` / `empty` / `unchanged` / null。
 */
export function dshEditSendState(input) {
  const backendReady = input?.backendReady === true;
  const sourceSeqReady = input?.sourceSeqReady !== false;
  const sending = input?.sending === true;
  const text = typeof input?.text === "string" ? input.text : "";
  const original = typeof input?.originalText === "string" ? input.originalText : "";
  const attachmentChanged = typeof input?.attachmentChanged === "number" && input.attachmentChanged > 0
    ? input.attachmentChanged
    : (typeof input?.addedCount === "number" && input.addedCount > 0 ? input.addedCount : 0);
  const selectionChanged = input?.selectionChanged === true;
  if (!backendReady) return {
    disabled: true,
    reason: "backend"
  };
  if (!sourceSeqReady) return {
    disabled: true,
    reason: "source_seq"
  };
  if (sending) return {
    disabled: true,
    reason: "sending"
  };
  if (text.trim() === "" && attachmentChanged === 0 && !selectionChanged) return {
    disabled: true,
    reason: "empty"
  };
  if (text === original && attachmentChanged === 0 && !selectionChanged) return {
    disabled: true,
    reason: "unchanged"
  };
  return {
    disabled: false,
    reason: null
  };
}

export function dshEditSourceSeqState(seq) {
  if (Number.isSafeInteger(seq) && seq >= 0) return { allowed: true, value: seq, reason: null };
  return {
    allowed: false,
    value: undefined,
    reason: "这条历史消息没有稳定编号，无法安全编辑重发",
  };
}

export function dshEditAvailabilityReason(reason) {
  return {
    session_not_found: "当前会话已不存在，无法编辑重发",
    session_running: "当前会话仍在运行，结束后再试",
    pending_input: "当前会话有待处理输入，完成后再试",
    no_real_user_message: "这条消息不是可编辑的真人用户消息",
    message_not_found: "这条历史消息已变化或不再存在",
    snapshot_missing: "这条历史消息缺少发送前状态快照，不能安全编辑重发",
    branch_store_conflict: "这条消息的分支记录损坏或冲突，现有文件已保留，修复记录前不能安全重发",
  }[reason] ?? "当前无法确认这条消息能否安全编辑重发";
}

export function dshEditLargeTextMode(text) {
  return typeof text === "string" && text.length > 64 * 1024;
}

export function dshEditCurrentModelSelection(sessions, sessionId) {
  try {
    const scope = sessions?.scope?.(sessionId);
    const current = scope?.get?.("modelDirectories")?.directoryFor?.(sessionId)?.store?.getSnapshot?.().current;
    if (typeof current?.provider !== "string" || current.provider === "" || typeof current?.model !== "string" || current.model === "") return undefined;
    return {
      provider: current.provider,
      model: current.model,
      ...(typeof current.reasoningEffort === "string" && current.reasoningEffort !== "" ? { reasoningEffort: current.reasoningEffort } : {}),
    };
  } catch {
    return undefined;
  }
}

export function dshEditNormalizeDraftOrder(order, { hasText, imageCount, fileCount }) {
  const normalized = [];
  let placedText = false;
  const placedImages = new Set();
  const placedFiles = new Set();
  const pushText = () => {
    if (!hasText || placedText) return;
    normalized.push({ type: "text" });
    placedText = true;
  };
  const pushImage = (index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= imageCount || placedImages.has(index)) return;
    normalized.push({ type: "image", index });
    placedImages.add(index);
  };
  const pushFile = (index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= fileCount || placedFiles.has(index)) return;
    normalized.push({ type: "file", index });
    placedFiles.add(index);
  };
  if (Array.isArray(order)) {
    for (const item of order) {
      const type = item?.type ?? item?.kind;
      if (type === "text") pushText();
      else if (type === "image") pushImage(item.index);
      else if (type === "file") pushFile(item.index);
    }
  }
  pushText();
  for (let index = 0; index < imageCount; index += 1) pushImage(index);
  for (let index = 0; index < fileCount; index += 1) pushFile(index);
  return normalized;
}

export function dshEditDraftFromContent(content, draft) {
  const marker = "【附件清单｜message-branch:v1】";
  const blocks = Array.isArray(content) ? content : [];
  const images = Array.isArray(draft?.images) ? [...draft.images] : [];
  const files = Array.isArray(draft?.files) ? [...draft.files] : [];
  const texts = [];
  const derivedOrder = [];
  let derivedImageCount = 0;
  let placedText = false;
  let placedFiles = false;
  for (const block of blocks) {
    if (block?.type === "image" && block.attachment !== undefined) {
      if (!Array.isArray(draft?.images)) images.push({ attachment: block.attachment });
      derivedOrder.push({ type: "image", index: derivedImageCount });
      derivedImageCount += 1;
      continue;
    }
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    if (block.text.startsWith(marker)) {
      if (!placedFiles) {
        for (let index = 0; index < files.length; index += 1) derivedOrder.push({ type: "file", index });
        placedFiles = true;
      }
      continue;
    }
    texts.push(block.text);
    if (!placedText) {
      derivedOrder.push({ type: "text" });
      placedText = true;
    }
  }
  const text = typeof draft?.text === "string" ? draft.text : texts.join("");
  const order = dshEditNormalizeDraftOrder(Array.isArray(draft?.order) ? draft.order : derivedOrder, {
    hasText: text.trim() !== "",
    imageCount: images.length,
    fileCount: files.length,
  });
  return { text, images, files, order };
}

export function dshEditSubmitOrder(originalOrder, keptImageIndexes, addedImageCount, fileCount, text, addedFileCount = 0) {
  const kept = Array.isArray(keptImageIndexes) ? keptImageIndexes : [];
  const oldToNew = new Map();
  kept.forEach((oldIndex, newIndex) => {
    if (Number.isSafeInteger(oldIndex) && oldIndex >= 0) oldToNew.set(oldIndex, newIndex);
  });
  const order = [];
  for (const item of Array.isArray(originalOrder) ? originalOrder : []) {
    const type = item?.type ?? item?.kind;
    if (type === "text") order.push({ type: "text" });
    else if (type === "image" && oldToNew.has(item.index)) order.push({ type: "image", index: oldToNew.get(item.index) });
    else if (type === "file") order.push({ type: "file", index: item.index });
  }
  const keptCount = kept.length;
  const totalImages = keptCount + (Number.isSafeInteger(addedImageCount) && addedImageCount > 0 ? addedImageCount : 0);
  for (let index = keptCount; index < totalImages; index += 1) order.push({ type: "image", index });
  return dshEditNormalizeDraftOrder(order, {
    hasText: typeof text === "string" && text.trim() !== "",
    imageCount: totalImages,
    fileCount: fileCount + (Number.isSafeInteger(addedFileCount) && addedFileCount > 0 ? addedFileCount : 0),
  });
}

export function dshEditTextFingerprint(text) {
  const value = typeof text === "string" ? text : "";
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + index), 3266489909);
  }
  return value.length + ":" + (first >>> 0) + ":" + (second >>> 0);
}

export function dshEditOperationIdFor(cache, input, createId) {
  const key = JSON.stringify({
    sessionId: input?.sessionId,
    nodeKey: input?.nodeKey,
    seq: input?.seq,
    textFingerprint: dshEditTextFingerprint(input?.text),
    keptImageIndexes: input?.keptImageIndexes,
    addedImageKeys: input?.addedImageKeys,
    addedFileKeys: input?.addedFileKeys,
    files: input?.files,
    order: input?.order,
    modelSelection: input?.modelSelection,
  });
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const operationId = createId();
  cache.set(key, operationId);
  return operationId;
}

/**
 * 图片按真实 `imageLimits` 投影筛选，普通文件统一接受到 16 MiB。
 *
 * 后端没有推送 `imageLimits` 时，图片不猜大小上限；普通文件使用本地接口的保守上限。
 * @param files - `DataTransfer`/`ClipboardEvent` 给出的文件列表。
 * @param limits - `useProjection("imageLimits")` 的值，可为 undefined。
 * @returns `{accepted, rejected}`，rejected 元素为 `{name, reason:"type"|"size"}`。
 */
export function dshEditIntakeFiles(files, limits) {
  const list = files === undefined || files === null ? [] : Array.from(files);
  const types = Array.isArray(limits?.mediaTypes) ? limits.mediaTypes : undefined;
  const maxBytes = typeof limits?.maxImageBytes === "number" && Number.isFinite(limits.maxImageBytes) ? limits.maxImageBytes : undefined;
  const accepted = [];
  const rejected = [];
  for (const file of list) {
    const type = typeof file?.type === "string" ? file.type : "";
    const image = type.startsWith("image/");
    const typeOk = !image || types === undefined || types.includes(type);
    const limit = image ? maxBytes : 16 * 1024 * 1024;
    const sizeOk = limit === undefined || !(typeof file?.size === "number") ? true : file.size <= limit;
    if (typeOk && sizeOk) accepted.push(file);
    else rejected.push({
      name: typeof file?.name === "string" && file.name !== "" ? file.name : "剪贴板图片",
      reason: typeOk ? "size" : "type"
    });
  }
  return {
    accepted,
    rejected
  };
}

/**
 * 「不会被撤销的外部副作用」清单归一化。
 *
 * 后端没给就返回空数组，**前端不编条目**（规范 9.3）。
 * @param effects - `editResend.externalEffects`，可为任意类型。
 * @returns 展示用条目数组 `{label, detail?}`。
 */
export function dshEditExternalEffects(effects) {
  if (!Array.isArray(effects)) return [];
  const rows = [];
  for (const effect of effects) {
    if (typeof effect === "string") {
      if (effect.trim() !== "") rows.push({ label: effect });
      continue;
    }
    const label = typeof effect?.label === "string" && effect.label !== "" ? effect.label : undefined;
    if (label === undefined) continue;
    const detail = typeof effect?.detail === "string" && effect.detail !== "" ? effect.detail : undefined;
    rows.push(detail === undefined ? { label } : { label, detail });
  }
  return rows;
}

const EDIT_RESEND_LOGIC_SOURCE = [dshEditSendState, dshEditSourceSeqState, dshEditAvailabilityReason, dshEditLargeTextMode, dshEditCurrentModelSelection, dshEditNormalizeDraftOrder, dshEditDraftFromContent, dshEditSubmitOrder, dshEditTextFingerprint, dshEditOperationIdFor, dshEditIntakeFiles, dshEditExternalEffects]
  .map((fn) => fn.toString().split("\n").map((line) => `\t\t${line}`).join("\n"))
  .join("\n");

/* ==================== 样式 ==================== */

/**
 * 编辑重发外壳样式。
 *
 * 卡片本体直接复用主输入框的 CSS 模块类（`InputBar_module_css_default.card` 等），
 * 这里只做三件事：把 card 的最大宽度放开到聊天列宽、加编辑态高亮、补本模块自己的
 * chip 行与提示行。配色只用现有 `--dsw-*` token。
 */
export const EDIT_RESEND_SHELL_STYLE = [
  '[data-dsh-edit-shell]{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0}',
  '[data-dsh-edit-card]{max-width:100%;padding-top:16px;border-color:var(--dsw-static-deepseek-500);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-static-deepseek-500) 15%,transparent)}',
  '[data-dsh-edit-scroll]{max-height:var(--dsh-composer-text-max-height,320px)}',
  '[data-dsh-edit-mirror]{min-height:48px}',
  '.dsh-er-gallery{padding:0 12px}',
  '.dsh-er-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px}',
  '.dsh-compose-file-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px}',
  '.dsh-compose-file-button[data-busy="true"]{opacity:.7}',
  '.dsh-er-chip{display:inline-flex;align-items:center;gap:6px;max-width:220px;min-width:0;padding:3px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
  '.dsh-er-chip img{flex:none;width:22px;height:22px;border-radius:5px;object-fit:cover}',
  '.dsh-er-chip>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-er-chipdrop{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
  '.dsh-er-chipdrop:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}',
  '.dsh-er-cancel{flex:none;height:28px;padding:0 10px;border:0;border-radius:999px;background:none;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:28px;cursor:pointer}',
  '.dsh-er-cancel:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-er-foot{display:flex;flex-direction:column;gap:2px;padding:0 6px}',
  '.dsh-er-note{display:flex;gap:6px;align-items:flex-start;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
  '.dsh-er-note i{flex:none;font-style:normal}',
  '.dsh-er-block{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:4px 8px;font-size:12px;line-height:18px}',
  '.dsh-er-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
  '.dsh-er-large-text{color:var(--dsw-alias-label-primary);-webkit-text-fill-color:currentColor;overflow-y:auto}',
  '.dsh-er-effects{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}',
  '.dsh-er-effects:hover{color:var(--dsw-alias-label-primary)}',
  '.dsh-er-chev{position:relative;display:inline-block;width:12px;height:18px}',
  '.dsh-er-chev:before{content:"";position:absolute;left:2px;top:6px;width:5px;height:5px;border-right:1.4px solid currentColor;border-bottom:1.4px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}',
  '.dsh-er-effects[aria-expanded="true"] .dsh-er-chev:before{left:1px;top:5px;transform:rotate(45deg)}',
  '.dsh-er-efflist{margin:0 0 0 16px;padding:0;list-style:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
  '.dsh-er-efflist li{padding:1px 0}',
  '.dsh-er-efflist em{font-style:normal;color:var(--dsw-alias-label-secondary)}',
  '@media (prefers-reduced-motion:reduce){.dsh-er-chev:before{transition:none}}',
].join("");

/* ==================== 注入到对话 bundle 的运行时 ==================== */

const EDIT_RESEND_RUNTIME_SOURCE = `${EDIT_RESEND_LOGIC_SOURCE}
\t\tconst DSH_EDIT_RESEND_CSS = ${JSON.stringify(EDIT_RESEND_SHELL_STYLE)};
\t\tif (typeof document !== "undefined" && document.querySelector('style[data-dsh-frontend="edit-resend"]') === null) {
\t\t\tconst tag = document.createElement("style");
\t\t\ttag.dataset.dshFrontend = "edit-resend";
\t\t\ttag.textContent = DSH_EDIT_RESEND_CSS;
\t\t\tdocument.head.appendChild(tag);
\t\t}
\t\tfunction dshEditReadBase64(file) {
\t\t\treturn new Promise((resolve, reject) => {
\t\t\t\tconst reader = new FileReader();
\t\t\t\treader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
\t\t\t\treader.onload = () => {
\t\t\t\t\tconst value = typeof reader.result === "string" ? reader.result : "";
\t\t\t\t\tconst comma = value.indexOf(",");
\t\t\t\t\tif (comma < 0) reject(new Error("图片编码格式无效"));
\t\t\t\t\telse resolve(value.slice(comma + 1));
\t\t\t\t};
\t\t\t\treader.readAsDataURL(file);
\t\t\t});
\t\t}
\t\tconst DSH_COMPOSER_FILE_TEXT_LIMIT = 256 * 1024;
\t\tfunction dshComposerFileSizeText(bytes) {
\t\t\tif (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
\t\t\tif (bytes < 1024) return String(bytes) + " B";
\t\t\tif (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + " KiB";
\t\t\treturn (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MiB";
\t\t}
\t\tfunction dshComposerCanInlineFile(file) {
\t\t\tconst name = String(file?.name ?? "");
\t\t\tconst type = String(file?.type ?? "");
\t\t\treturn type.startsWith("text/")
\t\t\t\t|| /\\.(?:txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|js|jsx|ts|tsx|py|css|html|htm|ini|toml|rs|go|java|c|cpp|h|hpp|cs|sh|ps1|bat|sql)$/iu.test(name);
\t\t}
\t\tasync function dshComposerFileManifest(items) {
\t\t\tconst lines = [
\t\t\t\t"【附件清单｜composer-files:v1】",
\t\t\t\t"以下普通文件来自本次用户输入；能安全读取为文本且不超过 256 KiB 的文件已内联，二进制或过大文件只提供元数据。"
\t\t\t];
\t\t\tfor (let index = 0; index < items.length; index += 1) {
\t\t\t\tconst file = items[index].file ?? items[index];
\t\t\t\tconst name = typeof file?.name === "string" && file.name !== "" ? file.name : "未命名文件";
\t\t\t\tconst type = typeof file?.type === "string" && file.type !== "" ? file.type : "application/octet-stream";
\t\t\t\tconst size = Number.isFinite(file?.size) ? file.size : 0;
\t\t\t\tlines.push("");
\t\t\t\tlines.push("### 文件 " + (index + 1) + ": " + name);
\t\t\t\tlines.push("- MIME: " + type);
\t\t\t\tlines.push("- 大小: " + dshComposerFileSizeText(size));
\t\t\t\tif (size <= DSH_COMPOSER_FILE_TEXT_LIMIT && dshComposerCanInlineFile(file) && typeof file.text === "function") {
\t\t\t\t\tconst text = await file.text();
\t\t\t\t\tlines.push("- 内容:");
\t\t\t\t\tlines.push("<file-content name=" + JSON.stringify(name) + ">");
\t\t\t\t\tlines.push(text.replaceAll("</file-content>", "<\\/file-content>"));
\t\t\t\t\tlines.push("</file-content>");
\t\t\t\t} else {
\t\t\t\t\tlines.push("- 内容未内联：该文件不是安全文本文件，或超过 256 KiB。");
\t\t\t\t}
\t\t\t}
\t\t\treturn lines.join("\\n");
\t\t}
	\t\tfunction dshComposerMergeFileManifest(draft, manifest) {
	\t\t\tconst text = String(draft ?? "").trim();
	\t\t\tif (text.includes("【附件清单｜composer-files:v1】")) return text;
	\t\t\treturn text === "" ? manifest : text + "\\n\\n" + manifest;
	\t\t}
	\t\tconst DSH_COMPOSER_FILE_DRAFTS = new Map();
	\t\tconst DSH_EDIT_RESEND_CLIENTS = new WeakMap();
\t\tfunction dshEditResendClient(sessions, sessionId) {
\t\t\tconst cacheable = (typeof sessions === "object" && sessions !== null) || typeof sessions === "function";
\t\t\tconst cached = cacheable ? DSH_EDIT_RESEND_CLIENTS.get(sessions)?.get(sessionId) : void 0;
\t\t\tif (cached !== void 0) return cached;
\t\t\tconst currentModelSelection = () => dshEditCurrentModelSelection(sessions, sessionId);
\t\t\tconst availabilityCache = new Map();
\t\t\tconst requestJson = async (url, init) => {
\t\t\t\tconst response = await fetch(url, init);
\t\t\t\tconst body = await response.json().catch(() => null);
\t\t\t\tif (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? ("编辑重发失败（HTTP " + response.status + "）"));
\t\t\t\treturn body;
\t\t\t};
\t\t\tconst client = {
\t\t\t\tsessionId,
\t\t\t\tasync availability(payload) {
\t\t\t\t\tif (!Number.isSafeInteger(payload?.seq) || payload.seq < 0) {
\t\t\t\t\t\treturn { allowed: false, reason: "message_not_found" };
\t\t\t\t\t}
\t\t\t\t\tconst cacheKey = String(payload.seq);
\t\t\t\t\tconst cachedAvailability = availabilityCache.get(cacheKey);
\t\t\t\t\tif (cachedAvailability !== void 0) return cachedAvailability;
\t\t\t\t\tconst query = new URLSearchParams({ sessionId, sourceEventSeq: String(payload.seq) });
\t\t\t\t\tconst pending = (async () => {
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\treturn (await requestJson("/message-branch/availability?" + query)).availability;
\t\t\t\t\t\t} finally {
\t\t\t\t\t\t\tif (availabilityCache.get(cacheKey) === pending) availabilityCache.delete(cacheKey);
\t\t\t\t\t\t}
\t\t\t\t\t})();
\t\t\t\t\tavailabilityCache.set(cacheKey, pending);
\t\t\t\t\treturn pending;
\t\t\t\t},
\t\t\t\tcurrentModelSelection,
\t\t\t\tfileUpload: { allowed: true },
\t\t\t\texternalEffects: [
\t\t\t\t\t{ label: "Sandbox、外部网站、远端 Git 与第三方 MCP 的副作用不会撤销" },
\t\t\t\t\t{ label: "系统补丁文件若后来已变化会保留当前内容，并在新分支提示冲突" }
  \t\t\t\t],
  \t\t\t\tasync submit(payload) {
  \t\t\t\t\tif (!Number.isSafeInteger(payload?.seq) || payload.seq < 0) {
  \t\t\t\t\t\tthrow new Error("这条历史消息没有稳定编号，无法安全编辑重发");
  \t\t\t\t\t}
  \t\t\t\t\tif (typeof payload?.operationId !== "string" || payload.operationId === "") {
  \t\t\t\t\t\tthrow new Error("编辑重发缺少稳定操作编号");
  \t\t\t\t\t}
  \t\t\t\t\tconst query = new URLSearchParams({ sessionId, sourceEventSeq: String(payload.seq) });
\t\t\t\t\tconst availability = (await requestJson("/message-branch/availability?" + query)).availability;
\t\t\t\t\tif (availability?.allowed !== true) throw new Error("这条消息当前不能编辑重发：" + String(availability?.reason ?? "unknown"));
\t\t\t\t\tconst addedImages = [];
\t\t\t\t\tfor (const file of payload.addedImages ?? []) addedImages.push({
\t\t\t\t\t\tdataBase64: await dshEditReadBase64(file),
\t\t\t\t\t\tmediaType: file.type,
\t\t\t\t\t\tname: file.name
\t\t\t\t\t});
\t\t\t\t\tconst addedFiles = [];
\t\t\t\t\tfor (const file of payload.addedFiles ?? []) addedFiles.push({
\t\t\t\t\t\tdataBase64: await dshEditReadBase64(file),
\t\t\t\t\t\tmediaType: file.type || "application/octet-stream",
\t\t\t\t\t\tname: file.name,
\t\t\t\t\t\tbytes: file.size
\t\t\t\t\t});
\t\t\t\t\tconst modelSelection = payload.modelSelection === void 0 ? currentModelSelection() : payload.modelSelection;
\t\t\t\t\tconst body = await requestJson("/message-branch/edit-and-resend", {
\t\t\t\t\t\tmethod: "POST",
\t\t\t\t\t\theaders: { "content-type": "application/json" },
\t\t\t\t\t\tbody: JSON.stringify({
\t\t\t\t\t\t\toperationId: payload.operationId,
\t\t\t\t\t\t\tsessionId,
\t\t\t\t\t\t\t...(modelSelection === undefined ? {} : { modelSelection }),
\t\t\t\t\t\t\texpectedSourceMessageId: availability.sourceMessageId,
\t\t\t\t\t\t\tsourceEventSeq: payload.seq,
\t\t\t\t\t\t\tdraft: {
\t\t\t\t\t\t\t\ttext: payload.text,
\t\t\t\t\t\t\t\timages: [...(payload.keptImages ?? []), ...addedImages],
\t\t\t\t\t\t\t\tfiles: [...(Array.isArray(payload.files) ? payload.files : availability.draft?.files ?? []), ...addedFiles],
\t\t\t\t\t\t\t\t...(Array.isArray(payload.order) ? { order: payload.order } : {})
\t\t\t\t\t\t\t}
\t\t\t\t\t\t})
\t\t\t\t\t});
\t\t\t\t\tconst result = body.result;
\t\t\t\t\tif (typeof result?.childSessionId === "string") {
\t\t\t\t\t\tif (result.childSessionId === sessionId) {
\t\t\t\t\t\t\tconst current = sessions.binding?.(sessionId)?.session;
\t\t\t\t\t\t\tif (typeof current?.resync !== "function") throw new Error("同会话重发成功，但当前界面无法重新加载该会话");
\t\t\t\t\t\t\tawait current.resync();
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tsessions.open(result.childSessionId);
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\treturn result;
\t\t\t\t}
\t\t\t};
\t\t\tif (cacheable) {
\t\t\t\tlet bySession = DSH_EDIT_RESEND_CLIENTS.get(sessions);
\t\t\t\tif (bySession === void 0) {
\t\t\t\t\tbySession = new Map();
\t\t\t\t\tDSH_EDIT_RESEND_CLIENTS.set(sessions, bySession);
\t\t\t\t}
\t\t\t\tbySession.set(sessionId, client);
\t\t\t}
\t\t\treturn client;
\t\t}
\t\t/**
\t\t * 编辑态总线。
\t\t *
\t\t * 只承担两件事：哪条消息正在被编辑（target），以及主输入框发布的真实控件通道
\t\t * （face：模型槽位的 renderSlot 绑定与 /permission 执行器）。不保存草稿、不碰会话状态。
\t\t */
  \t\tconst DSH_EDIT_BUS = (function createDshEditBus() {
  \t\t\tconst states = new Map();
  \t\t\tconst listeners = new Map();
  \t\t\tconst keyOf = (sessionId) => typeof sessionId === "string" ? sessionId : "";
  \t\t\tconst stateOf = (sessionId) => {
  \t\t\t\tconst key = keyOf(sessionId);
  \t\t\t\tlet state = states.get(key);
  \t\t\t\tif (state === void 0) {
  \t\t\t\t\tstate = { target: null, face: null };
  \t\t\t\t\tstates.set(key, state);
  \t\t\t\t}
  \t\t\t\treturn state;
  \t\t\t};
  \t\t\tconst emit = (sessionId) => {
  \t\t\t\tfor (const listener of [...(listeners.get(keyOf(sessionId)) ?? [])]) listener();
  \t\t\t};
  \t\t\treturn {
  \t\t\t\tsubscribe: (sessionId, listener) => {
  \t\t\t\tconst key = keyOf(sessionId);
  \t\t\t\tconst set = listeners.get(key) ?? new Set();
  \t\t\t\tset.add(listener);
  \t\t\t\tlisteners.set(key, set);
  \t\t\t\treturn () => {
  \t\t\t\t\tset.delete(listener);
  \t\t\t\t\tif (set.size === 0) listeners.delete(key);
  \t\t\t\t};
  \t\t\t\t},
  \t\t\t\treadTarget: (sessionId) => stateOf(sessionId).target,
  \t\t\t\treadFace: (sessionId) => stateOf(sessionId).face,
  \t\t\t\topen: (sessionId, next) => {
  \t\t\t\t\tstateOf(sessionId).target = next;
  \t\t\t\t\temit(sessionId);
  \t\t\t\t},
  \t\t\t\tclose: (sessionId, nodeKey) => {
  \t\t\t\t\tconst state = stateOf(sessionId);
  \t\t\t\t\tif (state.target === null) return;
  \t\t\t\t\tif (nodeKey !== void 0 && state.target.nodeKey !== nodeKey) return;
  \t\t\t\t\tstate.target = null;
  \t\t\t\t\temit(sessionId);
  \t\t\t\t},
  \t\t\t\tpublishFace: (sessionId, next) => {
  \t\t\t\t\tstateOf(sessionId).face = next;
  \t\t\t\t\temit(sessionId);
  \t\t\t\t},
  \t\t\t\tretractFace: (sessionId, previous) => {
  \t\t\t\t\tconst state = stateOf(sessionId);
  \t\t\t\t\tif (state.face !== previous) return;
  \t\t\t\t\tstate.face = null;
  \t\t\t\t\temit(sessionId);
  \t\t\t\t}
  \t\t\t};
  \t\t})();
\t\t/**
\t\t * 用户消息操作行改成 hover 才显现（规范 9.1）。
\t\t *
\t\t * 干净基线只把**时间标签**做成 hover 显现，复制按钮是常显的
\t\t * （MessageIconActions.module.css 里只有 timeStart/timeEnd 进了 hover 媒体查询）。
\t\t * 这里补上按钮，并且只作用于用户消息行（userRow），不改助手行的既有行为。
\t\t * 哈希类名只能在运行时从 CSS 模块读，所以这条规则必须**延迟注入**：
\t\t * 两个 \`var\` 在本补丁的注入位置（InputBar 之前）尚未赋值。
\t\t */
\t\tfunction dshEnsureMessageActionHoverStyle() {
\t\t\tif (typeof document === "undefined") return;
\t\t\tif (document.querySelector('style[data-dsh-frontend="edit-resend-hover"]') !== null) return;
\t\t\tconst row = MessageItem_module_css_default?.userRow;
\t\t\tconst action = MessageIconActions_module_css_default?.action;
\t\t\tif (typeof row !== "string" || typeof action !== "string") return;
\t\t\tconst tag = document.createElement("style");
\t\t\ttag.dataset.dshFrontend = "edit-resend-hover";
\t\t\ttag.textContent = "@media (hover:hover){." + row + " ." + action + "{opacity:0;transition:opacity 80ms}." + row + ":hover ." + action + ",." + row + ":focus-within ." + action + "{opacity:1}}";
\t\t\tdocument.head.appendChild(tag);
\t\t}
\t\t/** 消息下方的铅笔按钮：与复制图标同一行、同一套按钮样式。 */
  \t\tfunction DshEditPencil({ sessionId, nodeKey, seq, editResend, disabledReason }) {
\t\t\tconst seqState = dshEditSourceSeqState(seq);
  \t\t\tconst availabilityReady = typeof editResend?.availability === "function";
  \t\t\tconst buttonRef = (0, react.useRef)(null);
\t\t\tconst lastRetryAtRef = (0, react.useRef)(0);
  \t\t\tconst retryAttemptRef = (0, react.useRef)(0);
  \t\t\tconst [shouldCheck, setShouldCheck] = (0, react.useState)(false);
\t\t\tconst [checkRevision, setCheckRevision] = (0, react.useState)(0);
  \t\t\tconst [availability, setAvailability] = (0, react.useState)(() => ({ checking: false, allowed: false, reason: null, value: null }));
  \t\t\t(0, react.useEffect)(() => {
  \t\t\t\tif (!seqState.allowed || !availabilityReady || shouldCheck) return;
  \t\t\t\tconst element = buttonRef.current;
  \t\t\t\tif (element === null || typeof IntersectionObserver === "undefined") {
  \t\t\t\t\tsetShouldCheck(true);
  \t\t\t\t\treturn;
  \t\t\t\t}
  \t\t\t\tconst observer = new IntersectionObserver((entries) => {
  \t\t\t\t\tif (!entries.some((entry) => entry.isIntersecting)) return;
  \t\t\t\t\tsetShouldCheck(true);
  \t\t\t\t\tobserver.disconnect();
  \t\t\t\t}, { rootMargin: "160px" });
  \t\t\t\tobserver.observe(element);
  \t\t\t\treturn () => observer.disconnect();
  \t\t\t}, [availabilityReady, seqState.allowed, seqState.value, shouldCheck]);
  \t\t\t(0, react.useEffect)(() => {
  \t\t\t\tif (!seqState.allowed || !availabilityReady || !shouldCheck) return;
  \t\t\t\tlet active = true;
\t\t\t\tlastRetryAtRef.current = Date.now();
  \t\t\t\tsetAvailability({ checking: true, allowed: false, reason: null, value: null });
  \t\t\t\tPromise.resolve(editResend.availability({ seq: seqState.value })).then((next) => {
  \t\t\t\t\tif (active) setAvailability({ checking: false, allowed: next?.allowed === true, reason: next?.reason ?? "unknown", value: next ?? null });
  \t\t\t\t}, () => {
  \t\t\t\t\tif (active) setAvailability({ checking: false, allowed: false, reason: "unknown", value: null });
  \t\t\t\t});
  \t\t\t\treturn () => {
  \t\t\t\t\tactive = false;
  \t\t\t\t};
\t\t\t}, [availabilityReady, checkRevision, editResend, seqState.allowed, seqState.value, shouldCheck]);
\t\t\tconst retryAvailability = () => {
\t\t\t\tif (!shouldCheck || availability.checking || availability.allowed) return;
\t\t\t\tif (!["session_running", "pending_input", "unknown"].includes(availability.reason)) return;
\t\t\t\tif (Date.now() - lastRetryAtRef.current < 1000) return;
\t\t\t\tretryAttemptRef.current += 1;
\t\t\t\tsetCheckRevision((value) => value + 1);
\t\t\t};
  \t\t\t(0, react.useEffect)(() => {
  \t\t\t\tif (!shouldCheck || availability.checking || availability.allowed) {
  \t\t\t\t\tif (availability.allowed) retryAttemptRef.current = 0;
  \t\t\t\t\treturn;
  \t\t\t\t}
  \t\t\t\tif (!["session_running", "pending_input", "unknown"].includes(availability.reason)) {
  \t\t\t\t\tretryAttemptRef.current = 0;
  \t\t\t\t\treturn;
  \t\t\t\t}
  \t\t\t\tif (retryAttemptRef.current >= 12) return;
  \t\t\t\tconst delay = Math.min(3200, 900 + retryAttemptRef.current * 300);
  \t\t\t\tconst timer = window.setTimeout(() => {
  \t\t\t\t\tif (availability.checking || availability.allowed) return;
  \t\t\t\t\tretryAttemptRef.current += 1;
  \t\t\t\t\tsetCheckRevision((value) => value + 1);
  \t\t\t\t}, delay);
  \t\t\t\treturn () => window.clearTimeout(timer);
  \t\t\t}, [availability.allowed, availability.checking, availability.reason, shouldCheck]);
  \t\t\tconst unavailable = disabledReason ?? (!seqState.allowed ? seqState.reason : !availabilityReady ? "重发接口尚未接入" : !shouldCheck ? "滚动到这条消息后会自动检查能否安全编辑重发" : availability.checking ? "正在检查这条消息能否安全编辑重发" : availability.allowed ? void 0 : dshEditAvailabilityReason(availability.reason));
  \t\t\tconst label = unavailable === void 0 ? "编辑并重新发送" : unavailable;
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tdshEnsureMessageActionHoverStyle();
\t\t\t}, []);
\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
\t\t\t\tlabel,
\t\t\t\tside: "bottom",
\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\tref: buttonRef,
\t\t\t\t\ttype: "button",
\t\t\t\t\tclassName: MessageIconActions_module_css_default.action,
\t\t\t\t\t"aria-label": label,
  \t\t\t\t\t"aria-disabled": unavailable === void 0 ? void 0 : true,
  \t\t\t\t\t"data-unavailable": unavailable === void 0 ? void 0 : true,
\t\t\t\t\t"data-dsh-msg-action": "edit",
\t\t\t\t\tonPointerEnter: retryAvailability,
\t\t\t\t\tonFocus: retryAvailability,
\t\t\t\t\tonClick: unavailable === void 0 ? () => {
\t\t\t\t\t\tDSH_EDIT_BUS.open(sessionId, { nodeKey, seq: seqState.value, availability: availability.value });
\t\t\t\t\t} : retryAvailability,
\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
\t\t\t\t})
\t\t\t});
\t\t}
\t\t/** 编辑器里已有附件与新增附件的 chip。 */
\t\tfunction DshEditChip({ item, onRemove }) {
\t\t\treturn (0, react_jsx_runtime.jsxs)("span", {
\t\t\t\tclassName: "dsh-er-chip",
\t\t\t\tchildren: [typeof item.url === "string" ? (0, react_jsx_runtime.jsx)("img", {
\t\t\t\t\tsrc: item.url,
\t\t\t\t\talt: "",
\t\t\t\t\t"aria-hidden": true
\t\t\t\t}) : null, (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\ttitle: item.name,
\t\t\t\t\tchildren: item.name
\t\t\t\t}), typeof onRemove === "function" ? (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\ttype: "button",
\t\t\t\t\tclassName: "dsh-er-chipdrop",
\t\t\t\t\t"aria-label": "移除 " + item.name,
\t\t\t\t\tonClick: () => {
\t\t\t\t\t\tonRemove(item.key);
\t\t\t\t\t},
\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 })
\t\t\t\t}) : null]
\t\t\t});
\t\t}
\t\t/**
\t\t * 编辑态：原地替换用户消息气泡，复用主输入框的卡片结构、模式选择与模型选择。
\t\t *
\t\t * 发送能力来自 owner 注入的 \`editResend\`（后端未就绪时按钮禁用并写明原因）；
\t\t * 分支提示常驻，副作用清单只有后端给了才展开。
\t\t */
  \t\tfunction DshEditResendShell({ node, loadImage, editResend, useProjection, availability, t }) {
  \t\t\tconst data = node.data;
  \t\t\tconst original = dshEditDraftFromContent(data.content, availability?.draft);
  \t\t\tconst [text, setText] = (0, react.useState)(original.text);
  \t\t\tconst [removedImageIndexes, setRemovedImageIndexes] = (0, react.useState)(new Set());
  \t\t\tconst [added, setAdded] = (0, react.useState)([]);
  \t\t\tconst [rejected, setRejected] = (0, react.useState)([]);
  \t\t\tconst [failure, setFailure] = (0, react.useState)(null);
  \t\t\tconst [sending, setSending] = (0, react.useState)(false);
  \t\t\tconst [effectsOpen, setEffectsOpen] = (0, react.useState)(false);
  \t\t\tconst areaRef = (0, react.useRef)(null);
  \t\t\tconst fileInputRef = (0, react.useRef)(null);
  \t\t\tconst addedRef = (0, react.useRef)(added);
  \t\t\tconst operationIdsRef = (0, react.useRef)(new Map());
  \t\t\tconst sendingRef = (0, react.useRef)(false);
  \t\t\taddedRef.current = added;
  \t\t\tconst sessionId = typeof editResend?.sessionId === "string" ? editResend.sessionId : "";
  \t\t\tconst subscribe = (0, react.useCallback)((listener) => DSH_EDIT_BUS.subscribe(sessionId, listener), [sessionId]);
  \t\t\tconst readFace = (0, react.useCallback)(() => DSH_EDIT_BUS.readFace(sessionId), [sessionId]);
  \t\t\tconst face = (0, react.useSyncExternalStore)(subscribe, readFace);
\t\t\tconst permissions = useProjection === void 0 ? void 0 : useProjection("permissions");
\t\t\tconst imageLimits = useProjection === void 0 ? void 0 : useProjection("imageLimits");
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst el = areaRef.current;
\t\t\t\tif (el === null) return;
\t\t\t\tel.focus();
\t\t\t\tel.setSelectionRange(el.value.length, el.value.length);
\t\t\t}, []);
\t\t\t(0, react.useEffect)(() => () => {
\t\t\t\tfor (const item of addedRef.current) if (typeof item.url === "string") URL.revokeObjectURL(item.url);
\t\t\t}, []);
  \t\t\tconst close = () => {
  \t\t\t\tDSH_EDIT_BUS.close(sessionId, node.key);
  \t\t\t};
\t\t\tconst intake = (files) => {
\t\t\t\tconst outcome = dshEditIntakeFiles(files, imageLimits);
\t\t\t\tsetRejected(outcome.rejected);
\t\t\t\tif (outcome.accepted.length === 0) return false;
\t\t\t\tsetAdded((previous) => [...previous, ...outcome.accepted.map((file, index) => ({
\t\t\t\t\tkey: "added:" + Date.now() + ":" + index + ":" + (file.name ?? ""),
\t\t\t\t\tname: typeof file.name === "string" && file.name !== "" ? file.name : "未命名文件",
\t\t\t\t\tkind: typeof file.type === "string" && file.type.startsWith("image/") ? "image" : "file",
\t\t\t\t\t...(typeof file.type === "string" && file.type.startsWith("image/") ? { url: URL.createObjectURL(file) } : {}),
\t\t\t\t\tfile
\t\t\t\t}))]);
\t\t\t\treturn true;
\t\t\t};
  \t\t\tconst dropChip = (key) => {
\t\t\t\tsetAdded((previous) => {
\t\t\t\t\tconst gone = previous.find((item) => item.key === key);
\t\t\t\t\tif (typeof gone?.url === "string") URL.revokeObjectURL(gone.url);
\t\t\t\t\treturn previous.filter((item) => item.key !== key);
  \t\t\t\t});
  \t\t\t};
  \t\t\tconst keptImages = original.images.map((attachment, index) => ({ attachment, index })).filter((item) => !removedImageIndexes.has(item.index));
  \t\t\tconst dropKeptImage = (index) => {
  \t\t\t\tsetRemovedImageIndexes((previous) => new Set([...previous, index]));
  \t\t\t};
\t\t\tconst sourceSeq = dshEditSourceSeqState(data.seq);
  \t\t\tconst largeText = dshEditLargeTextMode(text);
  \t\t\tconst addedImages = added.filter((item) => item.kind === "image");
  \t\t\tconst addedFiles = added.filter((item) => item.kind === "file");
\t\t\tconst backendReady = typeof editResend?.submit === "function";
\t\t\tconst modelSelection = typeof editResend?.currentModelSelection === "function" ? editResend.currentModelSelection() : void 0;
\t\t\tconst originalModelSelection = availability?.modelSelection;
\t\t\tconst selectionChanged = modelSelection !== void 0 && originalModelSelection !== void 0 && (
\t\t\t\tmodelSelection.provider !== originalModelSelection.provider
\t\t\t\t|| modelSelection.model !== originalModelSelection.model
\t\t\t\t|| modelSelection.reasoningEffort !== originalModelSelection.reasoningEffort
\t\t\t);
  \t\t\tconst send = dshEditSendState({
  \t\t\t\tbackendReady,
  \t\t\t\tsourceSeqReady: sourceSeq.allowed,
  \t\t\t\tsending,
  \t\t\t\ttext,
  \t\t\t\toriginalText: original.text,
  \t\t\t\tattachmentChanged: added.length + removedImageIndexes.size,
  \t\t\t\tselectionChanged
  \t\t\t});
  \t\t\tconst sendReason = {
  \t\t\t\tbackend: "重发接口尚未接入：后端分支能力就绪后此按钮自动可用",
  \t\t\t\tsource_seq: sourceSeq.reason,
  \t\t\t\tsending: "正在发送，请等待结果；超时后重试会复用同一操作",
  \t\t\t\tempty: "消息内容不能为空",
\t\t\t\tunchanged: "内容未修改"
  \t\t\t}[send.reason ?? ""];
  \t\t\tconst onSend = () => {
  \t\t\t\tif (send.disabled || !backendReady || sendingRef.current) return;
  \t\t\t\tif (!sourceSeq.allowed) {
  \t\t\t\t\tsetFailure(sourceSeq.reason);
  \t\t\t\t\treturn;
  \t\t\t\t}
  \t\t\t\tsendingRef.current = true;
  \t\t\t\tsetSending(true);
  \t\t\t\tsetFailure(null);
  \t\t\t\tconst submittedModelSelection = typeof editResend?.currentModelSelection === "function" ? editResend.currentModelSelection() : modelSelection;
  \t\t\t\tconst submitOrder = dshEditSubmitOrder(original.order, keptImages.map((item) => item.index), addedImages.length, original.files.length, text, addedFiles.length);
  \t\t\t\tconst operationId = dshEditOperationIdFor(operationIdsRef.current, {
  \t\t\t\t\tsessionId,
  \t\t\t\t\tnodeKey: node.key,
  \t\t\t\t\tseq: sourceSeq.value,
  \t\t\t\t\ttext,
  \t\t\t\t\tkeptImageIndexes: keptImages.map((item) => item.index),
  \t\t\t\t\taddedImageKeys: addedImages.map((item) => item.key),
  \t\t\t\t\taddedFileKeys: addedFiles.map((item) => item.key),
  \t\t\t\t\tfiles: original.files,
  \t\t\t\t\torder: submitOrder,
  \t\t\t\t\tmodelSelection: submittedModelSelection
  \t\t\t\t}, () => typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : ("edit-resend-" + Date.now()));
  \t\t\t\tlet outcome;
  \t\t\t\ttry {
  \t\t\t\t\toutcome = editResend.submit({
  \t\t\t\t\t\tnodeKey: node.key,
  \t\t\t\t\t\toperationId,
  \t\t\t\t\t\tseq: sourceSeq.value,
  \t\t\t\t\t\ttext,
  \t\t\t\t\t\tkeptImages: keptImages.map((item) => item.attachment),
  \t\t\t\t\t\taddedImages: addedImages.map((item) => item.file),
  \t\t\t\t\t\taddedFiles: addedFiles.map((item) => item.file),
  \t\t\t\t\t\tfiles: original.files,
  \t\t\t\t\t\torder: submitOrder,
  \t\t\t\t\t\tmodelSelection: submittedModelSelection
  \t\t\t\t\t});
  \t\t\t\t} catch (error) {
  \t\t\t\t\tsendingRef.current = false;
  \t\t\t\t\tsetSending(false);
  \t\t\t\t\tsetFailure(error instanceof Error ? error.message : String(error));
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (outcome !== null && typeof outcome?.then === "function") {
  \t\t\t\t\toutcome.then(() => {
  \t\t\t\t\t\tclose();
  \t\t\t\t\t}, (error) => {
  \t\t\t\t\t\tsendingRef.current = false;
  \t\t\t\t\t\tsetSending(false);
  \t\t\t\t\t\tsetFailure(error instanceof Error ? error.message : String(error));
\t\t\t\t\t});
  \t\t\t\t\treturn;
  \t\t\t\t}
  \t\t\t\tsendingRef.current = false;
  \t\t\t\tsetSending(false);
  \t\t\t\tclose();
\t\t\t};
\t\t\tconst effects = dshEditExternalEffects(editResend?.externalEffects);
\t\t\tconst storeWarnings = Array.isArray(availability?.warnings) ? availability.warnings : [];
\t\t\tconst accessSelect = face?.command === void 0 || permissions === void 0 ? null : (0, react_jsx_runtime.jsx)(PermissionSelect, {
\t\t\t\tvalue: permissions,
\t\t\t\tlocked: false,
\t\t\t\tcommand: face.command,
\t\t\t\tt
\t\t\t});
\t\t\tconst modelSeat = face?.renderSlot === void 0 ? null : face.renderSlot("conversation.input.model", { locked: false });
\t\t\tconst orderSummary = original.order.map((item) => {
\t\t\t\tconst type = item.type ?? item.kind;
\t\t\t\tif (type === "text") return "文字";
\t\t\t\tif (type === "image") return "图片 " + (item.index + 1);
\t\t\t\tif (type === "file") return "文件 " + (item.index + 1);
\t\t\t\treturn "未知内容";
\t\t\t}).join(" → ");
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t"data-dsh-edit-shell": true,
\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\tclassName: InputBar_module_css_default.card,
\t\t\t\t\t"data-dsh-edit-card": true,
\t\t\t\t\tonKeyDown: (event) => {
\t\t\t\t\t\tif (event.key === "Escape") {
\t\t\t\t\t\t\tevent.preventDefault();
\t\t\t\t\t\t\tclose();
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tif (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
\t\t\t\t\t\t\tevent.preventDefault();
\t\t\t\t\t\t\tonSend();
\t\t\t\t\t\t}
\t\t\t\t\t},
\t\t\t\t\tonDragOver: (event) => {
\t\t\t\t\t\tif (event.dataTransfer === null) return;
\t\t\t\t\t\tevent.preventDefault();
\t\t\t\t\t\tevent.dataTransfer.dropEffect = "copy";
\t\t\t\t\t},
\t\t\t\t\tonDrop: (event) => {
\t\t\t\t\t\tif (event.dataTransfer === null) return;
  \t\t\t\t\t\tintake(event.dataTransfer.files);
  \t\t\t\t\t\tevent.preventDefault();
\t\t\t\t\t},
\t\t\t\t\tchildren: [
\t\t\t\t\t\toriginal.order.length <= 1 ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tclassName: "dsh-er-block",
\t\t\t\t\t\t\t"data-dsh-edit-order": "preserved",
\t\t\t\t\t\t\tchildren: "原始顺序：" + orderSummary
\t\t\t\t\t\t}),
  \t\t\t\t\t\tkeptImages.length === 0 ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tclassName: "dsh-er-gallery",
\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_attachment.ImageGallery, {
  \t\t\t\t\t\t\t\timages: keptImages.map((item) => item.attachment),
\t\t\t\t\t\t\t\tload: loadImage,
\t\t\t\t\t\t\t\talign: "start",
\t\t\t\t\t\t\t\tlabels: messageImageLabels(t)
\t\t\t\t\t\t\t})
  \t\t\t\t\t\t}), keptImages.length === 0 ? null : (0, react_jsx_runtime.jsx)("div", {
  \t\t\t\t\t\t\tclassName: "dsh-er-chips",
  \t\t\t\t\t\t\tchildren: keptImages.map((item) => (0, react_jsx_runtime.jsx)(DshEditChip, {
  \t\t\t\t\t\t\t\titem: { key: "kept:" + item.index, name: "已有图片 " + (item.index + 1) },
  \t\t\t\t\t\t\t\tonRemove: () => {
  \t\t\t\t\t\t\t\t\tdropKeptImage(item.index);
  \t\t\t\t\t\t\t\t}
  \t\t\t\t\t\t\t}, item.index))
  \t\t\t\t\t\t}),
\t\t\t\t\t\toriginal.files.length === 0 ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tclassName: "dsh-er-chips",
\t\t\t\t\t\t\tchildren: original.files.map((file, index) => (0, react_jsx_runtime.jsx)(DshEditChip, {
\t\t\t\t\t\t\t\titem: { key: "file:" + index, name: file.name ?? ("文件 " + (index + 1)) }
\t\t\t\t\t\t\t}, "file:" + index))
\t\t\t\t\t\t}), added.length === 0 ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tclassName: "dsh-er-chips",
\t\t\t\t\t\t\tchildren: added.map((item) => (0, react_jsx_runtime.jsx)(DshEditChip, {
\t\t\t\t\t\t\t\titem,
\t\t\t\t\t\t\t\tonRemove: dropChip
\t\t\t\t\t\t\t}, item.key))
\t\t\t\t\t\t}),
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tclassName: InputBar_module_css_default.scroll,
\t\t\t\t\t\t\t"data-dsh-edit-scroll": true,
\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.grow,
\t\t\t\t\t\t\t\tchildren: [largeText ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\t\t"aria-hidden": true,
\t\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.backdrop,
\t\t\t\t\t\t\t\t\tchildren: text
\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("textarea", {
\t\t\t\t\t\t\t\t\tref: areaRef,
\t\t\t\t\t\t\t\t\tclassName: largeText ? InputBar_module_css_default.input + " dsh-er-large-text" : InputBar_module_css_default.input,
\t\t\t\t\t\t\t\t\tvalue: text,
\t\t\t\t\t\t\t\t\trows: 2,
\t\t\t\t\t\t\t\t\t"aria-label": "编辑这条消息",
\t\t\t\t\t\t\t\t\tonChange: (event) => {
\t\t\t\t\t\t\t\t\t\tsetText(event.target.value);
\t\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t\t\tonPaste: (event) => {
\t\t\t\t\t\t\t\t\t\tif (event.clipboardData === null) return;
\t\t\t\t\t\t\t\t\t\tif (intake(event.clipboardData.files)) event.preventDefault();
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\t\t"aria-hidden": true,
\t\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.mirror,
\t\t\t\t\t\t\t\t\t"data-dsh-edit-mirror": true,
\t\t\t\t\t\t\t\t\tchildren: largeText ? "\\n" : text + "\\n"
\t\t\t\t\t\t\t\t})]
\t\t\t\t\t\t\t})
\t\t\t\t\t\t}),
\t\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\tclassName: InputBar_module_css_default.row,
\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.tools,
\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
  \t\t\t\t\t\t\t\t\tlabel: "命令菜单只能在下方主输入框使用",
\t\t\t\t\t\t\t\t\tside: "top",
\t\t\t\t\t\t\t\t\tdelayMs: 500,
\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.add,
\t\t\t\t\t\t\t\t\t\t"aria-label": t("input.commands"),
\t\t\t\t\t\t\t\t\t\tdisabled: true,
\t\t\t\t\t\t\t\t\t\t"data-dsh-edit-commands": true,
\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 14 })
\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
\t\t\t\t\t\t\t\t\tlabel: "文件",
\t\t\t\t\t\t\t\t\tside: "top",
\t\t\t\t\t\t\t\t\tdelayMs: 500,
\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsxs)("span", {
\t\t\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("input", {
\t\t\t\t\t\t\t\t\t\t\tref: fileInputRef,
\t\t\t\t\t\t\t\t\t\t\ttype: "file",
\t\t\t\t\t\t\t\t\t\t\tmultiple: true,
\t\t\t\t\t\t\t\t\t\t\tstyle: { display: "none" },
\t\t\t\t\t\t\t\t\t\t\t"data-dsh-edit-file-input": true,
\t\t\t\t\t\t\t\t\t\t\tonChange: (event) => {
\t\t\t\t\t\t\t\t\t\t\t\tintake(event.target.files);
\t\t\t\t\t\t\t\t\t\t\t\tevent.target.value = "";
\t\t\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.add,
\t\t\t\t\t\t\t\t\t\t\t"aria-label": "文件",
\t\t\t\t\t\t\t\t\t\t\t"data-dsh-edit-file-button": true,
\t\t\t\t\t\t\t\t\t\t\tonClick: () => fileInputRef.current?.click(),
\t\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("svg", {
\t\t\t\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",
\t\t\t\t\t\t\t\t\t\t\t\twidth: "16",
\t\t\t\t\t\t\t\t\t\t\t\theight: "16",
\t\t\t\t\t\t\t\t\t\t\t\t"aria-hidden": true,
\t\t\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", { d: "M1.5 4.25A1.75 1.75 0 0 1 3.25 2.5h3l1.25 1.5h5.25a1.75 1.75 0 0 1 1.75 1.75v6A1.75 1.75 0 0 1 12.75 13.5h-9.5A1.75 1.75 0 0 1 1.5 11.75v-7.5Zm1.75-.5a.5.5 0 0 0-.5.5v7.5c0 .276.224.5.5.5h9.5a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5H6.914l-1.25-1.5H3.25Z", fill: "currentColor" })
\t\t\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t\t\t})]
\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.modes,
\t\t\t\t\t\t\t\t\tchildren: accessSelect
\t\t\t\t\t\t\t\t})]
\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.trailing,
\t\t\t\t\t\t\t\tchildren: [modelSeat, (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t\t\tclassName: "dsh-er-cancel",
\t\t\t\t\t\t\t\t\t"data-dsh-edit-cancel": true,
\t\t\t\t\t\t\t\t\tonClick: close,
\t\t\t\t\t\t\t\t\tchildren: "取消"
\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
\t\t\t\t\t\t\t\t\tlabel: send.disabled ? sendReason ?? "重新发送" : "重新发送",
\t\t\t\t\t\t\t\t\tside: "top",
\t\t\t\t\t\t\t\t\tdelayMs: 500,
\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.primary,
\t\t\t\t\t\t\t\t\t\t"aria-label": "重新发送",
\t\t\t\t\t\t\t\t\t\tdisabled: send.disabled,
\t\t\t\t\t\t\t\t\t\t"data-dsh-edit-send": true,
\t\t\t\t\t\t\t\t\t\tonClick: onSend,
\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("svg", {
\t\t\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",
\t\t\t\t\t\t\t\t\t\t\twidth: "16",
\t\t\t\t\t\t\t\t\t\t\theight: "16",
\t\t\t\t\t\t\t\t\t\t\t"aria-hidden": true,
\t\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {
\t\t\t\t\t\t\t\t\t\t\t\td: "M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z",
\t\t\t\t\t\t\t\t\t\t\t\tfill: "currentColor"
\t\t\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t})]
\t\t\t\t\t\t\t})]
\t\t\t\t\t\t})
\t\t\t\t\t]
\t\t\t\t}), (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\tclassName: "dsh-er-foot",
\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\tclassName: "dsh-er-note",
\t\t\t\t\t\t"data-dsh-edit-branch-note": true,
\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("i", {
\t\t\t\t\t\t\t"aria-hidden": true,
\t\t\t\t\t\t\tchildren: "⚠"
\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tchildren: "发送后将从这条消息之前的状态创建新分支；Sandbox 执行、外部网站与远端提交等副作用不会被撤销。"
\t\t\t\t\t\t})]
  \t\t\t\t\t}), storeWarnings.length === 0 ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: "dsh-er-block",
\t\t\t\t\t\trole: "status",
  \t\t\t\t\t\tchildren: "有历史分支记录无法读取，原文件已保留；当前消息仍可继续编辑重发。"
  \t\t\t\t\t}), effects.length === 0 ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\tclassName: "dsh-er-effects",
\t\t\t\t\t\t\t"aria-expanded": effectsOpen,
\t\t\t\t\t\t\tonClick: () => {
\t\t\t\t\t\t\t\tsetEffectsOpen((value) => !value);
\t\t\t\t\t\t\t},
\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\tclassName: "dsh-er-chev",
\t\t\t\t\t\t\t\t"aria-hidden": true
\t\t\t\t\t\t\t}), "不会被撤销的外部副作用（" + effects.length + "）"]
\t\t\t\t\t\t}), effectsOpen ? (0, react_jsx_runtime.jsx)("ul", {
\t\t\t\t\t\t\tclassName: "dsh-er-efflist",
\t\t\t\t\t\t\tchildren: effects.map((effect, index) => (0, react_jsx_runtime.jsxs)("li", {
\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("em", { children: effect.label }), effect.detail === void 0 ? null : " · " + effect.detail]
\t\t\t\t\t\t\t}, effect.label + ":" + index))
\t\t\t\t\t\t}) : null]
\t\t\t\t\t}), send.reason !== "backend" ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: "dsh-er-block",
\t\t\t\t\t\t"data-dsh-edit-capability": "absent",
\t\t\t\t\t\tchildren: "重发接口尚未接入：可以编辑与取消，发送要等后端分支能力就绪。"
\t\t\t\t\t}), rejected.length === 0 ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: "dsh-er-block",
\t\t\t\t\t\tchildren: rejected.map((row) => row.name + (row.reason === "size" ? "（超出大小上限）" : "（不支持的类型）")).join("、") + " 未加入"
\t\t\t\t\t}), failure === null ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: "dsh-er-error",
\t\t\t\t\t\trole: "alert",
\t\t\t\t\t\tchildren: "重新发送失败：" + failure
\t\t\t\t\t})]
\t\t\t\t})]
\t\t\t});
\t\t}
`;

/**
 * 编辑上一条用户消息的展示外壳（G3）。
 *
 * 必须在 `patchConversationActivityPresentationSource` 与 G1 的
 * `patchActivityTrackFrontendSource` 之后执行也无妨：三处锚点互不重叠，
 * 全部取自干净基线 `0.1.0-rc.6-oauth`：
 *
 * 1. `InputBar` 函数签名行 —— 在其前注入总线、样式、纯逻辑与编辑器组件；
 * 2. `const permissions = useProjection("permissions");` —— 在其后让 InputBar
 *    把真实的 `renderSlot` 与 `command` 发布到总线；
 * 3. `UserMessageNodeView` 整个组件 —— 加铅笔按钮，并在编辑态原地替换气泡。
 * @param source - `dsh-client-ui-conversation/lib/client.js` 源码。
 * @returns 追加了编辑重发外壳的源码。
 */
export function patchEditResendShellSource(source) {
  assertNotAlreadyPatched(source, "function DshEditResendShell(", "编辑重发外壳");
  let result = replaceExactlyOnce(
    source,
    "\t\tfunction InputBar({ useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages, resolveSubmitMode, toggleCommandMenu, stop, command, t, renderSlot, useNotices, useLexicon, useMenuLauncher, useProjection, sessionId, variant, disabled: inert = false, blocked, workspacePickerOpen = false, onRequestWorkspace, placeholder, accessory, overlay, leftItems, rightItems, footer }) {",
    `${EDIT_RESEND_RUNTIME_SOURCE}\t\tfunction InputBar({ useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages, resolveSubmitMode, toggleCommandMenu, stop, command, t, renderSlot, useNotices, useLexicon, useMenuLauncher, useProjection, sessionId, variant, disabled: inert = false, blocked, workspacePickerOpen = false, onRequestWorkspace, placeholder, accessory, overlay, leftItems, rightItems, footer }) {`,
    "编辑重发外壳运行时",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst permissions = useProjection("permissions");
\t\t\tconst continuable = subagent?.address.mode === "continuable";`,
    `\t\t\tconst permissions = useProjection("permissions");
\t\t\tconst dshEditFace = (0, react.useMemo)(() => ({
\t\t\t\trenderSlot,
\t\t\t\tcommand
\t\t\t}), [command, renderSlot]);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tif (variant === "hero") return;
  \t\t\t\tDSH_EDIT_BUS.publishFace(sessionId, dshEditFace);
\t\t\t\treturn () => {
  \t\t\t\t\tDSH_EDIT_BUS.retractFace(sessionId, dshEditFace);
\t\t\t\t};
  \t\t\t}, [dshEditFace, sessionId, variant]);
\t\t\tconst continuable = subagent?.address.mode === "continuable";`,
    "主输入框发布编辑器控件通道",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst attachments = (0, react.useMemo)(() => input === void 0 || draftImages === void 0 ? [] : draftImages(input.imageIds), [draftImages, input?.imageIds]);
\t\t\tconst empty = draft.trim() === "" && attachments.length === 0;`,
    `\t\t\tconst attachments = (0, react.useMemo)(() => input === void 0 || draftImages === void 0 ? [] : draftImages(input.imageIds), [draftImages, input?.imageIds]);
\t\t\tconst [dshComposerFileState, setDshComposerFileState] = (0, react.useState)(() => ({
\t\t\t\tsessionId,
\t\t\t\tfiles: DSH_COMPOSER_FILE_DRAFTS.get(sessionId) ?? []
\t\t\t}));
\t\t\tconst dshDraftFiles = dshComposerFileState.sessionId === sessionId ? dshComposerFileState.files : DSH_COMPOSER_FILE_DRAFTS.get(sessionId) ?? [];
\t\t\tconst dshUpdateDraftFiles = (0, react.useCallback)((updater) => {
\t\t\t\tsetDshComposerFileState((state) => {
\t\t\t\t\tconst current = state.sessionId === sessionId ? state.files : DSH_COMPOSER_FILE_DRAFTS.get(sessionId) ?? [];
\t\t\t\t\tconst next = typeof updater === "function" ? updater(current) : updater;
\t\t\t\t\tif (next.length === 0) DSH_COMPOSER_FILE_DRAFTS.delete(sessionId);
\t\t\t\t\telse DSH_COMPOSER_FILE_DRAFTS.set(sessionId, next);
\t\t\t\t\treturn {
\t\t\t\t\t\tsessionId,
\t\t\t\t\t\tfiles: next
\t\t\t\t\t};
\t\t\t\t});
\t\t\t}, [sessionId]);
\t\t\tconst [dshFileSubmitting, setDshFileSubmitting] = (0, react.useState)(false);
\t\t\tconst dshFileSubmitDraftRef = (0, react.useRef)(null);
\t\t\tconst dshFileSubmitSeenRef = (0, react.useRef)(false);
\t\t\tconst empty = draft.trim() === "" && attachments.length === 0 && dshDraftFiles.length === 0;`,
    "普通输入框文件草稿状态",
  );
  result = replaceExactlyOnce(
    result,
    "\t\t\tconst inputRef = (0, react.useRef)(null);",
    `\t\t\tconst inputRef = (0, react.useRef)(null);
\t\t\tconst dshFileInputRef = (0, react.useRef)(null);`,
    "普通输入框文件选择引用",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst imageLimits = useProjection("imageLimits");
\t\t\t(0, react.useEffect)(() => {`,
    `\t\t\tconst imageLimits = useProjection("imageLimits");
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tsetDshFileSubmitting(false);
\t\t\t\tdshFileSubmitDraftRef.current = null;
\t\t\t\tdshFileSubmitSeenRef.current = false;
\t\t\t}, [sessionId]);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tif (!dshFileSubmitting) return;
\t\t\t\tconst currentDraft = input?.draft ?? "";
\t\t\t\tconst pendingDraft = dshFileSubmitDraftRef.current;
\t\t\t\tif (typeof pendingDraft === "string" && currentDraft === pendingDraft) dshFileSubmitSeenRef.current = true;
\t\t\t\tif (dshFileSubmitSeenRef.current && currentDraft.trim() === "") {
\t\t\t\t\tdshUpdateDraftFiles([]);
\t\t\t\t\tsetDshFileSubmitting(false);
\t\t\t\t\tdshFileSubmitDraftRef.current = null;
\t\t\t\t\tdshFileSubmitSeenRef.current = false;
\t\t\t\t}
\t\t\t}, [dshFileSubmitting, dshUpdateDraftFiles, input?.draft]);
\t\t\t(0, react.useEffect)(() => {`,
    "普通输入框文件发送后清理",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\tif (files.length > 0) intakeImages(files);`,
    `\t\t\t\tif (files.length > 0) dshIntakeComposerFiles(files);`,
    "普通输入框粘贴普通文件",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst canAcceptDrop = !locked && !machineBusy && addImages !== void 0;`,
    `\t\t\tconst dshIntakeComposerFiles = (0, react.useCallback)((files) => {
\t\t\t\tconst outcome = dshEditIntakeFiles(files, imageLimits);
\t\t\t\tif (outcome.rejected.length > 0) {
\t\t\t\t\tshowToast(outcome.rejected.map((row) => row.name + (row.reason === "size" ? "（超出大小上限）" : "（不支持的类型）")).join("、") + " 未加入");
\t\t\t\t}
\t\t\t\tconst imageFiles = [];
\t\t\t\tconst normalFiles = [];
\t\t\t\tfor (const file of outcome.accepted) {
\t\t\t\t\tconst type = typeof file?.type === "string" ? file.type : "";
\t\t\t\t\tif (type.startsWith("image/") && addImages !== void 0) imageFiles.push(file);
\t\t\t\t\telse normalFiles.push(file);
\t\t\t\t}
\t\t\t\tif (imageFiles.length > 0) intakeImages(imageFiles);
\t\t\t\tif (normalFiles.length > 0) {
\t\t\t\t\tdshUpdateDraftFiles((previous) => [...previous, ...normalFiles.map((file, index) => ({
\t\t\t\t\t\tkey: "composer:" + Date.now() + ":" + Math.random().toString(36).slice(2) + ":" + index,
\t\t\t\t\t\tfile,
\t\t\t\t\t\tname: typeof file?.name === "string" && file.name !== "" ? file.name : "未命名文件"
\t\t\t\t\t}))]);
\t\t\t\t}
\t\t\t\treturn outcome.accepted.length > 0;
\t\t\t}, [addImages, dshUpdateDraftFiles, imageLimits, intakeImages, showToast]);
\t\t\tconst dshDropComposerFile = (0, react.useCallback)((key) => {
\t\t\t\tdshUpdateDraftFiles((previous) => previous.filter((item) => item.key !== key));
\t\t\t}, [dshUpdateDraftFiles]);
\t\t\tconst dshSubmitWithFiles = (0, react.useCallback)(async (mode) => {
\t\t\t\tif (keyboard === void 0 || dshFileSubmitting) return;
\t\t\t\tif (dshDraftFiles.length === 0) {
\t\t\t\t\tkeyboard.submit(mode);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tsetDshFileSubmitting(true);
\t\t\t\ttry {
\t\t\t\t\tconst manifest = await dshComposerFileManifest(dshDraftFiles);
\t\t\t\t\tconst nextDraft = dshComposerMergeFileManifest(input?.draft ?? draft, manifest);
\t\t\t\t\tdshFileSubmitDraftRef.current = nextDraft;
\t\t\t\t\tdshFileSubmitSeenRef.current = false;
\t\t\t\t\tkeyboard.setDraft(nextDraft);
\t\t\t\t\tif (typeof keyboard.track === "function") keyboard.track(nextDraft, nextDraft.length);
\t\t\t\t\twindow.setTimeout(() => {
\t\t\t\t\t\tkeyboard.submit(mode);
\t\t\t\t\t}, 0);
\t\t\t\t\twindow.setTimeout(() => {
\t\t\t\t\t\tsetDshFileSubmitting(false);
\t\t\t\t\t}, 4000);
\t\t\t\t} catch (error) {
\t\t\t\t\tsetDshFileSubmitting(false);
\t\t\t\t\tshowToast("文件读取失败：" + (error instanceof Error ? error.message : String(error)));
\t\t\t\t}
\t\t\t}, [draft, dshDraftFiles, dshFileSubmitting, input?.draft, keyboard, showToast]);
\t\t\tconst canAcceptDrop = !locked && !machineBusy;`,
    "普通输入框普通文件入口逻辑",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\tintakeImages([...event.dataTransfer?.files ?? []]);`,
    `\t\t\t\t\tdshIntakeComposerFiles([...event.dataTransfer?.files ?? []]);`,
    "普通输入框拖拽普通文件",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t}, [canAcceptDrop, intakeImages]);`,
    `\t\t\t}, [canAcceptDrop, dshIntakeComposerFiles]);`,
    "普通输入框拖拽依赖普通文件",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\tkeyboard.submit(resolveSubmitMode(running, accelerated ? "accelerated" : "enter", subagent === null));`,
    `\t\t\t\tvoid dshSubmitWithFiles(resolveSubmitMode(running, accelerated ? "accelerated" : "enter", subagent === null));`,
    "普通输入框回车发送普通文件",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\tif (!empty && !disabled && !machineBusy) inputActions.submit();`,
    `\t\t\t\tif (!empty && !disabled && !machineBusy) void dshSubmitWithFiles("queue");`,
    "普通输入框按钮发送普通文件",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\trailItems.length > 0 && (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.attachments,
\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_attachment.AttachmentRail, {
\t\t\t\t\t\t\t\t\titems: railItems,
\t\t\t\t\t\t\t\t\tlabels: attachmentRailLabels(t),
\t\t\t\t\t\t\t\t\tonOpen: (item) => {
\t\t\t\t\t\t\t\t\t\tsetPreview(item.attachment);
\t\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t\t\tonRemove: (item) => {
\t\t\t\t\t\t\t\t\t\tremoveImage?.(item.attachment.id);
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t}),`,
    `\t\t\t\t\t\t\trailItems.length > 0 && (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.attachments,
\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_attachment.AttachmentRail, {
\t\t\t\t\t\t\t\t\titems: railItems,
\t\t\t\t\t\t\t\t\tlabels: attachmentRailLabels(t),
\t\t\t\t\t\t\t\t\tonOpen: (item) => {
\t\t\t\t\t\t\t\t\t\tsetPreview(item.attachment);
\t\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t\t\tonRemove: (item) => {
\t\t\t\t\t\t\t\t\t\tremoveImage?.(item.attachment.id);
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\tdshDraftFiles.length > 0 && (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\tclassName: "dsh-compose-file-chips",
\t\t\t\t\t\t\t\t"data-dsh-input-file-chips": true,
\t\t\t\t\t\t\t\tchildren: dshDraftFiles.map((item) => (0, react_jsx_runtime.jsx)(DshEditChip, {
\t\t\t\t\t\t\t\t\titem,
\t\t\t\t\t\t\t\t\tonRemove: dshFileSubmitting ? void 0 : dshDropComposerFile
\t\t\t\t\t\t\t\t}, item.key))
\t\t\t\t\t\t\t}),`,
    "普通输入框普通文件 chip",
  );
  const inputToolRowIndent = "\t".repeat(10);
  const inputFileButtonAnchor = [
    `${inputToolRowIndent}}),`,
    `${inputToolRowIndent}(0, react_jsx_runtime.jsxs)("div", {`,
    `${inputToolRowIndent}\tclassName: InputBar_module_css_default.modes,`,
  ].join("\n");
  const inputFileButtonSource = [
    `${inputToolRowIndent}(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {`,
    `${inputToolRowIndent}\tlabel: "文件",`,
    `${inputToolRowIndent}\tside: "top",`,
    `${inputToolRowIndent}\tdelayMs: 500,`,
    `${inputToolRowIndent}\tchildren: (0, react_jsx_runtime.jsxs)("span", {`,
    `${inputToolRowIndent}\t\tchildren: [(0, react_jsx_runtime.jsx)("input", {`,
    `${inputToolRowIndent}\t\t\tref: dshFileInputRef,`,
    `${inputToolRowIndent}\t\t\ttype: "file",`,
    `${inputToolRowIndent}\t\t\tmultiple: true,`,
    `${inputToolRowIndent}\t\t\tstyle: { display: "none" },`,
    `${inputToolRowIndent}\t\t\t"data-dsh-input-file-input": true,`,
    `${inputToolRowIndent}\t\t\tonChange: (event) => {`,
    `${inputToolRowIndent}\t\t\t\tdshIntakeComposerFiles(event.target.files);`,
    `${inputToolRowIndent}\t\t\t\tevent.target.value = "";`,
    `${inputToolRowIndent}\t\t\t}`,
    `${inputToolRowIndent}\t\t}), (0, react_jsx_runtime.jsx)("button", {`,
    `${inputToolRowIndent}\t\t\ttype: "button",`,
    `${inputToolRowIndent}\t\t\tclassName: InputBar_module_css_default.add,`,
    `${inputToolRowIndent}\t\t\t"aria-label": "文件",`,
    `${inputToolRowIndent}\t\t\t"data-dsh-input-file-button": true,`,
    `${inputToolRowIndent}\t\t\t"data-busy": dshFileSubmitting ? "true" : "false",`,
    `${inputToolRowIndent}\t\t\tdisabled: locked || machineBusy || dshFileSubmitting,`,
    `${inputToolRowIndent}\t\t\tonMouseDown: keepFocus,`,
    `${inputToolRowIndent}\t\t\tonClick: () => dshFileInputRef.current?.click(),`,
    `${inputToolRowIndent}\t\t\tchildren: (0, react_jsx_runtime.jsx)("svg", {`,
    `${inputToolRowIndent}\t\t\t\tviewBox: "0 0 16 16",`,
    `${inputToolRowIndent}\t\t\t\twidth: "16",`,
    `${inputToolRowIndent}\t\t\t\theight: "16",`,
    `${inputToolRowIndent}\t\t\t\t"aria-hidden": true,`,
    `${inputToolRowIndent}\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", { d: "M1.5 4.25A1.75 1.75 0 0 1 3.25 2.5h3l1.25 1.5h5.25a1.75 1.75 0 0 1 1.75 1.75v6A1.75 1.75 0 0 1 12.75 13.5h-9.5A1.75 1.75 0 0 1 1.5 11.75v-7.5Zm1.75-.5a.5.5 0 0 0-.5.5v7.5c0 .276.224.5.5.5h9.5a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5H6.914l-1.25-1.5H3.25Z", fill: "currentColor" })`,
    `${inputToolRowIndent}\t\t\t})`,
    `${inputToolRowIndent}\t\t})]`,
    `${inputToolRowIndent}\t})`,
    `${inputToolRowIndent}}),`,
  ].join("\n");
  result = replaceExactlyOnce(
    result,
    inputFileButtonAnchor,
    [
      `${inputToolRowIndent}}),`,
      inputFileButtonSource,
      `${inputToolRowIndent}(0, react_jsx_runtime.jsxs)("div", {`,
      `${inputToolRowIndent}\tclassName: InputBar_module_css_default.modes,`,
    ].join("\n"),
    "普通输入框文件按钮",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\t\tdisabled: primaryStops ? stop === void 0 : empty || disabled || machineBusy,`,
    `\t\t\t\t\t\t\t\tdisabled: primaryStops ? stop === void 0 : empty || disabled || machineBusy || dshFileSubmitting,`,
    "普通输入框文件发送期间禁用主按钮",
  );
  result = replaceExactlyOnce(
    result,
    "\t\tconst ChatNodeSeat = (0, react.memo)(function ChatNodeSeat({ nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, loadImage, fileMentions, useSession, renderSlot, t }) {",
    "\t\tconst ChatNodeSeat = (0, react.memo)(function ChatNodeSeat({ nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, loadImage, fileMentions, editResend, useSession, renderSlot, t }) {",
    "编辑重发能力进入聊天节点",
  );
  const nodeOwnerAnchor = [
    "\t\t\t\tloadImage,",
    "\t\t\t\tfileMentions",
    "\t\t\t}, [",
    "\t\t\t\tnode,",
  ].join("\n");
  result = replaceExactlyOnce(
    result,
    nodeOwnerAnchor,
    [
      "\t\t\t\tloadImage,",
      "\t\t\t\tfileMentions,",
      "\t\t\t\teditResend",
      "\t\t\t}, [",
      "\t\t\t\tnode,",
    ].join("\n"),
    "编辑重发能力进入节点 owner",
  );
  result = replaceExactlyOnce(
    result,
    [
      "\t\t\t\tloadImage,",
      "\t\t\t\tfileMentions",
      "\t\t\t]);",
    ].join("\n"),
    [
      "\t\t\t\tloadImage,",
      "\t\t\t\tfileMentions,",
      "\t\t\t\teditResend",
      "\t\t\t]);",
    ].join("\n"),
    "编辑重发 owner 依赖",
  );
  const chatViewWithProjection = "\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, useProjection, t }) {";
  const chatViewBaseline = "\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {";
  const chatViewSource = result.includes(chatViewWithProjection) ? chatViewWithProjection : chatViewBaseline;
  result = replaceExactlyOnce(
    result,
    chatViewSource,
    chatViewSource.replace(", t }) {", ", editResend, t }) {"),
    "编辑重发能力进入聊天视图",
  );
  result = replaceExactlyOnce(
    result,
    `${chatViewSource.replace(", t }) {", ", editResend, t }) {")}
\t\t\tconst order = useSession((s) => s.chat.order);
\t\t\tconst nodeStore = useSession((s) => s.chat.nodes);`,
    `${chatViewSource.replace(", t }) {", ", editResend, t }) {")}
\t\t\tconst rawOrder = useSession((s) => s.chat.order);
\t\t\tconst sessionEvents = useSession((s) => s.events ?? []);
\t\t\tconst nodeStore = useSession((s) => s.chat.nodes);
\t\t\tconst editReplacementRanges = (0, react.useMemo)(() => sessionEvents.flatMap((event) => {
\t\t\t\tif (event.type !== "user/message" || !(0, _deepseek_ai_dsh_client_runtime_client.isReplacementSurfaceEvent)(event) || event.data.source.kind !== "user") return [];
\t\t\t\tconst op = event.surfaceOp;
\t\t\t\tif (typeof op !== "object" || op === null || op.op !== "replace") return [];
\t\t\t\treturn [{ start: op.start, end: event.seq - 1 }];
\t\t\t}), [sessionEvents]);
\t\t\tconst order = (0, react.useMemo)(() => rawOrder.filter((key) => {
\t\t\t\tconst anchorSeq = nodeStore.get(key)?.anchorSeq;
\t\t\t\treturn typeof anchorSeq !== "number" || !editReplacementRanges.some((range) => range.start <= anchorSeq && anchorSeq <= range.end);
\t\t\t}), [editReplacementRanges, nodeStore, rawOrder]);`,
    "编辑重发按替换范围重建可见聊天表面",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tmatch: (event) => event.type === "user/message" && (0, _deepseek_ai_dsh_client_runtime_client.isAppendSurfaceEvent)(event) && !isCompactionCheckpoint(event) ? {`,
    `\t\t\tmatch: (event) => event.type === "user/message" && (((0, _deepseek_ai_dsh_client_runtime_client.isAppendSurfaceEvent)(event) && !isCompactionCheckpoint(event)) || ((0, _deepseek_ai_dsh_client_runtime_client.isReplacementSurfaceEvent)(event) && event.data.source.kind === "user")) ? {`,
    "编辑重发用户消息进入聊天投影",
  );
  const baselineNodeDelivery = [
    "\t\t\t\t\t\t\t\tloadImage,",
    "\t\t\t\t\t\t\t\tfileMentions,",
    "\t\t\t\t\t\t\t\trenderSlot,",
  ].join("\n");
  const groupedNodeDelivery = [
    "\t\t\t\t\t\t\t\t\tloadImage,",
    "\t\t\t\t\t\t\t\t\tfileMentions,",
    "\t\t\t\t\t\t\t\t\trenderSlot,",
  ].join("\n");
  const nodeDelivery = result.includes(groupedNodeDelivery) ? groupedNodeDelivery : baselineNodeDelivery;
  result = replaceExactlyOnce(
    result,
    nodeDelivery,
    nodeDelivery.replace("fileMentions,\n", "fileMentions,\n" + nodeDelivery.match(/^\t+/u)[0] + "editResend,\n"),
    "编辑重发能力传入消息节点",
  );
  result = replaceExactlyOnce(
    result,
    [
      "\t\t\t\t\t\tloadImage: (attachment) => conversation.resolveImage(sessionId, attachment),",
      "\t\t\t\t\t\tinspectCall: (callId) => {",
    ].join("\n"),
    [
      "\t\t\t\t\t\tloadImage: (attachment) => conversation.resolveImage(sessionId, attachment),",
      "\t\t\t\t\t\teditResend: dshEditResendClient(sessions, sessionId),",
      "\t\t\t\t\t\tinspectCall: (callId) => {",
    ].join("\n"),
    "编辑重发本地接口适配器",
  );
  return replaceExactlyOnce(
    result,
    `\t\tconst UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, loadImage, t }) {
\t\t\tconst data = node.data;
\t\t\treturn (0, react_jsx_runtime.jsx)(UserStyleBubble, {
\t\t\t\tcontent: data.content,
\t\t\t\timageLoader: loadImage,
\t\t\t\tt,
\t\t\t\tactions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
\t\t\t\t\ttext,
\t\t\t\t\ttime: data.time,
\t\t\t\t\tclock: "start",
\t\t\t\t\tclassName: MessageItem_module_css_default.actions,
\t\t\t\t\tt
\t\t\t\t})
\t\t\t});
\t\t});`,
    `\t\tconst UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, loadImage, editResend, useProjection, t }) {
\t\t\tconst data = node.data;
\t\t\tconst sessionId = typeof editResend?.sessionId === "string" ? editResend.sessionId : "";
\t\t\tconst subscribe = (0, react.useCallback)((listener) => DSH_EDIT_BUS.subscribe(sessionId, listener), [sessionId]);
\t\t\tconst readTarget = (0, react.useCallback)(() => DSH_EDIT_BUS.readTarget(sessionId), [sessionId]);
\t\t\tconst editTarget = (0, react.useSyncExternalStore)(subscribe, readTarget);
\t\t\tif (editTarget !== null && editTarget.nodeKey === node.key) return (0, react_jsx_runtime.jsx)(DshEditResendShell, {
\t\t\t\tnode,
\t\t\t\tloadImage,
\t\t\t\teditResend,
\t\t\t\tuseProjection,
\t\t\t\tavailability: editTarget.availability,
\t\t\t\tt
\t\t\t});
\t\t\treturn (0, react_jsx_runtime.jsx)(UserStyleBubble, {
\t\t\t\tcontent: data.content,
\t\t\t\timageLoader: loadImage,
\t\t\t\tt,
\t\t\t\tactions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
\t\t\t\t\ttext,
\t\t\t\t\ttime: data.time,
\t\t\t\t\tclock: "start",
\t\t\t\t\tclassName: MessageItem_module_css_default.actions,
\t\t\t\t\textraActions: (0, react_jsx_runtime.jsx)(DshEditPencil, {
\t\t\t\t\t\tsessionId,
\t\t\t\t\t\tnodeKey: node.key,
\t\t\t\t\t\tseq: data.seq,
\t\t\t\t\t\teditResend
\t\t\t\t\t}),
\t\t\t\t\tt
\t\t\t\t})
\t\t\t});
\t\t});`,
    "用户消息编辑入口",
  );
}
