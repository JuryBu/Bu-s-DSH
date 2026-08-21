import {
  MODEL_FACET_BROWSER_SOURCE,
  MODEL_SELECT_BROWSER_SOURCE,
} from "../../dsh-model-selection-view/lib/browser-source.js";
import {
  patchAccountUsageSettingsSource as patchAccountUsageSettingsFrontendSource,
  patchActivityTrackFrontendSource,
  patchAppearanceThemeSource,
  patchContextStatusCardSource,
  patchEditResendShellSource,
  patchSelectionAnnotationSource,
  patchTurnProcessCollapseSource,
  patchWorkspaceShellSource,
  patchWorkspaceConversationReferencesSource,
} from "./transforms-frontend.mjs";
import { patchToolDiffCardSource } from "./transforms-frontend-tool.mjs";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label} 与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本`);
  }
  return source.replace(before, () => after);
}

function replaceRangeExactlyOnce(source, start, end, replacement, label) {
  const first = source.indexOf(start);
  const last = source.lastIndexOf(start);
  if (first < 0 || first !== last) {
    throw new Error(`${label} 的起点与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本`);
  }
  const endIndex = source.indexOf(end, first + start.length);
  if (endIndex < 0 || source.indexOf(end, endIndex + end.length) >= 0) {
    throw new Error(`${label} 的终点与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(endIndex)}`;
}

export function mergeAdjacentReasoningBlocks(blocks) {
  const groups = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block?.kind !== "reasoning") {
      groups.push({ block, startIndex: index, endIndex: index });
      continue;
    }
    const texts = [block.text];
    let endIndex = index;
    while (endIndex + 1 < blocks.length && blocks[endIndex + 1]?.kind === "reasoning") {
      endIndex += 1;
      texts.push(blocks[endIndex].text);
    }
    groups.push({
      block: endIndex === index ? block : { ...block, text: texts.join("\n\n") },
      startIndex: index,
      endIndex,
    });
    index = endIndex;
  }
  return groups;
}

const MERGE_ADJACENT_REASONING_BLOCKS_SOURCE = mergeAdjacentReasoningBlocks
  .toString()
  .split("\n")
  .map((line) => `\t\t${line}`)
  .join("\n");

export function patchSystemPromptSource(source) {
  return replaceExactlyOnce(
    source,
    "return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\\n\\n${body}`;",
    "return `【当前运行状态】下面是此刻有效的运行环境快照；如果历史里存在旧的运行状态，以本快照为准。\\n\\n${body}`;",
    "运行状态总标题",
  );
}

export function patchTimeContextSource(source) {
  let result = replaceExactlyOnce(
    source,
    `\tconst refreshIntervalMs = config.refreshIntervalMs;\n\tvalidateRefreshInterval(refreshIntervalMs);`,
    `\tconst configuredRefreshIntervalMs = config.refreshIntervalMs;\n\tvalidateRefreshInterval(configuredRefreshIntervalMs);\n\tconst refreshIntervalMs = Math.max(60_000, configuredRefreshIntervalMs ?? 0);`,
    "时间上下文最短刷新间隔",
  );
  result = replaceExactlyOnce(
    result,
    `\t\tif (refreshIntervalMs !== void 0 && refreshIntervalMs > 0) {\n\t\t\tconst lastInjection = latestInjectionTime(agent);\n\t\t\tif (lastInjection !== void 0 && now >= lastInjection && now - lastInjection < refreshIntervalMs) return decision;\n\t\t}`,
    `\t\tif (step > 1) {\n\t\t\tconst lastInjection = latestInjectionTime(agent);\n\t\t\tif (lastInjection !== void 0 && now >= lastInjection && now - lastInjection < refreshIntervalMs) return decision;\n\t\t}`,
    "时间上下文按真人轮次与长轮次刷新",
  );
  return result;
}

export function patchAgentLoopActivityLabelSource(source) {
  let result = replaceExactlyOnce(
    source,
    `/** Append a started call and return the event seq that its result must cite. */\nfunction appendToolCall(session, turn, step, block) {`,
    `function activityLabelFromMessage(message) {\n\tconst firstToolIndex = message.content.findIndex((block) => block.type === "tool-call");\n\tconst preceding = firstToolIndex < 0 ? message.content : message.content.slice(0, firstToolIndex);\n\tconst publicText = preceding.filter((block) => block.type === "text" && typeof block.text === "string").at(-1);\n\tif (publicText === void 0) return void 0;\n\tconst lines = publicText.text.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);\n\tconst raw = lines.at(-1)?.replace(/^(?:[-*#>]+|(?:计划|准备|检查|处理)[:：])\\s*/u, "").trim();\n\tif (!raw) return void 0;\n\treturn raw.length > 80 ? raw.slice(0, 77) + "..." : raw;\n}\n/** Append a started call and return the event seq that its result must cite. */\nfunction appendToolCall(session, turn, step, block) {`,
    "工具活动语义标题提取",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\tfor (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });`,
    `\t\t\t\t\tfor (const message of decision.messages) {\n\t\t\t\t\t\tconst replacement = message?.dshSurfaceReplace;\n\t\t\t\t\t\tif (replacement === void 0) {\n\t\t\t\t\t\t\tthis.session.append("user/message", message, { surfaceOp: "append" });\n\t\t\t\t\t\t\tcontinue;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tconst { dshSurfaceReplace: _ignored, ...loggedMessage } = message;\n\t\t\t\t\t\tthis.session.append("user/message", loggedMessage, {\n\t\t\t\t\t\t\tsurfaceOp: { op: "replace", start: replacement.start, end: replacement.end },\n\t\t\t\t\t\t\tsourceEventSeqs: replacement.sourceEventSeqs\n\t\t\t\t\t\t});\n\t\t\t\t\t}`,
    "编辑重发在原会话内替换当前表面分支",
  );
  result = replaceExactlyOnce(
    result,
    `\t\targuments: block.arguments\n\t}).seq;`,
    `\t\targuments: block.arguments,\n\t\t...typeof block.activityLabel === "string" && block.activityLabel !== "" ? { activityLabel: block.activityLabel } : {}\n\t}).seq;`,
    "工具调用持久化语义标题",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst toolCalls = message.content.filter((block) => block.type === "tool-call");`,
    `\t\t\tconst activityLabel = activityLabelFromMessage(message);\n\t\t\tconst toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => activityLabel === void 0 ? block : { ...block, activityLabel });`,
    "同一模型步骤工具共享语义标题",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tsource: sections.length === 0 ? {\n\t\t\t\tkind: "plugin",\n\t\t\t\tplugin: SOURCE\n\t\t\t} : {`,
    `\t\t\tsource: sections.length === 0 ? {\n\t\t\t\tkind: "plugin",\n\t\t\t\tplugin: SOURCE,\n\t\t\t\tform: "cleared"\n\t\t\t} : {`,
    "运行状态清空事件显式标记",
  );
  return result;
}

export function patchAgentPresetModuleResolutionSource(source) {
  let result = replaceExactlyOnce(
    source,
    "const base = harnessBase.get(this.config);",
    "const base = import.meta.url;",
    "Agent Preset 裸包解析基准",
  );
  if (source.includes("this.config = config;")) {
    result = replaceExactlyOnce(
      result,
      "this.config = config;",
      "this.config = { ...config, default: config.default === \"standard\" ? \"stardust-main\" : config.default };",
      "Agent Preset 默认模式",
    );
    result = replaceExactlyOnce(
      result,
      "{ base: { default: config.default } }",
      "{ base: { default: this.config.default } }",
      "Agent Preset 持久设置基准",
    );
  }
  return result;
}

export function patchAgentModelSelectionPromptSource(source) {
  let result = replaceExactlyOnce(
    source,
    `\t\t\t\tprovider: selected.provider,
\t\t\t\tmodel: selected.model
`,
    `\t\t\t\tprovider: selected.provider,
\t\t\t\tmodel: selected.model,
\t\t\t\treasoning_effort: selected.reasoningEffort ?? ""
`,
    "Agent 当前模型思考强度提示词变量",
  );
  result = replaceExactlyOnce(
    result,
    `		const selected = selection.current;
		const assembled = await next();`,
    `		const selected = selection.current;
		if (selected !== void 0) {
			_assembly.variables = {
				..._assembly.variables,
				provider: selected.provider,
				model: selected.model,
				reasoning_effort: selected.reasoningEffort ?? ""
			};
		}
		const assembled = await next();`,
    "Agent 当前模型在下游提示词组装前可见",
  );
  return result;
}

export function patchWindsurfSettingsSource(source) {
  const helpers = `
		const WINDSURF_AUTH_BASE = "/oauth/windsurf";
		const windsurfCopy = {
			zh: {
				title: "Windsurf / Devin 订阅",
				description: "可从 Devin Desktop 当前登录状态导入，也可使用独立浏览器授权或 API Key；导入后的凭据由 Windows 当前用户加密保存。",
				community: "实验性社区适配：可使用订阅，但稳定性与账号政策不等同于官方第三方 SDK。",
				connected: "已连接",
				disconnected: "尚未连接",
				connectedAs: "已连接账号：{account}",
				browserLogin: "浏览器授权登录",
				browserSwitch: "切换到浏览器授权",
				browserRenew: "重新授权",
				apiKey: "使用 API Key",
				localImport: "从 Devin 本机导入",
				importing: "正在导入…",
				apiKeySwitch: "切换到 API Key",
				apiKeyUpdate: "更新 API Key",
				apiKeyLabel: "Windsurf API Key",
				apiServerLabel: "API 服务器地址（可选）",
				saveApiKey: "保存并启用 API Key",
				cancel: "取消",
				logout: "退出当前登录",
				waiting: "等待浏览器授权…",
				saving: "正在保存…",
				failed: "无法读取 Windsurf 登录状态"
			},
			en: {
				title: "Windsurf / Devin subscription",
				description: "Import the current Devin Desktop sign-in, or use separate browser authorization or an API key. Imported credentials are encrypted for the current Windows user.",
				community: "Experimental community integration: subscription access may work, but stability and account policy are not an official third-party SDK guarantee.",
				connected: "Connected",
				disconnected: "Not connected",
				connectedAs: "Connected account: {account}",
				browserLogin: "Browser sign-in",
				browserSwitch: "Switch to browser authorization",
				browserRenew: "Authorize again",
				apiKey: "Use API key",
				localImport: "Import from Devin Desktop",
				importing: "Importing…",
				apiKeySwitch: "Switch to API key",
				apiKeyUpdate: "Update API key",
				apiKeyLabel: "Windsurf API key",
				apiServerLabel: "API server URL (optional)",
				saveApiKey: "Save and use API key",
				cancel: "Cancel",
				logout: "Sign out current method",
				waiting: "Waiting for browser authorization…",
				saving: "Saving…",
				failed: "Windsurf sign-in status is unavailable"
			}
		};
		function windsurfUiCopy() {
			const language = typeof document === "undefined" ? "en" : document.documentElement.lang || navigator.language;
			return language.toLowerCase().startsWith("zh") ? windsurfCopy.zh : windsurfCopy.en;
		}
		async function windsurfRequest(path, method = "GET", body) {
			const headers = { accept: "application/json" };
			if (body !== void 0) headers["content-type"] = "application/json";
			const response = await fetch(WINDSURF_AUTH_BASE + "/" + path, {
				method,
				headers,
				cache: "no-store",
				...(body === void 0 ? {} : { body: JSON.stringify(body) })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok || result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "Windsurf request failed (" + String(response.status) + ")");
			return result;
		}
		function useWindsurfAuth() {
			const [status, setStatus] = (0, react.useState)({ state: "loading", connected: false, authenticationMode: "browser_oauth", methods: {}, error: null });
			const [busy, setBusy] = (0, react.useState)(null);
			const [localError, setLocalError] = (0, react.useState)(null);
			const loginGenerationRef = (0, react.useRef)(0);
			const [editingApiKey, setEditingApiKey] = (0, react.useState)(false);
			const [apiKey, setApiKey] = (0, react.useState)("");
			const [apiServerUrl, setApiServerUrl] = (0, react.useState)("");
			const refresh = (0, react.useCallback)(async () => {
				try {
					const next = await windsurfRequest("status");
					setStatus(next);
					setLocalError(null);
					return next;
				} catch (error) {
					setLocalError(error instanceof Error ? error.message : String(error));
					return void 0;
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const switchMode = (0, react.useCallback)(async (authenticationMode) => {
				setBusy("switch");
				setLocalError(null);
				try {
					const next = await windsurfRequest("mode", "POST", { authenticationMode });
					setStatus(next);
					setEditingApiKey(false);
				} catch (error) {
					setLocalError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(null);
				}
			}, []);
			const login = (0, react.useCallback)(async () => {
				const loginGeneration = ++loginGenerationRef.current;
				setBusy("login");
				setLocalError(null);
				try {
					const started = await windsurfRequest("login", "POST", {});
					setStatus((previous) => ({ ...previous, ...started }));
					if (started.browserOpened !== true && typeof started.url === "string") window.open(started.url, "_blank", "noopener,noreferrer");
					if (started.authorizationBrowserOpened !== true && typeof started.authorizationUrl === "string") window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
					for (let attempt = 0; attempt < 600; attempt++) {
						await new Promise((resolve) => setTimeout(resolve, 1000));
						if (loginGeneration !== loginGenerationRef.current) return;
						const next = await windsurfRequest("status");
						setStatus(next);
						if (next.connected && next.authenticationMode === "browser_oauth" && next.state !== "waiting" && next.state !== "starting") return;
						if (next.state === "error") throw new Error(next.error || windsurfUiCopy().failed);
					}
					throw new Error(windsurfUiCopy().failed);
				} catch (error) {
					if (loginGeneration === loginGenerationRef.current) setLocalError(error instanceof Error ? error.message : String(error));
				} finally {
					if (loginGeneration === loginGenerationRef.current) setBusy(null);
				}
			}, []);
			const cancelLogin = (0, react.useCallback)(async () => {
				loginGenerationRef.current += 1;
				setLocalError(null);
				try {
					const next = await windsurfRequest("cancel", "POST", {});
					setStatus(next);
				} catch (error) {
					setLocalError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(null);
				}
			}, []);
			const saveApiKey = (0, react.useCallback)(async () => {
				const trimmedKey = apiKey.trim();
				if (trimmedKey.length === 0) return;
				setBusy("save");
				setLocalError(null);
				try {
					await windsurfRequest("api-key", "POST", { apiKey: trimmedKey, apiServerUrl: apiServerUrl.trim() || void 0 });
					const next = await windsurfRequest("mode", "POST", { authenticationMode: "manual_api_key" });
					setStatus(next);
					setApiKey("");
					setEditingApiKey(false);
				} catch (error) {
					setLocalError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(null);
				}
			}, [apiKey, apiServerUrl]);
			const importLocal = (0, react.useCallback)(async () => {
				setBusy("import");
				setLocalError(null);
				try {
					await windsurfRequest("local-import", "POST", {});
					const next = await windsurfRequest("status");
					setStatus(next);
				} catch (error) {
					setLocalError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(null);
				}
			}, []);
			const logout = (0, react.useCallback)(async () => {
				loginGenerationRef.current += 1;
				setBusy("logout");
				setLocalError(null);
				try {
					const next = await windsurfRequest("logout", "POST", { authenticationMode: status.authenticationMode });
					setStatus(next);
				} catch (error) {
					setLocalError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(null);
				}
			}, [status.authenticationMode]);
			return { status, busy, localError, editingApiKey, setEditingApiKey, apiKey, setApiKey, apiServerUrl, setApiServerUrl, refresh, switchMode, login, cancelLogin, saveApiKey, importLocal, logout };
		}
		function WindsurfAuthCard() {
			const copy = windsurfUiCopy();
			const auth = useWindsurfAuth();
			const status = auth.status;
			const connected = status.connected === true;
			const mode = status.authenticationMode;
			const browserConfigured = status.methods?.browser_oauth?.configured === true;
			const apiKeyConfigured = status.methods?.manual_api_key?.configured === true;
			const accountName = status.methods?.[mode]?.accountName;
			const detail = connected ? typeof accountName === "string" && accountName.length > 0 ? copy.connectedAs.replace("{account}", accountName) : copy.connected : copy.disconnected;
			const browserLabel = auth.busy === "login" ? copy.cancel : mode === "browser_oauth" && browserConfigured ? copy.browserRenew : browserConfigured ? copy.browserSwitch : copy.browserLogin;
			const apiKeyLabel = mode === "manual_api_key" && apiKeyConfigured ? copy.apiKeyUpdate : apiKeyConfigured ? copy.apiKeySwitch : copy.apiKey;
			const useBrowser = () => {
				if (browserConfigured && mode !== "browser_oauth") auth.switchMode("browser_oauth");
				else auth.login();
			};
			const useApiKey = () => {
				if (apiKeyConfigured && mode !== "manual_api_key") auth.switchMode("manual_api_key");
				else auth.setEditingApiKey(true);
			};
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ModelsSection_module_css_default["rowCard"],
				style: { gap: "10px" },
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: ModelsSection_module_css_default["rowHead"],
						style: { flexWrap: "wrap", alignItems: "flex-start", gap: "10px 12px" },
						children: [(0, react_jsx_runtime.jsxs)("span", {
							className: ModelsSection_module_css_default["rowIdentity"],
							style: { flex: "1 1 180px", minWidth: 0, whiteSpace: "nowrap" },
							children: [(0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["rowName"], children: copy.title }), (0, react_jsx_runtime.jsx)("span", {
								className: [ModelsSection_module_css_default["credentialDot"], ModelsSection_module_css_default[connected ? "credentialDotConfigured" : "credentialDotMissing"]].join(" "),
								role: "img",
								"aria-label": detail,
								title: detail
							})]
						}), (0, react_jsx_runtime.jsxs)("span", {
							className: ModelsSection_module_css_default["rowActions"],
							style: { flex: "1 1 420px", display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginLeft: "auto" },
							children: [(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ModelsSection_module_css_default["secondaryButton"],
								style: { whiteSpace: "nowrap", flex: "0 0 auto" },
								disabled: auth.busy !== null && auth.busy !== "login",
								onClick: auth.busy === "login" ? auth.cancelLogin : useBrowser,
								children: browserLabel
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ModelsSection_module_css_default["secondaryButton"],
								style: { whiteSpace: "nowrap", flex: "0 0 auto" },
								disabled: auth.busy !== null,
								onClick: auth.importLocal,
								children: auth.busy === "import" ? copy.importing : copy.localImport
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ModelsSection_module_css_default["secondaryButton"],
								style: { whiteSpace: "nowrap", flex: "0 0 auto" },
								disabled: auth.busy !== null,
								onClick: useApiKey,
								children: apiKeyLabel
							}), connected ? (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ModelsSection_module_css_default["secondaryButton"],
								style: { whiteSpace: "nowrap", flex: "0 0 auto" },
								disabled: auth.busy !== null,
								onClick: auth.logout,
								children: copy.logout
							}) : null]
						})]
					}),
					(0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["intro"], children: detail }),
					(0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["intro"], children: copy.description }),
					(0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["notice"], children: copy.community }),
					auth.editingApiKey ? (0, react_jsx_runtime.jsxs)("div", {
						className: ModelsSection_module_css_default["editor"],
						children: [(0, react_jsx_runtime.jsxs)("label", {
							className: ModelsSection_module_css_default["field"],
							children: [(0, react_jsx_runtime.jsx)("span", { children: copy.apiKeyLabel }), (0, react_jsx_runtime.jsx)("input", {
								className: ModelsSection_module_css_default["input"],
								type: "password",
								autoComplete: "off",
								value: auth.apiKey,
								onChange: (event) => auth.setApiKey(event.currentTarget.value)
							})]
						}), (0, react_jsx_runtime.jsxs)("label", {
							className: ModelsSection_module_css_default["field"],
							children: [(0, react_jsx_runtime.jsx)("span", { children: copy.apiServerLabel }), (0, react_jsx_runtime.jsx)("input", {
								className: ModelsSection_module_css_default["input"],
								type: "url",
								value: auth.apiServerUrl,
								onChange: (event) => auth.setApiServerUrl(event.currentTarget.value)
							})]
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: ModelsSection_module_css_default["editorActions"],
							children: [(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ModelsSection_module_css_default["secondaryButton"],
								disabled: auth.busy !== null,
								onClick: () => auth.setEditingApiKey(false),
								children: copy.cancel
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ModelsSection_module_css_default["primaryButton"],
								disabled: auth.busy !== null || auth.apiKey.trim().length === 0,
								onClick: auth.saveApiKey,
								children: auth.busy === "save" ? copy.saving : copy.saveApiKey
							})]
						})]
					}) : null,
					auth.localError === null && status.error == null ? null : (0, react_jsx_runtime.jsx)("p", {
						className: ModelsSection_module_css_default["error"],
						role: "alert",
						children: auth.localError ?? status.error
					})
				]
			});
		}
