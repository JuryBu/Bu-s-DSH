export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const WINDSURF_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const ACCOUNT_USAGE_CACHE_TTL_MS = 60_000;
export const ACCOUNT_USAGE_REQUEST_DEDUP_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const INVALID_QUOTA = Symbol("invalid-quota");

const PROVIDER_POLICIES = Object.freeze({
  "deepseek-api-key": Object.freeze({
    requestMode: "deepseek_balance",
    boundary: "official_api_key_balance",
    usageUrl: "https://api-docs.deepseek.com/zh-cn/api/get-user-balance/",
  }),
  "openai-codex-oauth": Object.freeze({
    requestMode: "openai_rate_limits",
    boundary: "authenticated_internal_chatgpt_usage_api",
    usageUrl: "https://chatgpt.com/codex/settings/usage",
  }),
  "experimental-windsurf-devin": Object.freeze({
    requestMode: "windsurf_user_status",
    boundary: "authenticated_internal_windsurf_user_status_api",
    usageUrl: "https://app.windsurf.com/subscription/manage-plan",
  }),
});

function cloneSnapshot(snapshot) {
  return structuredClone(snapshot);
}

function normalizeConnectionStatus(value) {
  if (value?.connection === "connected" || value?.connected === true) return "connected";
  if (value?.connection === "disconnected" || value?.connected === false) return "disconnected";
  return "unknown";
}

function normalizeUsageUrl(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function normalizeWindsurfApiServerUrl(value) {
  const fallback = "https://server.codeium.com";
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return fallback;
    return parsed.origin;
  } catch {
    return fallback;
  }
}

function createBaseSnapshot(providerId, policy, connection, updatedAt) {
  return {
    providerId,
    connection,
    updatedAt,
    usageUrl: policy.usageUrl,
    boundary: policy.boundary,
    balance: null,
    quota: null,
  };
}

function unavailableSnapshot(providerId, policy, connection, updatedAt, reason) {
  return {
    ...createBaseSnapshot(providerId, policy, connection, updatedAt),
    availability: "unavailable",
    reason,
  };
}

