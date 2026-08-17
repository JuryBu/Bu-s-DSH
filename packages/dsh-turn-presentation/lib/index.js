import { z } from "zod";

export const name = "stardust-turn-presentation";

const turnSchema = z.object({
  turnId: z.string().min(1),
  status: z.enum(["running", "settled", "interrupted"]),
  nodeKeys: z.array(z.string().min(1)),
  interruptKeys: z.array(z.string().min(1)).optional(),
  finalReplyFrom: z.string().min(1).optional(),
  processStartedAt: z.number().finite().optional(),
  processEndedAt: z.number().finite().optional(),
}).strict();

export const turnPresentationSchema = z.object({
  version: z.literal(1),
  branchId: z.string().min(1),
  turns: z.array(turnSchema),
}).strict();

export function conversationContextKey(kind, id) {
  return `${kind.length}:${kind}${id}`;
}

function assistantStepKey(turn, step) {
  return conversationContextKey("assistant-step", `${turn}:${step}`);
}

function toolCallKey(callId) {
  return conversationContextKey("tool-call", String(callId));
}

function modelRetryKey(retryId) {
  return conversationContextKey("model-retry", String(retryId));
}

function inputMessageKey(messageId) {
  return conversationContextKey("input-message", String(messageId));
}

function visibleBlock(block) {
  if (block === null || typeof block !== "object" || block.type === "tool-call") return false;
  if (block.type === "text" || block.type === "reasoning") {
    return typeof block.text === "string" && block.text.trim() !== "";
  }
  return true;
}

function textBlock(block) {
  return block !== null
    && typeof block === "object"
    && block.type === "text"
    && typeof block.text === "string"
    && block.text.trim() !== "";
}

function chunkFacts(chunk) {
  if (chunk === null || typeof chunk !== "object") return { visible: false, text: false };
  if (chunk.type === "text-delta") {
    const present = typeof chunk.text === "string" && chunk.text.trim() !== "";
    return { visible: present, text: present };
  }
  if (chunk.type === "reasoning-delta") {
    return { visible: typeof chunk.text === "string" && chunk.text.trim() !== "", text: false };
  }
  if (chunk.type === "block-end") {
    return { visible: visibleBlock(chunk.block), text: textBlock(chunk.block) };
  }
  return { visible: false, text: false };
}

function projectionTurnId(branchId, turn) {
  return `${branchId}:${turn}`;
}

function makeTurn(branchId, turn, time) {
  return {
    turnId: projectionTurnId(branchId, turn),
    status: "running",
    nodes: [],
    steps: [],
    ...(Number.isFinite(time) ? { processStartedAt: time } : {}),
  };
}

function findTurn(state, turn) {
  return state.turns.findIndex(candidate => candidate.turnId === projectionTurnId(state.branchId, turn));
}

function ensureTurn(state, turn, time) {
  const index = findTurn(state, turn);
  if (index >= 0) return { state, index };
  return {
    state: { ...state, turns: [...state.turns, makeTurn(state.branchId, turn, time)] },
    index: state.turns.length,
  };
}

function replaceTurn(state, index, turn) {
  const turns = state.turns.slice();
  turns[index] = turn;
  return { ...state, turns };
}

function addNode(turn, key, anchorSeq) {
  if (typeof key !== "string" || key === "" || !Number.isFinite(anchorSeq)) return turn;
  const existing = turn.nodes.findIndex(node => node.key === key);
  if (existing >= 0) {
    if (turn.nodes[existing].anchorSeq <= anchorSeq) return turn;
    const nodes = turn.nodes.slice();
    nodes[existing] = { key, anchorSeq };
    return { ...turn, nodes };
  }
  return { ...turn, nodes: [...turn.nodes, { key, anchorSeq }] };
}

function addInterruptNode(turn, key, anchorSeq) {
  const next = addNode(turn, key, anchorSeq);
  const interruptKeys = Array.isArray(next.interruptKeys) ? next.interruptKeys : [];
  if (interruptKeys.includes(key)) return next;
  return { ...next, interruptKeys: [...interruptKeys, key] };
}

function updateStep(turn, stepNumber, update) {
  const stepId = String(stepNumber);
  const index = turn.steps.findIndex(step => step.stepId === stepId);
  const previous = index >= 0 ? turn.steps[index] : { stepId };
  const next = update(previous);
  if (next === previous) return turn;
  const steps = turn.steps.slice();
  if (index >= 0) steps[index] = next;
  else steps.push(next);
  return { ...turn, steps };
}

function applyChunk(turn, event) {
  const facts = chunkFacts(event.data.chunk);
  if (!facts.visible && !facts.text) return turn;
  let next = updateStep(turn, event.data.step, step => ({
    ...step,
    ...(Number.isFinite(step.firstVisibleTime ?? event.time) ? { firstVisibleTime: step.firstVisibleTime ?? event.time } : {}),
    ...(facts.text && Number.isFinite(step.firstTextTime ?? event.time) ? { firstTextTime: step.firstTextTime ?? event.time } : {}),
    visible: step.visible === true || facts.visible,
  }));
  if (facts.visible) next = addNode(next, assistantStepKey(event.data.turn, event.data.step), event.seq);
  return next;
}

