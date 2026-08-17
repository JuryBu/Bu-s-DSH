import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTurnPresentation,
  conversationContextKey,
  createTurnPresentationState,
  turnPresentationProjectionDefinition,
  viewTurnPresentation,
} from "../lib/index.js";

function fold(events) {
  return events.reduce(applyTurnPresentation, createTurnPresentationState());
}

function event(type, seq, time, data = {}) {
  return { type, seq, time, data };
}

test("正常工具轮只在 turn/end 后标出最终正文边界", () => {
  const state = fold([
    event("user/message", 1, 990, { id: "human-1", source: { kind: "user" }, content: [] }),
    event("turn/start", 2, 1000, { turn: 7 }),
    event("step/start", 3, 1010, { turn: 7, step: 1 }),
    event("assistant/message", 4, 2000, {
      turn: 7,
      step: 1,
      message: { content: [{ type: "reasoning", text: "查找" }, { type: "tool-call", id: "call-1" }] },
    }),
    event("tool/call", 5, 2010, { turn: 7, step: 1, callId: "call-1", name: "read" }),
    event("step/start", 6, 3000, { turn: 7, step: 2 }),
    event("assistant/chunk", 7, 3500, { turn: 7, step: 2, chunk: { type: "text-delta", text: "最终" } }),
    event("assistant/message", 8, 4000, {
      turn: 7,
      step: 2,
      message: { content: [{ type: "text", text: "最终答案" }] },
    }),
  ]);
  const running = viewTurnPresentation(state).turns[0];
  assert.equal(running.status, "running");
  assert.equal(running.finalReplyFrom, undefined);

  const settledState = applyTurnPresentation(state, event("turn/end", 9, 4100, {
    turn: 7,
    reason: { kind: "completed" },
  }));
  const projection = viewTurnPresentation(settledState);
  assert.equal(projection.branchId, "message:human-1");
  assert.deepEqual(projection.turns[0], {
    turnId: "message:human-1:7",
    status: "settled",
    originKey: conversationContextKey("input-message", "human-1"),
    nodeKeys: [
      conversationContextKey("assistant-step", "7:1"),
      conversationContextKey("tool-call", "call-1"),
      conversationContextKey("assistant-step", "7:2"),
    ],
    finalReplyFrom: conversationContextKey("assistant-step", "7:2"),
    processStartedAt: 1000,
    processEndedAt: 3500,
  });
  assert.deepEqual(turnPresentationProjectionDefinition.schema.parse(projection), projection);
  assert.deepEqual(JSON.parse(JSON.stringify(settledState)), settledState, "projection state 必须可无损 JSON 往返");
});

test("纯工具 assistant step 不产生不可见节点，工具节点仍进入过程", () => {
  const projection = viewTurnPresentation(fold([
    event("turn/start", 1, 1000, { turn: 1 }),
    event("step/start", 2, 1010, { turn: 1, step: 1 }),
    event("assistant/message", 3, 1200, {
      turn: 1,
      step: 1,
      message: { content: [{ type: "tool-call", id: "c1", name: "read" }] },
    }),
    event("tool/call", 4, 1210, { turn: 1, step: 1, callId: "c1", name: "read" }),
  ]));
  assert.deepEqual(projection.turns[0].nodeKeys, [conversationContextKey("tool-call", "c1")]);
});

test("运行状态注入按真实事件顺序进入本轮过程", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 900, { id: "human-context", source: { kind: "user" } }),
    event("turn/start", 2, 1000, { turn: 5 }),
    event("step/start", 3, 1010, { turn: 5, step: 1 }),
    event("user/message", 4, 1020, {
      id: "runtime-context-1",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
      content: [{ type: "text", text: "当前时间" }],
    }),
    event("assistant/message", 5, 1030, {
      turn: 5,
      step: 1,
      message: { content: [{ type: "text", text: "最终答案" }] },
    }),
    event("turn/end", 6, 1040, { turn: 5, reason: { kind: "completed" } }),
  ]));
  assert.deepEqual(projection.turns[0].nodeKeys, [
    conversationContextKey("input-message", "runtime-context-1"),
    conversationContextKey("assistant-step", "5:1"),
  ]);
});