`;
  let result = replaceExactlyOnce(
    source,
    "\t\t/**\n\t\t* Render the Models section content column.",
    `${helpers}\n\t\t/**\n\t\t* Render the Models section content column.`,
    "Windsurf 设置卡插入点",
  );
  result = replaceExactlyOnce(
    result,
    'const configured = state.rows.filter((row) => row.configured && row.entry.provider !== "openai-codex");\n\t\t\tconst addable = state.rows.filter((row) => !row.configured && row.entry.settingsNs !== "" && row.entry.provider !== "openai-codex");',
    'const configured = state.rows.filter((row) => row.configured && row.entry.provider !== "openai-codex" && row.entry.provider !== "windsurf");\n\t\t\tconst addable = state.rows.filter((row) => !row.configured && row.entry.settingsNs !== "" && row.entry.provider !== "openai-codex" && row.entry.provider !== "windsurf");',
    "Windsurf 通用 Provider 行去重",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)(OpenAICodexOAuthCard, {}),',
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)(OpenAICodexOAuthCard, {}),\n\t\t\t\t\t(0, react_jsx_runtime.jsx)(WindsurfAuthCard, {}),',
    "Windsurf 设置卡渲染位置",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\tconst [localError, setLocalError] = (0, react.useState)(null);\n\t\t\tconst refresh = (0, react.useCallback)(async () => {',
    '\t\t\tconst [localError, setLocalError] = (0, react.useState)(null);\n\t\t\tconst loginGenerationRef = (0, react.useRef)(0);\n\t\t\tconst refresh = (0, react.useCallback)(async () => {',
    "OpenAI OAuth 取消代次",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\tconst login = (0, react.useCallback)(async () => {\n\t\t\t\tsetBusy(true);',
    '\t\t\tconst login = (0, react.useCallback)(async () => {\n\t\t\t\tconst loginGeneration = ++loginGenerationRef.current;\n\t\t\t\tsetBusy(true);',
    "OpenAI OAuth 登录代次",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t\t\tfor (let attempt = 0; attempt < 180; attempt++) {\n\t\t\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, 1000));\n\t\t\t\t\t\tconst next = await oauthRequest("status");',
    '\t\t\t\t\tfor (let attempt = 0; attempt < 180; attempt++) {\n\t\t\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, 1000));\n\t\t\t\t\t\tif (loginGeneration !== loginGenerationRef.current) return;\n\t\t\t\t\t\tconst next = await oauthRequest("status");',
    "OpenAI OAuth 取消停止轮询",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t\t} catch (error) {\n\t\t\t\t\tsetLocalError(error instanceof Error ? error.message : String(error));\n\t\t\t\t} finally {\n\t\t\t\t\tsetBusy(false);\n\t\t\t\t}\n\t\t\t}, [onConnected]);\n\t\t\tconst logout = (0, react.useCallback)(async () => {',
    '\t\t\t\t} catch (error) {\n\t\t\t\t\tif (loginGeneration === loginGenerationRef.current) setLocalError(error instanceof Error ? error.message : String(error));\n\t\t\t\t} finally {\n\t\t\t\t\tif (loginGeneration === loginGenerationRef.current) setBusy(false);\n\t\t\t\t}\n\t\t\t}, [onConnected]);\n\t\t\tconst logout = (0, react.useCallback)(async () => {\n\t\t\t\tloginGenerationRef.current += 1;',
    "OpenAI OAuth 取消清理",
  );
  result = replaceExactlyOnce(
    result,
    'disabled: waiting,\n\t\t\t\t\t\t\t\tonClick: oauth.login,\n\t\t\t\t\t\t\t\tchildren: waiting ? copy.connecting : copy.login',
    'disabled: false,\n\t\t\t\t\t\t\t\tonClick: waiting ? oauth.logout : oauth.login,\n\t\t\t\t\t\t\t\tchildren: waiting ? "取消授权" : copy.login',
    "OpenAI OAuth 等待时允许取消",
  );
  return result;
}

/**
 * 账户使用情况面板属于纯展示层，实现已移交 G4 的
 * `lib/frontend/account-usage-panel.mjs`；此处保留同名委托，
 * `scripts/Build-CandidateRelease.mjs` 的命名导入不变。
 */
export function patchAccountUsageSettingsSource(source) {
  return patchAccountUsageSettingsFrontendSource(source);
}

