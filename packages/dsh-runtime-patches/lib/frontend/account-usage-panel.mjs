/**
 * 批次 C（窗口 G4）· 设置页「账户使用情况」面板的展示层补丁。
 *
 * 只替换注入到 `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` 里的
 * 展示组件源码；两个锚点与 Codex 首版一致，插入点取自干净基线
 * `%LOCALAPPDATA%\DeepSeekHarness\app\releases\0.1.0-rc.6-oauth`。
 *
 * 注意执行顺序：渲染位置锚点 `WindsurfAuthCard` 是主线
 * `patchWindsurfSettingsSource` 注入的，因此本函数必须在其之后执行，
 * 与 `scripts/Build-CandidateRelease.mjs` 当前的组合顺序一致。
 *
 * 路由、凭据、快照字段与缓存策略全部不动，属于 `packages/dsh-account-usage`
 * 的后端职责。
 */

import { ACCOUNT_USAGE_PANEL_BROWSER_SOURCE } from "../../../dsh-account-usage/lib/settings-panel-source.js";
import { assertNotAlreadyPatched, replaceExactlyOnce } from "./replace-exactly.mjs";

export function patchAccountUsageSettingsSource(source) {
  assertNotAlreadyPatched(source, "function AccountUsagePanel()", "账户使用情况面板");
  let result = replaceExactlyOnce(
    source,
    "\t\t/**\n\t\t* Render the Models section content column.",
    `${ACCOUNT_USAGE_PANEL_BROWSER_SOURCE}\n\t\t/**\n\t\t* Render the Models section content column.`,
    "账户使用情况面板插入点",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)(WindsurfAuthCard, {}),',
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)(WindsurfAuthCard, {}),\n\t\t\t\t\t(0, react_jsx_runtime.jsx)(AccountUsagePanel, {}),',
    "账户使用情况面板渲染位置",
  );
  return result;
}
