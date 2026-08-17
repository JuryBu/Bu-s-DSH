import {
  CONTEXT_STATUS_SOURCE_SERVICE,
  CONVERSATION_INPUT_RIGHT_SLOT,
  type ContextStatusSource,
  type ConversationInputRightMount,
  type DshContextStatusUiPluginContext,
} from "./contracts.ts";
import { ContextStatusRenderer } from "./status-view.ts";

export const name = "dsh-context-status-ui";
export const inject: string[] = [
  CONTEXT_STATUS_SOURCE_SERVICE,
  CONVERSATION_INPUT_RIGHT_SLOT,
];

export interface DshContextStatusUiPluginConfig {
  enabled?: boolean;
}

export const DEFAULT_DSH_CONTEXT_STATUS_UI_CONFIG = Object.freeze({
  enabled: false,
});

function getService(context: DshContextStatusUiPluginContext, serviceName: string): unknown {
  try {
    return context.get?.(serviceName);
  } catch {
    return undefined;
  }
}

function isContextStatusSource(value: unknown): value is ContextStatusSource {
  return typeof value === "object" && value !== null && typeof (value as ContextStatusSource).getSnapshot === "function";
}

function isConversationInputRightMount(value: unknown): value is ConversationInputRightMount {
  return typeof value === "object" && value !== null && typeof (value as ConversationInputRightMount).mount === "function";
}

export function apply(
  context: DshContextStatusUiPluginContext,
  config: DshContextStatusUiPluginConfig = {},
): (() => void) | void {
  if (config.enabled !== true) {
    context.logger?.info?.("上下文状态 UI 未启用，保持隐藏");
    return;
  }
  const source = getService(context, CONTEXT_STATUS_SOURCE_SERVICE);
  if (!isContextStatusSource(source)) {
    context.logger?.info?.("上下文状态源不可用，状态 UI 保持隐藏");
    return;
  }
  const mountPoint = getService(context, CONVERSATION_INPUT_RIGHT_SLOT);
  if (!isConversationInputRightMount(mountPoint)) {
    context.logger?.warn?.("conversation.input.right 挂载点不可用，状态 UI 保持隐藏");
    return;
  }
  const renderer = new ContextStatusRenderer(source);
  try {
    const disposeMount = mountPoint.mount(CONVERSATION_INPUT_RIGHT_SLOT, renderer);
    return () => {
      try {
        if (typeof disposeMount === "function") disposeMount();
      } finally {
        renderer.dispose();
      }
    };
  } catch {
    renderer.dispose();
    context.logger?.warn?.("conversation.input.right 挂载失败，状态 UI 保持隐藏");
  }
}

export default { name, inject, apply };