export function patchModelSelectionUxSource(source) {
  let result = replaceRangeExactlyOnce(
    source,
    "\t\t\tasync select(selection) {",
    "\n\t\t\t/**\n\t\t\t* Drop the previous Host generation",
    `\t\t\tasync select(selection) {
\t\t\t\tthis.assertAvailable();
\t\t\t\tconst generation = ++this.generation;
\t\t\t\tconst previous = this.store.getSnapshot();
\t\t\t\tthis.store.update((s) => {
\t\t\t\t\ts.current = {
\t\t\t\t\t\tprovider: selection.provider,
\t\t\t\t\t\tmodel: selection.model,
\t\t\t\t\t\t...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
\t\t\t\t\t};
\t\t\t\t\ts.routable = false;
\t\t\t\t\ts.status = "selecting";
\t\t\t\t\ts.error = null;
\t\t\t\t});
\t\t\t\tconst { result } = await this.sessions.selectModel({
\t\t\t\t\tsessionId: this.sessionId,
\t\t\t\t\tprovider: selection.provider,
\t\t\t\t\tmodel: selection.model,
\t\t\t\t\t...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
\t\t\t\t});
\t\t\t\tif (this.disposed || generation !== this.generation) {
\t\t\t\t\tif (!result.ok) throw new Error(\`\${result.error.code}: \${result.error.message}\`);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (!result.ok) {
\t\t\t\t\tthis.store.update((s) => {
\t\t\t\t\t\ts.current = previous.current;
\t\t\t\t\t\ts.routable = previous.routable;
\t\t\t\t\t\ts.status = "error";
\t\t\t\t\t\ts.error = \`\${result.error.code}: \${result.error.message}\`;
\t\t\t\t\t});
\t\t\t\t\tthrow new Error(\`session.selectModel failed: \${result.error.code}: \${result.error.message}\`);
\t\t\t\t}
\t\t\t\tthis.store.update((s) => {
\t\t\t\t\ts.current = result.value.selected;
\t\t\t\t\ts.routable = true;
\t\t\t\t\ts.status = "ready";
\t\t\t\t\ts.error = null;
\t\t\t\t});
\t\t\t}
\t\t\t/**
\t\t\t* Drop the previous Host generation`,
    "模型选择即时反馈状态机",
  );
  result = replaceRangeExactlyOnce(
    result,
    "\t\tfunction ModelSelect({ locked, available, directory, load, select, t }) {",
    "\n\t\t//#endregion\n\t\t//#region lib/types/client/locales.js",
    `${MODEL_FACET_BROWSER_SOURCE}\n${MODEL_SELECT_BROWSER_SOURCE.trimStart()}\n\t\t//#endregion\n\t\t//#region lib/types/client/locales.js`,
    "模型选择三层界面",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t"trigger.ariaEffort": "选择模型，当前 {model}，推理等级 {effort}",\n\t\t\t"menu.aria": "模型与推理等级",\n\t\t\t"menu.model": "模型",\n\t\t\t"menu.effort": "推理等级",\n\t\t\t"effort.providerDefault": "Default",\n\t\t\t"status.loading": "正在刷新模型列表…",',
    '\t\t\t"trigger.ariaEffort": "选择模型，当前 {model}，推理强度 {effort}",\n\t\t\t"menu.aria": "模型、上下文窗口、推理强度与速度",\n\t\t\t"menu.model": "模型",\n\t\t\t"menu.context": "上下文窗口",\n\t\t\t"menu.effort": "推理强度",\n\t\t\t"menu.speed": "速度",\n\t\t\t"effort.unset": "未选择",\n\t\t\t"status.loading": "正在刷新模型列表…",\n\t\t\t"status.selecting": "正在切换模型…",\n\t\t\t"status.selectingShort": "切换中…",',
    "模型选择中文词条",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t"error.action": "模型操作失败：{message}",\n\t\t\t"action.reload": "重新加载",',
    '\t\t\t"error.action": "模型操作失败：{message}",\n\t\t\t"error.combination": "当前推理强度与速度没有可用的真实模型组合。",\n\t\t\t"action.reload": "重新加载",',
    "模型组合错误中文词条",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t"trigger.ariaEffort": "Select model, current {model}, reasoning effort {effort}",\n\t\t\t"menu.aria": "Model and reasoning effort",\n\t\t\t"menu.model": "Model",\n\t\t\t"menu.effort": "Effort",\n\t\t\t"effort.providerDefault": "Default",\n\t\t\t"status.loading": "Refreshing model list…",',
    '\t\t\t"trigger.ariaEffort": "Select model, current {model}, reasoning effort {effort}",\n\t\t\t"menu.aria": "Model, context window, reasoning effort, and speed",\n\t\t\t"menu.model": "Model",\n\t\t\t"menu.context": "Context window",\n\t\t\t"menu.effort": "Reasoning",\n\t\t\t"menu.speed": "Speed",\n\t\t\t"effort.unset": "Not selected",\n\t\t\t"status.loading": "Refreshing model list…",\n\t\t\t"status.selecting": "Switching model…",\n\t\t\t"status.selectingShort": "Switching…",',
    "模型选择英文词条",
  );
  result = replaceExactlyOnce(
    result,
    '\t\t\t"error.action": "Model operation failed: {message}",\n\t\t\t"action.reload": "Reload",',
    '\t\t\t"error.action": "Model operation failed: {message}",\n\t\t\t"error.combination": "No real model variant supports this reasoning and speed combination.",\n\t\t\t"action.reload": "Reload",',
    "模型组合错误英文词条",
  );
  result = replaceRangeExactlyOnce(
    result,
    "\t\tfunction optionsOf(directory, t) {",
    "\n\t\t/**\n\t\t* Resolve a picked row back",
    `\t\tfunction optionsOf(directory, t) {
\t\t\tconst rows = [];
\t\t\tfor (const group of stardustFacetGroups(directory.groups)) for (const family of group.families) rows.push({
\t\t\t\tid: rowId(group.id, family.id),
\t\t\t\tlabel: family.name,
\t\t\t\tdetail: family.description !== void 0 ? \`\${group.name} · \${family.description}\` : group.name,
\t\t\t\t...stardustFamilyForCurrent([group], directory.current)?.family.id === family.id ? { active: true } : {}
\t\t\t});
\t\t\tfor (const failure of directory.failures) rows.push({
\t\t\t\tid: \`failure/\${failure.id}\`,
\t\t\t\tlabel: failure.name,
\t\t\t\tdetail: t("option.loadError", { message: failure.message })
\t\t\t});
\t\t\treturn rows;
\t\t}
\t\t/**
\t\t* Resolve a picked row back`,
    "/model 基础模型列表",
  );
  result = replaceRangeExactlyOnce(
    result,
    "\t\tfunction selectionOf(state, id) {",
    "\n\t\t/** Dictionary namespace owned by this plugin. */",
    `\t\tfunction selectionOf(state, id) {
\t\t\tconst facetGroups = stardustFacetGroups(state.groups);
\t\t\tconst current = stardustFamilyForCurrent(facetGroups, state.current);
\t\t\tfor (const group of facetGroups) for (const family of group.families) {
\t\t\t\tif (rowId(group.id, family.id) !== id) continue;
\t\t\t\treturn stardustSelectionForFamily(family, {
\t\t\t\t\teffort: current?.family.id === family.id && current.group.id === group.id ? state.current?.reasoningEffort ?? current.variant.effort : void 0,
\t\t\t\t\tspeed: current?.family.id === family.id && current.group.id === group.id ? current.variant.speed : STARDUST_STANDARD_SPEED,
\t\t\t\t\tcontext: current?.family.id === family.id && current.group.id === group.id ? current.variant.context : STARDUST_DEFAULT_CONTEXT
\t\t\t\t});
\t\t\t}
\t\t}
\t\t/** Dictionary namespace owned by this plugin. */`,
    "/model 真实组合解析",
  );
  return result;
}

export function patchHostModelSelectionSource(source) {
  if (source.includes("const pendingImage = [...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep]")) {
    let result = replaceExactlyOnce(
      source,
      `                const logged = agent.session.requestHeader()?.config;
                if (logged === undefined)
                    return defaults.defaultModelSelection();
                return {
                    provider: logged.provider,
                    model: logged.model,
                    ...logged.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: logged.reasoningEffort },
                };`,
      `                const durable = agent.session.requestContext?.();
                const logged = agent.session.requestHeader()?.config;
                const provider = durable?.provider ?? logged?.provider;
                const model = durable?.model ?? logged?.model;
                if (provider === undefined || model === undefined)
                    return defaults.defaultModelSelection();
                const reasoningEffort = durable?.reasoningEffort
                    ?? (logged?.provider === provider && logged?.model === model ? logged.reasoningEffort : undefined);
                return {
                    provider,
                    model,
                    ...reasoningEffort === undefined ? {} : { reasoningEffort },
                };`,
      "模型切换类型文件从持久请求上下文恢复当前选择",
    );
    result = replaceExactlyOnce(
      result,
      `                        const pendingImage = [...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep]
                            .some(message => contentHasImage(message.content));
                        if (pendingImage || messagesHaveImage(found.agent.session.deriveMessages())) {
                            const info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);
                            if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
                                return err(request, {`,
      `                        const info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);
                        const acceptsImages = info.inputModalities === undefined || info.inputModalities.includes('image');
                        if (false && !acceptsImages) {
                            const pendingImage = [...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep]
                                .some(message => contentHasImage(message.content));
                            if (pendingImage || messagesHaveImage(found.agent.session.deriveMessages())) {
                                return err(request, {`,
      "模型切换类型文件按能力跳过长会话图片扫描",
    );
    result = replaceExactlyOnce(
      result,
      `                        selectionFor(found.agent).current = selected;
                        try {
                            await defaults.saveDefaultModelSelection?.(selected);`,
      `                        selectionFor(found.agent).current = selected;
                         const requestContext = {
                             provider: selected.provider,
                             model: selected.model,
                             ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
                             ...(info.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
                         };
                        const previousContext = found.agent.session.requestContext();
                        if (previousContext?.provider !== requestContext.provider
                             || previousContext.model !== requestContext.model
                             || previousContext.reasoningEffort !== requestContext.reasoningEffort
                             || previousContext.contextWindow !== requestContext.contextWindow) {
                            found.agent.session.append("request/context", requestContext);
                        }
                        try {
                            await defaults.saveDefaultModelSelection?.(selected);`,
      "模型切换类型文件立即同步上下文窗口",
    );
    result = replaceExactlyOnce(
      result,
      `                        try {
                            await defaults.saveDefaultModelSelection?.(selected);
                        }
                        catch (error) {
                            ctx.logger.warn(\`api-proxy: the model switch applies to this session but was not saved as the default: \${String(error)}\`);
                        }
                        return ok(request, { selected: { ...selected } });`,
      `                        void Promise.resolve(defaults.saveDefaultModelSelection?.(selected)).catch((error) => {
                            ctx.logger.warn(\`api-proxy: the model switch applies to this session but was not saved as the default: \${String(error)}\`);
                        });
                        return ok(request, { selected: { ...selected } });`,
      "模型切换类型文件异步保存默认值",
    );
    result = replaceExactlyOnce(
      result,
      `            set current(next) {
                picked = next;
            },
            assembled: undefined,`,
      `            set current(next) {
                picked = next;
            },
            pending: undefined,
            assembled: undefined,`,
      "模型切换类型文件记录未完成选择",
    );
    result = replaceExactlyOnce(
      result,
      `        const agent = found.agent;
        const selection = selectionFor(agent).current;`,
      `        const agent = found.agent;
        const selectionState = selectionFor(agent);
        if (selectionState.pending !== undefined) await selectionState.pending;
        const selection = selectionState.current;`,
      "模型切换类型文件轮次等待选择完成",
    );
    result = replaceExactlyOnce(
      result,
      `                return serializeImageAdmission(found.agent, async () => {`,
      `                const selectionState = selectionFor(found.agent);
                const pendingSelection = serializeImageAdmission(found.agent, async () => {`,
      "模型切换类型文件建立选择屏障",
    );
    result = replaceExactlyOnce(
      result,
      `                    }
                });
            },
            async rename(request) {`,
      `                    }
                });
                selectionState.pending = pendingSelection;
                try {
                    return await pendingSelection;
                }
                finally {
                    if (selectionState.pending === pendingSelection) selectionState.pending = undefined;
                }
            },
            async rename(request) {`,
      "模型切换类型文件释放选择屏障",
    );
    return result;
  }
  let result = replaceExactlyOnce(
    source,
    `\t\t\t\tconst logged = agent.session.requestHeader()?.config;
\t\t\t\tif (logged === void 0) return defaults.defaultModelSelection();
\t\t\t\treturn {
\t\t\t\t\tprovider: logged.provider,
\t\t\t\t\tmodel: logged.model,
\t\t\t\t\t...logged.reasoningEffort === void 0 ? {} : { reasoningEffort: logged.reasoningEffort }
\t\t\t\t};`,
    `\t\t\t\tconst durable = agent.session.requestContext?.();
\t\t\t\tconst logged = agent.session.requestHeader()?.config;
\t\t\t\tconst provider = durable?.provider ?? logged?.provider;
\t\t\t\tconst model = durable?.model ?? logged?.model;
\t\t\t\tif (provider === void 0 || model === void 0) return defaults.defaultModelSelection();
\t\t\t\tconst reasoningEffort = durable?.reasoningEffort ?? (logged?.provider === provider && logged?.model === model ? logged.reasoningEffort : void 0);
\t\t\t\treturn {
\t\t\t\t\tprovider,
\t\t\t\t\tmodel,
\t\t\t\t\t...reasoningEffort === void 0 ? {} : { reasoningEffort }
\t\t\t\t};`,
    "模型切换从持久请求上下文恢复当前选择",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\tconst resolved = await ctx.llm.resolveCallConfig({
\t\t\t\t\t\t\tprovider,
\t\t\t\t\t\t\tmodel,
\t\t\t\t\t\t\t...reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }
\t\t\t\t\t\t});
\t\t\t\t\t\tif ([...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep].some((message) => contentHasImage(message.content)) || messagesHaveImage(found.agent.session.deriveMessages())) {
\t\t\t\t\t\t\tconst info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);
\t\t\t\t\t\t\tif (info.inputModalities !== void 0 && !info.inputModalities.includes("image")) return err(request, {`,
    `\t\t\t\t\t\tconst resolved = await ctx.llm.resolveCallConfig({
\t\t\t\t\t\t\tprovider,
\t\t\t\t\t\t\tmodel,
\t\t\t\t\t\t\t...reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }
\t\t\t\t\t\t});
\t\t\t\t\t\tconst info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);
\t\t\t\t\t\tif (false && info.inputModalities !== void 0 && !info.inputModalities.includes("image")) {
\t\t\t\t\t\t\tif ([...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep].some((message) => contentHasImage(message.content)) || messagesHaveImage(found.agent.session.deriveMessages())) return err(request, {`,
    "模型切换按能力跳过长会话图片扫描",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\tselectionFor(found.agent).current = selected;
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tawait defaults.saveDefaultModelSelection?.(selected);`,
    `\t\t\t\t\t\tselectionFor(found.agent).current = selected;
\t\t\t\t\t\tconst requestContext = {
\t\t\t\t\t\t\tprovider: selected.provider,
\t\t\t\t\t\t\tmodel: selected.model,
\t\t\t\t\t\t\t...selected.reasoningEffort === void 0 ? {} : { reasoningEffort: selected.reasoningEffort },
\t\t\t\t\t\t\t...info.context?.contextWindow === void 0 ? {} : { contextWindow: info.context.contextWindow }
\t\t\t\t\t\t};
\t\t\t\t\t\tconst previousContext = found.agent.session.requestContext();
\t\t\t\t\t\tif (previousContext?.provider !== requestContext.provider || previousContext.model !== requestContext.model || previousContext.reasoningEffort !== requestContext.reasoningEffort || previousContext.contextWindow !== requestContext.contextWindow) found.agent.session.append("request/context", requestContext);
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tawait defaults.saveDefaultModelSelection?.(selected);`,
    "模型切换立即同步上下文窗口",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tawait defaults.saveDefaultModelSelection?.(selected);
\t\t\t\t\t\t} catch (error) {
\t\t\t\t\t\t\tctx.logger.warn(\`api-proxy: the model switch applies to this session but was not saved as the default: \${String(error)}\`);
\t\t\t\t\t\t}
\t\t\t\t\t\treturn ok(request, { selected: { ...selected } });`,
    `\t\t\t\t\t\tvoid Promise.resolve(defaults.saveDefaultModelSelection?.(selected)).catch((error) => {
\t\t\t\t\t\t\tctx.logger.warn(\`api-proxy: the model switch applies to this session but was not saved as the default: \${String(error)}\`);
\t\t\t\t\t\t});
\t\t\t\t\t\treturn ok(request, { selected: { ...selected } });`,
    "模型切换默认值异步保存",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tset current(next) {
\t\t\t\tpicked = next;
\t\t\t},
\t\t\tassembled: void 0`,
    `\t\t\tset current(next) {
\t\t\t\tpicked = next;
\t\t\t},
\t\t\tpending: void 0,
\t\t\tassembled: void 0`,
    "模型切换记录未完成选择",
  );
  result = replaceExactlyOnce(
    result,
    `\t\tconst agent = found.agent;
\t\tconst selection = selectionFor(agent).current;`,
    `\t\tconst agent = found.agent;
\t\tconst selectionState = selectionFor(agent);
\t\tif (selectionState.pending !== void 0) await selectionState.pending;
\t\tconst selection = selectionState.current;`,
    "模型轮次等待选择完成",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\treturn serializeImageAdmission(found.agent, async () => {`,
    `\t\t\t\tconst selectionState = selectionFor(found.agent);
\t\t\t\tconst pendingSelection = serializeImageAdmission(found.agent, async () => {`,
    "模型切换建立选择屏障",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t}
\t\t\t\t});
\t\t\t},
\t\t\tasync rename(request) {`,
    `\t\t\t\t\t}
\t\t\t\t});
\t\t\t\tselectionState.pending = pendingSelection;
\t\t\t\ttry {
\t\t\t\t\treturn await pendingSelection;
\t\t\t\t} finally {
\t\t\t\t\tif (selectionState.pending === pendingSelection) selectionState.pending = void 0;
\t\t\t\t}
\t\t\t},
\t\t\tasync rename(request) {`,
    "模型切换释放选择屏障",
  );
  return result;
}

export function patchAgentInstructionsSource(source) {
  const replacements = [
    [
      'const SYSTEM_REMINDER_CLOSE = "</system-reminder>";',
      'const SYSTEM_REMINDER_CLOSE = "</system-reminder>";\nconst DSH_IGNORE_MARKER = "<!-- dsh:ignore -->";',
      "DSH 跳过标记",
    ],
    [
      'const WORKSPACE_CONTEXT_INTRO = "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.";',
      'const WORKSPACE_CONTEXT_INTRO = "下面是当前工作区可能与你正在处理的内容有关的规则。需要时遵循；距离目标文件更近的规则更具体，但它们不能覆盖系统要求、当前运行安全状态或主人的直接指令。";',
      "工作区规则基线说明",
    ],
    [
      'const REPLACEMENT_WORKSPACE_CONTEXT_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.";',
      'const REPLACEMENT_WORKSPACE_CONTEXT_INTRO = "这是一份完整的新工作区规则基线，替代此前所有工作区规则基线。需要时遵循下面的规则；距离目标文件更近的规则更具体，但它们不能覆盖系统要求、当前运行安全状态或主人的直接指令。";',
      "工作区规则替换说明",
    ],
    [
      'const EMPTY_REPLACEMENT_WORKSPACE_CONTEXT_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active.";',
      'const EMPTY_REPLACEMENT_WORKSPACE_CONTEXT_INTRO = "这份空基线替代此前所有工作区规则基线；当前没有生效的工作区规则。";',
      "空工作区规则说明",
    ],
    [
      'const COMPACT_WORKSPACE_CONTEXT_INTRO = "Workspace instructions were omitted or truncated to fit the configured byte budget.";',
      'const COMPACT_WORKSPACE_CONTEXT_INTRO = "部分工作区规则因超过当前字节预算而被省略或截短；不要假装已经看过被省略的内容。";',
      "工作区规则截断说明",
    ],
    [
      'return `Instructions from: ${file.displayPath}\\n\\n${file.content}`;',
      'return `【工作区规则来源：${file.displayPath}】\\n\\n${file.content}`;',
      "工作区规则来源标题",
    ],
    [
      '`Additional instructions from: ${file.displayPath}`',
      '`【新增工作区规则：${file.displayPath}】`',
      "新增工作区规则标题",
    ],
    [
      '`These instructions apply to work under \\`${scope}\\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.`',
      '`这些规则适用于 \\`${scope}\\` 目录及其内部内容。处理相关文件时遵循；更深目录的规则更具体，但不能覆盖系统要求、当前运行安全状态或主人的直接指令。`',
      "新增工作区规则范围",
    ],
    [
      'if (change.action === "remove") return `Instructions removed: ${change.path}\\n\\nThe previously loaded instructions from this file no longer apply.`;',
      'if (change.action === "remove") return `【工作区规则已移除：${change.path}】\\n\\n此前从该文件加载的规则不再生效。`;',
      "工作区规则移除通知",
    ],
    [
      '`Updated instructions from: ${change.path}`',
      '`【工作区规则已更新：${change.path}】`',
      "工作区规则更新标题",
    ],
    [
      '"This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file."',
      '"该文件在加载后发生了变化。下面的完整内容替代此前从该文件加载的规则。"',
      "工作区规则更新说明",
    ],
    [
      'if (omitted.length > 0) parts.push(`omitted ${omitted.map((file) => file.displayPath).join(", ")}`);',
      'if (omitted.length > 0) parts.push(`已省略：${omitted.map((file) => file.displayPath).join(", ")}`);',
      "工作区规则省略标记",
    ],
    [
      'if (truncated.length > 0) parts.push(`truncated ${truncated.map((item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(", ")}`);',
      'if (truncated.length > 0) parts.push(`已截短：${truncated.map((item) => `${item.displayPath}，由 ${item.originalBytes} 字节缩到 ${item.includedBytes} 字节`).join(", ")}`);',
      "工作区规则截短标记",
    ],
    [
      'return `Workspace instruction budget ${maxBytes} bytes: ${parts.join("; ")}`;',
      'return `工作区规则预算为 ${maxBytes} 字节：${parts.join("；")}`;',
      "工作区规则预算说明",
    ],
    [
      'if (content !== void 0) loaded.push({',
      'if (content !== void 0 && !content.includes(DSH_IGNORE_MARKER)) loaded.push({',
      "初始基线跳过标记",
    ],
    [
      'if (content === void 0) return void 0;\n\treturn {',
      'if (content === void 0 || content.includes(DSH_IGNORE_MARKER)) return void 0;\n\treturn {',
      "动态刷新跳过标记",
    ],
    [
      'if (!projectionLifecycle.signal.aborted) ctx.logger.warn("workspace instruction refresh failed: %o", error);',
      'if (!projectionLifecycle.signal.aborted) ctx.logger.warn("工作区规则刷新失败：%o", error);',
      "工作区规则错误日志",
    ],
  ];

  let result = source;
  for (const [before, after, label] of replacements) {
    result = replaceExactlyOnce(result, before, after, label);
  }
  return result;
}

