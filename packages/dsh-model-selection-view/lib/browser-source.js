export const MODEL_FACET_BROWSER_SOURCE = String.raw`
const STARDUST_FAST_PREFIX = "fast::";
const STARDUST_STANDARD_SPEED = "standard";
const STARDUST_FAST_SPEED = "fast";
const STARDUST_DEFAULT_CONTEXT = "default";
const STARDUST_ONE_MILLION_CONTEXT = "1m";
const STARDUST_EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const STARDUST_WINDSURF_FAMILIES = [
  ["claude-5-fable", "Claude Fable 5"],
  ["claude-fable-5", "Claude Fable 5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-opus-4-7", "Claude Opus 4.7"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["MODEL_CLAUDE_4_5_OPUS", "Claude Opus 4.5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["glm-5-2", "GLM-5.2"],
  ["kimi-k3", "Kimi K3"],
  ["kimi-k2-7", "Kimi K2.7"],
  ["kimi-k2-6", "Kimi K2.6"],
  ["MODEL_GOOGLE_GEMINI_3_0_FLASH", "Gemini 3 Flash"],
  ["gemini-3-7-flash", "Gemini 3.7 Flash"],
  ["gemini-3-6-flash", "Gemini 3.6 Flash"],
  ["gemini-3-5-flash", "Gemini 3.5 Flash"],
  ["gemini-3-1-pro", "Gemini 3.1 Pro"],
  ["MODEL_GOOGLE_GEMINI_2_5_PRO", "Gemini 2.5 Pro"],
  ["grok-4-6", "Grok 4.6"],
  ["grok-4-5", "Grok 4.5"],
  ["swe-1-7-lightning", "SWE-1.7 Lightning"],
  ["swe-1-7", "SWE-1.7"],
  ["swe-1-6", "SWE-1.6"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["gpt-5-3-codex", "GPT-5.3-Codex"],
  ["gpt-5-4-mini", "GPT-5.4 Mini"],
  ["gpt-5-5", "GPT-5.5"],
  ["gpt-5-4", "GPT-5.4"],
  ["MODEL_GPT_5_2", "GPT-5.2"]
];

function stardustUnique(values) {
  return [...new Set(values)];
}

function stardustEffortLabel(effort) {
  return ({
    off: "关闭",
    minimal: "极简",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
    ultra: "超高"
  })[effort] ?? effort;
}

function stardustSpeedLabel(speed) {
  return speed === STARDUST_FAST_SPEED ? "快速" : "标准";
}

function stardustContextLabel(context, family) {
  if (context === STARDUST_ONE_MILLION_CONTEXT) return "1M";
  if (family?.id === "glm-5-2") return "200K";
  return "标准";
}

function stardustSortEfforts(values) {
  return stardustUnique(values).sort((left, right) => {
    const leftIndex = STARDUST_EFFORT_ORDER.indexOf(left);
    const rightIndex = STARDUST_EFFORT_ORDER.indexOf(right);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
  });
}

function stardustPreferredEffort(values, preferred) {
  const efforts = stardustSortEfforts(values);
  if (preferred !== void 0 && efforts.includes(preferred)) return preferred;
  for (const candidate of ["high", "medium", "xhigh", "max", "low", "off", "minimal", "ultra"]) {
    if (efforts.includes(candidate)) return candidate;
  }
  return efforts[0];
}

function stardustEncodedEffort(tokens) {
  let effort;
  for (const token of tokens) {
    if (token === "none" || token === "no") effort = "off";
    else if (["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(token)) effort = token;
  }
  if (effort === void 0 && (tokens.includes("thinking") || tokens.includes("reasoning"))) effort = "high";
  return effort;
}

function stardustSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "model";
}

function stardustDynamicWindsurfFamily(model) {
  const label = model.name || model.id;
  const id = model.id || "";
  const source = String(id) + " " + String(label);
  const trusted = /^(?:MODEL_|claude-|gemini-|gpt-|grok-|glm-|kimi-|deepseek-|swe-|inkling-|nemotron-|o3\b|xai-)/iu.test(id)
    || /^(?:Claude|Gemini|GPT|Grok|GLM|Kimi|DeepSeek|SWE|Inkling|Nemotron|o3\b|xAI)\b/u.test(label);
  if (!trusted) return void 0;
  const tokens = source.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  const oneMillion = tokens.includes("1m");
  const speed = tokens.some((token) => token === "fast" || token === "priority")
    ? STARDUST_FAST_SPEED
    : STARDUST_STANDARD_SPEED;
  const effort = model.stardustVariantEffort ?? stardustEncodedEffort(tokens);
  const familyName = label
    .replace(/\b1M\b/giu, "")
    .replace(/\bFast\b/giu, "")
    .replace(/\b(?:No|None|Minimal|Low|Medium|High|XHigh|Max|Ultra)\s+(?:Thinking|Reasoning)\b/giu, "")
    .replace(/\b(?:Thinking|Reasoning)\b/giu, "")
    .replace(/\b(?:None|Minimal|Low|Medium|High|XHigh|Max|Ultra)\b$/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (familyName === "") return void 0;
  return {
    familyId: "dynamic::" + stardustSlug(familyName),
    familyName,
    effort,
    speed,
    context: oneMillion ? STARDUST_ONE_MILLION_CONTEXT : STARDUST_DEFAULT_CONTEXT
  };
}

function stardustWindsurfVariant(model) {
  let family;
  for (const candidate of STARDUST_WINDSURF_FAMILIES) {
    if (model.id === candidate[0] || model.id.startsWith(candidate[0] + "-") || model.id.startsWith(candidate[0] + "_")) {
      if (family === void 0 || candidate[0].length > family[0].length) family = candidate;
    }
  }
  if (family === void 0) return {
    ...(stardustDynamicWindsurfFamily(model) ?? {
      familyId: model.id,
      familyName: model.name,
      effort: model.stardustVariantEffort ?? model.reasoning?.defaultEffort,
      speed: STARDUST_STANDARD_SPEED,
      context: STARDUST_DEFAULT_CONTEXT
    }),
    raw: model,
    parsed: false
  };
  const suffix = model.id.slice(family[0].length).replace(/^[-_]+/u, "").toLowerCase();
  const tokens = suffix.split(/[-_]+/u).filter(Boolean);
  const oneMillion = tokens.includes("1m");
  const speed = tokens.some((token) => token === "fast" || token === "priority")
    ? STARDUST_FAST_SPEED
    : STARDUST_STANDARD_SPEED;
  let effort = model.stardustVariantEffort ?? stardustEncodedEffort(tokens);
  if (family[0] === "swe-1-7" && effort === void 0) effort = "max";
  return {
    familyId: family[0],
    familyName: family[1],
    effort,
    speed,
    context: oneMillion ? STARDUST_ONE_MILLION_CONTEXT : STARDUST_DEFAULT_CONTEXT,
    raw: model,
    parsed: true
  };
}

function stardustFamilyHasEffort(family) {
  return family?.variants.some((variant) => variant.effort !== void 0 || (variant.efforts?.length ?? 0) > 0) === true;
}

function stardustFacetGroups(groups) {
  return groups.map((group) => {
    const families = new Map();
    for (const model of group.models) {
      if (group.id === "windsurf") {
        const variant = stardustWindsurfVariant(model);
        const family = families.get(variant.familyId) ?? {
          id: variant.familyId,
          name: variant.familyName,
          description: model.description,
          provider: group.id,
          variants: []
        };
        family.variants.push({
          model: variant.raw.id,
          raw: variant.raw,
          effort: variant.effort,
          speed: variant.speed,
          context: variant.context,
          encodedParameters: true
        });
        families.set(variant.familyId, family);
        continue;
      }
      const fast = group.id === "openai-codex" && model.id.startsWith(STARDUST_FAST_PREFIX);
      const familyId = fast ? model.id.slice(STARDUST_FAST_PREFIX.length) : model.id;
      const family = families.get(familyId) ?? {
        id: familyId,
        name: fast ? model.name.replace(/\s*·\s*Fast$/u, "") : model.name,
        description: model.description,
        provider: group.id,
        variants: []
      };
      const efforts = model.reasoning?.efforts?.map((entry) => entry.id) ?? [];
      family.variants.push({
        model: model.id,
        raw: model,
        effort: void 0,
        efforts,
        speed: fast ? STARDUST_FAST_SPEED : STARDUST_STANDARD_SPEED,
        context: STARDUST_DEFAULT_CONTEXT,
        encodedParameters: false
      });
      families.set(familyId, family);
    }
    return { id: group.id, name: group.name, families: [...families.values()] };
  }).filter((group) => group.families.length > 0);
}

function stardustFamilyForCurrent(facetGroups, current) {
  if (current === null) return void 0;
  for (const group of facetGroups) {
    if (group.id !== current.provider) continue;
    for (const family of group.families) {
      const variant = family.variants.find((entry) => entry.model === current.model);
      if (variant !== void 0) return { group, family, variant };
    }
  }
}

function stardustFamilyContexts(family) {
  if (family === void 0) return [];
  return stardustUnique(family.variants.map((variant) => variant.context ?? STARDUST_DEFAULT_CONTEXT)).sort((left, right) => {
    if (left === STARDUST_DEFAULT_CONTEXT) return -1;
    if (right === STARDUST_DEFAULT_CONTEXT) return 1;
    return left.localeCompare(right);
  });
}

function stardustFamilyEfforts(family, speed, context) {
  if (family === void 0) return [];
  const matching = family.variants.filter((variant) => {
    if (speed !== void 0 && variant.speed !== speed) return false;
    return context === void 0 || (variant.context ?? STARDUST_DEFAULT_CONTEXT) === context;
  });
  const hasEffort = stardustFamilyHasEffort(family);
  return stardustSortEfforts(matching.flatMap((variant) => variant.efforts ?? (variant.effort === void 0 ? hasEffort ? ["off"] : [] : [variant.effort])));
}

function stardustFamilySpeeds(family, effort, context) {
  if (family === void 0) return [];
  const hasEffort = stardustFamilyHasEffort(family);
  return stardustUnique(family.variants.filter((variant) => {
    if (context !== void 0 && (variant.context ?? STARDUST_DEFAULT_CONTEXT) !== context) return false;
    if (effort === void 0) return true;
    if (variant.efforts !== void 0) return variant.efforts.includes(effort);
    return (variant.effort ?? (hasEffort ? "off" : void 0)) === effort;
  }).map((variant) => variant.speed));
}

function stardustSelectionForFamily(family, requested = {}) {
  if (family === void 0) return void 0;
  const contexts = stardustFamilyContexts(family);
  const context = contexts.includes(requested.context)
    ? requested.context
    : contexts.includes(STARDUST_DEFAULT_CONTEXT)
      ? STARDUST_DEFAULT_CONTEXT
      : contexts[0];
  const allEfforts = stardustFamilyEfforts(family, void 0, context);
  let effort = stardustPreferredEffort(allEfforts, requested.effort);
  let availableSpeeds = stardustFamilySpeeds(family, effort, context);
  if (availableSpeeds.length === 0) availableSpeeds = stardustFamilySpeeds(family, void 0, context);
  const speed = availableSpeeds.includes(requested.speed)
    ? requested.speed
    : availableSpeeds.includes(STARDUST_STANDARD_SPEED)
      ? STARDUST_STANDARD_SPEED
      : availableSpeeds[0];
  const availableEfforts = stardustFamilyEfforts(family, speed, context);
  effort = stardustPreferredEffort(availableEfforts, effort);
  const hasEffort = stardustFamilyHasEffort(family);
  const variant = family.variants.find((entry) => {
    if ((entry.context ?? STARDUST_DEFAULT_CONTEXT) !== context) return false;
    if (entry.speed !== speed) return false;
    if (entry.efforts !== void 0) return effort === void 0 || entry.efforts.includes(effort);
    const entryEffort = entry.effort ?? (hasEffort ? "off" : void 0);
    return entryEffort === effort || entryEffort === void 0 && effort === void 0;
  });
  if (variant === void 0) return void 0;
  return {
    provider: family.provider,
    model: variant.model,
    ...effort === void 0 || variant.encodedParameters ? {} : { reasoningEffort: effort },
    __familyId: family.id,
    __speed: speed,
    __context: context
  };
}
`;

