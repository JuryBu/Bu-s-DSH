const roleItems = { type: "string", enum: ["system", "user", "assistant", "tool"] };
const rangeItems = {
  type: "object",
  additionalProperties: false,
  properties: {
    start: { type: "integer", required: true, description: "起始轮号，包含该轮。" },
    end: { type: "integer", required: true, description: "结束轮号，包含该轮。" },
  },
};

function jsonOutput(summary) {
  return {
    schema: { type: "json" },
    render: (_args, value) => {
      const continuation = typeof value?.continuationCursor === "string" && value.continuationCursor.length > 0
        ? `\n\n➡️ 下一段参数（必须原样复制）\n${JSON.stringify({ continuation_cursor: value.continuationCursor })}`
        : "";
      return [{ type: "text", text: `${summary}\n${JSON.stringify(value, null, 2)}${continuation}` }];
    },
  };
}

function toLosslessJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("线程工具返回了非有限数字");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : toLosslessJson(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, toLosslessJson(item)]));
  }
  throw new TypeError("线程工具返回了不能转换为无损 JSON 的值");
}

function losslessExecute(execute) {
  return async (...args) => toLosslessJson(await execute(...args));
}

function hasStableFragmentLocator(round) {
  const source = round?.source;
  return typeof source?.blockId === "string" && source.blockId.length > 0
    && Number.isSafeInteger(source.startOffset) && source.startOffset >= 0
    && Number.isSafeInteger(source.endOffset) && source.endOffset > source.startOffset
    && source.unit === "utf8-byte"
    && typeof source.contentHash === "string" && /^[0-9a-f]{64}$/iu.test(source.contentHash);
}

function assertDeliveredRoundsComplete(result, operation) {
  const partialRounds = result?.rounds?.filter(round => round?.partial === true) ?? [];
  const unlocatedPartial = result?.partial === true && partialRounds.length === 0
    || partialRounds.some(round => !hasStableFragmentLocator(round));
  if (unlocatedPartial) {
    throw new ThreadIntegrationError("thread_read_partial_round", `${operation} 包含没有稳定 block/offset/content hash 定位符的不完整原始轮，不能为该轮签发可确认回执`);
  }
  if (!Array.isArray(result?.rounds) || result.rounds.length === 0) {
    throw new ThreadIntegrationError("thread_read_no_rounds", `${operation} 本次没有实际交付完整原始轮，不能签发读取回执`);
  }
}

function currentSessionSummary(exec) {
  const session = exec?.agent?.session;
  if (!session?.id) return undefined;
  let title;
  if (Array.isArray(session.events)) {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index];
      if (event?.type !== "session/title") continue;
      title = event.data?.title ?? event.data?.text;
      if (typeof title === "string" && title.trim()) break;
    }
  }
  return {
    sessionId: String(session.id),
    title: typeof title === "string" && title.trim() ? title.trim() : "当前会话",
    current: true,
    live: true,
  };
}