export function patchMcpClientMultimodalSource(source) {
  let result = source;
  result = replaceExactlyOnce(
    result,
    "for (const [publicName, definition] of definitions) disposers.set(publicName, ctx.tools.register(definition));",
    "for (const [publicName, definition] of definitions) disposers.set(publicName, ctx.root.tools.register(definition));",
    "MCP 工具注册提升到宿主根作用域",
  );
  result = replaceExactlyOnce(
    result,
    'import { createHash } from "node:crypto";',
    'import { createHash } from "node:crypto";\nimport { mkdir, writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";',
    "MCP 多媒体持久化依赖",
  );
  result = replaceExactlyOnce(
    result,
    'execute: createExecutor(client, tool.name, tool.execution?.taskSupport === "required", opts)',
    'execute: createExecutor(client, tool.name, tool.execution?.taskSupport === "required", opts, ctx)',
    "MCP executor 上下文接线",
  );
  result = replaceExactlyOnce(
    result,
    `return [{
\t\t\t\ttype: "text",
\t\t\t\ttext: extractText(value.content, rawName)
\t\t\t}];`,
    "return renderMcpContent(value.content, rawName);",
    "MCP Native 内容渲染",
  );
  result = replaceExactlyOnce(
    result,
    "function createExecutor(client, rawName, taskRequired, opts) {",
    "function createExecutor(client, rawName, taskRequired, opts, ctx) {",
    "MCP executor 签名",
  );
  result = replaceExactlyOnce(
    result,
    `\t\tconst content = result.content;
\t\tconst text = extractText(content, rawName);
\t\tif (result.isError === true) throw new Error(text);
\t\treturn {
\t\t\tcontent,
\t\t\t...result.structuredContent !== void 0 ? { structuredContent: result.structuredContent } : {}
\t\t};`,
    `\t\tconst rawContent = result.content;
\t\tconst text = extractText(rawContent, rawName);
\t\tif (result.isError === true) throw new Error(text);
\t\tconst content = await prepareMcpContent(rawContent, rawName, ctx, exec);
\t\treturn {
\t\t\tcontent,
\t\t\t...result.structuredContent !== void 0 ? { structuredContent: result.structuredContent } : {}
\t\t};`,
    "MCP executor 内容准备",
  );

  const start = "function extractText(mcpContent, toolName) {";
  const end = "//#endregion";
  const first = result.indexOf(start);
  const second = result.indexOf(start, first + start.length);
  const endIndex = result.indexOf(end, first);
  if (first < 0 || second >= 0 || endIndex < 0) {
    throw new Error("MCP 内容投影结构与受支持的 DSH 0.1.0-rc.6 结构不一致，停止修改候选版本");
  }
  const helpers = `const MCP_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MCP_ARTIFACT_ROOT = process.env.DSH_MCP_ARTIFACT_ROOT || join(process.env.LOCALAPPDATA || tmpdir(), "DeepSeekHarness", "mcp-artifacts");

function artifactSafeName(value) {
\treturn String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "mcp-tool";
}

async function persistMcpBlock(block, toolName) {
\tconst serialized = JSON.stringify(block);
\tconst hash = createHash("sha256").update(serialized).digest("hex");
\tawait mkdir(MCP_ARTIFACT_ROOT, { recursive: true });
\tconst path = join(MCP_ARTIFACT_ROOT, \`\${artifactSafeName(toolName)}-\${hash}.json\`);
\ttry {
\t\tawait writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
\t} catch (error) {
\t\tif (error?.code !== "EEXIST") throw error;
\t}
\treturn { path, sha256: hash, bytes: Buffer.byteLength(serialized) };
}

async function routeSupportsImage(ctx, exec) {
\tconst routed = exec.agent?.session.requestHeader()?.config;
\tconst provider = routed?.provider ?? exec.agent?.options.provider;
\tconst model = routed?.model ?? exec.agent?.options.model;
\tconst llm = ctx.get("llm");
\tif (provider === void 0 || model === void 0 || llm === void 0) return false;
\tconst active = await llm.resolveModelInfo(provider, model, exec.signal);
\treturn Array.isArray(active.inputModalities) && active.inputModalities.includes("image");
}

function artifactMessage(kind, artifact, detail = "") {
\treturn \`[MCP \${kind} 已完整保存，不冒充模型已直接读取\${detail ? \`: \${detail}\` : ""}; artifact=\${artifact.path}; sha256=\${artifact.sha256}; bytes=\${artifact.bytes}]\`;
}

async function prepareMcpContent(mcpContent, toolName, ctx, exec) {
\tconst prepared = [];
\tfor (const value of mcpContent) {
\t\tif (typeof value !== "object" || value === null || Array.isArray(value)) {
\t\t\tconst artifact = await persistMcpBlock(value, toolName);
\t\t\tprepared.push({ type: "stardust_text", text: artifactMessage("未知内容", artifact) });
\t\t\tcontinue;
\t\t}
\t\tconst block = value;
\t\tif (block.type === "text") {
\t\t\tprepared.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
\t\t\tcontinue;
\t\t}
\t\tif (block.type === "image") {
\t\t\tconst attachments = ctx.get("attachments");
\t\t\tconst canUseImage = attachments !== void 0
\t\t\t\t&& MCP_IMAGE_TYPES.has(block.mimeType)
\t\t\t\t&& attachments.imageLimits.mediaTypes.includes(block.mimeType)
\t\t\t\t&& await routeSupportsImage(ctx, exec);
\t\t\tif (canUseImage && typeof block.data === "string") {
\t\t\t\ttry {
\t\t\t\t\tconst ref = await attachments.saveImage({ data: Buffer.from(block.data, "base64"), mediaType: block.mimeType });
\t\t\t\t\tprepared.push({ type: "stardust_image", attachment: ref, summary: \`MCP 图片 \${ref.mediaType}，\${ref.width}x\${ref.height}，\${ref.bytes} 字节\` });
\t\t\t\t\tcontinue;
\t\t\t\t} catch {}
\t\t\t}
\t\t\tconst artifact = await persistMcpBlock(block, toolName);
\t\t\tprepared.push({ type: "stardust_text", text: artifactMessage("图片", artifact, "当前模型或附件服务不支持直接视觉输入") });
\t\t\tcontinue;
\t\t}
\t\tif (block.type === "resource") {
\t\t\tconst artifact = await persistMcpBlock(block, toolName);
\t\t\tconst resource = block.resource;
\t\t\tconst label = resource?.uri ? \`资源 \${resource.uri}\` : "资源";
\t\t\tconst text = typeof resource?.text === "string" ? \`\${label}\\n\${resource.text}\\n\${artifactMessage("资源块", artifact)}\` : artifactMessage(label, artifact);
\t\t\tprepared.push({ type: "stardust_text", text });
\t\t\tcontinue;
\t\t}
\t\tif (block.type === "resource_link") {
\t\t\tconst artifact = await persistMcpBlock(block, toolName);
\t\t\tprepared.push({ type: "stardust_text", text: artifactMessage("资源链接", artifact, block.uri || block.name || "") });
\t\t\tcontinue;
\t\t}
\t\tif (block.type === "audio") {
\t\t\tconst artifact = await persistMcpBlock(block, toolName);
\t\t\tprepared.push({ type: "stardust_text", text: artifactMessage("音频", artifact, "DSH rc.6 没有原生音频上下文类型") });
\t\t\tcontinue;
\t\t}
\t\tconst artifact = await persistMcpBlock(block, toolName);
\t\tprepared.push({ type: "stardust_text", text: artifactMessage(\`\${block.type || "未知"} 内容\`, artifact) });
\t}
\treturn prepared;
}

function renderMcpContent(content, toolName) {
\tconst rendered = [];
\tfor (const block of content) {
\t\tif (block?.type === "text" || block?.type === "stardust_text") {
\t\t\tif (block.text) rendered.push({ type: "text", text: block.text });
\t\t} else if (block?.type === "stardust_image") {
\t\t\trendered.push({ type: "text", text: block.summary });
\t\t\trendered.push({ type: "image", attachment: block.attachment });
\t\t}
\t}
\treturn rendered.length > 0 ? rendered : [{ type: "text", text: \`(\${toolName} 没有返回可显示内容)\` }];
}

function extractText(mcpContent, toolName) {
\tconst parts = [];
\tfor (const value of mcpContent) {
\t\tif (typeof value !== "object" || value === null || Array.isArray(value)) {
\t\t\tparts.push("[未知内容]");
\t\t\tcontinue;
\t\t}
\t\tconst block = value;
\t\tif (block.type === "text" && block.text !== void 0) parts.push(block.text);
\t\telse parts.push(\`[\${block.type || "未知"} 内容]\`);
\t}
\treturn parts.join("\\n") || \`(\${toolName} 没有返回文本内容)\`;
}
`;
  return `${result.slice(0, first)}${helpers}${result.slice(endIndex)}`;
}

