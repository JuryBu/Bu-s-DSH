import assert from "node:assert/strict";
import test from "node:test";

import { ACCOUNT_USAGE_PROVIDERS, applyWithDependencies } from "../src/plugin.js";

function createResponse() {
  return {
    status: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers }; },
    end(body) { this.body = body ?? ""; },
  };
}

function createContext() {
  const routes = [];
  return {
    routes,
    webServer: { register(route) { routes.push(route); return () => {}; } },
    effect(callback) { return callback(); },
    logger: { info() {} },
  };
}

function localRequest(path, overrides = {}) {
  return {
    method: "GET",
    url: path,
    headers: { origin: "http://127.0.0.1:3119", "sec-fetch-site": "same-origin" },
    socket: { remoteAddress: "127.0.0.1", localPort: 3119 },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    resolveDeepSeekCredential: async () => undefined,
    readOpenAICredential: async () => undefined,
    readWindsurfStatus: async () => ({ connected: false }),
    readWindsurfCredential: async () => undefined,
    ...overrides,
  };
}

test("the plugin registers one local read-only route for each provider", () => {
  const context = createContext();
  applyWithDependencies(context, dependencies());
  assert.deepEqual(context.routes.map((route) => route.path), ACCOUNT_USAGE_PROVIDERS.map((providerId) => `/account-usage/${providerId}`));
});

test("DeepSeek secrets only appear in the outbound Authorization header", async () => {
  const context = createContext();
  const secret = "deepseek-secret-that-must-not-leak";
  let outboundAuthorization;
  applyWithDependencies(context, dependencies({
    fetchImpl: async (_url, options) => {
      outboundAuthorization = options.headers.authorization;
      return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.34", granted_balance: "2.34", topped_up_balance: "10.00" }] }) };
    },
    resolveDeepSeekCredential: async () => secret,
  }));
  const route = context.routes.find((entry) => entry.path.endsWith("deepseek-api-key"));
  const response = createResponse();
  await route.handler(localRequest(route.path), response);
  assert.equal(outboundAuthorization, `Bearer ${secret}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.includes(secret), false);
  assert.equal(JSON.parse(response.body).snapshot.balance[0].totalBalance, "12.34");
});

test("ChatGPT usage attaches OAuth and account headers without returning credentials", async () => {
  const context = createContext();
  let outbound;
  applyWithDependencies(context, dependencies({
    readOpenAICredential: async () => ({ type: "oauth", access: "chatgpt-secret", accountId: "account-123" }),
    fetchImpl: async (url, options) => {
      outbound = { url, options };
      return { ok: true, status: 200, json: async () => ({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 88, limit_window_seconds: 18_000 } } }) };
    },
  }));
  const route = context.routes.find((entry) => entry.path.endsWith("openai-codex-oauth"));
  const response = createResponse();
  await route.handler(localRequest(route.path), response);
  assert.equal(outbound.options.headers.authorization, "Bearer chatgpt-secret");
  assert.equal(outbound.options.headers["chatgpt-account-id"], "account-123");
  assert.equal(response.body.includes("chatgpt-secret"), false);
  assert.equal(JSON.parse(response.body).snapshot.quota.windows[0].remainingPercent, 12);
});

test("Windsurf usage sends the API key only inside the authenticated status request", async () => {
  const context = createContext();
  const secret = "windsurf-secret-that-must-not-leak";
  let outbound;
  applyWithDependencies(context, dependencies({
    readWindsurfStatus: async () => ({ connected: true }),
    readWindsurfCredential: async () => ({ apiKey: secret, apiServerUrl: "https://server.example.test" }),
    fetchImpl: async (url, options) => {
      outbound = { url, options };
      return { ok: true, status: 200, json: async () => ({ userStatus: { planStatus: { planInfo: { planName: "Max", billingStrategy: "BILLING_STRATEGY_QUOTA" }, weeklyQuotaRemainingPercent: 55, overageBalanceMicros: 1_670_000 } } }) };
    },
  }));
  const route = context.routes.find((entry) => entry.path.endsWith("experimental-windsurf-devin"));
  const response = createResponse();
  await route.handler(localRequest(route.path), response);
  assert.match(outbound.url, /^https:\/\/server\.example\.test\//);
  assert.equal(JSON.parse(outbound.options.body).metadata.apiKey, secret);
  assert.equal(response.body.includes(secret), false);
  assert.equal(JSON.parse(response.body).snapshot.quota.windows[0].remainingPercent, 55);
});

test("non-local, cross-site, and non-GET requests are rejected before credential reads", async () => {
  for (const request of [
    localRequest("/account-usage/deepseek-api-key", { socket: { remoteAddress: "192.0.2.10", localPort: 3119 } }),
    localRequest("/account-usage/deepseek-api-key", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
    localRequest("/account-usage/deepseek-api-key", { method: "POST" }),
  ]) {
    const context = createContext();
    let reads = 0;
    applyWithDependencies(context, dependencies({
      resolveDeepSeekCredential: async () => { reads += 1; return "secret"; },
      readOpenAICredential: async () => { reads += 1; return {}; },
      readWindsurfStatus: async () => { reads += 1; return { connected: true }; },
      readWindsurfCredential: async () => { reads += 1; return {}; },
    }));
    const response = createResponse();
    await context.routes[0].handler(request, response);
    assert.equal(reads, 0);
    assert.equal(response.status, request.method === "POST" ? 405 : 403);
  }
});
