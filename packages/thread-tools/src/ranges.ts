import type { ThreadRole, ThreadRound, ThreadRoundRange, ThreadSourceRange } from "./types.ts";

const ROLE_ORDER: readonly ThreadRole[] = ["system", "user", "assistant", "tool", "mixed", "unknown"];

function assertRoundRange(range: ThreadRoundRange): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start) {
    throw new RangeError(`Invalid round range ${range.start}-${range.end}.`);
  }
}

export function mergeAdjacentRoundRanges(ranges: readonly ThreadRoundRange[]): ThreadRoundRange[] {
  const ordered = ranges.map(range => ({ ...range })).sort((left, right) => left.start - right.start);
  for (const range of ordered) {
    assertRoundRange(range);
  }

  const merged: ThreadRoundRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1) {
      merged.push(range);
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

export function roundIsSelected(round: number, ranges: readonly ThreadRoundRange[]): boolean {
  return ranges.length === 0 || ranges.some(range => round >= range.start && round <= range.end);
}

export function normalizeRoles(roles: readonly ThreadRole[] | undefined): ThreadRole[] | undefined {
  if (roles === undefined) {
    return undefined;
  }
  const unique = new Set<ThreadRole>();
  for (const role of roles) {
    if (!ROLE_ORDER.includes(role)) {
      throw new RangeError(`Unknown thread role ${String(role)}.`);
    }
    unique.add(role);
  }
  return ROLE_ORDER.filter(role => unique.has(role));
}

export function roundRangesEqual(left: readonly ThreadRoundRange[], right: readonly ThreadRoundRange[]): boolean {
  return left.length === right.length && left.every((range, index) =>
    range.start === right[index].start && range.end === right[index].end,
  );
}

export function rolesEqual(left: readonly ThreadRole[] | undefined, right: readonly ThreadRole[] | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.length === right.length && left.every((role, index) => role === right[index]);
}

export function selectRoundsByRange(
  rounds: readonly ThreadRound[],
  ranges: readonly ThreadRoundRange[],
  roles: readonly ThreadRole[] | undefined,
): ThreadRound[] {
  if (ranges.length === 0) {
    return roles ? rounds.filter(round => roles.includes(round.role)) : [...rounds];
  }

  const selected: ThreadRound[] = [];
  let searchFrom = 0;
  for (const range of ranges) {
    let low = searchFrom;
    let high = rounds.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rounds[middle].round < range.start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    let index = low;
    while (index < rounds.length && rounds[index].round <= range.end) {
      if (!roles || roles.includes(rounds[index].role)) {
        selected.push(rounds[index]);
      }
      index += 1;
    }
    searchFrom = index;
  }
  return selected;
}

export function mergeAdjacentSourceRanges(ranges: readonly ThreadSourceRange[]): ThreadSourceRange[] {
  const ordered = ranges
    .map(range => ({ ...range }))
    .sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);

  for (const range of ordered) {
    if (!range.blockId || !Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)
      || range.startOffset < 0 || range.endOffset < range.startOffset) {
      throw new RangeError(`Invalid source range ${range.blockId}:${range.startOffset}-${range.endOffset}.`);
    }
  }

  const merged: ThreadSourceRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (!previous || range.startOffset > previous.endOffset) {
      merged.push(range);
      continue;
    }
    previous.endOffset = Math.max(previous.endOffset, range.endOffset);
    previous.blockId = `${previous.blockId}+${range.blockId}`;
  }
  return merged;
}
