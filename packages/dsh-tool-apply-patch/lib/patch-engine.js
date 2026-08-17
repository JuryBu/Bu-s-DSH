function normalizeText(value) {
  return String(value).replace(/\r\n?/gu, "\n");
}

function readPath(line, prefix) {
  const value = line.slice(prefix.length).trim();
  if (!value) throw new Error(`${prefix.trim()} 后缺少文件路径`);
  if (value.includes("\0")) throw new Error("文件路径不能包含 NUL 字符");
  return value;
}

function parseAdd(lines, cursor, path) {
  const content = [];
  while (cursor < lines.length && !lines[cursor].startsWith("*** ")) {
    const line = lines[cursor];
    if (!line.startsWith("+")) throw new Error(`新增文件 ${path} 的每一行都必须以 + 开头`);
    content.push(line.slice(1));
    cursor += 1;
  }
  return {
    operation: { kind: "add", path, content: content.length === 0 ? "" : `${content.join("\n")}\n` },
    cursor,
  };
}

function parseUpdate(lines, cursor, path) {
  const hunks = [];
  while (cursor < lines.length && !lines[cursor].startsWith("*** ")) {
    const marker = lines[cursor];
    if (!marker.startsWith("@@")) throw new Error(`更新文件 ${path} 时缺少 @@ 分块标记`);
    cursor += 1;
    const hunkLines = [];
    while (cursor < lines.length && !lines[cursor].startsWith("@@") && !lines[cursor].startsWith("*** ")) {
      const line = lines[cursor];
      if (!line || ![" ", "+", "-"].includes(line[0])) {
        throw new Error(`更新文件 ${path} 的补丁行必须以空格、+ 或 - 开头`);
      }
      hunkLines.push({ marker: line[0], text: line.slice(1) });
      cursor += 1;
    }
    if (hunkLines.length === 0) throw new Error(`更新文件 ${path} 存在空补丁块`);
    hunks.push(hunkLines);
  }
  if (hunks.length === 0) throw new Error(`更新文件 ${path} 没有可应用的补丁块`);
  return { operation: { kind: "update", path, hunks }, cursor };
}

export function parsePatch(patchText) {
  if (typeof patchText !== "string" || patchText.trim().length === 0) throw new Error("patch 必须是非空字符串");
  const lines = normalizeText(patchText).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("patch 必须使用 *** Begin Patch / *** End Patch 包裹");
  }

  const operations = [];
  const paths = new Set();
  let addCount = 0;
  let cursor = 1;
  while (cursor < lines.length - 1) {
    const header = lines[cursor];
    let parsed;
    if (header.startsWith("*** Add File: ")) {
      const path = readPath(header, "*** Add File: ");
      parsed = parseAdd(lines, cursor + 1, path);
      addCount += 1;
    } else if (header.startsWith("*** Update File: ")) {
      const path = readPath(header, "*** Update File: ");
      parsed = parseUpdate(lines, cursor + 1, path);
    } else if (header.startsWith("*** Delete File: ")) {
      throw new Error("当前 DSH 文件系统没有安全删除接口，apply_patch 拒绝 Delete File；请保留文件或改为空文件");
    } else {
      throw new Error(`无法识别的补丁头：${header}`);
    }
    if (paths.has(parsed.operation.path)) throw new Error(`同一补丁不能重复声明文件：${parsed.operation.path}`);
    paths.add(parsed.operation.path);
    operations.push(parsed.operation);
    cursor = parsed.cursor;
  }
  if (operations.length === 0) throw new Error("patch 没有文件操作");
  if (addCount > 1) {
    throw new Error("为保证失败时不留下半套新增文件，一份原子补丁最多新增一个文件");
  }
  return operations;
}

function matchingPositions(lines, expected, start) {
  if (expected.length === 0) return [start];
  const positions = [];
  for (let index = start; index <= lines.length - expected.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (lines[index + offset] !== expected[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) positions.push(index);
  }
  return positions;
}

export function applyUpdate(content, hunks, path = "<unknown>") {
  const normalized = normalizeText(content);
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  let searchStart = 0;

  for (const hunk of hunks) {
    const expected = hunk.filter(line => line.marker !== "+").map(line => line.text);
    const replacement = hunk.filter(line => line.marker !== "-").map(line => line.text);
    const positions = matchingPositions(lines, expected, searchStart);
    if (positions.length === 0) throw new Error(`补丁内容与 ${path} 当前内容不一致`);
    if (positions.length > 1) throw new Error(`补丁块在 ${path} 中匹配多处，请增加上下文后重试`);
    const position = positions[0];
    lines.splice(position, expected.length, ...replacement);
    searchStart = position + replacement.length;
  }
  return `${lines.join("\n")}${finalNewline ? "\n" : ""}`;
}