export function patchPiAiFastModelsSource(source) {
  let result = source;
  result = replaceExactlyOnce(
    result,
    'import { openAICodexCredentialStore } from "@stardust/dsh-openai-codex-oauth/store";',
    'import { openAICodexCredentialStore } from "@stardust/dsh-openai-codex-oauth/store";\nimport { loadOpenAICodexCatalog, mergeOpenAICodexCatalogModels } from "@stardust/dsh-openai-codex-oauth/catalog";\nimport { createWindsurfPiProvider } from "@deepseek-harness/experimental-windsurf-provider/provider";',
    "动态模型 Provider 导入",
  );
  result = replaceExactlyOnce(
    result,
    `function buildProvider(spec) {
\tconst catalog = catalogProvider(spec.provider);`,
    `function buildProvider(spec) {
\tif (spec.provider === "windsurf") return createWindsurfPiProvider();
\tconst catalog = catalogProvider(spec.provider);`,
    "Windsurf 原生 Provider 注册",
  );
  result = replaceExactlyOnce(
    result,
    "const entries = Object.entries(providers ?? {});",
    `const windsurfProvider = createWindsurfPiProvider();
\tconst entries = Object.entries({
\t\twindsurf: {
\t\t\tdisplayName: windsurfProvider.name,
\t\t\tapi: "openai-completions",
\t\t\tbaseURL: windsurfProvider.baseUrl,
\t\t\tmodels: windsurfProvider.getModels().map(({ id, name, input, contextWindow, maxTokens }) => ({ id, name, input, contextWindow, maxTokens }))
\t\t},
\t\t...providers ?? {}
\t});`,
    "Windsurf 内置 Provider 配置",
  );
  result = replaceExactlyOnce(
    result,
    "return getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : void 0;",
    "return supportedReasoningLevels(model).some((level) => level === effort) ? effort : void 0;",
    "pi-ai 模型描述推理档位",
  );
  result = replaceExactlyOnce(
    result,
    "if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;",
    "if (supportedReasoningLevels(model).some((level) => level === effort)) return effort;",
    "pi-ai 请求推理档位校验",
  );
  result = replaceExactlyOnce(
    result,
    "efforts: getSupportedThinkingLevels(model).map((level) => ({",
    "efforts: supportedReasoningLevels(model).map((level) => ({",
    "pi-ai 推理档位展示",
  );
  result = replaceExactlyOnce(
    result,
    "var PiAiAdapter = class extends LlmAdapter {",
    `const FAST_MODEL_PREFIX = "fast::";
function isFastModel(provider, model) {
\treturn provider === "openai-codex" && model.startsWith(FAST_MODEL_PREFIX);
}
function baseModelId(provider, model) {
\treturn isFastModel(provider, model) ? model.slice(FAST_MODEL_PREFIX.length) : model;
}
function fastModelId(model) {
\treturn \`\${FAST_MODEL_PREFIX}\${model}\`;
}
function supportedReasoningLevels(model) {
\treturn Array.isArray(model.stardustReasoningEfforts) ? [...model.stardustReasoningEfforts] : getSupportedThinkingLevels(model);
}
function supportsFastModel(model) {
\treturn Array.isArray(model.stardustServiceTiers) && model.stardustServiceTiers.some((tier) => tier?.id === "priority");
}
function requestOptionsForModel(options, model) {
\tconst isVisionTool = (tool) => tool?.name === "read_image" || tool?.name === "view_image" || tool?.name === "inspect_image" || tool?.requiresVision === true || tool?.requires_vision === true || Array.isArray(tool?.inputModalities) && tool.inputModalities.includes("image");
\tconst hasDirectImage = options.messages?.some((message) => contentHasImage(message.content)) === true;
\tif (model.input.includes("image")) {
\t\tif (!hasDirectImage) return options;
\t\tconst tools = options.tools?.filter((tool) => !isVisionTool(tool));
\t\treturn {
\t\t\t...options,
\t\t\t...tools === void 0 ? {} : { tools }
\t\t};
\t}
\tconst tools = options.tools?.filter((tool) => !isVisionTool(tool));
\tconst imagePlaceholder = "[图片已在本次非视觉模型请求中暂时省略；原会话中的图片仍然保留]";
\tconst sanitizeBlocks = (blocks) => Array.isArray(blocks) ? blocks.map((part) => {
\t\tif (part?.type === "image" || part?.type === "image_url" || part?.type === "input_image") return { type: "text", text: imagePlaceholder };
\t\tif (part?.type === "tool-result" && Array.isArray(part.content)) return { ...part, content: sanitizeBlocks(part.content) };
\t\treturn part;
\t}) : blocks;
\tconst messages = options.messages?.map((message) => ({
\t\t...message,
\t\tcontent: sanitizeBlocks(message.content)
\t}));
\tconst note = "当前模型仅支持文本输入，视觉工具未向本次请求暴露；会话中的图片会在本次请求里替换为文字占位，原图仍保留在会话中。";
\treturn {
\t\t...options,
\t\t...messages === void 0 ? {} : { messages },
\t\t...tools === void 0 ? {} : { tools },
\t\tsystem: options.system === void 0 || options.system.length === 0 ? note : options.system + "\\n\\n" + note
\t};
}
function modelsOf(snapshot, provider) {
\treturn provider === "openai-codex" && Array.isArray(snapshot.openAICodexModels)
\t\t? snapshot.openAICodexModels
\t\t: snapshot.models.getModels(provider);
}
async function refreshDynamicModels(snapshot, provider, signal) {
\tif (provider === "openai-codex") {
\t\tconst catalog = await loadOpenAICodexCatalog({ signal });
\t\tsnapshot.openAICodexModels = mergeOpenAICodexCatalogModels(snapshot.models.getModels(provider), catalog);
\t\treturn;
\t}
\tif (provider === "windsurf") await snapshot.models.getProvider(provider)?.refreshModels?.({ allowNetwork: true, signal });
}
var PiAiAdapter = class extends LlmAdapter {`,
    "pi-ai Fast 模型辅助函数",
  );
  result = replaceExactlyOnce(
    result,
    "const resolved = snapshot.models.getModel(provider, model);",
    `const resolved = modelsOf(snapshot, provider).find((entry) => entry.id === baseModelId(provider, model));
\t\tif (resolved !== void 0 && isFastModel(provider, model) && !supportsFastModel(resolved)) throw new LlmError(\`pi-ai provider "\${provider}" model "\${model}" does not support Fast\`, "UNKNOWN_MODEL");`,
    "pi-ai Fast 基础模型解析",
  );
  result = replaceExactlyOnce(
    result,
    'if (state.model !== source.model) return invalidReplay("model does not match assistant source");',
    'const replayModelMatches = state.model === source.model || source.provider === "openai-codex" && source.model.startsWith("fast::") && state.model === source.model.slice("fast::".length);\n\tif (!replayModelMatches) return invalidReplay("model does not match assistant source");',
    "pi-ai Fast 重放模型别名兼容",
  );
  result = replaceExactlyOnce(
    result,
    `listModels(provider) {
\t\treturn Promise.resolve().then(() => {
\t\t\tconst snapshot = this.current();
\t\t\tthis.profileOf(snapshot, provider);
\t\t\treturn snapshot.models.getModels(provider).map((model) => ({
\t\t\t\tprovider,
\t\t\t\tid: model.id,
\t\t\t\tname: model.name,
\t\t\t\tinputModalities: [...model.input]
\t\t\t}));
\t\t});
\t}`,
    `async listModels(provider) {
\t\tconst snapshot = this.current();
\t\tthis.profileOf(snapshot, provider);
\t\tawait refreshDynamicModels(snapshot, provider);
\t\tconst models = modelsOf(snapshot, provider);
\t\treturn models.flatMap((model) => {
\t\t\tconst entry = {
\t\t\t\tprovider,
\t\t\t\tid: model.id,
\t\t\t\tname: model.name,
\t\t\t\tinputModalities: [...model.input],
\t\t\t\t...model.stardustVariantEffort === void 0 ? {} : { stardustVariantEffort: model.stardustVariantEffort }
\t\t\t};
\t\t\treturn provider === "openai-codex" && supportsFastModel(model)
\t\t\t\t? [entry, { ...entry, id: fastModelId(entry.id), name: \`\${entry.name} · Fast\` }]
\t\t\t\t: [entry];
\t\t});
\t}`,
    "pi-ai Fast 模型目录",
  );
  result = replaceExactlyOnce(
    result,
    `resolveModel(provider, model, _signal) {
\t\treturn Promise.resolve().then(() => {
\t\t\tconst snapshot = this.current();
\t\t\tconst profile = this.profileOf(snapshot, provider);
\t\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);
\t\t\tconst defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning);
\t\t\tconst configuredMaxTokens = profile.configuredMaxTokens.get(model);
\t\t\treturn {
\t\t\t\tprovider,
\t\t\t\tid: model,
\t\t\t\tname: resolvedModel.name,
\t\t\t\tinputModalities: [...resolvedModel.input],
\t\t\t\tcontext: { contextWindow: resolvedModel.contextWindow },
\t\t\t\t...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens },
\t\t\t\t...reasoningInfo(resolvedModel, defaultLevel)
\t\t\t};
\t\t});
\t}`,
    `async resolveModel(provider, model, _signal) {
\t\tconst snapshot = this.current();
\t\tconst profile = this.profileOf(snapshot, provider);
\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);
\t\tconst defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning);
\t\tconst configuredMaxTokens = profile.configuredMaxTokens.get(baseModelId(provider, model));
\t\treturn {
\t\t\tprovider,
\t\t\tid: model,
\t\t\tname: isFastModel(provider, model) ? \`\${resolvedModel.name} · Fast\` : resolvedModel.name,
\t\t\tinputModalities: [...resolvedModel.input],
\t\t\tcontext: { contextWindow: resolvedModel.contextWindow },
\t\t\t...resolvedModel.stardustVariantEffort === void 0 ? {} : { stardustVariantEffort: resolvedModel.stardustVariantEffort },
\t\t\t...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens },
\t\t\t...reasoningInfo(resolvedModel, defaultLevel)
\t\t};
\t}`,
    "pi-ai 动态模型解析",
  );
  result = replaceExactlyOnce(
    result,
    "const model = this.modelOf(snapshot, options.provider, options.model);",
    "await refreshDynamicModels(snapshot, options.provider, options.signal);\n\t\t\tconst fastModel = isFastModel(options.provider, options.model);\n\t\t\tconst model = this.modelOf(snapshot, options.provider, options.model);",
    "pi-ai Fast 请求识别",
  );
  result = replaceExactlyOnce(
    result,
    "const containsImage = options.messages.some((message) => contentHasImage(message.content));",
    "const requestOptions = requestOptionsForModel(options, model);\n\t\t\t\tconst containsImage = requestOptions.messages.some((message) => contentHasImage(message.content));",
    "pi-ai 文本模型工具过滤",
  );
  result = replaceExactlyOnce(
    result,
    "const context = attachments === void 0 ? toPiContext(options) : await toPiContext(options, attachments);",
    "const context = attachments === void 0 ? toPiContext(requestOptions) : await toPiContext(requestOptions, attachments);",
    "pi-ai 能力过滤请求组装",
  );
  result = replaceExactlyOnce(
    result,
    `\t\tcase "error":
\t\t\tyield {
\t\t\t\ttype: "usage",
\t\t\t\tusage: mapUsage(event.error.usage)
\t\t\t};
\t\t\tyield {`,
    `\t\tcase "error":
\t\t\tif (event.error.usage !== void 0) yield {
\t\t\t\ttype: "usage",
\t\t\t\tusage: mapUsage(event.error.usage)
\t\t\t};
\t\t\tyield {`,
    "pi-ai 错误用量保持未知",
  );
  result = replaceExactlyOnce(
    result,
    "...profileOptions(profile, reasoning, apiKey),",
    '...profileOptions(profile, reasoning, apiKey),\n\t\t\t\t\t...fastModel ? { serviceTier: "priority" } : {},',
    "pi-ai Fast service tier",
  );
  return result;
}