function applyAssistantMessage(turn, event) {
  const content = Array.isArray(event.data.message?.content) ? event.data.message.content : [];
  const visible = content.some(visibleBlock);
  const hasText = content.some(textBlock);
  let next = updateStep(turn, event.data.step, step => ({
    ...step,
    visible: step.visible === true || visible,
    hasText,
    finalSeq: event.seq,
    finalTime: event.time,
    ...(visible && Number.isFinite(step.firstVisibleTime ?? event.time) ? { firstVisibleTime: step.firstVisibleTime ?? event.time } : {}),
    ...(hasText && Number.isFinite(step.firstTextTime ?? event.time) ? { firstTextTime: step.firstTextTime ?? event.time } : {}),
  }));
  if (visible) next = addNode(next, assistantStepKey(event.data.turn, event.data.step), event.seq);
  return next;
}

function settleTurn(turn, event) {
  const completed = event.data.reason?.kind === "completed";
  if (!completed) return { ...turn, status: "interrupted" };
  const lastNode = turn.nodes.reduce((latest, node) => latest === undefined || node.anchorSeq > latest.anchorSeq ? node : latest, undefined);
  const closing = turn.steps
    .filter(step => step.hasText === true && Number.isFinite(step.finalSeq))
    .sort((left, right) => right.finalSeq - left.finalSeq)
    .find(step => lastNode?.key === assistantStepKey(event.data.turn, step.stepId));
  if (closing === undefined) return { ...turn, status: "settled" };
  const processEndedAt = closing.firstTextTime ?? closing.finalTime;
  return {
    ...turn,
    status: "settled",
    finalReplyFrom: assistantStepKey(event.data.turn, closing.stepId),
    ...(Number.isFinite(processEndedAt) ? { processEndedAt } : {}),
  };
}

function claimPendingTurn(state, turnNumber, turn) {
  if (!state.awaitingTurnStart) return { state, turn };
  let nextTurn = turn;
  const pendingTurnNodes = Array.isArray(state.pendingTurnNodes) ? state.pendingTurnNodes : [];
  for (const node of pendingTurnNodes) nextTurn = addNode(nextTurn, node.key, node.anchorSeq);
  return {
    state: {
      ...state,
      activeTurn: turnNumber,
      awaitingTurnStart: false,
      pendingTurnNodes: [],
    },
    turn: nextTurn,
  };
}

export function createTurnPresentationState() {
  return {
    version: 1,
    branchId: "unbound",
    awaitingBranchUser: true,
    awaitingTurnStart: false,
    pendingTurnNodes: [],
    turns: [],
  };
}

