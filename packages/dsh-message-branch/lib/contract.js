import { createHash } from "node:crypto";
import path from "node:path";

import { branchError } from "./errors.js";

export const MESSAGE_BRANCH_SCHEMA_VERSION = 2;
export const MESSAGE_BRANCH_STATE_EVENT = "message-branch/state";
export const MESSAGE_BRANCH_SERVICE = "messageBranches";
export const FILE_MANIFEST_MARKER = "【附件清单｜message-branch:v1】";
export const EXTERNAL_EFFECTS_WARNING = "本会话由编辑历史用户消息创建分支。DSH 内部可重放状态已恢复到该消息发送前；Sandbox、MCP、外部 API、远端 Git、网络请求及未纳入系统补丁记录的文件副作用没有撤销，仍可能存在。不得声称它们已回滚；继续操作前如相关应重新核对。";

const imageMediaTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value, field, maxLength = 4096) {
  if (typeof value !== "string" || value.trim() === "") {
    throw branchError("invalid_request", `${field} 必须是非空字符串`, { field });
  }
  if (value.length > maxLength) {
    throw branchError("invalid_request", `${field} 超过长度上限`, { field, maxLength });
  }
  return value;
}

function normalizeImageRef(value) {
  if (!isPlainObject(value)) throw branchError("invalid_attachment", "图片附件引用格式无效");
  const attachmentId = assertNonEmptyString(value.attachmentId, "attachment.attachmentId", 512);
  if (!imageMediaTypes.has(value.mediaType)) {
    throw branchError("invalid_attachment", "图片 mediaType 不受支持", { mediaType: value.mediaType });
  }
  for (const field of ["bytes", "width", "height"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) {
      throw branchError("invalid_attachment", `attachment.${field} 必须是正整数`, { field });
    }
  }
  const normalized = {
    attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
  };
  if (value.name !== undefined) normalized.name = assertNonEmptyString(value.name, "attachment.name", 512);
  return normalized;
}

export function normalizeDraftShape(draft) {
  if (!isPlainObject(draft)) throw branchError("invalid_request", "draft 必须是对象");
  const text = typeof draft.text === "string" ? draft.text : "";
  const images = draft.images === undefined ? [] : draft.images;
  const files = draft.files === undefined ? [] : draft.files;
  if (!Array.isArray(images) || !Array.isArray(files)) {
    throw branchError("invalid_request", "draft.images 和 draft.files 必须是数组");
  }
  if (images.length > 20) throw branchError("invalid_attachment", "单条消息最多 20 张图片");
  if (files.length > 50) throw branchError("invalid_attachment", "单条消息最多 50 个文件");
  if (text.trim() === "" && images.length === 0 && files.length === 0) {
    throw branchError("empty_draft", "编辑后的消息不能为空");
  }
  const order = normalizeDraftOrder(draft.order, { hasText: text.trim() !== "", imageCount: images.length, fileCount: files.length });
  return { text, images: [...images], files: [...files], ...(order === undefined ? {} : { order }) };
}

export function normalizeModelSelection(selection) {
  if (selection === undefined) return undefined;
  if (!isPlainObject(selection)) throw branchError("invalid_request", "modelSelection 必须是对象");
  const normalized = {
    provider: assertNonEmptyString(selection.provider, "modelSelection.provider", 512),
    model: assertNonEmptyString(selection.model, "modelSelection.model", 512),
  };
  if (selection.reasoningEffort !== undefined) {
    normalized.reasoningEffort = assertNonEmptyString(selection.reasoningEffort, "modelSelection.reasoningEffort", 512);
  }
  return normalized;
}