export function patchDeepSeekLlmSource(source) {
  let result = replaceExactlyOnce(
    source,
    `/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
\tif (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
}`,
    `/** Replace images only in the text-only provider request; durable session events stay unchanged. */
function sanitizeTextOnlyBlocks(blocks) {
\tconst placeholder = "[图片已在本次非视觉模型请求中暂时省略；原会话中的图片仍然保留]";
\treturn blocks.map((block) => {
\t\tif (block?.type === "image" || block?.type === "image_url" || block?.type === "input_image") return { type: "text", text: placeholder };
\t\tif (block?.type === "tool-result" && Array.isArray(block.content)) return { ...block, content: sanitizeTextOnlyBlocks(block.content) };
\t\treturn block;
\t});
}`,
    "DeepSeek 文本适配器图片占位辅助",
  );
  result = replaceExactlyOnce(
    result,
    `function serializeMessages(messages) {
\tconst wire = [];
\tfor (const message of messages) {
\t\tassertTextOnly(message.content);
\t\tif (message.role === "system") {
\t\t\twire.push({
\t\t\t\trole: "system",
\t\t\t\tcontent: flattenText(message.content)
\t\t\t});
\t\t\tcontinue;
\t\t}
\t\tif (message.role === "assistant") {
\t\t\twire.push(serializeAssistant(message));
\t\t\tcontinue;
\t\t}
\t\tconst toolResults = message.content.filter((block) => block.type === "tool-result");
\t\tconst text = flattenText(message.content);`,
    `function serializeMessages(messages) {
\tconst wire = [];
\tfor (const message of messages) {
\t\tconst content = sanitizeTextOnlyBlocks(message.content);
\t\tif (message.role === "system") {
\t\t\twire.push({
\t\t\t\trole: "system",
\t\t\t\tcontent: flattenText(content)
\t\t\t});
\t\t\tcontinue;
\t\t}
\t\tif (message.role === "assistant") {
\t\t\twire.push(serializeAssistant({ ...message, content }));
\t\t\tcontinue;
\t\t}
\t\tconst toolResults = content.filter((block) => block.type === "tool-result");
\t\tconst text = flattenText(content);`,
    "DeepSeek 文本适配器请求时图片占位",
  );
  return result;
}

export function patchPiAiSimpleOptionsServiceTierSource(source) {
  return replaceExactlyOnce(
    source,
    "        metadata: options?.metadata,\n        env: options?.env,",
    "        metadata: options?.metadata,\n        serviceTier: options?.serviceTier,\n        env: options?.env,",
    "pi-ai 简化流 Fast service tier 转发",
  );
}

export function patchToolsReadImageSdkSource(source) {
  return replaceExactlyOnce(
    source,
    ".filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {",
    '.filter((definition) => definition.name !== RUN_CODE_NAME && definition.name !== "read_image").map((definition) => {',
    "Code Mode 排除图像块工具",
  );
}

export function patchJobsCompletionDeliverySource(source) {
  let result = replaceExactlyOnce(
    source,
    `\tif (delivery === "wakeup") ctx.on("agent/inbox/claimed", ({ agent, message }) => {
\t\tif (message.source.kind === "user") spentWakes.delete(agent);
\t});
\tconst outputLimits = /* @__PURE__ */ new WeakMap();`,
    `\tconst deferredCompletions = /* @__PURE__ */ new WeakMap();
\tfunction deferredNotice(owner, snapshots) {
\t\treturn createUserMessage({
\t\t\tcontent: [{
\t\t\t\ttype: "text",
\t\t\t\ttext: snapshots.map(fitCompletionNotice).join("\\n\\n")
\t\t\t}],
\t\t\tsource: {
\t\t\t\tkind: "plugin",
\t\t\t\tplugin: "tool-jobs",
\t\t\t\tform: "notice",
\t\t\t\tsummary: boundContextSummary(snapshots.map(completionSummary).join("; "))
\t\t\t}
\t\t});
\t}
\tfunction flushDeferredCompletions(owner) {
\t\tconst snapshots = deferredCompletions.get(owner);
\t\tif (snapshots === void 0 || snapshots.length === 0 || owner.status !== "idle") return false;
\t\tconst spent = spentWakes.get(owner) ?? 0;
\t\tif (spent >= wakeBudget) return false;
\t\ttry {
\t\t\towner.followup(deferredNotice(owner, snapshots));
\t\t\tspentWakes.set(owner, spent + 1);
\t\t\tdeferredCompletions.delete(owner);
\t\t\treturn true;
\t\t} catch (error) {
\t\t\tctx.logger.warn(\`tool-jobs: delayed completion notice for agent "\${owner.id}" remains queued: \${String(error)}\`);
\t\t\treturn false;
\t\t}
\t}
\tif (delivery === "wakeup") {
\t\tctx.on("agent/inbox/claimed", ({ agent, message }) => {
\t\t\tif (message.source.kind === "user") spentWakes.delete(agent);
\t\t});
\t\tctx.on("agent/status", ({ agent, status }) => {
\t\t\tif (status === "idle") flushDeferredCompletions(agent);
\t\t});
\t\tctx.on("agent/disposed", ({ agent }) => {
\t\t\tdeferredCompletions.delete(agent);
\t\t});
\t}
\tconst outputLimits = /* @__PURE__ */ new WeakMap();`,
    "Jobs 完成投递延迟队列",
  );
  result = replaceExactlyOnce(
    result,
    `\tctx.jobs.onJobDone((snapshot, owner) => {
\t\tif (snapshot.reported || owner === void 0) return;
\t\tconst message = createUserMessage({
\t\t\tcontent: [{
\t\t\t\ttype: "text",
\t\t\t\ttext: fitCompletionNotice(snapshot)
\t\t\t}],
\t\t\tsource: {
\t\t\t\tkind: "plugin",
\t\t\t\tplugin: "tool-jobs",
\t\t\t\tform: "notice",
\t\t\t\tsummary: completionSummary(snapshot)
\t\t\t}
\t\t});
\t\tconst spent = spentWakes.get(owner) ?? 0;
\t\tif (delivery === "wakeup" && owner.status === "idle" && spent < wakeBudget) {
\t\t\tspentWakes.set(owner, spent + 1);
\t\t\towner.followup(message);
\t\t\treturn;
\t\t}
\t\towner.inject(message);
\t});`,
    `\tctx.jobs.onJobDone((snapshot, owner) => {
\t\tif (snapshot.reported || owner === void 0) return;
\t\tif (delivery !== "wakeup") {
\t\t\towner.inject(createUserMessage({
\t\t\t\tcontent: [{ type: "text", text: fitCompletionNotice(snapshot) }],
\t\t\t\tsource: {
\t\t\t\t\tkind: "plugin",
\t\t\t\t\tplugin: "tool-jobs",
\t\t\t\t\tform: "notice",
\t\t\t\t\tsummary: completionSummary(snapshot)
\t\t\t\t}
\t\t\t}));
\t\t\treturn;
\t\t}
\t\tconst snapshots = deferredCompletions.get(owner) ?? [];
\t\tsnapshots.push(snapshot);
\t\tdeferredCompletions.set(owner, snapshots);
\t\tflushDeferredCompletions(owner);
\t});`,
    "Jobs 完成投递分支",
  );
  return result;
}

export function patchJobsLocalTeardownSource(source) {
  let result = replaceExactlyOnce(
    source,
    "const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10;",
    "const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10;\n/** Maximum teardown wait before a non-cooperative producer is recorded as failed. */\nconst DEFAULT_TEARDOWN_CANCEL_TIMEOUT_MS = 1e4;",
    "Jobs 本地关闭超时常量",
  );
  result = replaceExactlyOnce(
    result,
    "static Config = z.object({ maxConcurrentJobsPerOwner: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER) });",
    "static Config = z.object({ maxConcurrentJobsPerOwner: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER), teardownCancelTimeoutMs: z.number().min(1).default(DEFAULT_TEARDOWN_CANCEL_TIMEOUT_MS) });",
    "Jobs 本地关闭超时配置",
  );
  result = replaceExactlyOnce(
    result,
    "\t/** Schemastery-defaulted active-job limit. */\n\tmaxConcurrentJobsPerOwner;",
    "\t/** Schemastery-defaulted active-job limit. */\n\tmaxConcurrentJobsPerOwner;\n\t/** Bounded wait for a producer that ignores cancellation during teardown. */\n\tteardownCancelTimeoutMs;",
    "Jobs 本地关闭超时字段",
  );
  result = replaceExactlyOnce(
    result,
    "\t\tthis.maxConcurrentJobsPerOwner = config.maxConcurrentJobsPerOwner;\n\t\tthis.selfCtx = ctx;",
    "\t\tthis.maxConcurrentJobsPerOwner = config.maxConcurrentJobsPerOwner;\n\t\tthis.teardownCancelTimeoutMs = config.teardownCancelTimeoutMs;\n\t\tthis.selfCtx = ctx;",
    "Jobs 本地关闭超时初始化",
  );
  result = replaceExactlyOnce(
    result,
    `\t/** Cancel, await terminal records, and drop every job owned by one exact agent lifecycle. */
\tasync disposeOwned(owner) {`,
    `\t/** Bound shutdown when a producer ignores cancellation and leaves its done promise pending. */
\tasync awaitTeardownSettlement(job, reason) {
\t\tif (isTerminal(job.status)) return;
\t\tlet timeout;
\t\tawait Promise.race([job.settled, new Promise((resolve) => {
\t\t\ttimeout = setTimeout(resolve, this.teardownCancelTimeoutMs);
\t\t})]);
\t\tif (timeout !== void 0) clearTimeout(timeout);
\t\tif (isTerminal(job.status)) return;
\t\tconst detail = \`cancel did not settle within \${this.teardownCancelTimeoutMs}ms during \${reason}; work may be orphaned\`;
\t\tthis.selfCtx.logger.warn(\`jobs: \${job.id} \${detail}; record forced failed so teardown can continue\`);
\t\tthis.settle(job, { status: "failed", detail });
\t}
\t/** Cancel, await terminal records, and drop every job owned by one exact agent lifecycle. */
\tasync disposeOwned(owner) {`,
    "Jobs 本地关闭有界等待",
  );
  result = replaceExactlyOnce(
    result,
    "\t\tawait Promise.all(owned.map((job) => job.settled));",
    "\t\tawait Promise.all(owned.map((job) => this.awaitTeardownSettlement(job, \"owner disposal\")));",
    "Jobs 所有者关闭等待",
  );
  result = replaceExactlyOnce(
    result,
    "\t\tawait Promise.all(all.map((job) => job.settled));",
    "\t\tawait Promise.all(all.map((job) => this.awaitTeardownSettlement(job, \"service disposal\")));",
    "Jobs 服务关闭等待",
  );
  return result;
}

export function patchHeadlessShutdownSource(source) {
  let result = source;
  result = replaceExactlyOnce(
    result,
    `const internals = {
\tstdout: process.stdout,
\tstderr: process.stderr
};`,
    `const internals = {
\tstdout: process.stdout,
\tstderr: process.stderr,
\tforceExit: (code) => process.exit(code)
};`,
    "Headless 退出兜底注入点",
  );
  result = replaceExactlyOnce(
    result,
    "const { agent } = await agents.create({",
    "const { agent, dispose } = await agents.create({",
    "Headless Agent 关闭句柄",
  );
  result = replaceExactlyOnce(
    result,
    `const outcome = summarize(agent.session.events, firstSeq);
\tio.stdout.write(outcome.text + "\\n");`,
    `const outcome = summarize(agent.session.events, firstSeq);
\tawait dispose();
\tio.stdout.write(outcome.text + "\\n");`,
    "Headless 退出前等待 Agent 关闭",
  );
  result = replaceExactlyOnce(
    result,
    `const io = {
\t\tstdout: internals.stdout,
\t\tstderr: internals.stderr,
\t\texit
\t};`,
    `const io = {
\t\tstdout: internals.stdout,
\t\tstderr: internals.stderr,
\t\texit: (code) => {
\t\t\texit(code);
\t\t\tconst fallback = setTimeout(() => internals.forceExit(code), 6e3);
\t\t\tfallback.unref();
\t\t}
\t};`,
    "Headless 清理后残留句柄退出兜底",
  );
  return result;
}

export function patchHeadlessBundleSource(source) {
  return replaceExactlyOnce(
    source,
    `- id: hmr
  disabled: true
`,
    `- id: hmr
  disabled: true

# Headless 是一次性输出，不展示会话列表；停用额外的 LLM 标题请求，
# 仍保留 session-title 服务生成的本地首句回退标题。
- id: session-title-llm
  disabled: true
`,
    "Headless 停用额外标题模型请求",
  );
}