test("运行中到达的第二条真人消息固定在过程结束线下方且不越过最终正文", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 900, { id: "human-start", source: { kind: "user" } }),
    event("turn/start", 2, 1000, { turn: 12 }),
    event("step/start", 3, 1010, { turn: 12, step: 1 }),
    event("assistant/message", 4, 1020, {
      turn: 12,
      step: 1,
      message: { content: [{ type: "reasoning", text: "处理中" }] },
    }),
    event("user/message", 5, 1030, {
      id: "human-interrupt",
      source: { kind: "user" },
      content: [{ type: "text", text: "好了，可以暂停了" }],
    }),
    event("step/start", 6, 1040, { turn: 12, step: 2 }),
    event("assistant/message", 7, 1050, {
      turn: 12,
      step: 2,
      message: { content: [{ type: "text", text: "最终答复" }] },
    }),
    event("turn/end", 8, 1060, { turn: 12, reason: { kind: "completed" } }),
  ]));
  assert.deepEqual(projection.turns[0].nodeKeys, [
    conversationContextKey("assistant-step", "12:1"),
    conversationContextKey("input-message", "human-interrupt"),
    conversationContextKey("assistant-step", "12:2"),
  ]);
  assert.deepEqual(projection.turns[0].interruptKeys, [
    conversationContextKey("input-message", "human-interrupt"),
  ]);
  assert.equal(projection.turns[0].finalReplyFrom, conversationContextKey("assistant-step", "12:2"));
});

test("下一轮 turn/start 先于真人消息时不把真人消息当成 interrupt", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 900, { id: "human-first", source: { kind: "user" } }),
    event("turn/start", 2, 1000, { turn: 1 }),
    event("step/start", 3, 1010, { turn: 1, step: 1 }),
    event("assistant/message", 4, 1020, {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "上一轮完成" }] },
    }),
    event("turn/end", 5, 1030, { turn: 1, reason: { kind: "completed" } }),
    event("turn/start", 6, 1040, { turn: 2 }),
    event("step/start", 7, 1050, { turn: 2, step: 1 }),
    event("user/message", 8, 1060, {
      id: "human-second",
      source: { kind: "user" },
      content: [{ type: "text", text: "下一轮真人消息" }],
    }),
    event("assistant/message", 9, 1070, {
      turn: 2,
      step: 1,
      message: { content: [{ type: "text", text: "下一轮答复" }] },
    }),
    event("turn/end", 10, 1080, { turn: 2, reason: { kind: "completed" } }),
  ]));
  assert.deepEqual(projection.turns.map(turn => turn.turnId), [
    "message:human-first:1",
    "message:human-second:2",
  ]);
  assert.deepEqual(projection.turns[1].nodeKeys, [
    conversationContextKey("assistant-step", "2:1"),
  ]);
  assert.equal(projection.turns[1].interruptKeys, undefined);
  assert.equal(projection.turns[1].finalReplyFrom, conversationContextKey("assistant-step", "2:1"));
});

test("seed 后插件与 skill-catalog 先于真人消息时进入新轮待领节点", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 900, { id: "old-human", source: { kind: "user" } }),
    event("turn/start", 2, 1000, { turn: 1 }),
    event("step/start", 3, 1010, { turn: 1, step: 1 }),
    event("assistant/message", 4, 1020, {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "旧轮完成" }] },
    }),
    event("turn/end", 5, 1030, { turn: 1, reason: { kind: "completed" } }),
    event("session/end-seed", 6, 1040),
    event("turn/start", 7, 1050, { turn: 2 }),
    event("step/start", 8, 1060, { turn: 2, step: 1 }),
    event("user/message", 9, 1070, {
      id: "runtime-context-before-human",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
    }),
    event("user/message", 10, 1080, {
      id: "skill-catalog-before-human",
      source: { kind: "skill-catalog", form: "catalog" },
    }),
    event("user/message", 11, 1090, {
      id: "new-human",
      source: { kind: "user" },
      content: [{ type: "text", text: "新轮真人消息" }],
    }),
    event("assistant/message", 12, 1100, {
      turn: 2,
      step: 1,
      message: { content: [{ type: "text", text: "新轮答复" }] },
    }),
  ]));
  assert.deepEqual(projection.turns[0].nodeKeys, [
    conversationContextKey("assistant-step", "1:1"),
  ]);
  assert.deepEqual(projection.turns[1].nodeKeys, [
    conversationContextKey("input-message", "runtime-context-before-human"),
    conversationContextKey("input-message", "skill-catalog-before-human"),
    conversationContextKey("assistant-step", "2:1"),
  ]);
  assert.equal(projection.turns[1].originKey, conversationContextKey("input-message", "new-human"));
  assert.equal(projection.turns[1].interruptKeys, undefined);
});

