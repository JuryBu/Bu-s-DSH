import { createHash } from "node:crypto";

import { ThreadCursorError } from "./errors.js";

const CURSOR_PREFIX = "dsh-native-thread-v1";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value) {
  return sha256(stableJson(value)).slice(0, 24);
}

export function encodeCursor(kind, payload) {
  const encoded = Buffer.from(JSON.stringify({ version: 1, kind, payload }), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}.${encoded}.${sha256(encoded).slice(0, 24)}`;
}

export function decodeCursor(cursor, expectedKind) {
  const [prefix, encoded, checksum, extra] = String(cursor || "").split(".");
  if (prefix !== CURSOR_PREFIX || !encoded || !checksum || extra || sha256(encoded).slice(0, 24) !== checksum) {
    throw new ThreadCursorError("线程续读光标的形状或校验值无效");
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ThreadCursorError("线程续读光标不是有效 JSON");
  }
  if (envelope?.version !== 1 || envelope?.kind !== expectedKind || !("payload" in envelope)) {
    throw new ThreadCursorError(`线程续读光标不属于 ${expectedKind}`);
  }
  return envelope.payload;
}

export function normalizeRanges(ranges) {
  if (ranges === undefined || ranges.length === 0) return [];
  const ordered = ranges.map(range => ({ start: Number(range.start), end: Number(range.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const range of ordered) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 || range.end < range.start) {
      throw new RangeError(`轮次范围 ${range.start}-${range.end} 无效`);
    }
  }
  const merged = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1) merged.push(range);
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

export function normalizeRoles(roles) {
  if (roles === undefined) return undefined;
  const allowed = ["system", "user", "assistant", "tool"];
  const result = [...new Set(roles.map(String))].sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right));
  if (result.some(role => !allowed.includes(role))) {
    throw new RangeError("roles 只接受 system、user、assistant、tool；mixed 与 unknown 不能作为精确过滤条件");
  }
  return result;
}

export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

export function normalizeBudget(maxBytes, maxTokens) {
  const requestedMaxBytes = maxBytes ?? 96 * 1024;
  const requestedMaxTokens = maxTokens ?? 24 * 1024;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes <= 0
    || !Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) {
    throw new RangeError("max_bytes 与 max_tokens 必须是正整数");
  }
  return { requestedMaxBytes, requestedMaxTokens };
}

export function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}…`, "utf8") > maxBytes) break;
    result += character;
  }
  return `${result}…`;
}