/**
 * 模型能力菜单的样式。
 *
 * 只复用 DSH 现有 design token；`docs/evidence/stage11/frontend/g4/` 的静态预览页
 * 引用同一份文本，预览即实现。
 *
 * 关键点：把上游 `.menu`（`position:absolute`）在被包进 `.dsh-ms-wrap` 时改成静态
 * 定位；外层固定到 viewport 并由组件按触发器位置钳制 top/left，避免初始页输入框
 * 太靠底部时把子菜单顶到屏幕外。
 */
export const MODEL_MENU_STYLE = `
.dsh-ms-wrap{position:fixed;z-index:1000;left:var(--dsh-ms-left,8px);top:var(--dsh-ms-top,8px);bottom:auto!important;right:auto!important;display:flex;flex-direction:row-reverse;align-items:flex-start;align-content:flex-start;justify-content:flex-end;flex-wrap:nowrap;gap:6px;max-width:calc(100vw - 16px);max-height:var(--dsh-ms-max-height,calc(100vh - 16px));overflow:visible}
.dsh-ms-panel{position:static!important;bottom:auto!important;right:auto!important;flex:none;max-height:var(--dsh-ms-root-max-height,var(--dsh-ms-max-height,min(468px,100vh - 72px)));overflow-y:auto}
.dsh-ms-sub{width:min(268px,calc(100vw - 32px));max-height:var(--dsh-ms-sub-max-height,min(420px,100vh - 72px));overflow-y:auto}
.dsh-ms-subhead{padding:6px 10px 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-ms-provider-scroll{max-height:min(238px,calc(var(--dsh-ms-sub-max-height,420px) - 96px));overflow-y:auto;overscroll-behavior:contain;padding-right:2px;margin-right:-2px}
.dsh-ms-provider-scroll::-webkit-scrollbar{width:8px}
.dsh-ms-provider-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:999px}
.dsh-ms-cell-open{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ms-adv{margin-top:2px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:2px}
.dsh-ms-advhead{display:flex;align-items:center;gap:4px;width:100%;height:30px;padding:0 10px;border:none;border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;text-align:left}
.dsh-ms-advhead:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-ms-advcaret{position:relative;display:inline-block;width:12px;height:12px}
.dsh-ms-advcaret::before{content:"";position:absolute;left:2px;top:3px;width:5px;height:5px;border-right:1.4px solid currentColor;border-bottom:1.4px solid currentColor;transform:rotate(-135deg);transition:transform .12s ease}
.dsh-ms-adv[data-open="true"] .dsh-ms-advcaret::before{transform:rotate(45deg);top:2px}
.dsh-ms-advbody{padding:2px 10px 6px}
.dsh-ms-slider{padding:4px 0 10px}
.dsh-ms-slider+.dsh-ms-slider{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
.dsh-ms-slider-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.dsh-ms-slider-lab{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-ms-slider-val{margin-left:auto;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;line-height:18px}
.dsh-ms-track{position:relative;height:30px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-module-platform));box-shadow:inset 0 1px 2px rgba(15,23,42,.1),inset 0 0 0 1px var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.dsh-ms-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#e6b34a 0%,#ef8a3c 58%,#e2603c 100%);box-shadow:inset 0 0 0 1px rgba(15,23,42,.06);transition:width .14s cubic-bezier(.32,.72,.35,1)}
.dsh-ms-tick{position:absolute;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:currentColor;opacity:.35}
.dsh-ms-knob{position:absolute;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover-solid,#eef1f4),0 0 0 4px rgba(15,23,42,.06),0 2px 6px rgba(15,23,42,.24);transition:left .14s cubic-bezier(.32,.72,.35,1);pointer-events:none}
.dsh-ms-range{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:pointer;-webkit-appearance:none;appearance:none;background:0 0}
.dsh-ms-range:focus-visible+.dsh-ms-knob{box-shadow:0 0 0 3px var(--dsw-alias-border-l3),0 1px 3px rgba(15,23,42,.28)}
.dsh-ms-slider-hint{min-height:18px;margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ms-trigger{height:32px;max-width:280px;padding:0 6px 0 12px;gap:6px;border-radius:999px;font-size:13.5px}
.dsh-ms-trigglabel{color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-ms-trigeffort{font-size:12.5px}
.dsh-ms-advrow{display:flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:18px}
.dsh-ms-advrow code{font-family:"Cascadia Code","Cascadia Mono",Consolas,"Courier New",monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsh-ms-advlink{margin-top:4px;padding:0;border:none;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;text-decoration:underline;text-decoration-color:var(--dsw-alias-border-l3);cursor:pointer}
.dsh-ms-advlink:hover{color:var(--dsw-alias-label-primary)}
.dsh-ms-foot{position:sticky;bottom:-4px;z-index:1;display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px;padding:6px 6px;background:var(--dsw-specific-menu);border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-ms-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;white-space:nowrap}
.dsh-ms-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ms-btn[data-primary="true"]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-ms-btn[data-primary="true"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-ms-btn:disabled{cursor:default;color:var(--dsw-alias-label-dimmed)}
.dsh-ms-btn[data-primary="true"]:disabled{background:0 0;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-dimmed)}
.dsh-ms-trigspin{flex:none;width:11px;height:11px;box-sizing:border-box;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:dsh-ms-sp .9s linear infinite}
@keyframes dsh-ms-sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-ms-trigspin{animation:none}.dsh-ms-advcaret::before{transition:none}}
`;

