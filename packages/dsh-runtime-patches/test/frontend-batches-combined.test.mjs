import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchAccountUsageSettingsSource,
  patchConversationUiSource,
  patchToolActivityPresentationSource,
  patchWindsurfSettingsSource,
} from "../lib/transforms.mjs";

/**
 * 批次 A / B / C 叠加组合测试。
 *
 * 单批次各自的用例只证明「对干净基线单独应用能过」，不能证明三批次落在同一个候选里也能过：
 * A 与 C 同改 `dsh-client-ui-conversation`，B 与主线同改 `dsh-client-ui-tool`。
 * 本文件按 `Build-CandidateRelease.mjs` 的真实入口函数整链应用，锁住组合结果。
 */
const BASELINE = "C:/Users/Stardust/AppData/Local/DeepSeekHarness/app/releases/0.1.0-rc.6-oauth/node_modules/@deepseek-ai";
const baselineAvailable = existsSync(BASELINE);

function baselineSource(pkg) {
  return readFileSync(path.join(BASELINE, pkg, "lib", "client.js"), "utf8");
}

function assertSyntaxOk(name, source) {
  const dir = path.join(tmpdir(), "dsh-frontend-combined");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  writeFileSync(file, source, "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

/**
 * 组件定义必须恰好出现一次：0 次 = 补丁掉了，2 次 = 被重复注入。
 * 只对函数定义用这条，CSS 选择器与 JSX 属性天然会在样式和结构里各出现一次，不能要求唯一。
 */
function assertDefinedOnce(source, markers) {
  for (const [label, marker] of Object.entries(markers)) {
    assert.equal(source.split(marker).length - 1, 1, `${label} 应恰好定义一次：${marker}`);
  }
}

/** 样式与结构标志只要求存在，用于确认该批次真的接进了这个文件。 */
function assertPresent(source, markers) {
  for (const [label, marker] of Object.entries(markers)) {
    assert.ok(source.includes(marker), `${label} 应出现在产物中：${marker}`);
  }
}

test("conversation：主线 + 批次 A + 批次 C + 批次 D 叠加后标志物齐全且可解析", { skip: !baselineAvailable }, () => {
  const baseline = baselineSource("dsh-client-ui-conversation");
  const patched = patchConversationUiSource(baseline);
  assert.ok(patched.length > baseline.length);
  assertDefinedOnce(patched, {
    "批次 A 活动分组组件": "function ActivityGroup({ group, children }) {",
    "批次 A 事实读取器": "function activityFactsOf(nodeStore, nodeKey) {",
    "批次 C 压缩状态组件": "function StardustCompactionStatus(",
    "批次 D 编辑器组件": "function DshEditResendShell(",
    "批次 D 铅笔按钮": "function DshEditPencil(",
  });
  assertPresent(patched, {
    "批次 A 思考视窗锚点": '"data-think-body": true',
    "批次 A 计时列样式": "[data-tool-activity-duration]",
    "批次 C 上下文卡容器": '"data-dsh-context-card": true',
    "批次 C 主百分比类名": "dsh-cs-percent",
    "批次 D 编辑态容器": '"data-dsh-edit-shell": true',
    "批次 D 编辑态高亮样式": "[data-dsh-edit-card]",
  });
  assertSyntaxOk("conversation-abc", patched);
});

test("conversation：整链补丁拒绝被重复执行", { skip: !baselineAvailable }, () => {
  const patched = patchConversationUiSource(baselineSource("dsh-client-ui-conversation"));
  // 构建脚本若因重试对同一文件跑两次，必须立刻失败而不是静默注入两份组件。
  assert.throws(() => patchConversationUiSource(patched));
});

test("tool：主线工具展示 + 批次 B 差异卡叠加后可解析", { skip: !baselineAvailable }, () => {
  const patched = patchToolActivityPresentationSource(baselineSource("dsh-client-ui-tool"));
  assertDefinedOnce(patched, {
    "主线 工具计时组件": "function ToolActivityDuration(",
    "批次 B 差异卡组件": "function DshDiffCard(",
    "批次 B 单文件卡": "function DshDiffFileCard(",
  });
  assertPresent(patched, { "批次 B 差异语义变量": "--dsh-diff-add-bg" });
  assertSyntaxOk("tool-b", patched);
});

test("settings-models：主线 Windsurf 卡 + 批次 C 账户面板叠加后可解析", { skip: !baselineAvailable }, () => {
  const patched = patchAccountUsageSettingsSource(patchWindsurfSettingsSource(baselineSource("dsh-client-ui-settings-models")));
  assertDefinedOnce(patched, {
    "主线 Windsurf 授权卡": "function WindsurfAuthCard(",
    "批次 C 账户面板": "function AccountUsagePanel()",
  });
  assertPresent(patched, { "批次 C 账户样式前缀": ".dsh-au-" });
  assertSyntaxOk("settings-models-c", patched);
});

test("三个文件的样式类前缀互不重名，避免叠加后互相覆盖", { skip: !baselineAvailable }, () => {
  const conversation = patchConversationUiSource(baselineSource("dsh-client-ui-conversation"));
  const tool = patchToolActivityPresentationSource(baselineSource("dsh-client-ui-tool"));
  const settings = patchAccountUsageSettingsSource(patchWindsurfSettingsSource(baselineSource("dsh-client-ui-settings-models")));
  // 批次 C 的账户前缀只能出现在设置页，上下文卡前缀只能出现在会话页，差异卡前缀只能出现在工具页。
  assert.ok(settings.includes(".dsh-au-"), "账户前缀应在设置页");
  assert.ok(!conversation.includes(".dsh-au-") && !tool.includes(".dsh-au-"), "账户前缀不应泄漏到其它文件");
  assert.ok(conversation.includes(".dsh-cs-"), "上下文卡前缀应在会话页");
  assert.ok(!tool.includes(".dsh-cs-") && !settings.includes(".dsh-cs-"), "上下文卡前缀不应泄漏到其它文件");
  assert.ok(conversation.includes(".dsh-er-"), "编辑重发前缀应在会话页");
  assert.ok(!tool.includes(".dsh-er-") && !settings.includes(".dsh-er-"), "编辑重发前缀不应泄漏到其它文件");
  assert.ok(tool.includes("--dsh-diff-add-bg"), "差异语义变量应在工具页");
  assert.ok(!conversation.includes("--dsh-diff-add-bg") && !settings.includes("--dsh-diff-add-bg"), "差异语义变量不应泄漏到其它文件");
});