export function patchCompactionIdleRegionSource(source) {
  const insertion = [
    "\t}",
    "\t/**",
    "\t * Commit one already-selected range while the agent is idle. This keeps the",
    "\t * official maintenance admission, selected-span validation and durable flush,",
    "\t * while allowing an asynchronously prepared BPC candidate to publish without",
    "\t * waiting for another human turn.",
    "\t */",
    "\tcompactIdleRegion(start, end, agent, signal, sourceCommandId) {",
    "\t\tsignal.throwIfAborted();",
    "\t\ttry {",
    "\t\t\treturn agent.runMaintenance(async (agentSignal) => {",
    "\t\t\t\tconst operationSignal = AbortSignal.any([agentSignal, signal]);",
    "\t\t\t\ttry {",
    "\t\t\t\t\toperationSignal.throwIfAborted();",
    "\t\t\t\t\treturn await compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, {",
    "\t\t\t\t\t\towner: null,",
    "\t\t\t\t\t\tstability: \"selected-span\",",
    "\t\t\t\t\t\t...sourceCommandId === void 0 ? {} : { sourceCommandId },",
    "\t\t\t\t\t\tflush: async () => {",
    "\t\t\t\t\t\t\tawait this.ctx.sessions.flush(agent.session);",
    "\t\t\t\t\t\t}",
    "\t\t\t\t\t}, operationSignal);",
    "\t\t\t\t} catch (error) {",
    "\t\t\t\t\tif (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw new ManualCompactionError(\"cancelled\", \"idle range compaction was cancelled\", { cause: error });",
    "\t\t\t\t\toperationSignal.throwIfAborted();",
    "\t\t\t\t\tthrow error;",
    "\t\t\t\t}",
    "\t\t\t});",
    "\t\t} catch (error) {",
    "\t\t\tthrow new ManualCompactionError(\"busy\", \"idle range compaction requires an idle agent with no waking queued work\", { cause: error });",
    "\t\t}",
    "\t}",
    "\t/** Bind the effective token meter and dynamically dispatched summarizer hook. */",
    "\tregionDependencies() {",
  ].join("\n");
  return replaceExactlyOnce(
    source,
    `\t}\n\t/** Bind the effective token meter and dynamically dispatched summarizer hook. */\n\tregionDependencies() {`,
    insertion,
    "BPC 指定范围空闲事务提交接口",
  );
}

export function patchContextMeterThresholdsSource(source) {
  let result = source;
  result = replaceExactlyOnce(
    result,
    `function contextOccupancy(pressure) {
\t\t\tconst usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
\t\t\tif (usedTokens === void 0 || pressure?.contextWindow === void 0) return null;`,
    `function contextOccupancy(pressure, breakdown) {
\t\t\tconst measuredTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
\t\t\tconst estimatedTokens = breakdown === void 0 ? void 0 : Object.values(breakdown).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
\t\t\tconst usedTokens = measuredTokens === void 0 || measuredTokens === 0 && estimatedTokens > 0 ? estimatedTokens : measuredTokens;
\t\t\tif (usedTokens === void 0 || pressure?.contextWindow === void 0) return null;`,
    "上下文占用错误样本回退",
  );
  result = replaceExactlyOnce(
    result,
    "const context = contextOccupancy(pressure);",
    "const context = contextOccupancy(pressure, breakdown);",
    "上下文占用使用分项估算",
  );
  result = replaceExactlyOnce(
    result,
    'const READING_SLOT = "\\0";',
    'const READING_SLOT = "\\0";\n\t\tconst BPC_THRESHOLD_PERCENT = 68;\n\t\tconst HARD_COMPACTION_THRESHOLD_PERCENT = 90;\n\t\tconst RECENT_RAW_TARGET_PERCENT = 16;',
    "上下文面板双阈值常量",
  );
  result = replaceExactlyOnce(
    result,
    `children: segments.map((segment) => (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\tclassName: segment.color === void 0 ? ContextMeter_module_css_default.segment : \`\${ContextMeter_module_css_default.segment} \${segment.color}\`,
\t\t\t\t\t\t\t\tstyle: { width: \`\${segment.width}%\` }
\t\t\t\t\t\t\t}, segment.key))`,
    `style: { position: "relative" },
\t\t\tchildren: [...segments.map((segment) => (0, react_jsx_runtime.jsx)("div", {
\t\t\t\tclassName: segment.color === void 0 ? ContextMeter_module_css_default.segment : \`\${ContextMeter_module_css_default.segment} \${segment.color}\`,
\t\t\t\tstyle: { width: \`\${segment.width}%\` }
\t\t\t}, segment.key)), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t"aria-hidden": true,
\t\t\t\tstyle: { position: "absolute", left: \`\${BPC_THRESHOLD_PERCENT}%\`, top: 0, bottom: 0, width: "1px", background: "#3b82f6" }
\t\t\t}, "bpc-threshold"), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t"aria-hidden": true,
\t\t\t\tstyle: { position: "absolute", left: \`\${HARD_COMPACTION_THRESHOLD_PERCENT}%\`, top: 0, bottom: 0, width: "1px", background: "#f59e0b" }
\t\t\t}, "hard-threshold")]`,
    "上下文面板阈值标记",
  );
  result = replaceExactlyOnce(
    result,
    `breakdown !== void 0 && (0, react_jsx_runtime.jsx)("dl", {
\t\t\t\t\t\t\tclassName: ContextMeter_module_css_default.rows,
\t\t\t\t\t\t\tchildren: ROWS.map((row) => (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\t\tclassName: ContextMeter_module_css_default.row,
\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("dt", { children: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\tclassName: \`\${ContextMeter_module_css_default.swatch} \${row.color}\`,
\t\t\t\t\t\t\t\t\t"aria-hidden": true
\t\t\t\t\t\t\t\t}), t(row.label)] }), (0, react_jsx_runtime.jsx)("dd", { children: \`~\${formatTokens(breakdown[row.key])}\` })]
\t\t\t\t\t\t\t}, row.key))
\t\t\t\t\t\t})`,
    `breakdown !== void 0 && (0, react_jsx_runtime.jsx)("dl", {
\t\t\tclassName: ContextMeter_module_css_default.rows,
\t\t\tchildren: ROWS.map((row) => (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ContextMeter_module_css_default.row,
\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("dt", { children: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\tclassName: \`\${ContextMeter_module_css_default.swatch} \${row.color}\`,
\t\t\t\t\t"aria-hidden": true
\t\t\t\t}), t(row.label)] }), (0, react_jsx_runtime.jsx)("dd", { children: \`~\${formatTokens(breakdown[row.key])}\` })]
\t\t\t}, row.key))
\t\t}), (0, react_jsx_runtime.jsx)("dl", {
\t\t\tclassName: ContextMeter_module_css_default.rows,
\t\t\tchildren: [
\t\t\t\t["BPC 预压缩阈值", \`\${BPC_THRESHOLD_PERCENT}%\`],
\t\t\t\t["硬压缩阈值", \`\${HARD_COMPACTION_THRESHOLD_PERCENT}%\`],
\t\t\t\t["近期原文保留目标", \`\${RECENT_RAW_TARGET_PERCENT}%\`],
\t\t\t\t["当前占用区间", percent >= HARD_COMPACTION_THRESHOLD_PERCENT ? "已进入硬压缩区间" : percent >= BPC_THRESHOLD_PERCENT ? "已进入后台预压缩区间" : "尚未达到压缩阈值"]
\t\t\t].map(([label, value]) => (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ContextMeter_module_css_default.row,
\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("dt", { children: label }), (0, react_jsx_runtime.jsx)("dd", { children: value })]
\t\t\t}, label))
\t\t})`,
    "上下文面板策略详情",
  );
  return result;
}

