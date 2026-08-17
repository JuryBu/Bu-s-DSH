/**
 * 前端展示补丁共用的锚点替换器。
 *
 * 与 `../transforms.mjs` 内部同名私有函数语义完全一致：锚点必须在干净基线里
 * 唯一出现，否则立即抛错停止构建，绝不做模糊替换。这里独立一份是为了让前端
 * 补丁模块不必改动 Codex 拥有的 `transforms.mjs`。
 */

/**
 * 注入型补丁的守卫。
 *
 * 注入是「在锚点前插入」，锚点本身不会消失，所以 `replaceExactlyOnce` 不足以
 * 拦住重复执行——那会静默注入两份组件。构建候选时必须直接失败。
 * @param source - 待修改源码。
 * @param marker - 注入后一定存在的标记（例如组件函数名）。
 * @param label - 报错用的补丁名。
 */
export function assertNotAlreadyPatched(source, marker, label) {
  if (source.includes(marker)) {
    throw new Error(`${label} 已存在于源码中，拒绝重复注入（请检查是否对已打补丁的候选再次构建）`);
  }
}

export function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label} 与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本`);
  }
  return source.replace(before, after);
}

export function replaceRangeExactlyOnce(source, start, end, replacement, label) {
  const first = source.indexOf(start);
  const last = source.lastIndexOf(start);
  if (first < 0 || first !== last) {
    throw new Error(`${label} 的起点与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本`);
  }
  const endIndex = source.indexOf(end, first + start.length);
  if (endIndex < 0 || source.indexOf(end, endIndex + end.length) >= 0) {
    throw new Error(`${label} 的终点与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(endIndex)}`;
}
