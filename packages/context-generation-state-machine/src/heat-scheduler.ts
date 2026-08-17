import { createHash } from "node:crypto";

export const HEAT_SCHEDULER_DEFAULT_TARGET_ROUNDS = 30 as const;
export const HEAT_SCHEDULER_SAFE_MIN_ROUNDS = 24 as const;
export const HEAT_SCHEDULER_SAFE_MAX_ROUNDS = 36 as const;
export const HEAT_SCHEDULER_MAX_TARGET_CHANGE = 3 as const;
export const HEAT_SCHEDULER_FULL_CONFIRMATION_ROUNDS = 48 as const;
export const HEAT_SCHEDULER_TAIL_CONFIRMATION_MULTIPLIER = 0.5 as const;
export const HEAT_SCHEDULER_CALLER_PROTECTION_WINDOW_BUDGET_FRACTION = 0.5 as const;

export interface HeatRound {
  roundId: number;
  priorHeat?: number;
  priorHeatAgeTurns?: number;
  timePosition?: number;
}
export interface ReadHit {
  roundIds: readonly number[];
  strength?: number;
  ageTurns?: number;
  confirmed?: boolean;
}

export interface OrderedRoundsReceipt {
  receiptId: string;
  orderedRounds: readonly number[];
}

export interface HeatSchedulerBudget {
  requiredHitBudget?: number;
  availableHitBudget?: number;
  maxExplorationRounds?: number;
}

export interface HeatSchedulerInput {
  rounds: readonly HeatRound[];
  readHits?: readonly ReadHit[];
  orderedRounds?: readonly OrderedRoundsReceipt[];
  protectedRoundIds?: readonly number[];
  requestedTargetRoundCount?: number;
  previousTargetRoundCount?: number;
  budget?: HeatSchedulerBudget;
  explorationSeed?: string;
  heatHalfLifeTurns?: number;
}

export interface RemovedOrderEdge {
  startRoundId: number;
  endRoundId: number;
  reason: "opposed_tie" | "opposed_weaker" | "cycle_weakest";
}

export interface RoundHeatTrace {
  roundId: number;
  priorHeat: number;
  priorHeatAfterDecay: number;
  rawReadHeat: number;
  confirmationMultiplier: number;
  effectiveReadHeat: number;
  timePosition: number;
  priorContribution: number;
  readContribution: number;
  timeContribution: number;
  heat: number;
}

export interface HeatScheduleResult {
  targetRoundCount: number;
  hitBudgetScale: number;
  callerProtectionWindowBudgetFraction: typeof HEAT_SCHEDULER_CALLER_PROTECTION_WINDOW_BUDGET_FRACTION;
  rankedRoundIds: readonly number[];
  selectedRoundIds: readonly number[];
  normalSelectedRoundIds: readonly number[];
  protectedRoundIds: readonly number[];
  explorationRoundIds: readonly number[];
  fullHeatConfirmedRoundIds: readonly number[];
  tailHeatConfirmedRoundIds: readonly number[];
  explicitRoundIds: readonly number[];
  removedOrderEdges: readonly RemovedOrderEdge[];
  traces: ReadonlyMap<number, RoundHeatTrace>;
}

interface NormalizedRound {
  roundId: number;
  priorHeat: number;
  priorHeatAgeTurns: number;
  timePosition: number;
}

interface NormalizedBudget {
  hitBudgetScale: number;
  explorationCount: number;
}

interface Edge {
  startRoundId: number;
  endRoundId: number;
  receiptIds: Set<string>;
}

interface ExplicitOrder {
  orderedRoundIds: number[];
  explicitRoundIds: Set<number>;
  removedOrderEdges: RemovedOrderEdge[];
}

function requireRoundId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} 必须是正整数 roundId`);
  }
  return value as number;
}

function requireFiniteNonNegative(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || (value as number) < 0) {
    throw new RangeError(`${label} 必须是非负有限数值`);
  }
  return value as number;
}

function requirePositiveFinite(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || (value as number) <= 0) {
    throw new RangeError(`${label} 必须是正有限数值`);
  }
  return value as number;
}

function requireTargetCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} 必须是正整数`);
  }
  return value as number;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampTarget(value: number): number {
  return Math.max(HEAT_SCHEDULER_SAFE_MIN_ROUNDS, Math.min(HEAT_SCHEDULER_SAFE_MAX_ROUNDS, value));
}