export const MODEL_SELECT_BROWSER_SOURCE = `\n\t\tconst STARDUST_MODEL_MENU_CSS = ${JSON.stringify(MODEL_MENU_STYLE)};\n` + String.raw`		const STARDUST_COST_HINT_EFFORTS = ["xhigh", "max", "ultra"];
		/**
		* 成本副标题。只写两件真实且有用的事：Fast 档是 1.5 倍速度且更耗用量，
		* 高推理档更快消耗额度。其余档位不编描述。
		*/
		function stardustSpeedHint(speed) {
			return speed === STARDUST_FAST_SPEED ? "1.5 倍速度，用量更多" : "默认速度";
		}
		function stardustEffortHint(effort) {
			return STARDUST_COST_HINT_EFFORTS.includes(effort) ? "更快消耗使用额度" : void 0;
		}
		function stardustUseProviderAuth(open) {
			const [auth, setAuth] = (0, react.useState)({});
			(0, react.useEffect)(() => {
				let disposed = false;
				Promise.all([
					fetch("/oauth/openai-codex/status", { cache: "no-store" }).then((response) => response.json()).catch(() => null),
					fetch("/oauth/windsurf/status", { cache: "no-store" }).then((response) => response.json()).catch(() => null)
				]).then(([openai, windsurf]) => {
					if (disposed) return;
					setAuth({
						...(openai?.ok === true ? { "openai-codex": openai.connected === true } : {}),
						...(windsurf?.ok === true ? { windsurf: windsurf.connected === true } : {})
					});
				});
				return () => { disposed = true; };
			}, [open]);
			return auth;
		}
		function ModelSelect({ locked, available, directory, load, select, t }) {
			const state = (0, react.useSyncExternalStore)((fn) => directory.subscribe(fn), () => directory.getSnapshot());
			const [open, setOpen] = (0, react.useState)(false);
			const providerAuth = stardustUseProviderAuth(open);
			const [pane, setPane] = (0, react.useState)("root");
			const [draftSelection, setDraftSelection] = (0, react.useState)(null);
			const lastActionRef = (0, react.useRef)("load");
			const [toast, setToast] = (0, react.useState)(null);
			const toastSeq = (0, react.useRef)(0);
			const rootRef = (0, react.useRef)(null);
			const triggerRef = (0, react.useRef)(null);
			const wrapRef = (0, react.useRef)(null);
			const [advanced, setAdvanced] = (0, react.useState)(false);
			const [menuBox, setMenuBox] = (0, react.useState)(null);
			const id = (0, react.useId)();
			const facetGroups = (0, react.useMemo)(() => stardustFacetGroups(state.groups).filter((group) => providerAuth[group.id] !== false), [state.groups, providerAuth]);
			const displayedCurrent = open && draftSelection !== null ? draftSelection : state.current;
			const currentFacet = (0, react.useMemo)(() => stardustFamilyForCurrent(facetGroups, displayedCurrent), [facetGroups, displayedCurrent]);
			const currentFamily = currentFacet?.family;
			const effectiveSpeed = displayedCurrent?.__speed ?? currentFacet?.variant.speed ?? STARDUST_STANDARD_SPEED;
			const effectiveEffort = displayedCurrent?.reasoningEffort ?? currentFacet?.variant.effort;
			const effectiveContext = displayedCurrent?.__context ?? currentFacet?.variant.context ?? STARDUST_DEFAULT_CONTEXT;
			const effortChoices = (0, react.useMemo)(() => stardustFamilyEfforts(currentFamily, effectiveSpeed, effectiveContext).map((effort) => ({
				key: "effort:" + effort,
				effort,
				label: stardustEffortLabel(effort),
				hint: stardustEffortHint(effort)
			})), [currentFamily, effectiveSpeed, effectiveContext]);
			const speedChoices = (0, react.useMemo)(() => stardustFamilySpeeds(currentFamily, effectiveEffort, effectiveContext).map((speed) => ({
				key: "speed:" + speed,
				speed,
				label: stardustSpeedLabel(speed),
				hint: stardustSpeedHint(speed)
			})), [currentFamily, effectiveEffort, effectiveContext]);
			const contextChoices = (0, react.useMemo)(() => stardustFamilyContexts(currentFamily).map((context) => ({
				key: "context:" + context,
				context,
				label: stardustContextLabel(context, currentFamily)
			})), [currentFamily]);
			const busy = state.status === "selecting";
			const effortLabel = effectiveEffort === void 0 ? t("effort.unset") : stardustEffortLabel(effectiveEffort);
			const speedLabel = stardustSpeedLabel(effectiveSpeed);
			const contextLabel = stardustContextLabel(effectiveContext, currentFamily);
			const modelLabel = currentFamily?.name ?? t("trigger.fallback");
			const reload = () => {
				lastActionRef.current = "load";
				load();
			};
			(0, react.useEffect)(() => {
				if (available) reload();
			}, [available, load]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (!rootRef.current?.contains(event.target)) {
						setOpen(false);
						setPane("root");
						setDraftSelection(null);
					}
				};
				document.addEventListener("mousedown", closeOutside);
				return () => document.removeEventListener("mousedown", closeOutside);
			}, [open]);
			(0, react.useLayoutEffect)(() => {
				if (!open) {
					setMenuBox(null);
					return;
				}
				let frame = 0;
				const update = () => {
					const anchor = triggerRef.current?.getBoundingClientRect();
					const wrap = wrapRef.current;
					if (anchor === void 0 || wrap === null) return;
					const margin = 8;
					const viewportWidth = Math.max(window.innerWidth || 0, 320);
					const viewportHeight = Math.max(window.innerHeight || 0, 320);
					const maxWidth = Math.max(240, viewportWidth - margin * 2);
					const rootPanel = wrap.querySelector(".dsh-ms-panel:not(.dsh-ms-sub)") ?? wrap;
					const subPanel = wrap.querySelector(".dsh-ms-sub");
					const wrapRect = wrap.getBoundingClientRect();
					const rootRect = rootPanel.getBoundingClientRect();
					const measuredWidth = Math.min(Math.ceil(wrap.offsetWidth || wrapRect.width || 280), maxWidth);
					const maxHeight = Math.max(180, viewportHeight - margin * 2);
					const rootMaxHeight = Math.min(468, maxHeight);
					const subMaxHeight = Math.min(420, maxHeight);
					const subRect = subPanel?.getBoundingClientRect();
					const measuredRootHeight = Math.min(Math.ceil(rootPanel.scrollHeight || rootRect.height || 320), rootMaxHeight);
					const measuredSubHeight = subPanel === null ? 0 : Math.min(Math.ceil(subPanel.scrollHeight || subRect?.height || 320), subMaxHeight);
					const measuredHeight = Math.max(measuredRootHeight, measuredSubHeight, Math.ceil(wrapRect.height || 0));
					const left = Math.min(Math.max(margin, Math.round(anchor.right - measuredWidth)), viewportWidth - measuredWidth - margin);
					const preferredTop = Math.round(anchor.top - measuredHeight - margin);
					const fallbackTop = Math.round(anchor.bottom + margin);
					const top = preferredTop >= margin
						? preferredTop
						: Math.min(Math.max(margin, fallbackTop), viewportHeight - measuredHeight - margin);
					setMenuBox({
						left: Math.max(margin, left),
						top: Math.max(margin, top),
						maxHeight,
						rootMaxHeight,
						subMaxHeight
					});
				};
				const schedule = () => {
					cancelAnimationFrame(frame);
					frame = requestAnimationFrame(update);
				};
				update();
				frame = requestAnimationFrame(update);
				window.addEventListener("resize", schedule);
				window.addEventListener("scroll", schedule, true);
				return () => {
					cancelAnimationFrame(frame);
					window.removeEventListener("resize", schedule);
					window.removeEventListener("scroll", schedule, true);
				};
			}, [open, pane, advanced, facetGroups.length, effortChoices.length, speedChoices.length, contextChoices.length]);
			if (!available) return null;
			const close = (restoreFocus = false) => {
				setOpen(false);
				setPane("root");
				setDraftSelection(null);
				if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
			};
			const show = () => {
				const selected = currentFacet === void 0 ? state.current : stardustSelectionForFamily(currentFacet.family, {
					effort: state.current?.reasoningEffort ?? currentFacet.variant.effort,
					speed: currentFacet.variant.speed ?? STARDUST_STANDARD_SPEED,
					context: currentFacet.variant.context ?? STARDUST_DEFAULT_CONTEXT
				});
				setDraftSelection(selected ?? state.current);
				setPane("root");
				setOpen(true);
			};
			const showError = () => {
				const message = directory.getSnapshot().error;
				if (message === null) return;
				toastSeq.current += 1;
				setToast({ seq: toastSeq.current, text: t("error.action", { message }) });
			};
			const submit = (selection) => {
				if (selection === void 0) {
					toastSeq.current += 1;
					setToast({ seq: toastSeq.current, text: t("error.combination") });
					return;
				}
				close(true);
				lastActionRef.current = "select";
				select(selection).then((accepted) => {
					if (!accepted) showError();
				});
			};
			const chooseDraft = (selection) => {
				if (selection === void 0) {
					toastSeq.current += 1;
					setToast({ seq: toastSeq.current, text: t("error.combination") });
					return;
				}
				setDraftSelection(selection);
				setPane("root");
			};
			const chooseFamily = (family) => {
				if (currentFamily?.provider === family.provider && currentFamily.id === family.id) {
					setPane("root");
					return;
				}
				const sameProvider = currentFamily?.provider === family.provider;
				chooseDraft(stardustSelectionForFamily(family, {
					effort: sameProvider ? effectiveEffort : void 0,
					speed: sameProvider ? effectiveSpeed : STARDUST_STANDARD_SPEED,
					context: STARDUST_DEFAULT_CONTEXT
				}));
			};
			const chooseEffort = (effort) => chooseDraft(stardustSelectionForFamily(currentFamily, {
				effort,
				speed: effectiveSpeed,
				context: effectiveContext
			}));
			const chooseSpeed = (speed) => chooseDraft(stardustSelectionForFamily(currentFamily, {
				effort: effectiveEffort,
				speed,
				context: effectiveContext
			}));
			const chooseContext = (context) => chooseDraft(stardustSelectionForFamily(currentFamily, {
				effort: effectiveEffort,
				speed: effectiveSpeed,
				context
			}));
			const draftDirty = draftSelection !== null && (
				draftSelection.provider !== state.current?.provider
				|| draftSelection.model !== state.current?.model
				|| draftSelection.reasoningEffort !== state.current?.reasoningEffort
			);
			const triggerDetail = [contextChoices.length > 1 ? contextLabel : void 0, effectiveEffort === void 0 ? void 0 : effortLabel, effectiveSpeed === STARDUST_FAST_SPEED ? speedLabel : void 0].filter(Boolean).join(" · ");
			const triggerLabel = triggerDetail ? modelLabel + " · " + triggerDetail : modelLabel;
			const menuStyle = menuBox === null ? void 0 : {
				"--dsh-ms-left": menuBox.left + "px",
				"--dsh-ms-top": menuBox.top + "px",
				"--dsh-ms-max-height": menuBox.maxHeight + "px",
				"--dsh-ms-root-max-height": menuBox.rootMaxHeight + "px",
				"--dsh-ms-sub-max-height": menuBox.subMaxHeight + "px"
			};
			const rootCell = (label, value, target) => (0, react_jsx_runtime.jsxs)("button", {
				key: target,
				type: "button",
				role: "menuitem",
				"aria-haspopup": "menu",
				"aria-expanded": pane === target,
				className: clsx(ModelSelect_module_css_default.cell, pane === target && "dsh-ms-cell-open"),
				onClick: () => setPane(pane === target ? "root" : target),
				children: [
					(0, react_jsx_runtime.jsx)("span", { className: ModelSelect_module_css_default.cellLabel, children: label }),
					(0, react_jsx_runtime.jsx)("span", { className: ModelSelect_module_css_default.cellValue, children: value }),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, { className: ModelSelect_module_css_default.cellChevron })
				]
			});
			const paneTitles = {
				model: t("menu.model"),
				context: t("menu.context"),
				effort: t("menu.effort"),
				speed: t("menu.speed")
			};
			/**
			* 档位拖动条：刻度点数量等于目录里真实存在的档位数，不补空档。
			* 只有 2 档以上才画，当前值不在列表时退回第一档并保持可选。
			* 交互用透明 range 承接，拖动、点击、方向键与读屏都免费拿到。
			*/
			const facetSlider = (key, label, entries, currentIndex, onPick) => {
				const total = entries.length;
				const index = currentIndex < 0 ? 0 : currentIndex;
				const percent = total > 1 ? index / (total - 1) * 100 : 100;
				const active = entries[index];
				// 球心不能贴到轨道端点外：按 24px 球径 + 两端各留 2px 条身内缩 15px。
				const seat = (value) => "calc(" + value + "% + " + (15 - value * 0.3) + "px)";
				const ratio = (position) => total > 1 ? position / (total - 1) * 100 : 100;
				return (0, react_jsx_runtime.jsxs)("div", {
					key,
					className: "dsh-ms-slider",
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-ms-slider-head",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dsh-ms-slider-lab",
							children: label
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-ms-slider-val",
							children: active === void 0 ? "未知" : active.label
						})]
					}), (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-ms-track",
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								className: "dsh-ms-fill",
								style: { width: "calc(" + percent + "% + " + (20 - percent * 0.3) + "px)" }
							}),
							...entries.map((entry, tickIndex) => (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-ms-tick",
								"aria-hidden": true,
								style: { left: seat(ratio(tickIndex)) }
							}, "tick:" + entry.key)),
							(0, react_jsx_runtime.jsx)("input", {
								type: "range",
								className: "dsh-ms-range",
								min: 0,
								max: Math.max(0, total - 1),
								step: 1,
								value: index,
								"aria-label": label,
								"aria-valuetext": active === void 0 ? void 0 : active.label,
								onChange: (event) => {
									const picked = entries[Number(event.target.value)];
									if (picked !== void 0) onPick(picked);
								}
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "dsh-ms-knob",
								"aria-hidden": true,
								style: { left: seat(percent) }
							})
						]
					}), (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-ms-slider-hint",
						children: active?.hint ?? ""
					})]
				});
			};
			const option = ({ key, selected, title, description, onClick }) => (0, react_jsx_runtime.jsxs)("button", {
				key,
				type: "button",
				role: "menuitemradio",
				"aria-checked": selected,
				className: clsx(ModelSelect_module_css_default.option, selected && ModelSelect_module_css_default.selected),
				title,
				onClick,
				children: [
					(0, react_jsx_runtime.jsxs)("span", { className: ModelSelect_module_css_default.optionCopy, children: [
						(0, react_jsx_runtime.jsx)("span", { className: ModelSelect_module_css_default.modelName, children: title }),
						description === void 0 ? null : (0, react_jsx_runtime.jsx)("span", { className: ModelSelect_module_css_default.description, children: description })
					] }),
					(0, react_jsx_runtime.jsx)("span", { className: ModelSelect_module_css_default.check, children: selected ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {}) : null })
				]
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: ModelSelect_module_css_default.root,
				onKeyDown: (event) => {
					if (event.key !== "Escape" || !open) return;
					event.preventDefault();
					if (pane === "root") close(true);
					else setPane("root");
				},
				children: [
					(0, react_jsx_runtime.jsx)("style", { children: STARDUST_MODEL_MENU_CSS }),
					(0, react_jsx_runtime.jsxs)("button", {
						ref: triggerRef,
						type: "button",
						className: clsx(ModelSelect_module_css_default.trigger, "dsh-ms-trigger"),
						"aria-label": triggerLabel,
						"aria-haspopup": "menu",
						"aria-expanded": open,
						title: busy ? t("status.selecting") : triggerLabel,
						disabled: locked || busy,
						onClick: () => open ? close() : show(),
						children: [
							busy ? (0, react_jsx_runtime.jsx)("span", { className: "dsh-ms-trigspin", "aria-hidden": true }) : null,
							(0, react_jsx_runtime.jsx)("span", { className: clsx(ModelSelect_module_css_default.triggerLabel, "dsh-ms-trigglabel"), children: modelLabel }),
							(0, react_jsx_runtime.jsx)("span", { className: clsx(ModelSelect_module_css_default.triggerEffort, "dsh-ms-trigeffort"), children: busy ? t("status.selectingShort") : triggerDetail }),
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: clsx(ModelSelect_module_css_default.chevron, open && ModelSelect_module_css_default.chevronOpen) })
						]
					}),
					open && (0, react_jsx_runtime.jsxs)("div", {
						ref: wrapRef,
						className: "dsh-ms-wrap",
						style: menuStyle,
						children: [
						(0, react_jsx_runtime.jsxs)("div", {
						id: id + "-menu",
						className: clsx(ModelSelect_module_css_default.menu, "dsh-ms-panel"),
						role: "menu",
						"aria-label": t("menu.aria"),
						children: [
							advanced ? null : rootCell(t("menu.model"), modelLabel, "model"),
							advanced || contextChoices.length <= 1 ? null : rootCell(t("menu.context"), contextLabel, "context"),
							advanced || effortChoices.length === 0 ? null : rootCell(t("menu.effort"), effortLabel, "effort"),
							advanced || speedChoices.length <= 1 ? null : rootCell(t("menu.speed"), speedLabel, "speed"),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-ms-adv",
								"data-open": advanced ? "true" : "false",
								children: [
									(0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "dsh-ms-advhead",
										"aria-expanded": advanced,
										onClick: () => {
											setPane("root");
											setAdvanced(!advanced);
										},
										children: ["高级", (0, react_jsx_runtime.jsx)("span", { className: "dsh-ms-advcaret", "aria-hidden": true })]
									}),
									advanced ? (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-ms-advbody",
										children: [
											effortChoices.length <= 1 && speedChoices.length <= 1 && contextChoices.length <= 1
												? (0, react_jsx_runtime.jsx)("div", { className: "dsh-ms-advrow", children: "当前模型在目录里只有一种档位组合，没有可拖动的档位" })
												: null,
											effortChoices.length > 1 ? facetSlider(
												"effort",
												t("menu.effort"),
												effortChoices,
												effortChoices.findIndex((entry) => entry.effort === effectiveEffort),
												(entry) => chooseEffort(entry.effort)
											) : null,
											speedChoices.length > 1 ? facetSlider(
												"speed",
												t("menu.speed"),
												speedChoices,
												speedChoices.findIndex((entry) => entry.speed === effectiveSpeed),
												(entry) => chooseSpeed(entry.speed)
											) : null,
											contextChoices.length > 1 ? facetSlider(
												"context",
												t("menu.context"),
												contextChoices,
												contextChoices.findIndex((entry) => entry.context === effectiveContext),
												(entry) => chooseContext(entry.context)
											) : null,
											(0, react_jsx_runtime.jsxs)("div", { className: "dsh-ms-advrow", children: ["提供方", (0, react_jsx_runtime.jsx)("code", { children: displayedCurrent?.provider ?? "未知" })] }),
											(0, react_jsx_runtime.jsxs)("div", { className: "dsh-ms-advrow", children: ["模型 ID", (0, react_jsx_runtime.jsx)("code", { children: displayedCurrent?.model ?? "未知" })] }),
											(0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ms-advlink", onClick: reload, children: "重新加载模型目录" })
										]
									}) : null
								]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-ms-foot",
								children: [
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ms-btn", onClick: () => close(true), children: "取消" }),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-ms-btn",
										"data-primary": "true",
										disabled: !draftDirty || busy,
										onClick: () => submit(draftSelection),
										children: busy ? "应用中…" : "应用"
									})
								]
							})
						]
					}),
					pane !== "root" && (0, react_jsx_runtime.jsxs)("div", {
						className: clsx(ModelSelect_module_css_default.menu, "dsh-ms-panel", "dsh-ms-sub", "scrollable"),
						role: "menu",
						"aria-label": paneTitles[pane] ?? t("menu.aria"),
						children: [
							(0, react_jsx_runtime.jsx)("div", { className: "dsh-ms-subhead", children: paneTitles[pane] ?? "" }),
							pane === "model" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								state.status === "loading" && facetGroups.length === 0 ? (0, react_jsx_runtime.jsx)("div", { className: ModelSelect_module_css_default.status, children: t("status.loading") }) : null,
								state.error !== null && lastActionRef.current === "load" ? (0, react_jsx_runtime.jsxs)("div", { className: ModelSelect_module_css_default.error, children: [
									(0, react_jsx_runtime.jsx)("span", { children: t("error.action", { message: state.error }) }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: ModelSelect_module_css_default.retry, onClick: reload, children: t("action.reload") })
								] }) : null,
								(0, react_jsx_runtime.jsx)("div", { className: clsx(ModelSelect_module_css_default.groups, "scrollable"), children: facetGroups.map((group) => (0, react_jsx_runtime.jsxs)("section", {
									role: "group",
									className: ModelSelect_module_css_default.group,
									children: [
										(0, react_jsx_runtime.jsx)("div", { className: ModelSelect_module_css_default.groupTitle, children: group.name }),
										(0, react_jsx_runtime.jsx)("div", {
											className: group.id === "windsurf" && group.families.length > 8 ? "dsh-ms-provider-scroll" : void 0,
											children: group.families.map((family) => option({
												key: group.id + ":" + family.id,
												selected: currentFamily?.provider === family.provider && currentFamily.id === family.id,
												title: family.name,
												description: family.description,
												onClick: () => chooseFamily(family)
											}))
										})
									]
								}, group.id)) }),
								state.status === "ready" && facetGroups.every((group) => group.families.length === 0) ? (0, react_jsx_runtime.jsx)("div", { className: ModelSelect_module_css_default.empty, children: t("empty.models") }) : null
							] }),
							pane === "effort" && (effortChoices.length === 0
								? (0, react_jsx_runtime.jsx)("div", { className: ModelSelect_module_css_default.empty, children: t("empty.efforts") })
								: effortChoices.map((entry) => option({ key: entry.key, selected: effectiveEffort === entry.effort, title: entry.label, description: entry.hint, onClick: () => chooseEffort(entry.effort) }))),
							pane === "speed" && speedChoices.map((entry) => option({ key: entry.key, selected: effectiveSpeed === entry.speed, title: entry.label, description: entry.hint, onClick: () => chooseSpeed(entry.speed) })),
							pane === "context" && contextChoices.map((entry) => option({ key: entry.key, selected: effectiveContext === entry.context, title: entry.label, onClick: () => chooseContext(entry.context) }))
						]
					})]
					}),
					toast !== null && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: toast.text,
						icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {}),
						anchor: rootRef.current?.closest("[data-composer-card]") ?? null,
						onDone: () => setToast(null)
					}, toast.seq)
				]
			});
		}
`;
