export const CONTEXT_STATUS_SOURCE_SERVICE = "contextStatusSource" as const;
export const CONVERSATION_INPUT_RIGHT_SLOT = "conversation.input.right" as const;
export const BPC_THRESHOLD_PERCENT = 68;
export const HARD_COMPACTION_THRESHOLD_PERCENT = 90;

export type ContextCompressionPhase =
  | "disabled"
  | "idle"
  | "bpc-building"
  | "hard-building"
  | "validating"
  | "publishing"
  | "published"
  | "bpc-failed-using-previous"
  | "paused-protected";

export interface ContextStatusSnapshot {
  readonly currentTokens?: number;
  readonly contextWindowTokens?: number;
  readonly enabled?: boolean;
  readonly paused?: boolean;
  readonly phase?: ContextCompressionPhase | string;
}

export interface ContextStatusSource {
  getSnapshot(): ContextStatusSnapshot | undefined;
  subscribe?(listener: () => void): (() => void) | void;
}

export interface ContextStatusPresentation {
  readonly slot: typeof CONVERSATION_INPUT_RIGHT_SLOT;
  readonly summary: string;
  readonly usageText: string;
  readonly stateText: string;
  readonly bpcThresholdLabel: string;
  readonly hardThresholdLabel: string;
  readonly expanded: boolean;
  readonly toggleLabel: string;
  readonly details: readonly string[];
}

export type ContextStatusListener = (presentation: ContextStatusPresentation | undefined) => void;

export interface ContextStatusRenderer {
  getPresentation(): ContextStatusPresentation | undefined;
  toggleExpanded(): ContextStatusPresentation | undefined;
  subscribe(listener: ContextStatusListener): () => void;
  dispose(): void;
}

export interface ConversationInputRightMount {
  mount(
    slot: typeof CONVERSATION_INPUT_RIGHT_SLOT,
    renderer: ContextStatusRenderer,
  ): (() => void) | void;
}

export interface DshContextStatusUiPluginContext {
  get?(serviceName: string): unknown;
  logger?: {
    info?(message: string): void;
    warn?(message: string): void;
  };
}
