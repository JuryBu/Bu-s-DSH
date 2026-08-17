import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

process.env.DSH_OAUTH_BROWSER = "none";
const credentialTestRoot = await mkdtemp(join(tmpdir(), "dsh-oauth-test-"));
process.env.DSH_OAUTH_STORE_PATH = join(credentialTestRoot, "openai-codex-oauth.dpapi");

const { apply } = await import("../lib/index.js");
const {
  oauthStorePath,
  openAICodexCredentialStore,
  openAICodexProviderId,
} = await import("../lib/store.js");
const {
  createOpenAICodexCatalogClient,
  mergeOpenAICodexCatalogModels,
} = await import("../lib/catalog.js");

after(async () => {
  await rm(credentialTestRoot, { recursive: true, force: true });
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.DSH_RUNTIME_ROOT
  ?? resolve(process.env.LOCALAPPDATA ?? packageRoot, "DeepSeekHarness");
const candidateRelease = process.env.DSH_TEST_CANDIDATE_RELEASE
  ?? resolve(runtimeRoot, "app", "releases", "0.1.0-rc.6-oauth");
const originalRelease = process.env.DSH_TEST_ORIGINAL_RELEASE
  ?? resolve(runtimeRoot, "app", "releases", "0.1.0-rc.6");

function createRequest(method, origin = "http://127.0.0.1:3081") {
  return {
    method,
    headers: origin === null ? {} : { origin },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function createResponse() {
  return {
    headers: {},
    statusCode: undefined,
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(body = "") {
      this.body = String(body);
    },
  };
}

async function bindAndCloseCallbackPort() {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(1455, "127.0.0.1", () => server.close(resolve));
  });
}

function registerRoutes() {
  const routes = [];
  let cleanup = () => {};
  apply({
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    logger: { info() {} },
    effect(callback) {
      cleanup = callback();
    },
  });
  return {
    cleanup,
    route(path) {
      const route = routes.find((candidate) => candidate.path === path);
      assert.ok(route, `route ${path} should be registered`);
      return route;
    },
  };
}

test("DPAPI credential store round-trips without plaintext", async () => {
  const credential = {
    type: "oauth",
    access: "test-access-token",
    refresh: "test-refresh-token",
    expires: Date.now() + 60_000,
    accountId: "test-account",
  };
  await openAICodexCredentialStore.modify(openAICodexProviderId, () => credential);
  assert.deepEqual(await openAICodexCredentialStore.read(openAICodexProviderId), credential);
  const encrypted = await readFile(oauthStorePath, "utf8");
  assert.match(encrypted, /^DSH-OAUTH-DPAPI-V1\n/);
  assert.equal(encrypted.includes(credential.access), false);
  assert.equal(encrypted.includes(credential.refresh), false);
  await openAICodexCredentialStore.delete(openAICodexProviderId);
  assert.equal(await openAICodexCredentialStore.read(openAICodexProviderId), undefined);
});

test("native DeepSeek API-key adapter and onboarding remain present", async () => {
  const nativeAdapterPath = "node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js";
  const originalAdapter = await readFile(resolve(originalRelease, nativeAdapterPath));
  const candidateAdapter = await readFile(resolve(candidateRelease, nativeAdapterPath));
  assert.deepEqual(candidateAdapter, originalAdapter);

  const composition = await readFile(resolve(candidateRelease, "node_modules/@deepseek-ai/dsh-base/cordis.patch.yml"), "utf8");
  assert.match(composition, /- id: llm-deepseek\s+name: '@deepseek-ai\/dsh-llm-deepseek'/);
  assert.match(composition, /openai-codex:\s+displayName: OpenAI Codex \(ChatGPT Plus\/Pro\)/);

  const settingsClient = await readFile(resolve(candidateRelease, "node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js"), "utf8");
  assert.match(settingsClient, /provider === "deepseek-official"/);
  assert.match(settingsClient, /添加一个 API Key 开始使用/);
  assert.match(settingsClient, /Enter the API key, or leave the field empty/);
  assert.match(settingsClient, /row\.entry\.provider !== "openai-codex"/);
  assert.match(settingsClient, /可使用 ChatGPT 订阅登录，也可填写其他提供方的 API 密钥/);
  assert.match(settingsClient, /started\.browserOpened !== true/);
});

test("localhost callback exchanges a code and stores an encrypted OAuth credential", async () => {
  const registry = registerRoutes();
  const originalFetch = globalThis.fetch;
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "callback-test-account" },
    })).toString("base64url"),
    "test-signature",
  ].join(".");
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://auth.openai.com/oauth/token");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body?.get("grant_type"), "authorization_code");
    assert.equal(init?.body?.get("code"), "callback-test-code");
    return new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: "fixture-refresh",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const login = createResponse();
    await registry.route("/oauth/openai-codex/login").handler(createRequest("POST"), login);
    const loginBody = JSON.parse(login.body);
    assert.equal(loginBody.browserOpened, false);
    assert.equal(loginBody.browser, "disabled");
    const authorizationUrl = new URL(loginBody.url);
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);

    const callback = await originalFetch(`http://127.0.0.1:1455/auth/callback?code=callback-test-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /authentication completed/i);

    let statusBody;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = createResponse();
      await registry.route("/oauth/openai-codex/status").handler(createRequest("GET"), status);
      statusBody = JSON.parse(status.body);
      if (statusBody.connected) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(statusBody.connected, true);
    assert.equal(statusBody.state, "connected");
    const stored = await openAICodexCredentialStore.read(openAICodexProviderId);
    assert.equal(stored.accountId, "callback-test-account");
    const encrypted = await readFile(oauthStorePath, "utf8");
    assert.equal(encrypted.includes(accessToken), false);
    assert.equal(encrypted.includes("callback-test-refresh"), false);

    const logout = createResponse();
    await registry.route("/oauth/openai-codex/logout").handler(createRequest("POST"), logout);
    assert.equal(logout.statusCode, 200);
    await bindAndCloseCallbackPort();
  } finally {
    globalThis.fetch = originalFetch;
    await openAICodexCredentialStore.delete(openAICodexProviderId);
    registry.cleanup();
  }
});

test("local OAuth routes enforce origin and cleanly cancel login", async () => {
  const registry = registerRoutes();
  try {
    const denied = createResponse();
    await registry.route("/oauth/openai-codex/status").handler(createRequest("GET", "https://example.com"), denied);
    assert.equal(denied.statusCode, 403);

    const wrongMethod = createResponse();
    await registry.route("/oauth/openai-codex/login").handler(createRequest("GET"), wrongMethod);
    assert.equal(wrongMethod.statusCode, 405);

    const login = createResponse();
    await registry.route("/oauth/openai-codex/login").handler(createRequest("POST"), login);
    assert.equal(login.statusCode, 202);
    const loginBody = JSON.parse(login.body);
    assert.equal(loginBody.ok, true);
    const authorizationUrl = new URL(loginBody.url);
    assert.equal(authorizationUrl.protocol, "https:");
    assert.equal(authorizationUrl.hostname, "auth.openai.com");
    assert.equal(authorizationUrl.pathname, "/oauth/authorize");

    const logout = createResponse();
    await registry.route("/oauth/openai-codex/logout").handler(createRequest("POST"), logout);
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(JSON.parse(logout.body), { ok: true });
    await bindAndCloseCallbackPort();
  } finally {
    registry.cleanup();
  }
});

test("account model catalog uses remote capabilities, ETag cache, and no tokens on disk", async () => {
  const filename = join(credentialTestRoot, "openai-codex-models.json");
  let requests = 0;
  let currentTime = 1_000_000;
  const client = createOpenAICodexCatalogClient({
    filename,
    now: () => currentTime,
    ttlMs: 1_000,
    clientVersion: "0.146.0-test",
    resolveAuth: async () => ({ accessToken: "catalog-secret", accountId: "catalog-account" }),
    fetchImpl: async (input, init) => {
      requests += 1;
      assert.equal(String(input), "https://chatgpt.com/backend-api/codex/models?client_version=0.146.0-test");
      assert.equal(init.headers.authorization, "Bearer catalog-secret");
      assert.equal(init.headers["chatgpt-account-id"], "catalog-account");
      if (requests === 2) {
        assert.equal(init.headers["if-none-match"], 'W/"catalog-v1"');
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
            service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
            additional_speed_tiers: ["fast"],
            input_modalities: ["text", "image"],
            context_window: 272000,
            visibility: "list",
            supported_in_api: true,
          },
          {
            slug: "gpt-5.4-mini",
            display_name: "GPT-5.4-Mini",
            supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })),
            service_tiers: [],
            input_modalities: ["text", "image"],
            context_window: 272000,
            visibility: "list",
            supported_in_api: true,
          },
        ],
      }), { status: 200, headers: { etag: 'W/"catalog-v1"', "content-type": "application/json" } });
    },
  });

  const first = await client.load();
  assert.equal(first.source, "network");
  assert.equal(first.models[0].reasoningEfforts.at(-1), "ultra");
  assert.equal(first.models[0].serviceTiers[0].id, "priority");
  assert.equal((await client.load()).source, "cache-fresh");
  assert.equal(requests, 1);
  currentTime += 1_001;
  assert.equal((await client.load()).source, "network-not-modified");
  assert.equal(requests, 2);
  const persisted = await readFile(filename, "utf8");
  assert.equal(persisted.includes("catalog-secret"), false);
  assert.equal(persisted.includes("catalog-account"), false);

  const restarted = createOpenAICodexCatalogClient({
    filename,
    now: () => currentTime,
    ttlMs: 1_000,
    resolveAuth: async () => undefined,
  });
  const restored = await restarted.load();
  assert.equal(restored.source, "cache-no-auth");
  assert.deepEqual(restored.models[0].reasoningEfforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(restored.models[0].serviceTiers[0].id, "priority");
  assert.deepEqual(restored.models[0].inputModalities, ["text", "image"]);
  assert.equal(restored.models[0].contextWindow, 272000);

  const baseline = [
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      thinkingLevelMap: {},
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 128000,
    },
    {
      id: "gpt-5.4-mini",
      name: "GPT-5.4-Mini",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      thinkingLevelMap: {},
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 128000,
    },
  ];
  const merged = mergeOpenAICodexCatalogModels(baseline, first);
  assert.deepEqual(merged[0].stardustReasoningEfforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(merged[0].stardustServiceTiers[0].id, "priority");
  assert.equal(merged[1].stardustServiceTiers.length, 0);
  assert.equal(merged[1].thinkingLevelMap.minimal, null);
});
