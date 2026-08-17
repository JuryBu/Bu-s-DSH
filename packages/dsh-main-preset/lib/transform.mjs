const PERSONA_BLOCK = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`;

const ZH_PERSONA_BLOCK = `- id: persona
  name: '@stardust/dsh-zh-prompt-suite'
  config:
    watchRules: true`;

const INSTRUCTION_BLOCK = `- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536`;

const ZH_INSTRUCTION_BLOCK = `- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
    instructionFileCandidates:
      - AGENTS.md
      - DSH.md
    localInstructionFileCandidates:
      - AGENTS.local.md
      - DSH.local.md`;

const BOTH_PRESENTATION_BLOCK = `

# ── tool presentation ───────────────────────────────────────────────────────

# 单次简单操作直接调用原生工具；批量、循环、条件和并行编排再使用 run_code。
- id: tool-presentation
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: both
`;

const THREAD_TOOLS_BLOCK = `

# ── conversation thread tools ───────────────────────────────────────────────

# 当前 DSH 会话恢复原文时优先使用 thread_recall 的原生 events；跨会话、跨宿主、full/auto 深层回溯或明确的原生不可用才走 Memory Store。
- id: thread-tools
  name: '@stardust/dsh-thread-tools'
  config:
    # 只为实际交付的 raw 原文签发本地 sidecar 回执；压缩摘要、Record 和替换摘要不可确认，也绝不写入官方 DSH 会话日志。
    persistLedgerEvents: false
`;

const TURN_PRESENTATION_BLOCK = `

# ── turn presentation projection ──────────────────────────────────────────

# 从官方 turn/step/tool 事件生成只读轮级展示投影，不向 session JSONL 写入未知事件。
- id: turn-presentation
  name: '@stardust/dsh-turn-presentation'
`;

const OFFICIAL_COMPACTION_BLOCK = `    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'`;

const MEMORY_RECORD_COMPACTION_BLOCK = `    - id: compaction-basic
      name: '@dsh-experimental/context-generation-state-machine/compaction-provider'`;

const APPLY_PATCH_BLOCK = `

# ── transactional patch editing ────────────────────────────────────────────

# 主力模式用 apply_patch 取代旧 edit；官方标准模式保持原样作为救援入口。
- id: apply-patch
  name: '@stardust/dsh-tool-apply-patch'
`;

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label} 与受支持的 DSH 0.1.0-rc.6 标准模式不一致，停止生成候选版本`);
  }
  return source.replace(before, after);
}

export function transformStandardPreset(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new TypeError("标准模式组装文件不能为空");
  }
  if (source.includes("@deepseek-ai/dsh-agent-tool-presentation")) {
    throw new Error("标准模式已经声明工具呈现方式，不能重复追加 both 模式");
  }

  let result = replaceExactlyOnce(source, PERSONA_BLOCK, ZH_PERSONA_BLOCK, "Persona 结构");
  result = replaceExactlyOnce(result, INSTRUCTION_BLOCK, ZH_INSTRUCTION_BLOCK, "工作区规则结构");
  result = replaceExactlyOnce(result, OFFICIAL_COMPACTION_BLOCK, MEMORY_RECORD_COMPACTION_BLOCK, "上下文压缩 Provider");
  return `${result.trimEnd()}${APPLY_PATCH_BLOCK}${THREAD_TOOLS_BLOCK}${TURN_PRESENTATION_BLOCK}${BOTH_PRESENTATION_BLOCK}`;
}