test("turn/start 后非真人注入先于真人消息时不把折叠锚点提前到真人消息前", () => {
  const state = fold([
    event("session/end-seed", 1, 900),
    event("turn/start", 2, 1000, { turn: 1 }),
    event("step/start", 3, 1010, { turn: 1, step: 1 }),
    event("user/message", 4, 1015, {
      id: "approval-before-human",
      source: { kind: "plugin", plugin: "user-approval" },
      content: [{ type: "text", text: "approval" }],
    }),
    event("user/message", 5, 1020, {
      id: "human-after-approval",
      source: "user",
      content: [{ type: "text", text: "你目前能看到多少工具可以用" }],
    }),
    event("user/message", 6, 1030, {
      id: "runtime-after-human",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
    }),
    event("user/message", 7, 1040, {
      id: "skills-after-human",
      source: { kind: "skill-catalog", form: "catalog" },
    }),
    event("assistant/message", 8, 1100, {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "答复" }] },
    }),
    event("turn/end", 9, 1110, { turn: 1, reason: { kind: "completed" } }),
  ]);
  const projection = viewTurnPresentation(state);
  assert.equal(projection.branchId, "message:human-after-approval");
  assert.equal(projection.turns.length, 1);
  const turn = projection.turns[0];
  assert.equal(turn.turnId, "message:human-after-approval:1");
  assert.equal(turn.originKey, conversationContextKey("input-message", "human-after-approval"));
  const internalTurn = state.turns[0];
  const approvalNode = internalTurn.nodes.find(node => node.key === conversationContextKey("input-message", "approval-before-human"));
  assert.ok(approvalNode, "真人消息前的非真人注入仍应归入本轮折叠");
  assert.ok(approvalNode.anchorSeq > 5, "非真人注入在展示锚点上必须排到真人消息之后");
});

test("turn 已开始但真人消息后才到达的首条上下文注入仍归入本轮过程", () => {
  const projection = viewTurnPresentation(fold([
    event("session/end-seed", 1, 880),
    event("turn/start", 2, 890, { turn: 8 }),
    event("step/start", 3, 895, { turn: 8, step: 1 }),
    event("user/message", 4, 900, { id: "human-after-turn", source: { kind: "user" } }),
    event("user/message", 5, 910, {
      id: "runtime-context-before-turn",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
      content: [{ type: "text", text: "当前模型与时间" }],
    }),
    event("user/message", 6, 920, {
      id: "runtime-context-before-turn-cleared",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "cleared" },
    }),
    event("assistant/message", 7, 1020, {
      turn: 8,
      step: 1,
      message: { content: [{ type: "text", text: "完成" }] },
    }),
    event("turn/end", 8, 1030, { turn: 8, reason: { kind: "completed" } }),
  ]));
  assert.deepEqual(projection.turns[0].nodeKeys, [
    conversationContextKey("input-message", "runtime-context-before-turn"),
    conversationContextKey("assistant-step", "8:1"),
  ]);
  assert.equal(projection.turns[0].finalReplyFrom, conversationContextKey("assistant-step", "8:1"));
});

test("turn 结束后才落盘的 skill-catalog 仍归入刚完成的本轮过程", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 900, { id: "human-late-catalog", source: { kind: "user" } }),
    event("turn/start", 2, 1000, { turn: 10 }),
    event("step/start", 3, 1010, { turn: 10, step: 1 }),
    event("assistant/message", 4, 1020, {
      turn: 10,
      step: 1,
      message: { content: [{ type: "text", text: "完成" }] },
    }),
    event("turn/end", 5, 1030, { turn: 10, reason: { kind: "completed" } }),
    event("user/message", 6, 1040, {
      id: "skill-catalog-late",
      source: { kind: "skill-catalog", form: "catalog" },
    }),
  ]));
  assert.deepEqual(projection.turns[0].nodeKeys, [
    conversationContextKey("assistant-step", "10:1"),
    conversationContextKey("input-message", "skill-catalog-late"),
  ]);
  assert.equal(projection.turns[0].finalReplyFrom, conversationContextKey("assistant-step", "10:1"));
});

test("turn/start 后立即到达的快照仍归入本轮，清空事件不占可见折叠键", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 900, { id: "human-early", source: { kind: "user" } }),
    event("turn/start", 2, 1000, { turn: 6 }),
    event("user/message", 3, 1005, {
      id: "runtime-context-early",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
    }),
    event("user/message", 4, 1006, {
      id: "runtime-context-cleared",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "cleared" },
    }),
    event("step/start", 5, 1010, { turn: 6, step: 1 }),
    event("assistant/message", 6, 1020, {
      turn: 6,
      step: 1,
      message: { content: [{ type: "text", text: "完成" }] },
    }),
  ]));
  assert.deepEqual(projection.turns[0].nodeKeys, [
    conversationContextKey("input-message", "runtime-context-early"),
    conversationContextKey("assistant-step", "6:1"),
  ]);
});

test("失败或取消的轮标记 interrupted 且不伪造正文边界", () => {
  const state = fold([
    event("turn/start", 1, 1000, { turn: 2 }),
    event("step/start", 2, 1010, { turn: 2, step: 1 }),
    event("assistant/message", 3, 1200, {
      turn: 2,
      step: 1,
      message: { content: [{ type: "text", text: "未完成" }] },
    }),
    event("turn/end", 4, 1300, { turn: 2, reason: { kind: "error" } }),
  ]);
  const turn = viewTurnPresentation(state).turns[0];
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.finalReplyFrom, undefined);
  assert.equal(turn.processEndedAt, undefined);
});

