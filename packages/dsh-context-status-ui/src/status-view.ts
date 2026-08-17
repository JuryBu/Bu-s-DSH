import {
  BPC_THRESHOLD_PERCENT,
  CONVERSATION_INPUT_RIGHT_SLOT,
  HARD_COMPACTION_THRESHOLD_PERCENT,
  type ContextStatusListener,
  type ContextStatusPresentation,
  type ContextStatusRenderer as ContextStatusRendererContract,
  type ContextStatusSnapshot,
  type ContextStatusSource,
} from "./contracts.ts";

const phaseLabels: Readonly<Record<string, string>> = {
  disabled: "上下文维护未启用",
  idle: "空闲",
  "bpc-building": "后台整理中",
  "hard-building": "同步压缩中",
  validating: "候选验证中",
  publishing: "正在发布",
  published: "Record 已准备并发布",
  "bpc-failed-using-previous": "后台整理失败，继续使用原上下文",
  "paused-protected": "同步压缩失败，已暂停并保护现场",
};

function isSnapshot(value: unknown): value is ContextStatusSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsableTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsableContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function usageText(snapshot: ContextStatusSnapshot): string {
  if (!isUsableTokenCount(snapshot.currentTokens) || !isUsableContextWindow(snapshot.contextWindowTokens)) {
    return "当前 Token/窗口占用：暂不可用";
  }
  const ratio = (snapshot.currentTokens / snapshot.contextWindowTokens) * 100;
  return `当前 Token/窗口占用：${formatTokenCount(snapshot.currentTokens)} / ${formatTokenCount(snapshot.contextWindowTokens)}（${ratio.toFixed(1)}%）`;
}

function stateText(snapshot: ContextStatusSnapshot): string {
  if (snapshot.enabled === false) return "当前状态：上下文维护未启用";
  if (snapshot.paused === true) return "当前状态：同步压缩失败，已暂停并保护现场";
  if (typeof snapshot.phase !== "string") return "当前状态：暂不可用";
  return `当前状态：${phaseLabels[snapshot.phase] ?? "暂不可用"}`;
}

function readSnapshot(source: ContextStatusSource): ContextStatusSnapshot | undefined {
  try {
    const snapshot = source.getSnapshot();
    return isSnapshot(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

export function buildContextStatusPresentation(
  snapshot: unknown,
  expanded: boolean,
): ContextStatusPresentation | undefined {
  if (!isSnapshot(snapshot)) return undefined;
  const currentUsage = usageText(snapshot);
  const currentState = stateText(snapshot);
  const bpcThresholdLabel = `BPC 预压缩 ${BPC_THRESHOLD_PERCENT}%`;
  const hardThresholdLabel = `硬压缩 ${HARD_COMPACTION_THRESHOLD_PERCENT}%`;
  const details = expanded
    ? [
      currentState,
      currentUsage,
      `BPC 预压缩阈值：${BPC_THRESHOLD_PERCENT}%`,
      `硬压缩阈值：${HARD_COMPACTION_THRESHOLD_PERCENT}%`,
    ]
    : [];
  return {
    slot: CONVERSATION_INPUT_RIGHT_SLOT,
    summary: `${currentUsage} · ${bpcThresholdLabel} · ${hardThresholdLabel} · ${currentState}`,
    usageText: currentUsage,
    stateText: currentState,
    bpcThresholdLabel,
    hardThresholdLabel,
    expanded,
    toggleLabel: expanded ? "收起状态详情" : "展开状态详情",
    details,
  };
}

export class ContextStatusRenderer implements ContextStatusRendererContract {
  private readonly source: ContextStatusSource;
  private expanded = false;
  private readonly listeners = new Set<ContextStatusListener>();
  private stopSourceSubscription: (() => void) | undefined;

  constructor(source: ContextStatusSource) {
    this.source = source;
    try {
      const unsubscribe = source.subscribe?.(() => this.emit());
      if (typeof unsubscribe === "function") this.stopSourceSubscription = unsubscribe;
    } catch {
      this.stopSourceSubscription = undefined;
    }
  }

  getPresentation(): ContextStatusPresentation | undefined {
    return buildContextStatusPresentation(readSnapshot(this.source), this.expanded);
  }

  toggleExpanded(): ContextStatusPresentation | undefined {
    this.expanded = !this.expanded;
    const presentation = this.getPresentation();
    this.emit(presentation);
    return presentation;
  }

  subscribe(listener: ContextStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getPresentation());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopSourceSubscription?.();
    this.stopSourceSubscription = undefined;
    this.listeners.clear();
  }

  private emit(presentation = this.getPresentation()): void {
    for (const listener of this.listeners) listener(presentation);
  }
}
