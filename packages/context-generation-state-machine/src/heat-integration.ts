import type { RecordDetail } from "./context-builder.ts";
import {
  HEAT_SCHEDULER_DEFAULT_TARGET_ROUNDS,
  scheduleRoundHeat,
  type HeatScheduleResult,
} from "./heat-scheduler.ts";
import type { PersistedHeatState } from "./runtime-state.ts";

export interface ThreadConfirmationSignal {
  readReceiptId: string;
  confirmedRounds: readonly number[];
  orderedRounds?: readonly number[];
  confirmedAtOwnerRound?: number;
}

export interface ThreadProtectionSignal {
  ranges: readonly { start: number; end: number }[];
}

export interface HeatDetailPlanInput {
  roundStart: number;
  roundEnd: number;
  observedAtRound: number;
  previous?: PersistedHeatState;
  confirmations?: readonly ThreadConfirmationSignal[];
  protections?: readonly ThreadProtectionSignal[];
  explorationSeed: string;
}

export interface HeatDetailPlan {
  detailByRound: ReadonlyMap<number, RecordDetail>;
  protectedRoundIds: readonly number[];
  heatState: PersistedHeatState;
  schedule: HeatScheduleResult;
}

function rangeIds(start: number, end: number): number[] {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new RangeError("热度档位轮次范围无效");
  }
  return Array.from({ length: end - start + 1 }, (_value, index) => start + index);
}

function timePosition(round: number, start: number, end: number): number {
  if (start === end) return 1;
  const progress = (round - start) / (end - start);
  return progress ** 6;
}

function protectedRounds(
  protections: readonly ThreadProtectionSignal[],
  knownRounds: ReadonlySet<number>,
): number[] {
  const result = new Set<number>();
  for (const protection of protections) {
    for (const range of protection.ranges) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 || range.end < range.start) {
        throw new RangeError("线程保护范围无效");
      }
      for (let round = range.start; round <= range.end; round += 1) {
        if (knownRounds.has(round)) result.add(round);
      }
    }
  }
  return [...result].sort((left, right) => left - right);
}

export function buildHeatDetailPlan(input: HeatDetailPlanInput): HeatDetailPlan {
  const roundIds = rangeIds(input.roundStart, input.roundEnd);
  const knownRounds = new Set(roundIds);
  const previous = new Map((input.previous?.rounds ?? []).map(round => [round.roundId, round]));
  const confirmations = input.confirmations ?? [];
  const protectedRoundIds = protectedRounds(input.protections ?? [], knownRounds);
  const confirmedKnownCount = new Set(confirmations.flatMap(item => (
    item.confirmedRounds.filter(round => knownRounds.has(round))
  ))).size;
  const requestedTarget = input.previous?.targetRoundCount ?? HEAT_SCHEDULER_DEFAULT_TARGET_ROUNDS;
  const schedule = scheduleRoundHeat({
    rounds: roundIds.map(roundId => {
      const prior = previous.get(roundId);
      return {
        roundId,
        priorHeat: prior?.heat ?? 0,
        priorHeatAgeTurns: Math.max(0, input.observedAtRound - (prior?.observedAtRound ?? input.observedAtRound)),
        timePosition: timePosition(roundId, input.roundStart, input.roundEnd),
      };
    }),
    readHits: confirmations
      .filter(item => item.confirmedRounds.some(round => knownRounds.has(round)))
      .map(item => ({
        roundIds: item.confirmedRounds.filter(round => knownRounds.has(round)),
        confirmed: true,
        ageTurns: Math.max(0, input.observedAtRound - (item.confirmedAtOwnerRound ?? input.observedAtRound)),
      })),
    orderedRounds: confirmations
      .filter(item => item.orderedRounds !== undefined && item.orderedRounds.some(round => knownRounds.has(round)))
      .map(item => ({
        receiptId: item.readReceiptId,
        orderedRounds: item.orderedRounds!.filter(round => knownRounds.has(round)),
      }))
      .filter(item => item.orderedRounds.length > 0),
    protectedRoundIds,
    requestedTargetRoundCount: requestedTarget,
    previousTargetRoundCount: input.previous?.targetRoundCount,
    budget: confirmedKnownCount < requestedTarget
      ? { requiredHitBudget: requestedTarget, availableHitBudget: requestedTarget * 1.1, maxExplorationRounds: 3 }
      : { requiredHitBudget: requestedTarget, availableHitBudget: requestedTarget, maxExplorationRounds: 3 },
    explorationSeed: input.explorationSeed,
  });
  const full = new Set(schedule.selectedRoundIds);
  const summary = new Set(schedule.rankedRoundIds
    .filter(round => !full.has(round))
    .slice(0, schedule.targetRoundCount));
  const detailByRound = new Map<number, RecordDetail>();
  for (const round of roundIds) {
    detailByRound.set(round, full.has(round) ? "full" : summary.has(round) ? "summary" : "brief");
  }
  return {
    detailByRound,
    protectedRoundIds,
    schedule,
    heatState: {
      targetRoundCount: schedule.targetRoundCount,
      observedAtRound: input.observedAtRound,
      rounds: roundIds.map(roundId => ({
        roundId,
        heat: schedule.traces.get(roundId)?.heat ?? 0,
        observedAtRound: input.observedAtRound,
      })),
    },
  };
}

export const heatIntegrationTesting = Object.freeze({ timePosition, protectedRounds });
