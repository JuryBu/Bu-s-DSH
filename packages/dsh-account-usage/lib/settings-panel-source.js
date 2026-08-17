/**
 * 设置页「账户使用情况」面板的浏览器端源码。
 *
 * 这里只做展示：所有数字、百分比、重置时间、套餐名与失败原因都来自
 * `GET /account-usage/<provider>` 返回的真实脱敏快照（形状见 ../README.md 与
 * ../src/index.js）。缺字段一律显示「未知」并画斜纹条，绝不换算成 0%。
 *
 * 样式与 `docs/evidence/stage11/frontend/g4/` 的静态预览页共用同一份 CSS 文本，
 * 预览页即是这份实现的像素级镜像，不是另画一版。
 */

export const ACCOUNT_USAGE_PANEL_STYLE = `
[data-account-usage-panel]{padding:0;gap:0;overflow:hidden}
.dsh-au-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-au-head>div{min-width:0}
.dsh-au-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}
.dsh-au-sub{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px;margin-top:2px}
.dsh-au-refresh{flex:none;width:82px;height:30px;margin-top:1px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer}
.dsh-au-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-au-refresh:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.dsh-au-refresh:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-au-spin{flex:none;width:12px;height:12px;box-sizing:border-box;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:dsh-au-sp .9s linear infinite}
@keyframes dsh-au-sp{to{transform:rotate(360deg)}}
.dsh-au-note{margin:0;padding:12px 16px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px}
.dsh-au-prov{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-au-prov:last-child{border-bottom:0}
.dsh-au-prov-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-au-prov-name{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}
.dsh-au-plan{flex:none;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;white-space:nowrap}
.dsh-au-plan[data-muted="true"]{color:var(--dsw-alias-label-tertiary)}
.dsh-au-q{margin-top:12px}
.dsh-au-q-lab{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dsh-au-q-lab .k{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-au-q-lab .v{flex:none;color:var(--dsw-alias-label-primary);font-size:17px;font-weight:650;line-height:24px;font-variant-numeric:tabular-nums}
.dsh-au-q-lab .v[data-unknown="true"]{color:var(--dsw-alias-label-tertiary)}
.dsh-au-cap{margin-top:4px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums}
.dsh-au-bar{position:relative;height:9px;margin-top:7px;border-radius:999px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);background:linear-gradient(90deg,#e5484d 0%,#f0883e 15%,#e3b341 26%,#8fbf4a 40%,#3fae6d 55%,#2da05f 100%)}
.dsh-au-bar::after{content:"";position:absolute;top:0;right:0;bottom:0;width:calc(100% - var(--dsh-au-pct));background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-module-platform))}
.dsh-au-bar::before{content:"";position:absolute;top:0;left:0;bottom:0;width:var(--dsh-au-pct);background:linear-gradient(100deg,transparent 20%,rgba(255,255,255,.34) 50%,transparent 80%);background-size:220% 100%;animation:dsh-au-sheen 2.6s ease-in-out infinite}
@keyframes dsh-au-sheen{0%{background-position:120% 0}100%{background-position:-60% 0}}
.dsh-au-bar[data-unknown="true"]{background-color:var(--dsw-alias-bg-module-platform);background-image:repeating-linear-gradient(45deg,transparent 0 5px,var(--dsw-alias-border-l3) 5px 10px)}
.dsh-au-bar[data-unknown="true"]::after,.dsh-au-bar[data-unknown="true"]::before{display:none}
.dsh-au-foot{display:flex;justify-content:flex-end;margin-top:10px}
.dsh-au-link{display:inline-flex;align-items:center;gap:2px;height:22px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:22px;text-decoration:none;border-radius:6px;padding:0 4px}
.dsh-au-link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-au-link:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-au-fail{margin-top:8px;color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
@media (prefers-reduced-motion:reduce){.dsh-au-bar::before{animation:none}.dsh-au-spin{animation:none}}
`;