export function patchConversationActivityPresentationSource(source) {
  let result = source;
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst chips = occurrences.map((o) => ({
\t\t\t\toccurrenceId: o.occurrenceId,
\t\t\t\toffset: o.offset,
\t\t\t\tlabel: o.label,
\t\t\t\tinvalid: o.invalid === true
\t\t\t}));`,
    `\t\t\tconst chips = occurrences.map((o) => ({
\t\t\t\toccurrenceId: o.occurrenceId,
\t\t\t\tsource: o.source,
\t\t\t\tref: o.ref,
\t\t\t\toffset: o.offset,
\t\t\t\tlabel: o.label,
\t\t\t\tinvalid: o.invalid === true
\t\t\t}));`,
    "输入引用装饰保留来源与稳定 ID",
  );
  result = replaceExactlyOnce(
    result,
    `.uV2eYG_chipInvalid{opacity:.7;background:#d8616133;text-decoration:line-through}`,
    `.uV2eYG_chipInvalid{opacity:.7;background:#d8616133;text-decoration:line-through}.uV2eYG_chip[data-reference-source=conversation]:before{display:none}`,
    "对话引用不再占用通用单字符伪元素",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\tbackdrop.push((0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: clsx(InputBar_module_css_default.chip, chip.invalid && InputBar_module_css_default.chipInvalid),
\t\t\t\t\t\t\t"data-decoration": "chip",
\t\t\t\t\t\t\t"data-occurrence": chip.occurrenceId,
\t\t\t\t\t\t\t"data-invalid": chip.invalid || void 0,
\t\t\t\t\t\t\ttitle: chip.label,
\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.chipLabel,
\t\t\t\t\t\t\t\tchildren: chip.label
\t\t\t\t\t\t\t})
\t\t\t\t\t\t}, \`chip-\${chip.occurrenceId}\`));`,
    `\t\t\t\t\t\tbackdrop.push((0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: clsx(InputBar_module_css_default.chip, chip.invalid && InputBar_module_css_default.chipInvalid),
\t\t\t\t\t\t\t"data-decoration": "chip",
\t\t\t\t\t\t\t"data-occurrence": chip.occurrenceId,
\t\t\t\t\t\t\t"data-invalid": chip.invalid || void 0,
\t\t\t\t\t\t\t"data-reference-source": chip.source,
\t\t\t\t\t\t\t"data-reference-id": chip.ref,
\t\t\t\t\t\t\tstyle: chip.source === "conversation" ? { display: "inline-flex", alignItems: "center", verticalAlign: "text-bottom", padding: "0 5px", whiteSpace: "nowrap" } : void 0,
\t\t\t\t\t\t\ttitle: chip.label,
\t\t\t\t\t\t\tchildren: chip.source === "conversation" ? (0, react_jsx_runtime.jsxs)("span", {
\t\t\t\t\t\t\t\tstyle: { display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 },
\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("svg", {
\t\t\t\t\t\t\t\t\t"data-conversation-chip-icon": true,
\t\t\t\t\t\t\t\t\t"aria-hidden": true,
\t\t\t\t\t\t\t\t\twidth: 14,
\t\t\t\t\t\t\t\t\theight: 14,
\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",
\t\t\t\t\t\t\t\t\tfill: "none",
\t\t\t\t\t\t\t\t\tstyle: { flex: "none" },
\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", { d: "M3.25 2.75h9.5C13.44 2.75 14 3.31 14 4v6c0 .69-.56 1.25-1.25 1.25H7l-2.75 2v-2h-1C2.56 11.25 2 10.69 2 10V4c0-.69.56-1.25 1.25-1.25ZM5 6h6M5 8.5h4", stroke: "currentColor", strokeWidth: 1.25, strokeLinecap: "round", strokeLinejoin: "round" })
\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.chipLabel,
\t\t\t\t\t\t\t\t\tstyle: { position: "static", width: "auto", overflow: "visible", transform: "none", justifyContent: "flex-start", fontFamily: "var(--dsw-font-family)", fontSize: "inherit", lineHeight: "inherit" },
\t\t\t\t\t\t\t\t\tchildren: chip.label
\t\t\t\t\t\t\t\t})]
\t\t\t\t\t\t\t}) : (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\tclassName: InputBar_module_css_default.chipLabel,
\t\t\t\t\t\t\t\tchildren: chip.label
\t\t\t\t\t\t\t})
\t\t\t\t\t\t}, \`chip-\${chip.occurrenceId}\`));`,
    "对话引用展示完整标题与对话图标",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
\t\tconst ChatNodeSeat = (0, react.memo)(function ChatNodeSeat({ nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, loadImage, fileMentions, useSession, renderSlot, t }) {`,
    `\t\tfunction chatSemanticKind(node) {
\t\t\tif (node.kind === "assistant-step") {
\t\t\t\tconst blocks = Array.isArray(node.data?.blocks) ? node.data.blocks : [];
\t\t\t\tconst hasReasoning = blocks.some((block) => block.kind === "reasoning");
\t\t\t\tconst hasVisibleAnswer = blocks.some((block) => block.kind === "text" || block.kind === "tool-call");
\t\t\t\tif (hasReasoning && !hasVisibleAnswer) return "think";
\t\t\t}
\t\t\tif (node.kind === "tool-call") {
\t\t\t\tconst root = node.data?.root;
\t\t\t\tconst name = root === void 0 ? "" : "kind" in root ? root.call?.name ?? "" : root.name ?? "";
\t\t\t\treturn name === "run_code" ? "code" : "tool";
\t\t\t}
\t\t\treturn void 0;
\t\t}
\t\t/** Subscribe and dispatch one stable Context key without observing sibling Nodes. */
\t\tconst ChatNodeSeat = (0, react.memo)(function ChatNodeSeat({ nodeKey, selectedCallId, cwd, openFile, inspectCall, forkAt, loadImage, fileMentions, useSession, renderSlot, t }) {`,
    "对话节点展示语义分类",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t"data-chat-flow-kind": routedNode.kind,
\t\t\t\tchildren: renderSlot`,
    `\t\t\t\t"data-chat-flow-kind": routedNode.kind,
\t\t\t\t"data-chat-semantic-kind": chatSemanticKind(routedNode),
\t\t\t\tchildren: renderSlot`,
    "对话节点语义属性",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tbuildViewNode: (context) => {\n\t\t\t\tif (context.state === void 0) return null;\n\t\t\t\treturn chatNode(context, context.state.kind, context.state.seq, context.state);\n\t\t\t}`,
    `\t\t\tbuildViewNode: (context) => {\n\t\t\t\tif (context.state === void 0) return null;\n\t\t\t\tconst hiddenRuntimeClear = context.state.kind === "context"\n\t\t\t\t\t&& context.state.source?.kind === "plugin"\n\t\t\t\t\t&& context.state.source.plugin === "@deepseek-ai/dsh-system-prompt"\n\t\t\t\t\t&& context.state.source.form === "cleared";\n\t\t\t\treturn chatNode(context, context.state.kind, context.state.seq, context.state, hiddenRuntimeClear ? { visibility: "hidden" } : {});\n\t\t\t}`,
    "清空运行状态只保留模型语义不显示聊天行",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\ttime: match.event.time,\n\t\t\t\tcallView: match.view?.for === "call" ? match.view.view : null,`,
    `\t\t\t\ttime: match.event.time,\n\t\t\t\t...typeof match.event.data.activityLabel === "string" ? { activityLabel: match.event.data.activityLabel } : {},\n\t\t\t\tcallView: match.view?.for === "call" ? match.view.view : null,`,
    "工具开始节点保留语义标题",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\tcallTime: previous?.time ?? null,\n\t\t\t\tcontent: result.content,`,
    `\t\t\t\tcallTime: previous?.time ?? null,\n\t\t\t\t...typeof previous?.activityLabel === "string" ? { activityLabel: previous.activityLabel } : {},\n\t\t\t\tcontent: result.content,`,
    "工具结果节点保留语义标题",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\tcallTime: block.time,\n\t\t\t\tcontent: [],`,
    `\t\t\t\tcallTime: block.time,\n\t\t\t\t...typeof block.activityLabel === "string" ? { activityLabel: block.activityLabel } : {},\n\t\t\t\tcontent: [],`,
    "中断工具结果保留语义标题",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\tblocks,
\t\t\t\t\ttime,
\t\t\t\t\t...state.usage`,
    `\t\t\t\t\tblocks,
\t\t\t\t\ttime,
\t\t\t\t\tstartTime: context.start?.event.time ?? state.firstVisibleTime ?? time,
\t\t\t\t\t...state.usage`,
    "助手步骤开始时间投影",
  );
  result = replaceExactlyOnce(
    result,
    `\t\tfunction ReasoningRow({ text, running, t }) {`,
    `${MERGE_ADJACENT_REASONING_BLOCKS_SOURCE}
\t\tfunction ActivityDuration({ startTime, endTime, t }) {
\t\t\tconst [mountedAt] = (0, react.useState)(() => Date.now());
\t\t\tconst anchor = startTime ?? mountedAt;
\t\t\tconst [elapsedMs, setElapsedMs] = (0, react.useState)(() => Math.max(0, (endTime ?? Date.now()) - anchor));
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst tick = () => setElapsedMs(Math.max(0, (endTime ?? Date.now()) - anchor));
\t\t\t\ttick();
\t\t\t\tif (endTime !== null && endTime !== void 0) return void 0;
\t\t\t\tconst id = setInterval(tick, 1e3);
\t\t\t\treturn () => clearInterval(id);
\t\t\t}, [anchor, endTime]);
\t\t\treturn (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t"data-activity-duration": true,
\t\t\t\tstyle: { color: "var(--dsw-alias-label-caption)", flex: "none", marginLeft: 8, fontSize: 12, lineHeight: "20px" },
\t\t\t\tchildren: formatRunDuration(elapsedMs, t)
\t\t\t});
\t\t}
\t\tfunction ReasoningRow({ text, running, showDuration, startTime, endTime, codeLabels, mentions, t }) {`,
    "思考行 Markdown 与计时辅助",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst summary = running ? latestLine(text) : firstLine(text);`,
    `\t\t\tconst summary = running ? latestLine(text) : firstLine(text);`,
    "思考摘要保留 Markdown 源文本",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\ttitle: "Think",`,
    `\t\t\t\t\ttitle: "思考",`,
    "思考标题中文化",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\tclassName: ReasoningRow_module_css_default.root,\n\t\t\t\t"data-variant": "think",`,
    `\t\t\t\tclassName: ReasoningRow_module_css_default.root,\n\t\t\t\t"data-chat-semantic-kind": "think",\n\t\t\t\t"data-variant": "think",`,
    "思考行展示语义属性",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tref: summaryRef,
\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.summary,`,
    `\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tref: summaryRef,
\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.summary,`,
    "思考 Markdown 摘要容器",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t"data-follow-end": running || void 0,
\t\t\t\t\t\tchildren: summary
\t\t\t\t\t})] }),
\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.thinkBody,
\t\t\t\t\t\tchildren: text
\t\t\t\t\t})`,
    `\t\t\t\t\t\t"data-follow-end": running || void 0,
\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
\t\t\t\t\t\t\ttext: summary,
\t\t\t\t\t\t\tstreaming: running,
\t\t\t\t\t\t\tcodeLabels,
\t\t\t\t\t\t\tfileMentions: mentions
\t\t\t\t\t\t})
\t\t\t\t\t}), showDuration ? (0, react_jsx_runtime.jsx)(ActivityDuration, {
\t\t\t\t\t\tstartTime,
\t\t\t\t\t\tendTime,
\t\t\t\t\t\tt
\t\t\t\t\t}) : null] }),
\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: ReasoningRow_module_css_default.thinkBody,
\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
\t\t\t\t\t\t\ttext,
\t\t\t\t\t\t\tstreaming: running,
\t\t\t\t\t\t\tcodeLabels,
\t\t\t\t\t\t\tfileMentions: mentions
\t\t\t\t\t\t})
\t\t\t\t\t})`,
    "思考正文 Markdown 渲染与持续时间",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\tconst last = blocks.length - 1;
\t\t\tif (!(streaming || interrupted === true || blocks.some((block) => block.kind !== "tool-call"))) return null;
\t\t\tconst rendered = [];
\t\t\tfor (let i = 0; i < blocks.length; i++) {
\t\t\t\tconst block = blocks[i];`,
    `\t\t\tconst presentationBlocks = mergeAdjacentReasoningBlocks(blocks);
\t\t\tconst last = presentationBlocks.length - 1;
\t\t\tconst showReasoningDuration = presentationBlocks.length === 1 && presentationBlocks[0].block?.kind === "reasoning";
\t\t\tif (!(streaming || interrupted === true || presentationBlocks.some(({ block }) => block !== void 0 && block.kind !== "tool-call"))) return null;
\t\t\tconst rendered = [];
\t\t\tfor (let i = 0; i < presentationBlocks.length; i++) {
\t\t\t\tconst { block, startIndex } = presentationBlocks[i];`,
    "相邻思考块展示分组",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\tfileMentions: mentions
\t\t\t\t\t\t}, i));`,
    `\t\t\t\t\t\t\tfileMentions: mentions
\t\t\t\t\t\t}, startIndex));`,
    "助手正文展示稳定键",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\tt
\t\t\t\t\t\t}, i));`,
    `\t\t\t\t\t\t\tt
\t\t\t\t\t\t}, startIndex));`,
    "思考合并段展示稳定键",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\tconst start = i;
\t\t\t\t\t\tconst group = [block];
\t\t\t\t\t\twhile (i + 1 < blocks.length) {
\t\t\t\t\t\t\tconst next = blocks[i + 1];`,
    `\t\t\t\t\t\tconst start = startIndex;
\t\t\t\t\t\tconst group = [block];
\t\t\t\t\t\twhile (i + 1 < presentationBlocks.length) {
\t\t\t\t\t\t\tconst next = presentationBlocks[i + 1].block;`,
    "图片分组适配展示块索引",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\ttruncatedLabel: (total) => t("json.truncated", { total })
\t\t\t\t\t}, i));`,
    `\t\t\t\t\t\ttruncatedLabel: (total) => t("json.truncated", { total })
\t\t\t\t\t}, startIndex));`,
    "未知块展示稳定键",
  );
  result = replaceExactlyOnce(
    result,
    `\t\tconst AssistantMarkdown = (0, react.memo)(function AssistantMarkdown({ blocks, streaming, interrupted, loadImage, mentions, t }) {`,
    `\t\tconst AssistantMarkdown = (0, react.memo)(function AssistantMarkdown({ blocks, streaming, interrupted, startTime, completedTime, loadImage, mentions, t }) {`,
    "助手渲染时间参数",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t\t\t\trunning: streaming && i === last,
\t\t\t\t\t\t\tt`,
    `\t\t\t\t\t\t\trunning: streaming && i === last,
\t\t\t\t\t\t\tshowDuration: showReasoningDuration,
\t\t\t\t\t\t\tstartTime,
\t\t\t\t\t\t\tendTime: completedTime,
\t\t\t\t\t\t\tcodeLabels,
\t\t\t\t\t\t\tmentions,
\t\t\t\t\t\t\tt`,
    "思考行接收时间与 Markdown 参数",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\tinterrupted: data.status === "interrupted",
\t\t\t\tloadImage,`,
    `\t\t\t\tinterrupted: data.status === "interrupted",
\t\t\t\tstartTime: data.startTime,
\t\t\t\tcompletedTime: data.finalNode?.time ?? null,
\t\t\t\tloadImage,`,
    "助手节点传递开始结束时间",
  );
  return result;
}

export function patchConversationUiSource(source) {
  return patchWorkspaceShellSource(
    patchEditResendShellSource(
      patchTurnProcessCollapseSource(
        patchContextStatusCardSource(
          patchSelectionAnnotationSource(
            patchActivityTrackFrontendSource(
              patchConversationActivityPresentationSource(patchContextMeterThresholdsSource(source)),
            ),
          ),
        ),
      ),
    ),
  );
}

export function patchThemeUiSource(source) {
  return patchAppearanceThemeSource(source);
}

export function patchClientRuntimeSource(source) {
  return replaceExactlyOnce(
    source,
    `\t\t\treturn {
\t\t\t\t\tsessionId: this.sessionId,
\t\t\t\t\tviews: this.conversation,`,
    `\t\t\treturn {
\t\t\t\t\tsessionId: this.sessionId,
\t\t\t\t\tevents: this.events,
\t\t\t\t\tviews: this.conversation,`,
    "客户端会话快照暴露原始事件窗口",
  );
}

export { patchWorkspaceConversationReferencesSource };

export function patchToolActivityPresentationSource(source) {
  let result = source;
  result = replaceExactlyOnce(
    result,
    `\t\t/** One atomic call dispatched through the Tool-owned keyed slot. */
\t\tconst ToolCall = (0, react.memo)(function ToolCall({ renderSlot, callId, toolName, block, openFile, selected, cwd, inspectCall, t, children }) {`,
    `\t\tfunction formatToolDuration(ms) {
\t\t\tconst total = Math.max(0, Math.floor(ms / 1e3));
\t\t\tconst minutes = Math.floor(total / 60);
\t\t\tconst seconds = total % 60;
\t\t\treturn minutes > 0 ? \`\${minutes}分\${String(seconds).padStart(2, "0")}秒\` : \`\${seconds}秒\`;
\t\t}
\t\tfunction ToolActivityDuration({ block }) {
\t\t\tconst startTime = "kind" in block ? block.callTime : block.time;
\t\t\tconst endTime = "kind" in block ? block.time : null;
\t\t\tconst durationUnknown = "kind" in block && (startTime === null || startTime === void 0);
\t\t\tconst [mountedAt] = (0, react.useState)(() => Date.now());
\t\t\tconst anchor = startTime ?? mountedAt;
\t\t\tconst [elapsedMs, setElapsedMs] = (0, react.useState)(() => Math.max(0, (endTime ?? Date.now()) - anchor));
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst tick = () => setElapsedMs(Math.max(0, (endTime ?? Date.now()) - anchor));
\t\t\t\ttick();
\t\t\t\tif (endTime !== null && endTime !== void 0) return void 0;
\t\t\t\tconst id = setInterval(tick, 1e3);
\t\t\t\treturn () => clearInterval(id);
\t\t\t}, [anchor, endTime]);
\t\t\treturn (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t"data-tool-activity-duration": true,
\t\t\t\tstyle: { justifySelf: "end", whiteSpace: "nowrap", color: "var(--dsw-alias-label-caption)", fontSize: 12, lineHeight: "20px", pointerEvents: "none" },
\t\t\t\tchildren: durationUnknown ? "耗时未知" : formatToolDuration(elapsedMs)
\t\t\t});
\t\t}
\t\t/** One atomic call dispatched through the Tool-owned keyed slot. */
\t\tconst ToolCall = (0, react.memo)(function ToolCall({ renderSlot, callId, toolName, block, openFile, selected, cwd, inspectCall, t, children }) {`,
    "工具调用持续时间辅助",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ToolCallTree_module_css_default.callRow,`,
    `\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ToolCallTree_module_css_default.callRow,
\t\t\t\tstyle: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start", columnGap: 8 },`,
    "工具调用计时定位容器",
  );
  result = replaceExactlyOnce(
    result,
    `\t\t\t\t}), children]
\t\t\t});`,
    `\t\t\t\t}), (0, react_jsx_runtime.jsx)(ToolActivityDuration, { block }), children === void 0 ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tstyle: { gridColumn: "1 / -1", minWidth: 0 },
\t\t\t\t\tchildren
\t\t\t\t})]
\t\t\t});`,
    "工具调用展示持续时间",
  );
  // 批次 B 文件差异卡（窗口 G2）：展示层实现物理隔离在 transforms-frontend-tool.mjs。
  return patchToolDiffCardSource(result);
}