export function normalizeDraftOrder(order, { hasText, imageCount, fileCount }) {
  if (order === undefined) return undefined;
  if (!Array.isArray(order)) throw branchError("invalid_request", "draft.order 必须是数组");
  const normalized = [];
  let placedText = false;
  const placedImages = new Set();
  const placedFiles = new Set();
  const pushText = () => {
    if (placedText) throw branchError("invalid_request", "draft.order 不能重复放置文字");
    placedText = true;
    if (hasText) normalized.push({ type: "text" });
  };
  const pushIndexed = (type, index, count, seen) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
      throw branchError("invalid_request", `draft.order ${type} 索引越界`, { type, index });
    }
    if (seen.has(index)) throw branchError("invalid_request", `draft.order 不能重复放置 ${type}`, { type, index });
    seen.add(index);
    normalized.push({ type, index });
  };
  for (const item of order) {
    if (!isPlainObject(item)) throw branchError("invalid_request", "draft.order 条目必须是对象");
    const type = item.type ?? item.kind;
    if (type === "text") pushText();
    else if (type === "image") pushIndexed("image", item.index, imageCount, placedImages);
    else if (type === "file") pushIndexed("file", item.index, fileCount, placedFiles);
    else throw branchError("invalid_request", "draft.order 条目类型无效", { type });
  }
  if (hasText && !placedText) normalized.push({ type: "text" });
  for (let index = 0; index < imageCount; index += 1) {
    if (!placedImages.has(index)) normalized.push({ type: "image", index });
  }
  for (let index = 0; index < fileCount; index += 1) {
    if (!placedFiles.has(index)) normalized.push({ type: "file", index });
  }
  return normalized;
}

export function normalizeInlineImage(image) {
  if (!isPlainObject(image)) throw branchError("invalid_attachment", "图片附件格式无效");
  if (image.attachment !== undefined) {
    if (image.dataBase64 !== undefined) throw branchError("invalid_attachment", "图片不能同时提供 attachment 与 dataBase64");
    return { kind: "reference", attachment: normalizeImageRef(image.attachment) };
  }
  const dataBase64 = assertNonEmptyString(image.dataBase64, "image.dataBase64", 64 * 1024 * 1024);
  if (!imageMediaTypes.has(image.mediaType)) {
    throw branchError("invalid_attachment", "图片 mediaType 不受支持", { mediaType: image.mediaType });
  }
  const normalized = { kind: "inline", dataBase64, mediaType: image.mediaType };
  if (image.name !== undefined) normalized.name = assertNonEmptyString(image.name, "image.name", 512);
  return normalized;
}

export function normalizeFileDescriptor(file, cwd) {
  if (!isPlainObject(file)) throw branchError("invalid_attachment", "文件附件格式无效");
  const name = assertNonEmptyString(file.name, "file.name", 512);
  if (path.basename(name) !== name) throw branchError("invalid_attachment", "file.name 只能是文件名，不能包含路径", { name });
  const normalized = { name };
  if (file.mediaType !== undefined) normalized.mediaType = assertNonEmptyString(file.mediaType, "file.mediaType", 255);
  if (file.bytes !== undefined) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw branchError("invalid_attachment", "file.bytes 必须是非负整数");
    normalized.bytes = file.bytes;
  }
  if (file.workspacePath !== undefined) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
      throw branchError("workspace_unavailable", "源会话没有可验证的绝对工作区路径");
    }
    if (typeof file.workspacePath !== "string" || !path.isAbsolute(file.workspacePath)) {
      throw branchError("invalid_attachment", "file.workspacePath 必须是绝对路径");
    }
    const resolvedCwd = path.resolve(cwd);
    const resolvedFile = path.resolve(file.workspacePath);
    const relative = path.relative(resolvedCwd, resolvedFile);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw branchError("attachment_outside_workspace", "文件附件必须位于源会话工作区内", { workspacePath: resolvedFile });
    }
    normalized.workspacePath = resolvedFile;
  }
  if (file.attachmentRef !== undefined) {
    normalized.attachmentRef = assertNonEmptyString(file.attachmentRef, "file.attachmentRef", 2048);
  }
  if (normalized.workspacePath === undefined && normalized.attachmentRef === undefined) {
    throw branchError("invalid_attachment", "文件必须提供 workspacePath 或 attachmentRef");
  }
  return normalized;
}

export function normalizeInlineFile(file, cwd) {
  if (!isPlainObject(file)) throw branchError("invalid_attachment", "文件附件格式无效");
  if (file.dataBase64 === undefined) return { kind: "reference", file: normalizeFileDescriptor(file, cwd) };
  if (file.workspacePath !== undefined || file.attachmentRef !== undefined) {
    throw branchError("invalid_attachment", "文件不能同时提供 dataBase64 与已有引用");
  }
  const name = assertNonEmptyString(file.name, "file.name", 512);
  if (path.basename(name) !== name) throw branchError("invalid_attachment", "file.name 只能是文件名，不能包含路径", { name });
  const dataBase64 = assertNonEmptyString(file.dataBase64, "file.dataBase64", 24 * 1024 * 1024);
  const mediaType = file.mediaType === undefined ? "application/octet-stream" : assertNonEmptyString(file.mediaType, "file.mediaType", 255);
  return { kind: "inline", name, mediaType, dataBase64 };
}