export function applyTurnPresentation(state, event) {
  if (event === null || typeof event !== "object") return state;
  if (event.type === "session/end-seed") {
    const { activeTurn: _activeTurn, ...rest } = state;
    return {
      ...rest,
      awaitingBranchUser: true,
      awaitingTurnStart: false,
      pendingTurnNodes: [],
    };
  }
  if (event.type === "user/message" && event.data?.source?.kind === "user") {
    if (!state.awaitingBranchUser && state.branchId !== "unbound") {
      if (!Number.isSafeInteger(state.activeTurn)) return state;
      const id = typeof event.data.id === "string" && event.data.id !== "" ? event.data.id : String(event.seq);
      const ensured = ensureTurn(state, state.activeTurn, event.time);
      const turn = addInterruptNode(ensured.state.turns[ensured.index], inputMessageKey(id), event.seq);
      return replaceTurn(ensured.state, ensured.index, turn);
    }
    const id = typeof event.data.id === "string" && event.data.id !== "" ? event.data.id : String(event.seq);
    const { activeTurn: _activeTurn, ...rest } = state;
    const branchId = `message:${id}`;
    const activeTurn = Number.isSafeInteger(state.activeTurn) ? state.activeTurn : undefined;
    return {
      ...rest,
      branchId,
      awaitingBranchUser: false,
      awaitingTurnStart: activeTurn === undefined,
      ...(activeTurn === undefined ? {} : { activeTurn }),
      pendingTurnNodes: [],
      turns: state.turns.map(turn => activeTurn !== undefined && turn.turnId.endsWith(`:${activeTurn}`) && turn.status === "running"
        ? { ...turn, turnId: `${branchId}:${activeTurn}` }
        : turn),
    };
  }
  if (event.type === "user/message" && ["plugin", "skill-catalog"].includes(event.data?.source?.kind)) {
    if (event.data.source.plugin === "@deepseek-ai/dsh-system-prompt" && event.data.source.form === "cleared") return state;
    const messageId = typeof event.data.id === "string" && event.data.id !== "" ? event.data.id : String(event.seq);
    if (!Number.isSafeInteger(state.activeTurn)) {
      if (!state.awaitingTurnStart) {
        const lastIndex = state.turns.length - 1;
        if (lastIndex < 0) return state;
        const lastTurn = state.turns[lastIndex];
        if (!lastTurn.turnId.startsWith(`${state.branchId}:`)) return state;
        return replaceTurn(state, lastIndex, addNode(lastTurn, inputMessageKey(messageId), event.seq));
      }
      const pendingTurnNodes = Array.isArray(state.pendingTurnNodes) ? state.pendingTurnNodes : [];
      if (pendingTurnNodes.some(node => node.key === inputMessageKey(messageId))) return state;
      return {
        ...state,
        pendingTurnNodes: [...pendingTurnNodes, { key: inputMessageKey(messageId), anchorSeq: event.seq }],
      };
    }
    const ensured = ensureTurn(state, state.activeTurn, event.time);
    const turn = addNode(ensured.state.turns[ensured.index], inputMessageKey(messageId), event.seq);
    return replaceTurn(ensured.state, ensured.index, turn);
  }
  const turnNumber = event.data?.turn;
  if (!Number.isSafeInteger(turnNumber) || turnNumber < 0) return state;
  const ensured = ensureTurn(state, turnNumber, event.time);
  let projectionState = ensured.state;
  let turn = ensured.state.turns[ensured.index];
  if (event.type === "turn/start") {
    if (!(turn.status === "running" && turn.nodes.length === 0 && turn.steps.length === 0)) {
      turn = makeTurn(ensured.state.branchId, turnNumber, event.time);
    }
    ({ state: projectionState, turn } = claimPendingTurn(projectionState, turnNumber, turn));
  } else if (event.type === "step/start") {
    ({ state: projectionState, turn } = claimPendingTurn(projectionState, turnNumber, turn));
    turn = {
      ...turn,
      ...(Number.isFinite(turn.processStartedAt ?? event.time) ? { processStartedAt: turn.processStartedAt ?? event.time } : {}),
    };
    turn = updateStep(turn, event.data.step, step => ({
      ...step,
      ...(Number.isFinite(step.startedAt ?? event.time) ? { startedAt: step.startedAt ?? event.time } : {}),
    }));
  } else if (event.type === "assistant/chunk") {
    ({ state: projectionState, turn } = claimPendingTurn(projectionState, turnNumber, turn));
    turn = applyChunk(turn, event);
  } else if (event.type === "assistant/message") {
    ({ state: projectionState, turn } = claimPendingTurn(projectionState, turnNumber, turn));
    turn = applyAssistantMessage(turn, event);
  } else if (event.type === "tool/call") {
    ({ state: projectionState, turn } = claimPendingTurn(projectionState, turnNumber, turn));
    turn = addNode(turn, toolCallKey(event.data.callId), event.seq);
  } else if (event.type === "llm/retry" && typeof event.data.retryId === "string" && event.data.retryId !== "") {
    ({ state: projectionState, turn } = claimPendingTurn(projectionState, turnNumber, turn));
    turn = addNode(turn, modelRetryKey(event.data.retryId), event.seq);
  } else if (event.type === "turn/end") {
    ({ state: projectionState, turn } = claimPendingTurn(projectionState, turnNumber, turn));
    turn = settleTurn(turn, event);
  } else {
    return ensured.state === state ? state : ensured.state;
  }
  const next = replaceTurn(projectionState, ensured.index, turn);
  if (event.type === "turn/start") {
    return {
      ...next,
      activeTurn: turnNumber,
      awaitingTurnStart: false,
      pendingTurnNodes: [],
    };
  }
  if (event.type === "step/start") return { ...next, activeTurn: turnNumber };
  if (event.type === "turn/end") {
    const { activeTurn: _activeTurn, ...rest } = next;
    return rest;
  }
  return next;
}

export function viewTurnPresentation(state) {
  return {
    version: 1,
    branchId: state.branchId,
    turns: state.turns.map(turn => ({
      turnId: turn.turnId,
      status: turn.status,
      nodeKeys: turn.nodes
        .slice()
        .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
        .map(node => node.key),
      ...(Array.isArray(turn.interruptKeys) && turn.interruptKeys.length > 0 ? { interruptKeys: turn.interruptKeys.slice() } : {}),
      ...(typeof turn.finalReplyFrom === "string" ? { finalReplyFrom: turn.finalReplyFrom } : {}),
      ...(Number.isFinite(turn.processStartedAt) ? { processStartedAt: turn.processStartedAt } : {}),
      ...(Number.isFinite(turn.processEndedAt) ? { processEndedAt: turn.processEndedAt } : {}),
    })),
  };
}

export const turnPresentationProjectionDefinition = {
  key: "turnPresentation",
  schema: turnPresentationSchema,
  init: createTurnPresentationState,
  apply: applyTurnPresentation,
  view: viewTurnPresentation,
  stateVersion: 8,
};

export function apply(ctx) {
  return ctx.inject(["sessionProjections"], projectionCtx => (
    projectionCtx.sessionProjections.register(turnPresentationProjectionDefinition)
  ));
}
