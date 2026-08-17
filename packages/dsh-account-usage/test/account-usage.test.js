import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_USAGE_CACHE_TTL_MS,
  ACCOUNT_USAGE_REQUEST_DEDUP_MS,
  DEEPSEEK_BALANCE_URL,
  OPENAI_USAGE_URL,
  WINDSURF_USER_STATUS_PATH,
  createAccountUsageService,
} from "../src/index.js";

function jsonResponse(payload, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => payload };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createService({ fetcher, now = 1_700_000_000_000, requestTimeoutMs = 20, getProviderStatus } = {}) {
  let currentTime = now;
  return {
    service: createAccountUsageService({
      secretBearingFetcher: fetcher ?? (async () => jsonResponse({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" }],
      })),
      getProviderStatus: getProviderStatus ?? (async () => ({ connected: true })),
      clock: () => currentTime,
      requestTimeoutMs,
    }),
    advance(milliseconds) { currentTime += milliseconds; },
  };
}

test("DeepSeek delegates authentication to the host and preserves a real zero balance", async () => {
  let descriptor;
  const { service } = createService({
    fetcher: async (request) => {
      descriptor = request;
      return jsonResponse({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" }],
      });
    },
  });
  const snapshot = await service.getSnapshot("deepseek-api-key");
  assert.equal(descriptor.url, DEEPSEEK_BALANCE_URL);
  assert.equal(descriptor.method, "GET");
  assert.equal(Object.hasOwn(descriptor, "apiKey"), false);
  assert.equal(snapshot.availability, "available");
  assert.equal(snapshot.balance[0].totalBalance, "0.00");
});

test("ChatGPT OAuth usage normalizes five-hour and weekly windows", async () => {
  let descriptor;
  const { service } = createService({
    fetcher: async (request) => {
      descriptor = request;
      return jsonResponse({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 88, limit_window_seconds: 18_000, reset_at: 1_700_003_600 },
          secondary_window: { used_percent: 88, limit_window_seconds: 604_800, reset_at: 1_700_604_800 },
        },
      });
    },
  });
  const snapshot = await service.getSnapshot("openai-codex-oauth");
  assert.equal(descriptor.url, OPENAI_USAGE_URL);
  assert.equal(snapshot.availability, "available");
  assert.equal(snapshot.boundary, "authenticated_internal_chatgpt_usage_api");
  assert.equal(snapshot.quota.planName, "plus");
  assert.deepEqual(snapshot.quota.windows.map(({ label, remainingPercent }) => ({ label, remainingPercent })), [
    { label: "5 小时额度", remainingPercent: 12 },
    { label: "周额度", remainingPercent: 12 },
  ]);
});

test("Windsurf quota mode keeps weekly quota and extra balance without discarding the daily field", async () => {
  let descriptor;
  const { service } = createService({
    fetcher: async (request) => {
      descriptor = request;
      return jsonResponse({
        planInfo: { planName: "Max", billingStrategy: "BILLING_STRATEGY_QUOTA" },
        userStatus: { planStatus: {
          planInfo: { planName: "Max", billingStrategy: "BILLING_STRATEGY_QUOTA" },
          dailyQuotaRemainingPercent: 100,
          weeklyQuotaRemainingPercent: 55,
          overageBalanceMicros: 1_670_000,
          dailyQuotaResetAtUnix: 1_700_003_600,
          weeklyQuotaResetAtUnix: 1_700_604_800,
        } },
      });
    },
  });
  const snapshot = await service.getSnapshot("experimental-windsurf-devin");
  assert.equal(new URL(descriptor.url).pathname, WINDSURF_USER_STATUS_PATH);
  assert.match(descriptor.body.metadata.requestId, /^\d+$/);
  assert.equal(snapshot.availability, "available");
  assert.equal(snapshot.boundary, "authenticated_internal_windsurf_user_status_api");
  assert.equal(snapshot.quota.billingMode, "quota");
  assert.equal(snapshot.quota.planName, "Max");
  assert.deepEqual(snapshot.quota.windows.map(({ id, remainingPercent }) => ({ id, remainingPercent })), [
    { id: "daily", remainingPercent: 100 },
    { id: "weekly", remainingPercent: 55 },
  ]);
  assert.equal(snapshot.quota.overageBalanceMicros, 1_670_000);
});

