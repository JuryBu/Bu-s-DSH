import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG,
  ExperimentalFeatureGate,
  InMemoryFakeCredentialStore,
  WindowsDpapiCurrentUserCredentialStore,
  createExperimentalWindsurfDevinProvider
} from "../src/index.js";

const fixedClock = () => new Date("2026-08-14T12:35:00.000Z");

function enabledGate() {
  return new ExperimentalFeatureGate({ enabled: true, communityRiskAccepted: true });
}

test("候选插件默认配置保持关闭并明确选择 OAuth", () => {
  assert.deepEqual(DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG, {
    enabled: false,
    communityRiskAccepted: false,
    authenticationMode: "browser_oauth",
    credentialId: "experimental-windsurf-devin-provider"
  });
  assert.equal(Object.isFrozen(DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG), true);
  const provider = createExperimentalWindsurfDevinProvider();
  assert.equal(provider.authenticationMode, "browser_oauth");
  assert.throws(() => { provider.authenticationMode = "manual_api_key"; }, TypeError);
});

test("OAuth 与 API Key 的凭据记录 ID 必须不同", () => {
  assert.throws(
    () => createExperimentalWindsurfDevinProvider({
      credentialIds: { browserOAuth: "same-record", manualApiKey: "same-record" }
    }),
    (error) => error?.code === "credential_ids_must_be_distinct"
  );
});

function fakeCatalog(models = [{ modelUid: "swe-1", label: "SWE 1", disabled: false }]) {
  const requests = [];
  return {
    requests,
    source: {
      async fetch(request) {
        requests.push(request);
        return {
          source: "fake-get-cascade-model-configs",
          observedAt: "2026-08-14T12:35:00.000Z",
          models
        };
      }
    }
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

test("默认关闭时不会读取凭据或调用网络适配器", async () => {
  const store = new InMemoryFakeCredentialStore();
  const catalog = fakeCatalog();
  const provider = createExperimentalWindsurfDevinProvider({
    credentialStore: store,
    catalogSource: catalog.source,
    transport: { stream() { throw new Error("should not run"); } },
    clock: fixedClock
  });

  const status = await provider.getStatus();
  const events = await collect(provider.stream({ modelUid: "swe-1" }));

  assert.equal(status.experimental.enabled, false);
  assert.equal(status.authentication.mode, "not_checked");
  assert.deepEqual(events, [{ type: "error", code: "experimental_disabled" }]);
  assert.equal(catalog.requests.length, 0);
});

test("DPAPI 适配器拒绝非 CurrentUser 范围的宿主桥", () => {
  assert.throws(
    () => new WindowsDpapiCurrentUserCredentialStore({
      encryptedRecordStore: {
        async read() {},
        async write() {},
        async remove() {}
      },
      currentUserProtector: {
        scope: "LocalMachine",
        async protectCurrentUser() { return new Uint8Array(); },
        async unprotectCurrentUser() { return new Uint8Array(); }
      }
    }),
    (error) => error?.code === "dpapi_scope_must_be_current_user"
  );
});

test("OAuth 与手动 API Key 独立保存且重复 OAuth 必须再次拉起浏览器", async () => {
  const store = new InMemoryFakeCredentialStore();
  const openedUrls = [];
  const catalog = fakeCatalog();
  let beginCount = 0;
  let completeCount = 0;
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    catalogSource: catalog.source,
    oauthFlow: {
      async begin({ state }) {
        beginCount += 1;
        const redirectUri = "http://127.0.0.1:45671/oauth/callback";
        const authorizationUrl = new URL("https://example.invalid/authorize");
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.set("redirect_uri", redirectUri);
        return { authorizationUrl: authorizationUrl.href, transactionId: `fake-transaction-${beginCount}`, redirectUri };
      },
      async complete({ transactionId, redirectUri }) {
        completeCount += 1;
        assert.equal(transactionId, `fake-transaction-${completeCount}`);
        assert.equal(redirectUri, "http://127.0.0.1:45671/oauth/callback");
        return { apiKey: `fake-oauth-key-${completeCount}`, expiresAt: "2026-08-15T12:35:00.000Z" };
      }
    },
    clock: fixedClock
  });

  const manualSummary = await provider.manualApiKey.save({ apiKey: "fake-manual-key" });
  let oauthSummary;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = await provider.browserOAuth.start({ async openBrowser(url) { openedUrls.push(url); } });
    const oauthState = new URL(started.authorizationUrl).searchParams.get("state");
    oauthSummary = await provider.browserOAuth.complete({
      transactionId: started.transactionId,
      callbackParameters: { code: `fake-code-${attempt}`, state: oauthState }
    });
  }
  await provider.refreshModels();
  const status = await provider.getStatus();

  assert.equal(openedUrls.length, 2);
  assert.equal(new URL(openedUrls[0]).origin, "https://example.invalid");
  assert.equal(oauthSummary.mode, "browser_oauth");
  assert.equal(manualSummary.mode, "manual_api_key");
  assert.equal(status.authentication.selectedMode, "browser_oauth");
  assert.equal(status.authentication.mode, "browser_oauth");
  assert.equal(status.authentication.methods.browser_oauth.configured, true);
  assert.equal(status.authentication.methods.manual_api_key.configured, true);
  assert.equal(catalog.requests[0].apiKey, "fake-oauth-key-2");
});