function uniqueRoundIds(roundIds: readonly number[], knownRoundIds?: ReadonlySet<number>): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const value of roundIds) {
    if (!Number.isSafeInteger(value) || value < 1) continue;
    if (knownRoundIds && !knownRoundIds.has(value)) continue;
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

function normalizeRounds(rounds: readonly HeatRound[]): Map<number, NormalizedRound> {
  const normalized = new Map<number, NormalizedRound>();
  for (const round of rounds) {
    const roundId = requireRoundId(round.roundId, "round.roundId");
    if (normalized.has(roundId)) throw new RangeError(`roundId=${roundId} 重复出现`);
    normalized.set(roundId, {
      roundId,
      priorHeat: clampUnit(requireFiniteNonNegative(round.priorHeat, `round ${roundId} priorHeat`, 0)),
      priorHeatAgeTurns: requireFiniteNonNegative(round.priorHeatAgeTurns, `round ${roundId} priorHeatAgeTurns`, 0),
      timePosition: round.timePosition === undefined
        ? Number.NaN
        : clampUnit(requireFiniteNonNegative(round.timePosition, `round ${roundId} timePosition`, 0)),
    });
  }
  const sortedRoundIds = [...normalized.keys()].sort((left, right) => left - right);
  const span = Math.max(1, sortedRoundIds.length - 1);
  for (const [index, roundId] of sortedRoundIds.entries()) {
    const round = normalized.get(roundId)!;
    if (Number.isNaN(round.timePosition)) round.timePosition = index / span;
  }
  return normalized;
}

function decay(value: number, ageTurns: number, halfLifeTurns: number): number {
  return value * (0.5 ** (ageTurns / halfLifeTurns));
}

function aggregateReadHeat(
  readHits: readonly ReadHit[],
  knownRoundIds: ReadonlySet<number>,
  halfLifeTurns: number,
): { rawReadHeat: Map<number, number>; confirmedRoundIds: Set<number> } {
  const rawReadHeat = new Map<number, number>([...knownRoundIds].map(roundId => [roundId, 0]));
  const confirmedRoundIds = new Set<number>();
  for (const hit of readHits) {
    const strength = requireFiniteNonNegative(hit.strength, "read hit strength", 1);
    const ageTurns = requireFiniteNonNegative(hit.ageTurns, "read hit ageTurns", 0);
    const targets = uniqueRoundIds(hit.roundIds, knownRoundIds);
    if (targets.length === 0 || strength === 0) continue;
    const contribution = decay(strength, ageTurns, halfLifeTurns) / targets.length;
    for (const roundId of targets) {
      rawReadHeat.set(roundId, (rawReadHeat.get(roundId) ?? 0) + contribution);
      if (hit.confirmed === true) confirmedRoundIds.add(roundId);
    }
  }
  for (const [roundId, value] of rawReadHeat) rawReadHeat.set(roundId, clampUnit(value));
  return { rawReadHeat, confirmedRoundIds };
}

function edgeKey(startRoundId: number, endRoundId: number): string {
  return `${startRoundId}:${endRoundId}`;
}

function findCycle(nodes: ReadonlySet<number>, edges: ReadonlyMap<string, Edge>): Edge[] {
  const outgoing = new Map<number, Edge[]>();
  for (const roundId of nodes) outgoing.set(roundId, []);
  for (const edge of edges.values()) outgoing.get(edge.startRoundId)?.push(edge);
  for (const value of outgoing.values()) value.sort((left, right) => left.endRoundId - right.endRoundId);
  const state = new Map<number, 0 | 1 | 2>();
  const stack: Edge[] = [];
  const stackIndex = new Map<number, number>();

  const visit = (roundId: number): Edge[] => {
    state.set(roundId, 1);
    stackIndex.set(roundId, stack.length);
    for (const edge of outgoing.get(roundId) ?? []) {
      const nextState = state.get(edge.endRoundId) ?? 0;
      if (nextState === 0) {
        stack.push(edge);
        const cycle = visit(edge.endRoundId);
        if (cycle.length > 0) return cycle;
        stack.pop();
      } else if (nextState === 1) {
        const start = stackIndex.get(edge.endRoundId)!;
        return [...stack.slice(start), edge];
      }
    }
    stackIndex.delete(roundId);
    state.set(roundId, 2);
    return [];
  };

  for (const roundId of [...nodes].sort((left, right) => left - right)) {
    if ((state.get(roundId) ?? 0) === 0) {
      const cycle = visit(roundId);
      if (cycle.length > 0) return cycle;
    }
  }
  return [];
}

function explicitOrder(
  receipts: readonly OrderedRoundsReceipt[],
  knownRoundIds: ReadonlySet<number>,
  scores: ReadonlyMap<number, number>,
): ExplicitOrder {
  const receiptPayloads = new Map<string, readonly number[]>();
  const explicitRoundIds = new Set<number>();
  const edges = new Map<string, Edge>();
  for (const receipt of receipts) {
    if (typeof receipt.receiptId !== "string" || receipt.receiptId.trim().length === 0) {
      throw new RangeError("orderedRounds receiptId 必须是非空字符串");
    }
    const orderedRoundIds = uniqueRoundIds(receipt.orderedRounds, knownRoundIds);
    const previous = receiptPayloads.get(receipt.receiptId);
    if (previous && (previous.length !== orderedRoundIds.length || previous.some((roundId, index) => roundId !== orderedRoundIds[index]))) {
      throw new RangeError(`orderedRounds receiptId=${receipt.receiptId} 的内容发生变化`);
    }
    if (previous) continue;
    receiptPayloads.set(receipt.receiptId, orderedRoundIds);
    for (const roundId of orderedRoundIds) explicitRoundIds.add(roundId);
    for (let index = 0; index + 1 < orderedRoundIds.length; index += 1) {
      const startRoundId = orderedRoundIds[index]!;
      const endRoundId = orderedRoundIds[index + 1]!;
      if (startRoundId === endRoundId) continue;
      const key = edgeKey(startRoundId, endRoundId);
      const edge = edges.get(key) ?? { startRoundId, endRoundId, receiptIds: new Set<string>() };
      edge.receiptIds.add(receipt.receiptId);
      edges.set(key, edge);
    }
  }

  const removedOrderEdges: RemovedOrderEdge[] = [];
  const handledPairs = new Set<string>();
  for (const edge of [...edges.values()].sort((left, right) => left.startRoundId - right.startRoundId || left.endRoundId - right.endRoundId)) {
    const pairKey = [edge.startRoundId, edge.endRoundId].sort((left, right) => left - right).join(":");
    if (handledPairs.has(pairKey)) continue;
    const reverse = edges.get(edgeKey(edge.endRoundId, edge.startRoundId));
    if (!reverse) continue;
    handledPairs.add(pairKey);
    if (edge.receiptIds.size === reverse.receiptIds.size) {
      edges.delete(edgeKey(edge.startRoundId, edge.endRoundId));
      edges.delete(edgeKey(edge.endRoundId, edge.startRoundId));
      removedOrderEdges.push(
        { startRoundId: edge.startRoundId, endRoundId: edge.endRoundId, reason: "opposed_tie" },
        { startRoundId: reverse.startRoundId, endRoundId: reverse.endRoundId, reason: "opposed_tie" },
      );
    } else {
      const weaker = edge.receiptIds.size < reverse.receiptIds.size ? edge : reverse;
      edges.delete(edgeKey(weaker.startRoundId, weaker.endRoundId));
      removedOrderEdges.push({ startRoundId: weaker.startRoundId, endRoundId: weaker.endRoundId, reason: "opposed_weaker" });
    }
  }

  while (true) {
    const cycle = findCycle(explicitRoundIds, edges);
    if (cycle.length === 0) break;
    const weakest = [...cycle].sort((left, right) => (
      left.receiptIds.size - right.receiptIds.size
      || left.startRoundId - right.startRoundId
      || left.endRoundId - right.endRoundId
    ))[0]!;
    edges.delete(edgeKey(weakest.startRoundId, weakest.endRoundId));
    removedOrderEdges.push({ startRoundId: weakest.startRoundId, endRoundId: weakest.endRoundId, reason: "cycle_weakest" });
  }

  const parents = new Map<number, number[]>();
  for (const roundId of explicitRoundIds) parents.set(roundId, []);
  for (const edge of edges.values()) parents.get(edge.endRoundId)?.push(edge.startRoundId);
  const levels = new Map<number, number>();
  const level = (roundId: number): number => {
    const existing = levels.get(roundId);
    if (existing !== undefined) return existing;
    const value = Math.max(0, ...(parents.get(roundId) ?? []).map(parent => level(parent) + 1));
    levels.set(roundId, value);
    return value;
  };
  const orderedRoundIds = [...explicitRoundIds].sort((left, right) => (
    level(left) - level(right)
    || (scores.get(right) ?? 0) - (scores.get(left) ?? 0)
    || left - right
  ));
  return { orderedRoundIds, explicitRoundIds, removedOrderEdges };
}

function combineOrder(
  roundIds: readonly number[],
  receipts: readonly OrderedRoundsReceipt[],
  scores: ReadonlyMap<number, number>,
): ExplicitOrder {
  const explicit = explicitOrder(receipts, new Set(roundIds), scores);
  const remaining = roundIds
    .filter(roundId => !explicit.explicitRoundIds.has(roundId))
    .sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left - right);
  return {
    orderedRoundIds: [...explicit.orderedRoundIds, ...remaining],
    explicitRoundIds: explicit.explicitRoundIds,
    removedOrderEdges: explicit.removedOrderEdges,
  };
}

