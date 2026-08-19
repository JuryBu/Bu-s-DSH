/**
 * 批次 C（窗口 G4）· 上下文状态卡的展示层补丁。
 *
 * 现有布局不推翻（`docs/evidence/stage11/ui-reference/dsh-context-status-bpc.png`
 * 已被主人判定基本合格），只做两件事：
 *
 * 1. 把百分比拉成卡内最大的数字，并让 token 数与图例的层级退后；
 * 2. 新增「压缩状态」区：状态徽标 + generation + 重试次数 + 最近错误单行 + 是否阻塞。
 *
 * 压缩状态通过 adapter 读取投影，**没有真实事件就显示「状态未知」**：
 * `useProjection(key)` 对宿主从未推送过的 key 返回 `undefined`（见干净基线
 * `dsh-client-runtime` 的 ProjectionValueStore 注释：absence is an `undefined`
 * snapshot），所以这里不会因为后端尚未接线而报错，也不会画出假进度条。
 *
 * 三个锚点都取自干净基线 `0.1.0-rc.6-oauth`，且刻意避开 Codex 的
 * `patchContextMeterThresholdsSource` 已改写的文本，因此两者的执行顺序可交换。
 */

import { assertNotAlreadyPatched, replaceExactlyOnce, replaceRangeExactlyOnce } from "./replace-exactly.mjs";

/** 压缩状态区与大号百分比的样式，静态预览页复用同一份文本。 */
export const CONTEXT_STATUS_CARD_STYLE = `
[data-dsh-context-card]{width:300px}
.dsh-cs-head{display:flex;align-items:baseline;gap:8px}
.dsh-cs-percent{flex:none;color:var(--dsw-alias-label-primary);font-size:26px;font-weight:650;line-height:32px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.dsh-cs-headline{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-cs-figures{margin-left:auto;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dsh-cs-sect{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-cs-sect-head{display:flex;align-items:center;gap:6px}
.dsh-cs-sect-title{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.dsh-cs-gen{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:20px;font-variant-numeric:tabular-nums}
.dsh-cs-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:20px;white-space:nowrap}
.dsh-cs-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}
.dsh-cs-badge[data-tone="active"]{color:var(--dsw-static-blue-450,#3b82f6)}
.dsh-cs-badge[data-tone="ready"]{color:var(--dsw-alias-state-success-primary)}
.dsh-cs-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-label)}
.dsh-cs-badge[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-cs-badge[data-tone="unknown"]{color:var(--dsw-alias-label-tertiary)}
.dsh-cs-line{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:18px}
.dsh-cs-line[data-role="error"]{color:var(--dsw-alias-state-error-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-cs-line[data-role="blocking"]{color:var(--dsw-alias-state-warn-label)}
`;