test("完成事件没有紧邻最终 assistant 结果时不从最后文本 step 猜正文边界", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 1000, { id: "human-2", source: { kind: "user" } }),
    event("turn/start", 2, 1010, { turn: 3 }),
    event("step/start", 3, 1020, { turn: 3, step: 1 }),
    event("assistant/message", 4, 1030, {
      turn: 3,
      step: 1,
      message: { content: [{ type: "text", text: "不能拿来猜正文" }] },
    }),
    event("llm/retry", 5, 1040, { turn: 3, retryId: "retry-1" }),
    event("turn/end", 6, 1050, { turn: 3, reason: { kind: "completed" } }),
  ]));
  const turn = projection.turns[0];
  assert.equal(turn.status, "settled");
  assert.equal(turn.finalReplyFrom, undefined, "没有连续的最终结果就保持边界缺失");
  assert.equal(turn.processEndedAt, undefined, "边界缺失时不伪造过程结束时间");
});

test("最终正文与 turn/end 之间只有非展示元事件时仍保留正文边界", () => {
  const projection = viewTurnPresentation(fold([
    event("user/message", 1, 1000, { id: "human-meta", source: { kind: "user" } }),
    event("turn/start", 2, 1010, { turn: 4 }),
    event("step/start", 3, 1020, { turn: 4, step: 2 }),
    event("assistant/message", 4, 1030, {
      turn: 4,
      step: 2,
      message: { content: [{ type: "text", text: "真实最终正文" }] },
    }),
    event("step/end", 5, 1040, { turn: 4, step: 2 }),
    event("turn/end", 6, 1050, { turn: 4, reason: { kind: "completed" } }),
  ]));
  const turn = projection.turns[0];
  assert.equal(turn.finalReplyFrom, "14:assistant-step4:2");
  assert.equal(turn.processEndedAt, 1030);
});

test("最后一个 seed 后首条真人消息更换 branchId，插件注入不冒充分支", () => {
  const beforeHuman = fold([
    event("user/message", 1, 1000, { id: "old", source: { kind: "user" } }),
    event("session/end-seed", 2, 1100),
    event("user/message", 3, 1200, { id: "plugin", source: { kind: "plugin" } }),
  ]);
  assert.equal(viewTurnPresentation(beforeHuman).branchId, "message:old");
  const afterHuman = applyTurnPresentation(beforeHuman, event("user/message", 4, 1300, {
    id: "new-branch",
    source: { kind: "user" },
  }));
  assert.equal(viewTurnPresentation(afterHuman).branchId, "message:new-branch");
  assert.deepEqual(viewTurnPresentation(afterHuman).turns, [], "新分支不得复用旧分支的轮级投影");
});

test("session/end-seed 保留已完成分支，直到下一条真人消息才切换", () => {
  const beforeBranch = fold([
    event("user/message", 1, 1000, { id: "old-branch", source: { kind: "user" } }),
    event("turn/start", 2, 1010, { turn: 9 }),
    event("step/start", 3, 1020, { turn: 9, step: 1 }),
  ]);
  const seeded = applyTurnPresentation(beforeBranch, event("session/end-seed", 4, 1100));
  assert.equal(viewTurnPresentation(seeded).branchId, "message:old-branch");
  assert.deepEqual(
    viewTurnPresentation(seeded).turns.map(turn => turn.turnId),
    ["message:old-branch:9"],
    "关闭会话只标记等待下一分支，不应让刚完成的旧分支在重启后消失",
  );
  assert.deepEqual(beforeBranch.turns.map(turn => turn.turnId), ["message:old-branch:9"], "切换只生成新的投影视图，不修改既有状态");
  const retryBranch = applyTurnPresentation(seeded, event("user/message", 5, 1200, {
    id: "retry-branch",
    source: { kind: "user" },
  }));
  assert.deepEqual(viewTurnPresentation(retryBranch).turns.map(turn => turn.turnId), ["message:old-branch:9"], "继续旧会话时保留历史轮级投影");
  const reusedTurn = applyTurnPresentation(retryBranch, event("turn/start", 6, 1210, { turn: 9 }));
  assert.equal(viewTurnPresentation(reusedTurn).turns[1].turnId, "message:retry-branch:9");
  assert.notEqual(
    viewTurnPresentation(reusedTurn).turns[1].turnId,
    viewTurnPresentation(beforeBranch).turns[0].turnId,
    "官方 turn 数字重用时，分支投影仍必须产生新的 turnId",
  );
});