function targetRoundCount(input: HeatSchedulerInput): number {
  const requested = requireTargetCount(input.requestedTargetRoundCount, "requestedTargetRoundCount");
  const previous = requireTargetCount(input.previousTargetRoundCount, "previousTargetRoundCount");
  if (previous === undefined) return HEAT_SCHEDULER_DEFAULT_TARGET_ROUNDS;
  const prior = clampTarget(previous);
  const desired = clampTarget(requested ?? prior);
  return Math.max(prior - HEAT_SCHEDULER_MAX_TARGET_CHANGE, Math.min(prior + HEAT_SCHEDULER_MAX_TARGET_CHANGE, desired));
}

function normalizeBudget(budget: HeatSchedulerBudget | undefined, targetCount: number): NormalizedBudget {
  if (!budget) return { hitBudgetScale: 1, explorationCount: 0 };
  const required = requirePositiveFinite(budget.requiredHitBudget, "requiredHitBudget", 1);
  const available = requireFiniteNonNegative(budget.availableHitBudget, "availableHitBudget", required);
  const maxExplorationRounds = requireTargetCount(budget.maxExplorationRounds, "maxExplorationRounds") ?? HEAT_SCHEDULER_MAX_TARGET_CHANGE;
  if (available <= required) return { hitBudgetScale: available / required, explorationCount: 0 };
  const proportionalCount = Math.max(1, Math.floor(((available - required) / required) * targetCount));
  return {
    hitBudgetScale: 1,
    explorationCount: Math.min(maxExplorationRounds, proportionalCount),
  };
}

