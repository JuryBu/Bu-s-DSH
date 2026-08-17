import assert from "node:assert/strict";
import test from "node:test";

import { buildHeatDetailPlan, heatIntegrationTesting } from "../src/heat-integration.ts";

test("压缩档位使用近期曲线、确认衰减、显式顺序和保护范围", () => {
  const plan = buildHeatDetailPlan({
    roundStart: 1,
    roundEnd: 100,
    observedAtRound: 120,
    explorationSeed: "fixture-generation",
    confirmations: [{
      readReceiptId: "receipt-1",
      confirmedRounds: [5, 80, 81],
      orderedRounds: [81, 80, 5],
      confirmedAtOwnerRound: 118,
    }],
    protections: [{ ranges: [{ start: 20, end: 21 }] }],
  });
  assert.equal(plan.detailByRound.get(20), "full");
  assert.equal(plan.detailByRound.get(21), "full");
  assert.ok(plan.schedule.rankedRoundIds.indexOf(81) < plan.schedule.rankedRoundIds.indexOf(80));
  assert.ok(plan.schedule.rankedRoundIds.indexOf(80) < plan.schedule.rankedRoundIds.indexOf(5));
  assert.equal(plan.heatState.observedAtRound, 120);
  assert.equal(plan.schedule.explorationRoundIds.length, 3);
});

test("旧确认经过很久后降低读取贡献，近期时间曲线仍保持", () => {
  const recent = buildHeatDetailPlan({
    roundStart: 1,
    roundEnd: 60,
    observedAtRound: 60,
    explorationSeed: "same",
    confirmations: [{ readReceiptId: "r", confirmedRounds: [2], confirmedAtOwnerRound: 59 }],
  });
  const old = buildHeatDetailPlan({
    roundStart: 1,
    roundEnd: 60,
    observedAtRound: 120,
    explorationSeed: "same",
    confirmations: [{ readReceiptId: "r", confirmedRounds: [2], confirmedAtOwnerRound: 59 }],
  });
  assert.ok(recent.schedule.traces.get(2)!.readContribution > old.schedule.traces.get(2)!.readContribution);
  assert.equal(recent.schedule.traces.get(60)!.timePosition, 1);
  assert.equal(old.schedule.traces.get(60)!.timePosition, 1);
  assert.ok(heatIntegrationTesting.timePosition(10, 1, 60) < heatIntegrationTesting.timePosition(50, 1, 60));
});

test("同一代次探索选择可复现，已持久热度进入下一次评估", () => {
  const first = buildHeatDetailPlan({ roundStart: 1, roundEnd: 80, observedAtRound: 80, explorationSeed: "stable" });
  const repeated = buildHeatDetailPlan({ roundStart: 1, roundEnd: 80, observedAtRound: 80, explorationSeed: "stable" });
  assert.deepEqual(first.schedule.explorationRoundIds, repeated.schedule.explorationRoundIds);
  const next = buildHeatDetailPlan({
    roundStart: 1,
    roundEnd: 90,
    observedAtRound: 90,
    explorationSeed: "next",
    previous: first.heatState,
  });
  assert.equal(next.heatState.targetRoundCount, 30);
  assert.ok(next.schedule.traces.get(80)!.priorHeatAfterDecay > 0);
});