export function createThreadToolDefinitions({ defineTool, source, ledger }) {
  const recentReceipts = new Map();
  const ownerKey = exec => String(exec?.agent?.session?.id ?? "unknown-owner");
  const rememberReceipt = (exec, result, receipt) => {
    const key = ownerKey(exec);
    const history = recentReceipts.get(key) ?? [];
    history.push({
      readReceiptId: receipt.readReceiptId,
      sessionId: result.sessionId,
      rounds: [...receipt.rounds],
    });
    recentReceipts.set(key, history.slice(-32));
  };
  const resolveReceipt = (exec, rounds, sessionId) => {
    const wanted = new Set(rounds);
    const history = recentReceipts.get(ownerKey(exec)) ?? [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const receipt = history[index];
      if (sessionId !== undefined && receipt.sessionId !== sessionId) continue;
      if ([...wanted].every(round => receipt.rounds.includes(round))) return receipt.readReceiptId;
    }
    throw new ThreadIntegrationError("thread_confirm_without_visible_read", "这些轮没有匹配的当前读取记录；请先用 thread_read 或 thread_recall 读取原文，再确认真正有用的轮");
  };
  return [
    defineTool({
      name: "thread_list",
      description: "列出可读取的 DSH 对话，并明确返回当前会话编号。先用它定位跨会话目标；读取当前会话原文时可直接把 current_session_id 交给 thread_recall，或省略 session_id。不会读取整段正文。",
      parameters: {
        limit: { type: "integer", description: "本页最多返回多少条。" },
        continuation_cursor: { type: "string", description: "上一页返回的续读光标。" },
      },
      output: jsonOutput("已列出 DSH 对话"),
      execute: losslessExecute(async (args, exec) => {
        const result = await source.listThreads({ limit: args.limit, continuationCursor: args.continuation_cursor });
        const current = currentSessionSummary(exec);
        if (!current) return result;
        const sessions = Array.isArray(result.sessions) ? result.sessions : [];
        const merged = args.continuation_cursor || sessions.some(entry => entry.sessionId === current.sessionId)
          ? sessions.map(entry => entry.sessionId === current.sessionId ? { ...entry, current: true, live: true } : entry)
          : [current, ...sessions];
        return { ...result, currentSessionId: current.sessionId, sessions: merged };
      }),
    }),
    defineTool({
      name: "thread_search",
      description: "搜索 DSH 对话标题或指定对话内的历史内容。首次搜索必须填写 query；继续读取当前会话的下一页时可以只传上一页 continuation_cursor，查询词、会话和角色会从光标恢复。搜索只返回短预览；需要原文时再用 thread_read 按轮读取。",
      parameters: {
        query: { type: "string", description: "首次搜索要查找的文字；继续读取当前会话下一页时可以省略。" },
        session_id: { type: "string", description: "可选；指定后只搜索这一条对话。" },
        roles: { type: "array", items: roleItems, description: "可选的消息角色过滤。" },
        limit: { type: "integer", description: "本页最多返回多少条。" },
        preview_bytes: { type: "integer", description: "每条预览的大致字节上限。" },
        continuation_cursor: { type: "string", description: "上一页返回的续读光标。" },
      },
      output: jsonOutput("已搜索 DSH 对话"),
      execute: losslessExecute((args, exec) => source.searchThreads({
        query: args.query,
        sessionId: args.session_id,
        roles: args.roles,
        limit: args.limit,
        previewBytes: args.preview_bytes,
        continuationCursor: args.continuation_cursor,
      }, exec)),
    }),
    defineTool({
      name: "thread_read",
      description: "按轮次分页读取已定位的 DSH 对话。当前会话需要直接恢复原文时优先使用 thread_recall；跨会话分页和缓存续读可使用本工具。超大单轮会按带稳定 block、offset 与内容哈希的实际片段续读并签发回执，确认热度仍只归属原轮。",
      parameters: {
        session_id: { type: "string", required: true, description: "目标 DSH 会话编号。" },
        ranges: { type: "array", items: rangeItems, description: "可选的轮次范围；不填表示从可读内容开头分页。" },
        roles: { type: "array", items: roleItems, description: "可选的消息角色过滤。" },
        max_bytes: { type: "integer", description: "本次返回正文的字节预算。" },
        max_tokens: { type: "integer", description: "本次返回正文的估算 Token 预算。" },
        continuation_cursor: { type: "string", description: "上一页返回的续读光标；续读时不能更换范围或角色。" },
        operation_id: { type: "string", description: "可选；只有重试时复用同一编号才幂等，省略后每次执行都会生成新编号。" },
      },
      output: jsonOutput("已读取 DSH 对话片段"),
      execute: losslessExecute(async (args, exec) => {
        const result = await source.readThread({
          sessionId: args.session_id,
          ranges: args.ranges,
          roles: args.roles,
          maxBytes: args.max_bytes,
          maxTokens: args.max_tokens,
          continuationCursor: args.continuation_cursor,
        }, exec);
        assertDeliveredRoundsComplete(result, "thread_read");
        const receipt = await ledger.registerRead(exec, result, { operationId: args.operation_id });
        rememberReceipt(exec, result, receipt);
        return {
          ...result,
          receiptRounds: receipt.rounds,
          readReceiptTracked: true,
          ledgerDurability: receipt.ledgerDurability,
        };
      }),
    }),
    defineTool({
      name: "thread_recall",
      description: "恢复 DSH 对话 raw 原文。当前会话 manual 可省略 session_id，直接读取原生 session events，不调用 readSession 或 Memory Store；跨会话、跨宿主、full/auto 深层恢复以及明确的原生不可用才调用 Memory Store。预算不足时会在完整轮边界分页；超大单轮只有附带稳定 block、offset 与内容哈希的实际片段才能签发回执，确认热度仍只归属原轮。压缩摘要、Record 和替换摘要不会伪装成 raw。",
      parameters: {
        session_id: { type: "string", description: "目标会话编号；当前会话可省略。" },
        recall_mode: { type: "string", enum: ["manual", "full", "auto"], description: "manual 优先当前会话原生读取；full 和 auto 交给 Memory Store 深层恢复。" },
        data_chain: { type: "string", enum: ["dsh", "deepseek-harness", "codex", "antigravity", "claude-code", "windsurf", "wsf"], description: "对话来源宿主；不填默认当前 DSH。跨宿主时由 Memory Store 读取。" },
        start_round: { type: "integer", description: "manual 恢复的起始轮，包含该轮。" },
        end_round: { type: "integer", description: "manual 恢复的结束轮，包含该轮。" },
        roles: { type: "array", items: roleItems, description: "可选的消息角色过滤。" },
        max_bytes: { type: "integer", description: "本次返回 raw 原文的字节预算。" },
        max_tokens: { type: "integer", description: "本次返回 raw 原文的估算 Token 预算。" },
        continuation_cursor: { type: "string", description: "Memory Store 返回的续读光标；full、auto 与跨会话 recall 必须原样回传。" },
        operation_id: { type: "string", description: "可选；只有重试时复用同一编号才幂等，省略后每次执行都会生成新编号。" },
      },
      output: jsonOutput("已恢复 DSH raw 原文并签发本地读取回执"),
      execute: losslessExecute(async (args, exec) => {
        const result = await source.recallThread({
          sessionId: args.session_id,
          recallMode: args.recall_mode ?? "manual",
          dataChain: args.data_chain ?? "dsh",
          startRound: args.start_round,
          endRound: args.end_round,
          roles: args.roles,
          maxBytes: args.max_bytes,
          maxTokens: args.max_tokens,
          continuationCursor: args.continuation_cursor,
        }, exec);
        if (result.contentKind !== "raw" || !Array.isArray(result.rounds) || result.rounds.length === 0
          || result.rounds.some(round => round.contentKind !== "raw" || round.source?.contentKind !== "raw")) {
          throw new ThreadIntegrationError("thread_recall_not_raw", "thread_recall 只允许为实际交付的 raw 原文轮签发回执");
        }
        assertDeliveredRoundsComplete(result, "thread_recall");
        const receipt = await ledger.registerRead(exec, result, { operationId: args.operation_id });
        rememberReceipt(exec, result, receipt);
        return {
          ...result,
          receiptRounds: receipt.rounds,
          readReceiptTracked: true,
          ledgerDurability: receipt.ledgerDurability,
          receiptDuplicate: receipt.duplicate,
        };
      }),
    }),
    defineTool({
      name: "thread_confirm",
      description: "在确实读懂并用于当前工作后，确认最近读取记录中的有用轮。后台自动匹配当前读取记录，不需要传递回执编号；不要把一次批量读取的所有轮顺手全部确认。明确顺序时填写 ordered_rounds。",
      parameters: {
        session_id: { type: "string", description: "可选；最近读取过多条对话且轮号可能重叠时，用它指定目标 DSH 会话。" },
        rounds: { type: "array", required: true, items: { type: "integer" }, description: "这张回执中真正有用的轮号。" },
        ordered_rounds: { type: "array", items: { type: "integer" }, description: "可选；与 rounds 成员相同，顺序表示重要性或使用先后。" },
        operation_id: { type: "string", description: "可选；只有重试时复用同一编号才幂等，省略后每次执行都会生成新编号。" },
      },
      output: jsonOutput("已确认真正有用的历史轮"),
      execute: losslessExecute((args, exec) => ledger.confirm(exec, {
        readReceiptId: resolveReceipt(exec, args.rounds, args.session_id),
        rounds: args.rounds,
        orderedRounds: args.ordered_rounds,
        operationId: args.operation_id,
      })),
    }),
    defineTool({
      name: "thread_protect",
      description: "临时保护当前任务仍需要详细展示的历史轮。保护不是永久收藏；任务完成后必须用 thread_release_protection 解除。",
      parameters: {
        session_id: { type: "string", required: true, description: "目标 DSH 会话编号。" },
        ranges: { type: "array", required: true, items: rangeItems, description: "需要临时保护的轮次范围。" },
        operation_id: { type: "string", description: "可选；只有重试时复用同一编号才幂等，省略后每次执行都会生成新编号。" },
      },
      output: jsonOutput("已创建历史轮保护"),
      execute: losslessExecute((args, exec) => ledger.protect(exec, {
        sessionId: args.session_id,
        ranges: args.ranges,
        operationId: args.operation_id,
      })),
    }),
    defineTool({
      name: "thread_release_protection",
      description: "任务结束或不再需要详细历史后，解除一项 thread_protect 保护。",
      parameters: {
        protection_id: { type: "string", required: true, description: "thread_protect 返回的保护编号。" },
        session_id: { type: "string", description: "可选；用于再次核对目标会话。" },
        operation_id: { type: "string", description: "可选；只有重试时复用同一编号才幂等，省略后每次执行都会生成新编号。" },
      },
      output: jsonOutput("已解除历史轮保护"),
      execute: losslessExecute((args, exec) => ledger.release(exec, {
        protectionId: args.protection_id,
        sessionId: args.session_id,
        operationId: args.operation_id,
      })),
    }),
  ];
}
import { ThreadIntegrationError } from "./errors.js";