function deterministicExploration(
  candidates: readonly number[],
  count: number,
  seed: string,
): number[] {
  return [...candidates]
    .sort((left, right) => {
      const leftHash = createHash("sha256").update(`${seed}\u0000${left}`, "utf8").digest("hex");
      const rightHash = createHash("sha256").update(`${seed}\u0000${right}`, "utf8").digest("hex");
      return leftHash.localeCompare(rightHash) || left - right;
    })
    .slice(0, count);
}

function appendUnique(values: readonly number[]): number[] {
  return uniqueRoundIds(values);
}

export function scheduleRoundHeat(input: HeatSchedulerInput): HeatScheduleResult {
  const normalizedRounds = normalizeRounds(input.rounds);
  const roundIds = [...normalizedRounds.keys()].sort((left, right) => left - right);
  const knownRoundIds = new Set(roundIds);
  const halfLifeTurns = requirePositiveFinite(input.heatHalfLifeTurns, "heatHalfLifeTurns", 30);
  const { rawReadHeat, confirmedRoundIds } = aggregateReadHeat(input.readHits ?? [], knownRoundIds, halfLifeTurns);
  const preliminaryScores = new Map<number, number>();
  for (const roundId of roundIds) {
    const round = normalizedRounds.get(roundId)!;
    preliminaryScores.set(
      roundId,
      0.47 * decay(round.priorHeat, round.priorHeatAgeTurns, halfLifeTurns)
      + 0.48 * (rawReadHeat.get(roundId) ?? 0)
      + 0.05 * round.timePosition,
    );
  }
  const preliminaryOrder = combineOrder(roundIds, input.orderedRounds ?? [], preliminaryScores);
  const confirmedOrder = preliminaryOrder.orderedRoundIds.filter(roundId => confirmedRoundIds.has(roundId));
  const fullHeatConfirmedRoundIds = confirmedOrder.slice(0, HEAT_SCHEDULER_FULL_CONFIRMATION_ROUNDS);
  const fullHeatConfirmedSet = new Set(fullHeatConfirmedRoundIds);
  const tailHeatConfirmedRoundIds = confirmedOrder.slice(HEAT_SCHEDULER_FULL_CONFIRMATION_ROUNDS);
  const budget = normalizeBudget(input.budget, targetRoundCount(input));
  const traces = new Map<number, RoundHeatTrace>();
  const finalScores = new Map<number, number>();
  for (const roundId of roundIds) {
    const round = normalizedRounds.get(roundId)!;
    const priorHeatAfterDecay = decay(round.priorHeat, round.priorHeatAgeTurns, halfLifeTurns);
    const rawRead = rawReadHeat.get(roundId) ?? 0;
    const confirmationMultiplier = confirmedRoundIds.has(roundId)
      ? (fullHeatConfirmedSet.has(roundId) ? 1 : HEAT_SCHEDULER_TAIL_CONFIRMATION_MULTIPLIER)
      : 1;
    const effectiveReadHeat = rawRead * confirmationMultiplier;
    const trace: RoundHeatTrace = {
      roundId,
      priorHeat: round.priorHeat,
      priorHeatAfterDecay,
      rawReadHeat: rawRead,
      confirmationMultiplier,
      effectiveReadHeat,
      timePosition: round.timePosition,
      priorContribution: 0.47 * priorHeatAfterDecay,
      readContribution: 0.48 * effectiveReadHeat * budget.hitBudgetScale,
      timeContribution: 0.05 * round.timePosition,
      heat: 0,
    };
    trace.heat = trace.priorContribution + trace.readContribution + trace.timeContribution;
    traces.set(roundId, trace);
    finalScores.set(roundId, trace.heat);
  }
  const finalOrder = combineOrder(roundIds, input.orderedRounds ?? [], finalScores);
  const protectedRoundIds = finalOrder.orderedRoundIds.filter(roundId => uniqueRoundIds(input.protectedRoundIds ?? [], knownRoundIds).includes(roundId));
  const protectedSet = new Set(protectedRoundIds);
  const target = targetRoundCount(input);
  const normalSelectedRoundIds = finalOrder.orderedRoundIds.filter(roundId => !protectedSet.has(roundId)).slice(0, target);
  const selectedSet = new Set([...protectedRoundIds, ...normalSelectedRoundIds]);
  const explorationPool = finalOrder.orderedRoundIds.filter(roundId => (
    !selectedSet.has(roundId)
    && !protectedSet.has(roundId)
    && (traces.get(roundId)?.rawReadHeat ?? 0) === 0
  ));
  const fallbackExplorationPool = finalOrder.orderedRoundIds.filter(roundId => !selectedSet.has(roundId) && !protectedSet.has(roundId));
  const explorationRoundIds = deterministicExploration(
    explorationPool.length > 0 ? explorationPool : fallbackExplorationPool,
    budget.explorationCount,
    input.explorationSeed ?? "dsh-context-heat-scheduler",
  );
  return {
    targetRoundCount: target,
    hitBudgetScale: budget.hitBudgetScale,
    callerProtectionWindowBudgetFraction: HEAT_SCHEDULER_CALLER_PROTECTION_WINDOW_BUDGET_FRACTION,
    rankedRoundIds: finalOrder.orderedRoundIds,
    selectedRoundIds: appendUnique([...protectedRoundIds, ...normalSelectedRoundIds, ...explorationRoundIds]),
    normalSelectedRoundIds,
    protectedRoundIds,
    explorationRoundIds,
    fullHeatConfirmedRoundIds,
    tailHeatConfirmedRoundIds,
    explicitRoundIds: [...finalOrder.explicitRoundIds].sort((left, right) => left - right),
    removedOrderEdges: finalOrder.removedOrderEdges,
    traces,
  };
}