const COMPACTION_SOURCE = `
		const STARDUST_CONTEXT_CARD_CSS = ${JSON.stringify(CONTEXT_STATUS_CARD_STYLE)};
		const STARDUST_COMPACTION_PROJECTION_KEYS = ["contextCompaction", "contextGeneration"];
		const STARDUST_COMPACTION_PHASES = {
			building: { text: "后台整理中", tone: "active" },
			prepared: { text: "候选已就绪", tone: "ready" },
			applying: { text: "正在换入新上下文", tone: "active" },
			applied: { text: "已换入新上下文", tone: "ready" },
			failed: { text: "整理失败", tone: "error" },
			retrying: { text: "退避重试中", tone: "warn" },
			paused: { text: "已暂停并保护现场", tone: "warn" },
			idle: { text: "空闲", tone: "unknown" },
			disabled: { text: "上下文维护未启用", tone: "unknown" },
			"bpc-building": { text: "后台整理中", tone: "active" },
			"hard-building": { text: "同步压缩中", tone: "warn" },
			validating: { text: "候选验证中", tone: "active" },
			publishing: { text: "正在发布", tone: "active" },
			published: { text: "候选已就绪", tone: "ready" },
			"bpc-failed-using-previous": { text: "整理失败，继续使用原上下文", tone: "error" },
			"paused-protected": { text: "已暂停并保护现场", tone: "warn" }
		};
		function stardustCompactionNumber(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		function stardustCompactionLabel(value) {
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
			if (typeof value === "string" && value.trim().length > 0) return value.trim();
			return null;
		}
		function stardustCompactionFirst(snapshot, keys) {
			if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return void 0;
			for (const key of keys) {
				const value = snapshot[key];
				if (value !== null && value !== void 0) return value;
			}
			return void 0;
		}
		function stardustCompactionActivity(snapshot) {
			const activity = stardustCompactionFirst(snapshot, ["compactionActivity", "activity", "currentActivity"]);
			return typeof activity === "object" && activity !== null && !Array.isArray(activity) ? activity : null;
		}
		function stardustCompactionError(value) {
			if (typeof value === "string" && value.trim().length > 0) return value.trim().split(/\\r?\\n/u)[0];
			if (typeof value === "object" && value !== null) {
				const nested = stardustCompactionFirst(value, ["message", "reason", "error", "summary"]);
				if (typeof nested === "string" && nested.trim().length > 0) return nested.trim().split(/\\r?\\n/u)[0];
			}
			return null;
		}
		function stardustCompactionView(snapshot) {
			if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return { phase: void 0 };
			const activity = stardustCompactionActivity(snapshot);
			const rawPhase = stardustCompactionFirst(activity, ["phase", "state", "status"])
				?? stardustCompactionFirst(snapshot, ["phase", "state", "status"]);
			const paused = stardustCompactionFirst(snapshot, ["paused"]) === true;
			const rawMode = stardustCompactionFirst(activity, ["mode", "kind", "reason", "trigger"])
				?? stardustCompactionFirst(snapshot, ["mode", "kind", "reason", "trigger"]);
			const phaseKey = (() => {
				if (paused) return "paused";
				if (typeof rawPhase !== "string") return void 0;
				if (rawPhase === "building" && (rawMode === "hard" || rawMode === "hard-compaction")) return "hard-building";
				if (rawPhase === "building" && (rawMode === "bpc" || rawMode === "background")) return "bpc-building";
				return rawPhase;
			})();
			const blocking = stardustCompactionFirst(snapshot, ["blocking", "blocked", "blockingRequest"]) === true
				|| stardustCompactionFirst(activity, ["blocking", "blocked", "blockingRequest"]) === true
				|| phaseKey === "hard-building";
			const generation = stardustCompactionLabel(stardustCompactionFirst(activity, ["generation", "generationId"])
				?? stardustCompactionFirst(snapshot, ["generation", "generationId", "publishedGenerationId"])
				?? stardustCompactionFirst(stardustCompactionFirst(snapshot, ["prepared", "candidate"]), ["generation", "generationId"]));
			const lastError = stardustCompactionError(stardustCompactionFirst(snapshot, ["lastBpcFailure", "lastHardFailure", "lastError", "error", "errorMessage", "pauseReason"]));
			return {
				phase: phaseKey === void 0 ? void 0 : STARDUST_COMPACTION_PHASES[phaseKey],
				generation,
				retries: stardustCompactionNumber(stardustCompactionFirst(snapshot, ["bpcFailureCount", "hardFailureCount", "retryCount", "retries", "attempt"])),
				lastError,
				blocking,
				mode: rawMode === "hard" || rawMode === "hard-compaction" || phaseKey === "hard-building" ? "hard" : rawMode === "bpc" || rawMode === "background" || phaseKey === "bpc-building" ? "bpc" : void 0
			};
		}
		function StardustCompactionStatus({ useProjection }) {
			const projected = STARDUST_COMPACTION_PROJECTION_KEYS.map((key) => useProjection(key)).find((value) => value !== void 0);
			const view = stardustCompactionView(projected);
			const badge = view.phase ?? { text: "状态未知", tone: "unknown" };
			const notes = [];
			if (view.retries !== null && view.retries !== void 0 && view.retries > 0) notes.push("已重试 " + view.retries + " 次");
			if (view.mode === "bpc") notes.push("后台构建，完成后在后续请求无感换入");
			if (view.mode === "hard" && view.blocking !== true) notes.push("同步压缩，请求会阻塞到完成");
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-cs-sect",
				"data-dsh-compaction-status": true,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-cs-sect-head",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "dsh-cs-sect-title",
						children: "压缩状态"
					}), (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-cs-badge",
						"data-tone": badge.tone,
						children: badge.text
					}), view.generation === null || view.generation === void 0 ? null : (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-cs-gen",
						children: "generation " + view.generation
					})]
				}), notes.length === 0 ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-cs-line",
					children: notes.join("　·　")
				}), view.blocking !== true ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-cs-line",
					"data-role": "blocking",
					children: "正在阻塞当前请求，等压缩完成后自动继续"
				}), view.lastError === null || view.lastError === void 0 ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-cs-line",
					"data-role": "error",
					title: view.lastError,
					children: "最近错误：" + view.lastError
				})]
			});
		}
`;

export function patchContextStatusCardSource(source) {
  assertNotAlreadyPatched(source, "function StardustCompactionStatus(", "上下文卡压缩状态区");
  let result = replaceExactlyOnce(
    source,
    "\t\tfunction ContextMeter({ useProjection, t }) {",
    `${COMPACTION_SOURCE}\t\tfunction ContextMeter({ useProjection, t }) {`,
    "上下文卡压缩状态组件插入点",
  );
  result = replaceExactlyOnce(
    result,
    'className: ContextMeter_module_css_default.panel,\n\t\t\t\t\trole: "dialog",',
    'className: ContextMeter_module_css_default.panel,\n\t\t\t\t\t"data-dsh-context-card": true,\n\t\t\t\t\trole: "dialog",',
    "上下文卡容器标记",
  );
  result = replaceRangeExactlyOnce(
    result,
    '(0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\t\t\tclassName: ContextMeter_module_css_default.header,',
    '(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\tclassName: ContextMeter_module_css_default.bar,',
    `(0, react_jsx_runtime.jsxs)("div", {
							className: \`\${ContextMeter_module_css_default.header} dsh-cs-head\`,
							children: [
								(0, react_jsx_runtime.jsx)("style", { children: STARDUST_CONTEXT_CARD_CSS }),
								(0, react_jsx_runtime.jsx)("span", {
									className: "dsh-cs-percent",
									children: reading
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "dsh-cs-headline",
									children: [headBefore, headAfter].filter((part) => part.length > 0).join(" ")
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "dsh-cs-figures",
									children: \`~\${formatTokens(context.usedTokens)} / \${formatTokens(context.contextWindow)}\`
								})
							]
						}),
						`,
    "上下文卡主数字层级",
  );
  return replaceExactlyOnce(
    result,
    "\n\t\t\t\t\t]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t//#endregion\n\t\t//#region \\0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/PermissionSelect.module.css.mjs",
    "\n\t\t\t\t\t\t,(0, react_jsx_runtime.jsx)(StardustCompactionStatus, { useProjection })\n\t\t\t\t\t]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t//#endregion\n\t\t//#region \\0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/PermissionSelect.module.css.mjs",
    "上下文卡压缩状态区渲染位置",
  );
}