test("目录能力必须同时经过 Windsurf 图片附件模型表，能力未知时保守为文本", async () => {
  const store = new InMemoryFakeCredentialStore();
  const catalog = fakeCatalog([
    { modelUid: "gemini-3-1-pro-high", label: "Gemini 3.1 Pro High", disabled: false },
    { modelUid: "grok-4-5", label: "Grok 4.5", disabled: false },
    { modelUid: "unknown-static", label: "Unknown Static" },
    { modelUid: "disabled", label: "Disabled", disabled: true }
  ]);
  const featureGate = enabledGate();
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate,
    credentialStore: store,
    authenticationMode: "manual_api_key",
    catalogSource: catalog.source,
    capabilityResolver: {
      async resolve({ modelUid }) {
        if (modelUid === "gemini-3-1-pro-high" || modelUid === "grok-4-5") {
          return {
            authority: "realtime",
            observedAt: "2026-08-14T12:35:01.000Z",
            contextWindowTokens: 128000,
            supportsVision: true,
            reasoningLevels: ["low", "high"]
          };
        }

        return {
          authority: "static",
          contextWindowTokens: 1000000,
          supportsVision: true,
          reasoningLevels: ["max"]
        };
      }
    },
    clock: fixedClock
  });

  await provider.manualApiKey.save({ apiKey: "fake-catalog-key" });
  const models = await provider.refreshModels();
  const live = models.find((model) => model.modelUid === "gemini-3-1-pro-high");
  const grok = models.find((model) => model.modelUid === "grok-4-5");
  const unknown = models.find((model) => model.modelUid === "unknown-static");
  const disabled = models.find((model) => model.modelUid === "disabled");

  assert.equal(catalog.requests[0].apiKey, "fake-catalog-key");
  assert.deepEqual(live.input, ["text", "image"]);
  assert.equal(live.contextWindowTokens, 128000);
  assert.deepEqual(live.reasoningLevels, ["off", "low", "high"]);
  assert.equal(live.source.capabilityAuthority, "realtime");
  assert.deepEqual(grok.input, ["text"]);
  assert.equal(grok.source.capabilityAuthority, "realtime");
  assert.deepEqual(unknown.input, ["text"]);
  assert.equal(unknown.contextWindowTokens, null);
  assert.deepEqual(unknown.reasoningLevels, ["off"]);
  assert.equal(unknown.source.capabilityAuthority, "unknown");
  assert.equal(unknown.availability, "unknown");
  assert.equal(disabled.availability, "unavailable");
  featureGate.enabled = false;
  assert.deepEqual(provider.listModels(), []);
});

test("稀疏实时目录不会覆盖文档兜底模型", async () => {
  const store = new InMemoryFakeCredentialStore();
  const catalog = fakeCatalog([
    { modelUid: "swe-1-6", label: "SWE-1.6", disabled: false }
  ]);
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    authenticationMode: "manual_api_key",
    catalogSource: catalog.source,
    clock: fixedClock
  });

  await provider.manualApiKey.save({ apiKey: "fake-sparse-catalog-key" });
  await provider.refreshModels();
  const ids = provider.listModels().map((model) => model.modelUid);
  for (const id of [
    "swe-1-6",
    "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM",
    "claude-opus-4-6-thinking-1m",
    "MODEL_GPT_5_2_XHIGH_PRIORITY",
    "swe-1-7-lightning-medium"
  ]) {
    assert.ok(ids.includes(id), id);
  }
});

test("每次流调用都重新解析凭据并显式传给 transport", async () => {
  const store = new InMemoryFakeCredentialStore();
  const catalog = fakeCatalog();
  const requests = [];
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    authenticationMode: "manual_api_key",
    catalogSource: catalog.source,
    transport: {
      async *stream(request) {
        requests.push(request);
        yield { type: "text_delta", text: "hello" };
        yield { type: "reasoning_delta", text: "plan" };
        yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 7, outputTokens: 3 } };
      }
    },
    clock: fixedClock
  });

  await provider.manualApiKey.save({ apiKey: "fake-stream-key" });
  await provider.refreshModels();
  const events = await collect(provider.stream({ modelUid: "swe-1", messages: [{ role: "user", content: "test" }] }));
  await provider.manualApiKey.save({ apiKey: "fake-rotated-stream-key" });
  const rotatedEvents = await collect(provider.stream({ modelUid: "swe-1", messages: [{ role: "user", content: "test" }] }));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].apiKey, "fake-stream-key");
  assert.equal(requests[1].apiKey, "fake-rotated-stream-key");
  assert.equal(requests[0].modelUid, "swe-1");
  assert.equal(requests[1].modelUid, "swe-1");
  assert.deepEqual(events, [
    { type: "start", providerId: "experimental-windsurf-devin", modelUid: "swe-1" },
    { type: "delta", channel: "text", text: "hello" },
    { type: "delta", channel: "reasoning", text: "plan" },
    { type: "usage", inputTokens: 7, outputTokens: 3 },
    { type: "done", reason: "stop", usage: { inputTokens: 7, outputTokens: 3 } }
  ]);
  assert.deepEqual(rotatedEvents, events);
});

test("没有终止事件的上游流明确失败，不伪造成成功", async () => {
  const store = new InMemoryFakeCredentialStore();
  const catalog = fakeCatalog();
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    authenticationMode: "manual_api_key",
    catalogSource: catalog.source,
    transport: {
      async *stream() {
        yield { type: "text_delta", text: "partial" };
      }
    },
    clock: fixedClock
  });

  await provider.manualApiKey.save({ apiKey: "fake-incomplete-stream-key" });
  await provider.refreshModels();
  const events = await collect(provider.stream({ modelUid: "swe-1" }));

  assert.deepEqual(events.at(-1), { type: "error", code: "missing_terminal_event" });
});