const HELPERS = String.raw`
		const ACCOUNT_USAGE_PROVIDERS = [{
			id: "openai-codex-oauth",
			label: "ChatGPT 订阅",
			unknownLabel: "额度剩余"
		}, {
			id: "experimental-windsurf-devin",
			label: "Windsurf / Devin",
			unknownLabel: "额度剩余"
		}, {
			id: "deepseek-api-key",
			label: "DeepSeek API",
			unknownLabel: "账户余额"
		}];
		const ACCOUNT_USAGE_REASONS = {
			credential_unavailable: "尚未配置凭据，未发起请求",
			timeout: "请求超时，未取得账户数据",
			auth_error: "登录态失效或无访问权限",
			http_error: "接口返回错误状态",
			request_error: "请求失败，未取得账户数据",
			invalid_response: "接口返回结构无法解析",
			invalid_json: "接口返回内容不是合法 JSON",
			quota_fields_unavailable: "已连接，本次接口未返回额度字段"
		};
		const ACCOUNT_USAGE_CURRENCY = { CNY: "¥", USD: "$" };
		async function accountUsageRequest(providerId, forceRefresh = false) {
			const response = await fetch("/account-usage/" + providerId + (forceRefresh ? "?refresh=1" : ""), {
				method: "GET",
				headers: { accept: "application/json" },
				cache: "no-store"
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok || result.ok !== true || result.snapshot === void 0) throw new Error("账户使用情况暂时不可读取");
			return result.snapshot;
		}
		function accountUsageNumber(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : null;
		}
		function accountUsagePercentText(value) {
			const number = accountUsageNumber(value);
			return number === null ? "未知" : Math.round(number) + "%";
		}
		function accountUsageBarPercent(value) {
			const number = accountUsageNumber(value);
			return number === null ? null : Math.min(100, Math.max(0, number));
		}
		function accountUsageDuration(totalSeconds) {
			const seconds = accountUsageNumber(totalSeconds);
			if (seconds === null || seconds < 0) return null;
			const days = Math.floor(seconds / 86400);
			const hours = Math.floor(seconds % 86400 / 3600);
			const minutes = Math.floor(seconds % 3600 / 60);
			if (days > 0) return hours > 0 ? days + "天" + hours + "小时" : days + "天";
			if (hours > 0) return minutes > 0 ? hours + "小时" + minutes + "分" : hours + "小时";
			if (minutes > 0) return minutes + "分";
			return "不到 1 分钟";
		}
		function accountUsageClock(iso) {
			if (typeof iso !== "string" || iso.length === 0) return null;
			const date = new Date(iso);
			if (Number.isNaN(date.valueOf())) return null;
			return new Intl.DateTimeFormat("zh-CN", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false
			}).format(date).replace(/\//gu, "/");
		}
		function accountUsageDay(iso) {
			if (typeof iso !== "string" || iso.length === 0) return null;
			const date = new Date(iso);
			if (Number.isNaN(date.valueOf())) return null;
			return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
		}
		function accountUsageResetCaption(window) {
			const after = accountUsageDuration(window.resetAfterSeconds);
			const clock = accountUsageClock(window.resetAt);
			if (after !== null) return clock === null ? "重置：" + after + "后" : "重置：" + after + "后（" + clock + "）";
			if (clock !== null) return "重置：" + clock;
			return null;
		}
		function accountUsagePeriodCaption(quota) {
			const parts = [];
			const endsAt = accountUsageDay(quota.planEndsAt);
			if (typeof quota.planEndsAt === "string") {
				const remainingMs = new Date(quota.planEndsAt).valueOf() - Date.now();
				const remaining = accountUsageDuration(Number.isNaN(remainingMs) ? null : Math.max(0, Math.floor(remainingMs / 1e3)));
				if (remaining !== null) parts.push("配额周期剩余 " + remaining);
			}
			const startsAt = accountUsageDay(quota.planStartsAt);
			if (startsAt !== null && endsAt !== null) parts.push(startsAt + " – " + endsAt);
			else if (endsAt !== null) parts.push("周期结束 " + endsAt);
			return parts.length === 0 ? null : parts.join("　·　");
		}
		function accountUsageBarRow(key, label, remainingPercent, caption) {
			return {
				key,
				label,
				valueText: accountUsagePercentText(remainingPercent),
				percent: accountUsageBarPercent(remainingPercent),
				bar: true,
				caption
			};
		}
		function accountUsageFigureRow(key, label, valueText, caption) {
			return {
				key,
				label,
				valueText,
				percent: null,
				bar: false,
				caption
			};
		}
		function accountUsageBalanceRows(balance) {
			return balance.map((entry) => accountUsageFigureRow(
				"balance-" + entry.currency,
				"账户余额（" + entry.currency + "）",
				(ACCOUNT_USAGE_CURRENCY[entry.currency] ?? "") + entry.totalBalance,
				"赠送 " + entry.grantedBalance + "　·　充值 " + entry.toppedUpBalance
			));
		}
		function accountUsageRateLimitRows(quota) {
			const windows = Array.isArray(quota.windows) ? quota.windows : [];
			return windows.map((window) => accountUsageBarRow(
				"window-" + window.id,
				(window.label ?? "额度") + "剩余",
				window.remainingPercent,
				accountUsageResetCaption(window)
			));
		}
		function accountUsageWindsurfRows(quota) {
			const windows = Array.isArray(quota.windows) ? quota.windows : [];
			const weekly = windows.find((window) => window.id === "weekly");
			const primary = weekly ?? windows.find((window) => accountUsageNumber(window.remainingPercent) !== null) ?? windows[0];
			const ordered = primary === void 0 ? [] : [primary, ...windows.filter((window) => {
				if (window === primary) return false;
				const remaining = accountUsageNumber(window.remainingPercent);
				return remaining !== null && remaining < 100;
			})];
			const rows = ordered.map((window, index) => accountUsageBarRow(
				"window-" + window.id,
				(window.label ?? "额度") + "剩余",
				window.remainingPercent,
				index === 0 ? accountUsagePeriodCaption(quota) ?? accountUsageResetCaption(window) : accountUsageResetCaption(window)
			));
			const prompt = quota.credits?.prompt;
			if (prompt !== null && prompt !== void 0 && accountUsageNumber(prompt.remaining) !== null) {
				rows.push(accountUsageFigureRow(
					"credits-prompt",
					"Prompt 额度剩余",
					accountUsageNumber(prompt.total) === null ? String(prompt.remaining) : prompt.remaining + " / " + prompt.total,
					null
				));
			}
			const addOn = quota.credits?.addOn;
			if (addOn !== null && addOn !== void 0 && accountUsageNumber(addOn.remaining) !== null) {
				rows.push(accountUsageFigureRow(
					"credits-addon",
					"附加额度剩余",
					accountUsageNumber(addOn.total) === null ? String(addOn.remaining) : addOn.remaining + " / " + addOn.total,
					null
				));
			}
			const overage = accountUsageNumber(quota.overageBalanceMicros);
			if (overage !== null) rows.push(accountUsageFigureRow("overage", "额外用量余额", "$" + (overage / 1e6).toFixed(2), null));
			return rows;
		}
		function accountUsageRows(provider, snapshot) {
			if (snapshot === void 0) return [accountUsageFigureRow("pending", provider.unknownLabel, "读取中", null)];
			const reasonText = typeof snapshot.reason === "string" ? ACCOUNT_USAGE_REASONS[snapshot.reason] ?? "本次接口未返回可用数据" : null;
			if (snapshot.availability === "available") {
				if (Array.isArray(snapshot.balance) && snapshot.balance.length > 0) return accountUsageBalanceRows(snapshot.balance);
				if (snapshot.quota?.kind === "rate_limits") {
					const rows = accountUsageRateLimitRows(snapshot.quota);
					if (rows.length > 0) return rows;
				}
				if (snapshot.quota?.kind === "windsurf") {
					const rows = accountUsageWindsurfRows(snapshot.quota);
					if (rows.length > 0) return rows;
				}
			}
			return [{
				key: "unknown",
				label: provider.unknownLabel,
				valueText: "未知",
				percent: null,
				bar: true,
				unknown: true,
				caption: reasonText ?? (snapshot.connection === "disconnected" ? "尚未连接，未发起请求" : "本次接口未返回可用数据")
			}];
		}
		function accountUsagePlanTag(snapshot) {
			const planName = snapshot?.quota?.planName;
			if (typeof planName === "string" && planName.length > 0) return { text: planName, muted: false };
			if (snapshot === void 0) return { text: "读取中", muted: true };
			if (snapshot.connection === "connected") return { text: "已连接", muted: true };
			if (snapshot.connection === "disconnected") return { text: "未连接", muted: true };
			return { text: "状态未知", muted: true };
		}
		function AccountUsageMetric({ row }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-au-q",
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-au-q-lab",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "k",
						children: row.label
					}), (0, react_jsx_runtime.jsx)("span", {
						className: "v",
						"data-unknown": row.unknown === true ? "true" : void 0,
						children: row.valueText
					})]
				}), row.bar !== true ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-au-bar",
					"data-unknown": row.percent === null ? "true" : void 0,
					style: row.percent === null ? void 0 : { "--dsh-au-pct": row.percent + "%" },
					role: "img",
					"aria-label": row.label + " " + row.valueText
				}), row.caption === null || row.caption === void 0 ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-au-cap",
					children: row.caption
				})]
			});
		}
		function AccountUsageProviderCard({ provider, entry }) {
			const snapshot = entry?.snapshot;
			const plan = accountUsagePlanTag(snapshot);
			return (0, react_jsx_runtime.jsxs)("article", {
				className: "dsh-au-prov",
				"data-account-usage-provider": provider.id,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-au-prov-top",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "dsh-au-prov-name",
						children: provider.label
					}), (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-au-plan",
						"data-muted": plan.muted ? "true" : void 0,
						children: plan.text
					})]
				}), ...accountUsageRows(provider, snapshot).map((row) => (0, react_jsx_runtime.jsx)(AccountUsageMetric, { row }, row.key)), entry?.error === void 0 ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-au-fail",
					role: "alert",
					children: entry.error
				}), typeof snapshot?.usageUrl !== "string" ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-au-foot",
					children: (0, react_jsx_runtime.jsxs)("a", {
						className: "dsh-au-link",
						href: snapshot.usageUrl,
						target: "_blank",
						rel: "noreferrer",
						children: ["查看用量页面", (0, react_jsx_runtime.jsx)("span", { "aria-hidden": true, children: "›" })]
					})
				})]
			});
		}
		function AccountUsagePanel() {
			const [state, setState] = (0, react.useState)({ loading: true, refreshing: false, entries: {} });
			const load = (0, react.useCallback)(async (forceRefresh = false) => {
				setState((previous) => ({
					...previous,
					loading: Object.keys(previous.entries).length === 0,
					refreshing: forceRefresh
				}));
				const results = await Promise.all(ACCOUNT_USAGE_PROVIDERS.map(async (provider) => {
					try {
						return [provider.id, { snapshot: await accountUsageRequest(provider.id) }];
					} catch (error) {
						return [provider.id, { error: error instanceof Error ? error.message : String(error) }];
					}
				}));
				setState({ loading: false, refreshing: false, entries: Object.fromEntries(results) });
			}, []);
			(0, react.useEffect)(() => {
				load(false);
			}, [load]);
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ModelsSection_module_css_default["rowCard"],
				"data-account-usage-panel": "true",
				children: [(0, react_jsx_runtime.jsx)("style", { children: STARDUST_ACCOUNT_USAGE_CSS }), (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-au-head",
					children: [(0, react_jsx_runtime.jsxs)("div", {
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: "dsh-au-title",
							children: "账户使用情况"
						}), (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-au-sub",
							children: "显示官方余额或当前登录态实际返回的额度；实验性链路可能随服务版本变化"
						})]
					}), (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "dsh-au-refresh",
						disabled: state.loading || state.refreshing,
						onClick: () => load(true),
						children: [state.refreshing ? (0, react_jsx_runtime.jsx)("span", { className: "dsh-au-spin", "aria-hidden": true }) : null, state.refreshing ? "刷新中" : "刷新"]
					})]
				}), state.loading ? (0, react_jsx_runtime.jsx)("p", {
					className: "dsh-au-note",
					children: "正在读取账户状态…"
				}) : null, ...(state.loading ? [] : ACCOUNT_USAGE_PROVIDERS.map((provider) => (0, react_jsx_runtime.jsx)(AccountUsageProviderCard, {
					provider,
					entry: state.entries[provider.id]
				}, provider.id)))]
			});
		}
`;

export const ACCOUNT_USAGE_PANEL_BROWSER_SOURCE = `
		const STARDUST_ACCOUNT_USAGE_CSS = ${JSON.stringify(ACCOUNT_USAGE_PANEL_STYLE)};${HELPERS}`;