function isMoneyString(value) {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedPercent(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function unixSecondsToIso(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  const date = new Date(number * 1000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) ?? null;
}

function firstNumber(object, keys) {
  if (!object) return null;
  for (const key of keys) {
    const value = finiteNumber(object[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(object, keys) {
  if (!object) return null;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeBalance(payload) {
  if (!payload || payload.is_available !== true || !Array.isArray(payload.balance_infos)) return null;
  const entries = payload.balance_infos.map((entry) => {
    if (!entry || (entry.currency !== "CNY" && entry.currency !== "USD")) return null;
    if (!isMoneyString(entry.total_balance) || !isMoneyString(entry.granted_balance) || !isMoneyString(entry.topped_up_balance)) return null;
    return {
      currency: entry.currency,
      totalBalance: entry.total_balance,
      grantedBalance: entry.granted_balance,
      toppedUpBalance: entry.topped_up_balance,
    };
  });
  return entries.length > 0 && entries.every(Boolean) ? entries : null;
}

function normalizeOpenAIWindow(window, id, fallbackLabel) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = boundedPercent(window.used_percent);
  const windowSeconds = finiteNumber(window.limit_window_seconds);
  const resetAt = unixSecondsToIso(window.reset_at);
  const resetAfterSeconds = finiteNumber(window.reset_after_seconds);
  const invalidKnownField = [
    ["used_percent", usedPercent],
    ["limit_window_seconds", windowSeconds],
    ["reset_at", resetAt],
    ["reset_after_seconds", resetAfterSeconds],
  ].some(([key, normalized]) => Object.hasOwn(window, key) && window[key] !== null && window[key] !== undefined && normalized === null);
  if (invalidKnownField) return INVALID_QUOTA;
  if (usedPercent === null && windowSeconds === null && resetAt === null && resetAfterSeconds === null) return null;
  const hours = windowSeconds !== null && windowSeconds > 0 ? Math.round(windowSeconds / 3600) : null;
  return {
    id,
    label: hours !== null && hours < 48 ? `${hours} 小时额度` : fallbackLabel,
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowSeconds: windowSeconds !== null && windowSeconds > 0 ? windowSeconds : null,
    resetAt,
    resetAfterSeconds: resetAfterSeconds !== null && resetAfterSeconds >= 0 ? resetAfterSeconds : null,
  };
}

function normalizeOpenAIQuota(payload) {
  const rateLimit = firstObject(payload?.rate_limit, payload?.rateLimit);
  const normalizedWindows = [
    normalizeOpenAIWindow(firstObject(rateLimit?.primary_window, rateLimit?.primaryWindow), "primary", "短时额度"),
    normalizeOpenAIWindow(firstObject(rateLimit?.secondary_window, rateLimit?.secondaryWindow), "secondary", "周额度"),
  ];
  if (normalizedWindows.includes(INVALID_QUOTA)) return INVALID_QUOTA;
  const windows = normalizedWindows.filter(Boolean);
  const planName = firstString(payload, ["plan_type", "planType"]);
  if (windows.length === 0 && planName === null) return null;
  return { kind: "rate_limits", planName, windows, source: "chatgpt_wham_usage" };
}

function normalizeCreditValue(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  if (number >= 1000 || number >= 100 && number % 100 === 0) return number / 100;
  return number;
}

function normalizeBillingStrategy(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const canonical = value.trim().replace(/^billing[_-]?strategy[_-]?/i, "").toLowerCase();
  if (canonical === "quota") return "quota";
  if (canonical.includes("credit")) return "credits";
  return canonical || null;
}

function normalizeWindsurfCredits(planStatus, planInfo) {
  const promptAvailable = normalizeCreditValue(firstNumber(planStatus, ["availablePromptCredits", "available_prompt_credits"]));
  const promptUsed = normalizeCreditValue(firstNumber(planStatus, ["usedPromptCredits", "used_prompt_credits"]));
  const promptTotal = normalizeCreditValue(firstNumber(planInfo, ["monthlyPromptCredits", "monthly_prompt_credits"])) ?? promptAvailable;
  const promptRemaining = promptTotal !== null && promptUsed !== null ? Math.max(0, promptTotal - promptUsed) : promptAvailable;
  const addOnAvailable = normalizeCreditValue(firstNumber(planStatus, [
    "availableFlexCredits", "available_flex_credits", "availableAddOnCredits", "available_add_on_credits",
    "availableTopUpCredits", "available_top_up_credits",
  ]));
  const addOnUsed = normalizeCreditValue(firstNumber(planStatus, [
    "usedFlexCredits", "used_flex_credits", "usedAddOnCredits", "used_add_on_credits",
    "usedTopUpCredits", "used_top_up_credits",
  ]));
  const addOnTotal = normalizeCreditValue(firstNumber(planInfo, [
    "monthlyFlexCreditPurchaseAmount", "monthly_flex_credit_purchase_amount", "monthlyAddOnCredits",
    "monthly_add_on_credits", "monthlyTopUpCredits", "monthly_top_up_credits",
  ])) ?? addOnAvailable;
  const addOnRemaining = addOnTotal !== null && addOnUsed !== null ? Math.max(0, addOnTotal - addOnUsed) : addOnAvailable;
  return {
    prompt: promptTotal === null && promptUsed === null && promptRemaining === null ? null : { total: promptTotal, used: promptUsed, remaining: promptRemaining },
    addOn: addOnTotal === null && addOnUsed === null && addOnRemaining === null ? null : { total: addOnTotal, used: addOnUsed, remaining: addOnRemaining },
  };
}

function normalizeWindsurfQuota(payload) {
  const userStatus = firstObject(payload?.userStatus, payload?.user_status);
  const planStatus = firstObject(userStatus?.planStatus, userStatus?.plan_status, payload?.planStatus, payload?.plan_status);
  const planInfo = firstObject(planStatus?.planInfo, planStatus?.plan_info, payload?.planInfo, payload?.plan_info, userStatus?.planInfo, userStatus?.plan_info);
  if (planStatus === null && planInfo === null) return null;
  const billingMode = normalizeBillingStrategy(
    firstString(planStatus, ["billingStrategy", "billing_strategy"])
      ?? firstString(planInfo, ["billingStrategy", "billing_strategy"]),
  );
  const planName = firstString(planInfo, ["planName", "plan_name", "name"])
    ?? firstString(planStatus, ["planName", "plan_name"]);
  const windows = [
    { id: "daily", label: "每日额度", remainingPercent: boundedPercent(firstNumber(planStatus, ["dailyQuotaRemainingPercent", "daily_quota_remaining_percent"])), resetAt: unixSecondsToIso(firstNumber(planStatus, ["dailyQuotaResetAtUnix", "daily_quota_reset_at_unix"])) },
    { id: "weekly", label: "每周额度", remainingPercent: boundedPercent(firstNumber(planStatus, ["weeklyQuotaRemainingPercent", "weekly_quota_remaining_percent"])), resetAt: unixSecondsToIso(firstNumber(planStatus, ["weeklyQuotaResetAtUnix", "weekly_quota_reset_at_unix"])) },
  ].map((window) => ({ ...window, usedPercent: window.remainingPercent === null ? null : 100 - window.remainingPercent }))
    .filter((window) => window.remainingPercent !== null || window.resetAt !== null);
  const credits = normalizeWindsurfCredits(planStatus, planInfo);
  const overageBalanceMicros = firstNumber(planStatus, ["overageBalanceMicros", "overage_balance_micros"]);
  const planStartsAt = unixSecondsToIso(firstNumber(planStatus, ["planStart", "plan_start", "currentPeriodStart", "current_period_start"]));
  const planEndsAt = unixSecondsToIso(firstNumber(planStatus, ["planEnd", "plan_end", "currentPeriodEnd", "current_period_end"]));
  const hasData = planName !== null || billingMode !== null || windows.length > 0 || credits.prompt !== null || credits.addOn !== null || overageBalanceMicros !== null || planEndsAt !== null;
  if (!hasData) return null;
  return {
    kind: "windsurf",
    planName,
    billingMode,
    windows,
    credits,
    overageBalanceMicros: overageBalanceMicros !== null && overageBalanceMicros >= 0 ? overageBalanceMicros : null,
    planStartsAt,
    planEndsAt,
    source: "windsurf_api_key_user_status",
  };
}

function validateConstructorOptions(options) {
  if (typeof options?.secretBearingFetcher !== "function") throw new TypeError("secretBearingFetcher must be a function");
  if (typeof options?.getProviderStatus !== "function") throw new TypeError("getProviderStatus must be a function");
  if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0 || options.requestTimeoutMs > ACCOUNT_USAGE_REQUEST_DEDUP_MS) {
    throw new RangeError("requestTimeoutMs must be between 1 and ACCOUNT_USAGE_REQUEST_DEDUP_MS");
  }
}

function requestDescriptor(providerId, policy, providerStatus, signal) {
  if (policy.requestMode === "deepseek_balance") return { providerId, url: DEEPSEEK_BALANCE_URL, method: "GET", headers: { accept: "application/json" }, signal };
  if (policy.requestMode === "openai_rate_limits") return { providerId, url: OPENAI_USAGE_URL, method: "GET", headers: { accept: "application/json" }, signal };
  const baseUrl = normalizeWindsurfApiServerUrl(providerStatus?.apiServerUrl);
  return {
    providerId,
    url: new URL(WINDSURF_USER_STATUS_PATH, baseUrl).toString(),
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: {
      metadata: {
        ideName: "Windsurf",
        ideVersion: "1.0.0",
        extensionName: "codeium.windsurf",
        extensionVersion: "1.0.0",
        locale: "zh-CN",
        os: process.platform,
        disableTelemetry: false,
        sessionId: `dsh-${Date.now()}`,
        requestId: String(Date.now()),
      },
    },
    signal,
  };
}

export class AccountUsageService {
  #cache = new Map();
  #inFlight = new Map();
  #secretBearingFetcher;
  #getProviderStatus;
  #clock;
  #requestTimeoutMs;

  constructor({ secretBearingFetcher, getProviderStatus, clock = () => Date.now(), requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    validateConstructorOptions({ secretBearingFetcher, getProviderStatus, requestTimeoutMs });
    this.#secretBearingFetcher = secretBearingFetcher;
    this.#getProviderStatus = getProviderStatus;
    this.#clock = clock;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async getSnapshot(providerId, { forceRefresh = false } = {}) {
    const policy = PROVIDER_POLICIES[providerId];
    if (!policy) throw new RangeError(`unsupported account usage provider: ${providerId}`);
    const now = this.#clock();
    const cached = this.#cache.get(providerId);
    if (!forceRefresh && cached && now - cached.cachedAt < ACCOUNT_USAGE_CACHE_TTL_MS) return cloneSnapshot(cached.snapshot);
    const pending = this.#inFlight.get(providerId);
    if (pending) return cloneSnapshot(await pending);
    const request = this.#loadSnapshot(providerId, policy, now);
    this.#inFlight.set(providerId, request);
    try {
      const snapshot = await request;
      this.#cache.set(providerId, { cachedAt: this.#clock(), snapshot });
      return cloneSnapshot(snapshot);
    } finally {
      if (this.#inFlight.get(providerId) === request) this.#inFlight.delete(providerId);
    }
  }

  async #loadSnapshot(providerId, policy, requestedAt) {
    let providerStatus;
    try {
      providerStatus = await this.#getProviderStatus(providerId);
    } catch {
      providerStatus = undefined;
    }
    const connection = normalizeConnectionStatus(providerStatus);
    const usageUrl = normalizeUsageUrl(providerStatus?.usageUrl, policy.usageUrl);
    const effectivePolicy = { ...policy, usageUrl };
    const updatedAt = new Date(requestedAt).toISOString();
    if (connection !== "connected") return unavailableSnapshot(providerId, effectivePolicy, connection, updatedAt, "credential_unavailable");

    const controller = new AbortController();
    let timeoutHandle;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.#requestTimeoutMs);
    });
    const operation = Promise.resolve()
      .then(() => this.#secretBearingFetcher(requestDescriptor(providerId, policy, providerStatus, controller.signal)))
      .then(async (response) => {
        if (!response || response.ok !== true) return { kind: response?.status === 401 || response?.status === 403 ? "auth_error" : "http_error" };
        try {
          return { kind: "response", payload: await response.json() };
        } catch {
          return { kind: "invalid_json" };
        }
      })
      .catch(() => ({ kind: "request_error" }));
    const result = await Promise.race([operation, timeout]);
    clearTimeout(timeoutHandle);
    if (result.kind !== "response") return unavailableSnapshot(providerId, effectivePolicy, connection, updatedAt, result.kind);

    if (policy.requestMode === "deepseek_balance") {
      const balance = normalizeBalance(result.payload);
      if (balance === null) return unavailableSnapshot(providerId, effectivePolicy, connection, updatedAt, "invalid_response");
      return { ...createBaseSnapshot(providerId, effectivePolicy, connection, updatedAt), availability: "available", balance };
    }
    const quota = policy.requestMode === "openai_rate_limits" ? normalizeOpenAIQuota(result.payload) : normalizeWindsurfQuota(result.payload);
    if (quota === INVALID_QUOTA) return unavailableSnapshot(providerId, effectivePolicy, connection, updatedAt, "invalid_response");
    return {
      ...createBaseSnapshot(providerId, effectivePolicy, connection, updatedAt),
      availability: "available",
      quota,
      ...(quota === null ? { reason: "quota_fields_unavailable" } : {}),
    };
  }
}

export function createAccountUsageService(options) {
  return new AccountUsageService(options);
}