test("Windsurf credit mode derives remaining prompt credits", async () => {
  const { service } = createService({
    fetcher: async () => jsonResponse({
      userStatus: { planStatus: {
        planInfo: { planName: "Pro", billingStrategy: "BILLING_STRATEGY_CREDITS" },
        availablePromptCredits: 50_000,
        usedPromptCredits: 4_700,
      } },
    }),
  });
  const snapshot = await service.getSnapshot("experimental-windsurf-devin");
  assert.equal(snapshot.quota.billingMode, "credits");
  assert.deepEqual(snapshot.quota.credits.prompt, { total: 500, used: 47, remaining: 453 });
});

test("sparse successful payloads remain available without inventing zero quota", async () => {
  const { service } = createService({ fetcher: async () => jsonResponse({ userStatus: {} }) });
  const snapshot = await service.getSnapshot("experimental-windsurf-devin");
  assert.equal(snapshot.connection, "connected");
  assert.equal(snapshot.availability, "available");
  assert.equal(snapshot.quota, null);
  assert.equal(snapshot.reason, "quota_fields_unavailable");
});

test("authentication failures are distinguished without exposing server text", async () => {
  const { service } = createService({ fetcher: async () => jsonResponse({ error: "secret server detail" }, false, 401) });
  const snapshot = await service.getSnapshot("openai-codex-oauth");
  assert.equal(snapshot.availability, "unavailable");
  assert.equal(snapshot.reason, "auth_error");
  assert.equal(JSON.stringify(snapshot).includes("secret server detail"), false);
});

test("snapshots cache for 60 seconds and forced refresh bypasses cached snapshots", async () => {
  let calls = 0;
  const { service, advance } = createService({
    fetcher: async () => {
      calls += 1;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: String(calls), granted_balance: "0", topped_up_balance: String(calls) }] });
    },
  });
  const first = await service.getSnapshot("deepseek-api-key");
  first.balance[0].totalBalance = "mutated";
  advance(ACCOUNT_USAGE_CACHE_TTL_MS - 1);
  assert.equal((await service.getSnapshot("deepseek-api-key")).balance[0].totalBalance, "1");
  advance(1);
  await service.getSnapshot("deepseek-api-key");
  assert.equal(calls, 2);
  advance(ACCOUNT_USAGE_REQUEST_DEDUP_MS - 1);
  await service.getSnapshot("deepseek-api-key", { forceRefresh: true });
  assert.equal(calls, 3);
});

test("concurrent reads share one in-flight request", async () => {
  const pending = deferred();
  let calls = 0;
  const { service } = createService({ fetcher: async () => { calls += 1; return pending.promise; } });
  const first = service.getSnapshot("deepseek-api-key");
  const second = service.getSnapshot("deepseek-api-key");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  pending.resolve(jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "2", granted_balance: "0", topped_up_balance: "2" }] }));
  assert.deepEqual(await first, await second);
});

test("timeouts, malformed payloads, and disconnected credentials fail closed", async () => {
  const timeout = createService({ fetcher: async () => new Promise(() => {}), requestTimeoutMs: 5 });
  const malformed = createService({ fetcher: async () => jsonResponse({ rate_limit: { primary_window: { used_percent: "bad" } } }) });
  const disconnected = createService({
    fetcher: async () => { throw new Error("must not run"); },
    getProviderStatus: async () => ({ connected: false }),
  });
  assert.equal((await timeout.service.getSnapshot("deepseek-api-key")).reason, "timeout");
  assert.equal((await malformed.service.getSnapshot("openai-codex-oauth")).reason, "invalid_response");
  assert.equal((await disconnected.service.getSnapshot("experimental-windsurf-devin")).reason, "credential_unavailable");
});

test("the timeout cannot exceed the concurrent deduplication boundary", () => {
  assert.throws(() => createAccountUsageService({
    secretBearingFetcher: async () => jsonResponse({}),
    getProviderStatus: async () => ({ connected: true }),
    requestTimeoutMs: ACCOUNT_USAGE_REQUEST_DEDUP_MS + 1,
  }), /requestTimeoutMs/);
});
