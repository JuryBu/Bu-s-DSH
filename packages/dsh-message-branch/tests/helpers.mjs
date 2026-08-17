import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function withPackageTemp(label, run) {
  const root = path.join(packageRoot, ".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rmdir(path.dirname(root)).catch(error => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
        throw error;
      }
    });
  }
}

export function makeMessage(id, text, source = { kind: "user" }) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source,
  };
}

export function makeEvent(seq, type, data, options = {}) {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type,
    data,
    ...options,
  };
}

export function sourceEvents() {
  return [
    makeEvent(0, "turn/start", { turn: 1 }),
    makeEvent(1, "user/message", makeMessage("user-0", "第一条消息"), { surfaceOp: "append" }),
    makeEvent(2, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    makeEvent(3, "turn/start", { turn: 2 }),
    makeEvent(4, "user/message", makeMessage("user-1", "需要编辑的上一条真人消息"), { surfaceOp: "append" }),
    makeEvent(5, "turn/end", { turn: 2, reason: { kind: "completed" } }),
    makeEvent(6, "turn/start", { turn: 3 }),
    makeEvent(7, "user/message", makeMessage("plugin-0", "自动注入", { kind: "plugin", plugin: "fixture" }), { surfaceOp: "append" }),
    makeEvent(8, "turn/end", { turn: 3, reason: { kind: "completed" } }),
  ];
}

function nextTurn(events) {
  return events.reduce((highest, event) => event.type === "turn/start" ? Math.max(highest, event.data.turn) : highest, -1) + 1;
}

export function makeSourceAgent({ id = "session-parent", cwd, events = sourceEvents(), status = "idle" } = {}) {
  const listeners = new Map();
  const ctx = {
    id: `ctx-${id}`,
    on(name, listener) {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
      return () => listeners.set(name, entries.filter(candidate => candidate !== listener));
    },
    async waterfall(name, payload, context, terminal) {
      const entries = listeners.get(name) ?? [];
      let index = 0;
      const next = async () => {
        const listener = entries[index++];
        if (listener === undefined) return terminal();
        return name === "agent/request" ? listener(payload, next) : listener(payload, context, next);
      };
      return next();
    },
  };
  const session = {
    id,
    header: {
      version: 0,
      id,
      createdAt: 1_700_000_000_000,
      ...(cwd === undefined ? {} : { cwd }),
      agentPreset: "main",
    },
    events: structuredClone(events),
    surface: {
      get nodes() {
        const nodes = [];
        for (const event of session.events) {
          if (event.surfaceOp === "append") nodes.push(event.seq);
          else if (event.surfaceOp?.op === "replace") {
            const start = nodes.indexOf(event.surfaceOp.start);
            const end = nodes.indexOf(event.surfaceOp.end);
            nodes.splice(start, end - start + 1, event.seq);
          }
        }
        return nodes;
      },
    },
  };
  const agent = {
    id,
    status,
    inbox: { hasPending: false },
    session,
    ctx,
    options: { fixture: true },
    async runMaintenance(callback) {
      return callback(new AbortController().signal);
    },
    followup(message) {
      const turn = nextTurn(session.events);
      session.events.push(makeEvent(session.events.length, "turn/start", { turn }));
      const replacement = message.dshSurfaceReplace;
      const { dshSurfaceReplace: _ignored, ...loggedMessage } = structuredClone(message);
      session.events.push(makeEvent(session.events.length, "user/message", loggedMessage, replacement === undefined
        ? { surfaceOp: "append" }
        : {
            surfaceOp: { op: "replace", start: replacement.start, end: replacement.end },
            sourceEventSeqs: replacement.sourceEventSeqs,
          }));
      session.events.push(makeEvent(session.events.length, "turn/end", { turn, reason: { kind: "completed" } }));
    },
  };
  return agent;
}

export class FakeAgentRegistry {
  constructor(sourceAgent) {
    this.items = new Map([[sourceAgent.id, sourceAgent]]);
    this.created = [];
    this.beforeCommit = undefined;
  }

  get(id) {
    return this.items.get(id);
  }

  async create(options) {
    const session = {
      id: options.sessionId,
      header: {
        version: 0,
        id: options.sessionId,
        createdAt: 1_700_000_100_000,
        ...structuredClone(options.meta),
      },
      events: structuredClone(options.seed ?? []),
    };
    const childCtx = {
      contexts: [],
      listeners: new Map(),
      systemPrompt: {
        context: value => childCtx.contexts.push(structuredClone(value)),
      },
      on(name, listener) {
        const listeners = childCtx.listeners.get(name) ?? [];
        listeners.push(listener);
        childCtx.listeners.set(name, listeners);
        return () => childCtx.listeners.set(name, listeners.filter(candidate => candidate !== listener));
      },
      async waterfall(name, payload, context, terminal) {
        const listeners = childCtx.listeners.get(name) ?? [];
        let index = 0;
        const next = async () => {
          const listener = listeners[index++];
          if (listener === undefined) return terminal();
          return name === "agent/request" ? listener(payload, next) : listener(payload, context, next);
        };
        return next();
      },
    };
    const staged = await options.setup(childCtx);
    await this.beforeCommit?.({ options, session, childCtx });
    await staged?.commit?.();
    const child = {
      id: options.sessionId,
      status: "idle",
      inbox: { hasPending: false },
      session,
      ctx: childCtx,
      options: structuredClone(options.agentOptions),
      followup(message) {
        const turn = nextTurn(session.events);
        session.events.push(makeEvent(session.events.length, "turn/start", { turn }));
        session.events.push(makeEvent(session.events.length, "user/message", structuredClone(message), { surfaceOp: "append" }));
        session.events.push(makeEvent(session.events.length, "turn/end", { turn, reason: { kind: "completed" } }));
      },
    };
    const handle = {
      agent: child,
      disposed: false,
      dispose: async () => {
        handle.disposed = true;
        this.items.delete(child.id);
      },
    };
    this.items.set(child.id, child);
    this.created.push({ options, childCtx, child, handle });
    return handle;
  }
}

export function makeHarness({ sourceAgent, registry, store, attachments, replayRegistry, emitted = [] }) {
  let messageNumber = 0;
  const workspace = {
    sessionIds: [sourceAgent.id],
    attached: [],
    detached: [],
    async attachSession(id) {
      this.attached.push(id);
      this.sessionIds.push(id);
    },
    async detachSession(id) {
      this.detached.push(id);
      this.sessionIds = this.sessionIds.filter(item => item !== id);
    },
  };
  return {
    workspace,
    options: {
      agents: registry,
      agentPresets: {
        composedPreset: () => "main",
        composeFrom: childCtx => {
          childCtx.composedFrom = sourceAgent.ctx.id;
        },
      },
      workspaceRegistry: { list: () => [workspace] },
      attachments,
      sessions: {
        flushes: [],
        async flush(session) {
          this.flushes.push(session.id);
        },
      },
      createUserMessage({ content, source, ...rest }) {
        messageNumber += 1;
        return { id: `edited-${messageNumber}`, role: "user", content: structuredClone(content), source: structuredClone(source), ...structuredClone(rest) };
      },
      sessionIdFactory: () => `session-child-${registry.created.length + 1}`,
      store,
      replayRegistry,
      emitState: record => emitted.push(structuredClone(record)),
      now: (() => {
        let tick = 0;
        return () => `2026-08-16T05:30:${String(tick++).padStart(2, "0")}.000Z`;
      })(),
      acceptanceTimeoutMs: 200,
    },
  };
}

export function assertBranchError(assert, code) {
  return error => {
    assert.equal(error?.code, code);
    return true;
  };
}