export function findLastRealUserMessage(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "user/message" && event.data?.source?.kind === "user") return event;
  }
  return undefined;
}

export function findRealUserMessage(events, selector = {}) {
  const messageId = typeof selector.messageId === "string" && selector.messageId !== "" ? selector.messageId : undefined;
  const sourceEventSeq = Number.isSafeInteger(selector.sourceEventSeq) && selector.sourceEventSeq >= 0
    ? selector.sourceEventSeq
    : undefined;
  if (messageId === undefined && sourceEventSeq === undefined) return findLastRealUserMessage(events);
  return events.find(event => event?.type === "user/message"
    && event.data?.source?.kind === "user"
    && (messageId === undefined || event.data?.id === messageId)
    && (sourceEventSeq === undefined || event.seq === sourceEventSeq));
}

export function locateBranchPoint(events, messageEvent) {
  if (!messageEvent) throw branchError("no_real_user_message", "会话中没有可编辑的真人用户消息");
  const messageIndex = events.findIndex(event => event === messageEvent
    || (event?.type === "user/message" && event.seq === messageEvent.seq && event.data?.id === messageEvent.data?.id));
  if (messageIndex < 0) throw branchError("invalid_session_log", "目标用户消息不在当前会话日志中");
  for (let index = messageIndex; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn/start") {
      return {
        sourceTurn: event.data.turn,
        branchPointSeq: event.seq,
        seed: events.slice(0, index),
      };
    }
  }
  throw branchError("invalid_session_log", "目标用户消息没有对应的 turn/start", { sourceEventSeq: messageEvent.seq });
}

export function locatePendingBranchPoint(events, turn) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "turn/start") continue;
    if (turn !== undefined && event.data?.turn !== turn) continue;
    return {
      sourceTurn: event.data?.turn,
      branchPointSeq: event.seq,
      seed: events.slice(0, index),
    };
  }
  throw branchError("invalid_session_log", "真人消息进入前没有对应的 turn/start");
}

export function requestDigest(request) {
  const canonical = JSON.stringify({
    sessionId: request.sessionId,
    expectedSourceMessageId: request.expectedSourceMessageId,
    sourceEventSeq: request.sourceEventSeq,
    draft: request.draft,
    modelSelection: request.modelSelection,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function fileManifestText(files) {
  if (files.length === 0) return undefined;
  const lines = [FILE_MANIFEST_MARKER, "以下文件附件来自本次用户输入，按当前路径或宿主引用读取；创建消息分支不会撤销对这些文件的外部修改："];
  for (const file of files) {
    const facts = [`名称=${JSON.stringify(file.name)}`];
    if (file.mediaType !== undefined) facts.push(`类型=${JSON.stringify(file.mediaType)}`);
    if (file.bytes !== undefined) facts.push(`字节=${file.bytes}`);
    if (file.workspacePath !== undefined) facts.push(`工作区路径=${JSON.stringify(file.workspacePath)}`);
    if (file.attachmentRef !== undefined) facts.push(`宿主引用=${JSON.stringify(file.attachmentRef)}`);
    lines.push(`- ${facts.join("；")}`);
  }
  return lines.join("\n");
}

export function extractDraftFromMessage(message, files = []) {
  const texts = [];
  const images = [];
  const order = [];
  let placedText = false;
  let placedFiles = false;
  for (const block of message.content) {
    if (block?.type === "image") {
      order.push({ type: "image", index: images.length });
      images.push({ attachment: block.attachment });
      continue;
    }
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    if (block.text.startsWith(FILE_MANIFEST_MARKER)) {
      if (!placedFiles) {
        for (let index = 0; index < files.length; index += 1) order.push({ type: "file", index });
        placedFiles = true;
      }
      continue;
    }
    texts.push(block.text);
    if (!placedText) {
      order.push({ type: "text" });
      placedText = true;
    }
  }
  return { text: texts.join("\n\n"), images, files, order };
}
