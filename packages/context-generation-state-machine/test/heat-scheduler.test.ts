import assert from "node:assert/strict";
import test from "node:test";

import {
  HEAT_SCHEDULER_CALLER_PROTECTION_WINDOW_BUDGET_FRACTION,
  HEAT_SCHEDULER_FULL_CONFIRMATION_ROUNDS,
  scheduleRoundHeat,
  type HeatRound,
} from "../src/heat-scheduler.ts";

function rounds(count: number, overrides: Partial<HeatRound> = {}): HeatRound[] {
  return Array.from({ length: count }, (_unused, index) => ({ roundId: index + 1, ...overrides }));
}

function trace(result: ReturnType<typeof scheduleRoundHeat>, roundId: number) {
  const value = result.traces.get(roundId);
  assert.ok(value, `missing trace for round ${roundId}`);
  return value;
}

test("长对话冷启动固定 30 轮，安全区内每次最多调整 3 轮", () => {
  const input = { rounds: rounds(240), requestedTargetRoundCount: 36 };
  const cold = scheduleRoundHeat(input);
  assert.equal(cold.targetRoundCount, 30);
  assert.equal(cold.normalSelectedRoundIds.length, 30);
  assert.equal(cold.rankedRoundIds[0], 240);

  const firstChange = scheduleRoundHeat({ ...input, previousTargetRoundCount: 30 });
  assert.equal(firstChange.targetRoundCount, 33);
  const secondChange = scheduleRoundHeat({ ...input, previousTargetRoundCount: 33 });
  assert.equal(secondChange.targetRoundCount, 36);
  const constrainedDrop = scheduleRoundHeat({ rounds: rounds(240), previousTargetRoundCount: 36, requestedTargetRoundCount: 1 });
  assert.equal(constrainedDrop.targetRoundCount, 33);
});
test("早期命中过很久才压缩与旧热度都会按半衰期降温", () => {
  const readAged = scheduleRoundHeat({
    rounds: [
      { roundId: 1, timePosition: 0.5 },
      { roundId: 2, timePosition: 0.5 },
    ],
    readHits: [
      { roundIds: [1], strength: 1, ageTurns: 120, confirmed: true },
      { roundIds: [2], strength: 1, ageTurns: 0, confirmed: true },
    ],
  });
  assert.ok(trace(readAged, 1).rawReadHeat < 0.1);
  assert.ok(readAged.rankedRoundIds.indexOf(2) < readAged.rankedRoundIds.indexOf(1));

  const priorAged = scheduleRoundHeat({
    rounds: [
      { roundId: 1, priorHeat: 1, priorHeatAgeTurns: 120, timePosition: 0.5 },
      { roundId: 2, priorHeat: 0.3, priorHeatAgeTurns: 0, timePosition: 0.5 },
    ],
  });
  assert.ok(trace(priorAged, 1).priorHeatAfterDecay < trace(priorAged, 2).priorHeatAfterDecay);
  assert.ok(priorAged.rankedRoundIds.indexOf(2) < priorAged.rankedRoundIds.indexOf(1));
});

test("无效命中不会参与批次分母而稀释有效 round", () => {
  const baseInput = {
    rounds: [
      { roundId: 1, timePosition: 0.5 },
      { roundId: 2, timePosition: 0.5 },
    ],
  };
  const valid = scheduleRoundHeat({ ...baseInput, readHits: [{ roundIds: [1], strength: 1, confirmed: true }] });
  const withInvalid = scheduleRoundHeat({ ...baseInput, readHits: [{ roundIds: [1, 999, -3], strength: 1, confirmed: true }] });
  assert.equal(trace(valid, 1).rawReadHeat, trace(withInvalid, 1).rawReadHeat);
  assert.equal(trace(withInvalid, 2).rawReadHeat, 0);
});

test("确认前 48 轮完整热度，尾部确认轮只有一半读取热度", () => {
  const confirmedRoundIds = Array.from({ length: 50 }, (_unused, index) => index + 1);
  const result = scheduleRoundHeat({
    rounds: rounds(50),
    readHits: [{ roundIds: confirmedRoundIds, strength: 50, confirmed: true }],
  });
  assert.equal(result.fullHeatConfirmedRoundIds.length, HEAT_SCHEDULER_FULL_CONFIRMATION_ROUNDS);
  assert.equal(result.tailHeatConfirmedRoundIds.length, 2);
  for (const roundId of result.fullHeatConfirmedRoundIds) assert.equal(trace(result, roundId).confirmationMultiplier, 1);
  for (const roundId of result.tailHeatConfirmedRoundIds) assert.equal(trace(result, roundId).confirmationMultiplier, 0.5);
});

test("显式 orderedRounds 关系图压过自动分数，但只约束表达过的局部顺序", () => {
  const result = scheduleRoundHeat({
    rounds: [
      { roundId: 1, priorHeat: 1, timePosition: 1 },
      { roundId: 2, priorHeat: 0.9, timePosition: 0.9 },
      { roundId: 3, priorHeat: 0, timePosition: 0 },
    ],
    orderedRounds: [{ receiptId: "receipt-local-order", orderedRounds: [3, 1] }],
  });
  assert.ok(result.rankedRoundIds.indexOf(3) < result.rankedRoundIds.indexOf(1));
  assert.ok(result.rankedRoundIds.indexOf(1) < result.rankedRoundIds.indexOf(2));
  assert.deepEqual(result.explicitRoundIds, [1, 3]);
});

test("预算不足只削读取命中，近期时间与旧热度贡献保持不变", () => {
  const input = {
    rounds: [{ roundId: 1, priorHeat: 0.4, timePosition: 1 }],
    readHits: [{ roundIds: [1], strength: 1, confirmed: true }],
  };
  const unrestricted = scheduleRoundHeat(input);
  const constrained = scheduleRoundHeat({
    ...input,
    budget: { requiredHitBudget: 100, availableHitBudget: 25 },
  });
  assert.equal(constrained.hitBudgetScale, 0.25);
  assert.equal(trace(constrained, 1).timeContribution, trace(unrestricted, 1).timeContribution);
  assert.equal(trace(constrained, 1).priorContribution, trace(unrestricted, 1).priorContribution);
  assert.equal(trace(constrained, 1).readContribution, trace(unrestricted, 1).readContribution * 0.25);
});

test("预算过剩加入可复现的确定性探索", () => {
  const input = {
    rounds: rounds(80),
    readHits: [{ roundIds: [80], strength: 1, confirmed: true }],
    budget: { requiredHitBudget: 10, availableHitBudget: 20, maxExplorationRounds: 2 },
    explorationSeed: "generation-42",
  };
  const first = scheduleRoundHeat(input);
  const second = scheduleRoundHeat(input);
  assert.equal(first.explorationRoundIds.length, 2);
  assert.deepEqual(first.explorationRoundIds, second.explorationRoundIds);
  assert.equal(first.explorationRoundIds.every(roundId => trace(first, roundId).rawReadHeat === 0), true);
});

test("保护轮强制进入结果，由调用方保留 50% 窗口保护预算", () => {
  const result = scheduleRoundHeat({
    rounds: rounds(60),
    protectedRoundIds: [1],
  });
  assert.equal(result.callerProtectionWindowBudgetFraction, HEAT_SCHEDULER_CALLER_PROTECTION_WINDOW_BUDGET_FRACTION);
  assert.deepEqual(result.protectedRoundIds, [1]);
  assert.equal(result.normalSelectedRoundIds.includes(1), false);
  assert.equal(result.selectedRoundIds.includes(1), true);
  assert.equal(result.selectedRoundIds.length, result.normalSelectedRoundIds.length + 1);
});
