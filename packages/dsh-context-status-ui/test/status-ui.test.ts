import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_STATUS_SOURCE_SERVICE,
  CONVERSATION_INPUT_RIGHT_SLOT,
  type ContextStatusPresentation,
  type ContextStatusRenderer as ContextStatusRendererContract,
  type ContextStatusSnapshot,
} from "../src/contracts.ts";
import {
  DEFAULT_DSH_CONTEXT_STATUS_UI_CONFIG,
  apply,
  inject,
  name,
} from "../src/plugin.ts";
import {
  buildContextStatusPresentation,
  ContextStatusRenderer,
} from "../src/status-view.ts";

class FakeSource {
  private snapshot: ContextStatusSnapshot | undefined;
  private readonly listeners = new Set<() => void>();
  unsubscribeCount = 0;

  constructor(snapshot: ContextStatusSnapshot | undefined) {
    this.snapshot = snapshot;
  }

  getSnapshot(): ContextStatusSnapshot | undefined {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCount += 1;
      this.listeners.delete(listener);
    };
  }

  update(snapshot: ContextStatusSnapshot | undefined): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

class FakeInputRightMount {
  readonly entries: Array<{
    slot: string;
    renderer: ContextStatusRendererContract;
  }> = [];
  disposeCount = 0;

  mount(slot: typeof CONVERSATION_INPUT_RIGHT_SLOT, renderer: ContextStatusRendererContract): () => void {
    this.entries.push({ slot, renderer });
    return () => {
      this.disposeCount += 1;
    };
  }
}

function createContext(source: unknown, mountPoint: unknown) {
  return {
    get(serviceName: string): unknown {
      if (serviceName === CONTEXT_STATUS_SOURCE_SERVICE) return source;
      if (serviceName === CONVERSATION_INPUT_RIGHT_SLOT) return mountPoint;
      return undefined;
    },
  };
}

test("状态展示使用真实 token、BPC 68% 和硬压缩 90%", () => {
  const presentation = buildContextStatusPresentation({
    currentTokens: 12_500,
    contextWindowTokens: 100_000,
    phase: "bpc-building",
  }, false);

  assert.ok(presentation);
  assert.equal(presentation.slot, CONVERSATION_INPUT_RIGHT_SLOT);
  assert.equal(presentation.usageText, "当前 Token/窗口占用：12,500 / 100,000（12.5%）");
  assert.equal(presentation.stateText, "当前状态：后台整理中");
  assert.equal(presentation.bpcThresholdLabel, "BPC 预压缩 68%");
  assert.equal(presentation.hardThresholdLabel, "硬压缩 90%");
  assert.equal(presentation.expanded, false);
  assert.equal(presentation.toggleLabel, "展开状态详情");
  assert.deepEqual(presentation.details, []);
});

test("展开状态只展示只读详情，不提供 Pin 或选轮控制", () => {
  const source = new FakeSource({
    currentTokens: 68_000,
    contextWindowTokens: 100_000,
    phase: "published",
  });
  const renderer = new ContextStatusRenderer(source);

  const presentation = renderer.toggleExpanded();
  assert.ok(presentation);
  assert.equal(presentation.expanded, true);
  assert.equal(presentation.toggleLabel, "收起状态详情");
  assert.deepEqual(presentation.details, [
    "当前状态：Record 已准备并发布",
    "当前 Token/窗口占用：68,000 / 100,000（68.0%）",
    "BPC 预压缩阈值：68%",
    "硬压缩阈值：90%",
  ]);
  assert.doesNotMatch(JSON.stringify(presentation), /Pin|选轮|保护轮/);
  renderer.dispose();
});

test("缺少或失真的 token 计量不伪造零值", () => {
  const incomplete = buildContextStatusPresentation({ phase: "idle" }, false);
  assert.ok(incomplete);
  assert.equal(incomplete.usageText, "当前 Token/窗口占用：暂不可用");

  const invalid = buildContextStatusPresentation({
    currentTokens: -1,
    contextWindowTokens: 100_000,
    phase: "idle",
  }, false);
  assert.ok(invalid);
  assert.equal(invalid.usageText, "当前 Token/窗口占用：暂不可用");
  assert.equal(buildContextStatusPresentation(undefined, false), undefined);
  assert.equal(buildContextStatusPresentation([], false), undefined);
});

test("状态源更新和展开状态会通知挂载端", () => {
  const source = new FakeSource({
    currentTokens: 20_000,
    contextWindowTokens: 100_000,
    phase: "idle",
  });
  const renderer = new ContextStatusRenderer(source);
  const updates: Array<ContextStatusPresentation | undefined> = [];
  const unsubscribe = renderer.subscribe(presentation => updates.push(presentation));

  source.update({
    currentTokens: 91_000,
    contextWindowTokens: 100_000,
    phase: "hard-building",
  });
  renderer.toggleExpanded();

  assert.equal(updates.length, 3);
  assert.equal(updates[1]?.stateText, "当前状态：同步压缩中");
  assert.match(updates[1]?.usageText ?? "", /91\.0%/);
  assert.equal(updates[2]?.expanded, true);
  unsubscribe();
  renderer.dispose();
  assert.equal(source.unsubscribeCount, 1);
});

test("插件只在显式启用且两个注入服务齐全时挂到 conversation.input.right", () => {
  const source = new FakeSource({
    currentTokens: 2_000,
    contextWindowTokens: 100_000,
    phase: "idle",
  });
  const mountPoint = new FakeInputRightMount();
  const context = createContext(source, mountPoint);

  assert.equal(name, "dsh-context-status-ui");
  assert.deepEqual(inject, [CONTEXT_STATUS_SOURCE_SERVICE, CONVERSATION_INPUT_RIGHT_SLOT]);
  assert.deepEqual(DEFAULT_DSH_CONTEXT_STATUS_UI_CONFIG, { enabled: false });
  assert.equal(apply(context), undefined);
  assert.equal(mountPoint.entries.length, 0);

  const dispose = apply(context, { enabled: true });
  assert.equal(typeof dispose, "function");
  assert.equal(mountPoint.entries.length, 1);
  assert.equal(mountPoint.entries[0]?.slot, CONVERSATION_INPUT_RIGHT_SLOT);
  assert.match(mountPoint.entries[0]?.renderer.getPresentation()?.summary ?? "", /BPC 预压缩 68%/);

  dispose?.();
  assert.equal(mountPoint.disposeCount, 1);
  assert.equal(source.unsubscribeCount, 1);
});

test("状态源或挂载点缺失时安全隐藏", () => {
  const mountPoint = new FakeInputRightMount();
  assert.equal(apply(createContext(undefined, mountPoint), { enabled: true }), undefined);
  assert.equal(mountPoint.entries.length, 0);

  const source = new FakeSource({
    currentTokens: 1,
    contextWindowTokens: 10,
    phase: "idle",
  });
  assert.equal(apply(createContext(source, undefined), { enabled: true }), undefined);
});
