import assert from "node:assert/strict";
import test from "node:test";

import {
  ExperimentalFeatureGate,
  InMemoryFakeCredentialStore,
  WindowsDpapiCurrentUserCredentialStore,
  createExperimentalWindsurfDevinProvider
} from "../src/index.js";

function enabledGate() {
  return new ExperimentalFeatureGate({ enabled: true, communityRiskAccepted: true });
}

function authorizationStart(state, {
  transactionId = "fake-transaction",
  redirectUri = "http://127.0.0.1:45672/oauth/callback"
} = {}) {
  const authorizationUrl = new URL("https://example.invalid/authorize");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  return { authorizationUrl: authorizationUrl.href, transactionId, redirectUri };
}

function fakeCatalog() {
  return {
    async fetch() {
      return {
        source: "fake-get-cascade-model-configs",
        observedAt: "2026-08-14T12:35:00.000Z",
        models: [{ modelUid: "swe-1", label: "SWE 1", disabled: false }]
      };
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

test("默认关闭阻止状态检查、认证、目录和流读取凭据", async () => {
  const counters = { read: 0, write: 0, remove: 0, catalog: 0, transport: 0 };
  const provider = createExperimentalWindsurfDevinProvider({
    credentialStore: {
      async read() { counters.read += 1; throw new Error("must not read"); },
      async write() { counters.write += 1; },
      async remove() { counters.remove += 1; }
    },
    oauthFlow: {
      async begin() { throw new Error("must not begin"); },
      async complete() { throw new Error("must not complete"); }
    },
    catalogSource: {
      async fetch() { counters.catalog += 1; throw new Error("must not fetch"); }
    },
    transport: {
      stream() { counters.transport += 1; throw new Error("must not stream"); }
    }
  });

  await provider.getStatus();
  await assert.rejects(provider.manualApiKey.save({ apiKey: "fake-disabled-key" }), (error) => error?.code === "experimental_disabled");
  await assert.rejects(provider.browserOAuth.start({ openBrowser: async () => {} }), (error) => error?.code === "experimental_disabled");
  await assert.rejects(provider.refreshModels(), (error) => error?.code === "experimental_disabled");
  assert.deepEqual(await collect(provider.stream({ modelUid: "swe-1" })), [{ type: "error", code: "experimental_disabled" }]);
  assert.deepEqual(counters, { read: 0, write: 0, remove: 0, catalog: 0, transport: 0 });
});

test("OAuth 只接受随机 state 绑定的 HTTPS 授权页和精确 loopback 回调", async () => {
  const store = new InMemoryFakeCredentialStore();
  let observedState;
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    oauthFlow: {
      async begin({ state }) {
        observedState = state;
        return authorizationStart(state);
      },
      async complete({ callbackParameters, redirectUri }) {
        assert.equal(callbackParameters.state, observedState);
        assert.equal(redirectUri, "http://127.0.0.1:45672/oauth/callback");
        return { apiKey: "fake-oauth-security-key" };
      }
    },
    clock: () => new Date("2026-08-14T12:35:00.000Z")
  });

  const started = await provider.browserOAuth.start({ openBrowser: async () => {} });
  assert.match(observedState, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(new URL(started.authorizationUrl).searchParams.get("state"), observedState);
  const summary = await provider.browserOAuth.complete({
    transactionId: started.transactionId,
    callbackParameters: { code: "fake-code", state: observedState }
  });
  assert.equal(summary.mode, "browser_oauth");
});

test("OAuth state 不匹配时一次性废弃事务且不写凭据", async () => {
  const store = new InMemoryFakeCredentialStore();
  let cancelledTransaction;
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    oauthFlow: {
      async begin({ state }) { return authorizationStart(state); },
      async complete() { throw new Error("must not complete"); },
      async cancel({ transactionId }) { cancelledTransaction = transactionId; }
    },
    clock: () => new Date("2026-08-14T12:35:00.000Z")
  });

  const started = await provider.browserOAuth.start({ openBrowser: async () => {} });
  await assert.rejects(
    provider.browserOAuth.complete({ transactionId: started.transactionId, callbackParameters: { state: "wrong-state" } }),
    (error) => error?.code === "oauth_state_mismatch"
  );
  assert.equal(cancelledTransaction, started.transactionId);
  await assert.rejects(
    provider.browserOAuth.complete({ transactionId: started.transactionId, callbackParameters: { state: "wrong-state" } }),
    (error) => error?.code === "oauth_transaction_not_found"
  );
  assert.equal((await provider.getStatus()).authentication.configured, false);
});

test("OAuth 调用方在 begin 微任务前取消时不会漏掉信号或启动事务", async () => {
  let beginCalls = 0;
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: new InMemoryFakeCredentialStore(),
    oauthFlow: {
      async begin() {
        beginCalls += 1;
        return new Promise(() => {});
      }
    }
  });
  const controller = new AbortController();
  const started = provider.browserOAuth.start({ openBrowser: async () => {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(started, (error) => error?.code === "aborted");
  assert.equal(beginCalls, 0);
});

test("OAuth 拒绝 localhost 别名并支持显式取消", async () => {
  const rejectedProvider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: new InMemoryFakeCredentialStore(),
    oauthFlow: {
      async begin({ state }) {
        return authorizationStart(state, { redirectUri: "http://localhost:45673/oauth/callback" });
      }
    }
  });
  await assert.rejects(
    rejectedProvider.browserOAuth.start({ openBrowser: async () => {} }),
    (error) => error?.code === "oauth_redirect_must_be_loopback"
  );

  let cancelledTransaction;
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: new InMemoryFakeCredentialStore(),
    oauthFlow: {
      async begin({ state }) { return authorizationStart(state, { transactionId: "cancel-me" }); },
      async cancel({ transactionId }) { cancelledTransaction = transactionId; }
    }
  });
  const started = await provider.browserOAuth.start({ openBrowser: async () => {} });
  assert.equal(await provider.browserOAuth.cancel({ transactionId: started.transactionId }), true);
  assert.equal(cancelledTransaction, "cancel-me");
  assert.equal(await provider.browserOAuth.cancel({ transactionId: started.transactionId }), false);
});

test("OAuth begin 卡住时由本地超时终止且错误不泄露底层文本", async () => {
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: new InMemoryFakeCredentialStore(),
    oauthFlow: {
      async begin() { return new Promise(() => {}); }
    },
    oauthTimeoutMs: 10
  });
  await assert.rejects(
    provider.browserOAuth.start({ openBrowser: async () => {} }),
    (error) => error?.code === "oauth_start_timeout" && error.message === "oauth_start_timeout"
  );
});

test("认证入口独立保存并只清除自己的凭据", async () => {
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: new InMemoryFakeCredentialStore(),
    authenticationMode: "manual_api_key",
    oauthFlow: {
      async begin({ state }) { return authorizationStart(state); },
      async complete() { return { apiKey: "fake-oauth-clear-key" }; }
    }
  });

  await provider.manualApiKey.save({ apiKey: "fake-manual-clear-key" });
  const started = await provider.browserOAuth.start({ openBrowser: async () => {} });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  await provider.browserOAuth.complete({
    transactionId: started.transactionId,
    callbackParameters: { code: "fake-code", state }
  });
  let status = await provider.getStatus();
  assert.equal(status.authentication.methods.browser_oauth.configured, true);
  assert.equal(status.authentication.methods.manual_api_key.configured, true);
  assert.equal(await provider.browserOAuth.clear(), true);
  status = await provider.getStatus();
  assert.equal(status.authentication.methods.browser_oauth.configured, false);
  assert.equal(status.authentication.methods.manual_api_key.configured, true);
  assert.equal(status.authentication.mode, "manual_api_key");
  assert.equal(await provider.manualApiKey.clear(), true);
  assert.equal((await provider.getStatus()).authentication.configured, false);
});

test("DPAPI CurrentUser 抽象只把密文交给记录库并可清零明文缓冲", async () => {
  const records = new Map();
  let protectedPlaintext;
  let unprotectedPlaintext;
  const store = new WindowsDpapiCurrentUserCredentialStore({
    encryptedRecordStore: {
      async read(id) { return records.get(id); },
      async write(id, payload) { records.set(id, payload); },
      async remove(id) { records.delete(id); }
    },
    currentUserProtector: {
      scope: "CurrentUser",
      async protectCurrentUser(plaintext) {
        protectedPlaintext = plaintext;
        return Uint8Array.from(plaintext, (value) => value ^ 0xa5);
      },
      async unprotectCurrentUser(encryptedPayload) {
        unprotectedPlaintext = Uint8Array.from(encryptedPayload, (value) => value ^ 0xa5);
        return unprotectedPlaintext;
      }
    }
  });

  await store.write("fake-record", {
    kind: "manual_api_key",
    apiKey: "fake-dpapi-roundtrip-key",
    createdAt: "2026-08-14T12:35:00.000Z"
  });
  const ciphertext = records.get("fake-record");
  assert.equal(new TextDecoder().decode(ciphertext).includes("fake-dpapi-roundtrip-key"), false);
  assert.equal(protectedPlaintext.every((value) => value === 0), true);
  assert.equal((await store.read("fake-record")).apiKey, "fake-dpapi-roundtrip-key");
  assert.equal(unprotectedPlaintext.every((value) => value === 0), true);
  await store.remove("fake-record");
  assert.equal(records.has("fake-record"), false);
});

test("DPAPI CurrentUser 抽象拒绝密文复用明文缓冲", async () => {
  const store = new WindowsDpapiCurrentUserCredentialStore({
    encryptedRecordStore: {
      async read() {},
      async write() { throw new Error("must not persist"); },
      async remove() {}
    },
    currentUserProtector: {
      scope: "CurrentUser",
      async protectCurrentUser(plaintext) { return plaintext; },
      async unprotectCurrentUser() { return new Uint8Array(); }
    }
  });

  await assert.rejects(
    store.write("fake-alias-record", {
      kind: "manual_api_key",
      apiKey: "fake-alias-key",
      createdAt: "2026-08-14T12:35:00.000Z"
    }),
    (error) => error?.code === "dpapi_ciphertext_must_not_alias_plaintext"
  );
});

test("过期凭据不能刷新目录或进入流请求", async () => {
  let now = new Date("2026-08-14T12:35:00.000Z");
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: new InMemoryFakeCredentialStore(),
    authenticationMode: "manual_api_key",
    catalogSource: fakeCatalog(),
    transport: {
      async *stream() { throw new Error("must not stream"); }
    },
    clock: () => now
  });
  await provider.manualApiKey.save({
    apiKey: "fake-expiring-key",
    expiresAt: "2026-08-14T12:36:00.000Z"
  });
  await provider.refreshModels();
  now = new Date("2026-08-14T12:37:00.000Z");
  assert.deepEqual(await collect(provider.stream({ modelUid: "swe-1" })), [{ type: "error", code: "credential_expired" }]);
  await assert.rejects(provider.refreshModels(), (error) => error?.code === "credential_expired");
});

test("原生流在上游 next 卡住时仍可取消并关闭迭代器", async () => {
  const store = new InMemoryFakeCredentialStore();
  let iteratorClosed = false;
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    authenticationMode: "manual_api_key",
    catalogSource: fakeCatalog(),
    transport: {
      stream() {
        return {
          [Symbol.asyncIterator]() { return this; },
          next() { return new Promise(() => {}); },
          return() { iteratorClosed = true; return Promise.resolve({ done: true }); }
        };
      }
    }
  });
  await provider.manualApiKey.save({ apiKey: "fake-cancellable-key" });
  await provider.refreshModels();
  const controller = new AbortController();
  const eventsPromise = collect(provider.stream({ modelUid: "swe-1", signal: controller.signal }));
  setTimeout(() => controller.abort(), 5).unref?.();
  const events = await eventsPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), { type: "error", code: "aborted" });
  assert.equal(iteratorClosed, true);
});

test("底层异常和未知结束原因只暴露固定错误码，不包含伪密钥", async () => {
  const secret = "fake-never-log-this-key";
  const store = new InMemoryFakeCredentialStore();
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    authenticationMode: "manual_api_key",
    catalogSource: fakeCatalog(),
    transport: {
      async *stream() { throw new Error(`transport failed with ${secret}`); }
    }
  });
  await provider.manualApiKey.save({ apiKey: secret });
  await provider.refreshModels();
  const events = await collect(provider.stream({ modelUid: "swe-1" }));
  assert.deepEqual(events.at(-1), { type: "error", code: "transport_failed" });
  assert.equal(JSON.stringify(events).includes(secret), false);

  const unknownFinishProvider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: store,
    authenticationMode: "manual_api_key",
    catalogSource: fakeCatalog(),
    transport: {
      async *stream() { yield { type: "finish", reason: "unexpected-success" }; }
    }
  });
  await unknownFinishProvider.refreshModels();
  assert.deepEqual(
    (await collect(unknownFinishProvider.stream({ modelUid: "swe-1" }))).at(-1),
    { type: "error", code: "invalid_finish_reason" }
  );
});

test("目录刷新失败不替换上一代模型且不透传带密钥的异常", async () => {
  const secret = "fake-catalog-secret-key";
  let shouldFail = false;
  const provider = createExperimentalWindsurfDevinProvider({
    featureGate: enabledGate(),
    credentialStore: new InMemoryFakeCredentialStore(),
    authenticationMode: "manual_api_key",
    catalogSource: {
      async fetch() {
        if (shouldFail) {
          throw new Error(`catalog leaked ${secret}`);
        }
        return fakeCatalog().fetch();
      }
    }
  });
  await provider.manualApiKey.save({ apiKey: secret });
  await provider.refreshModels();
  shouldFail = true;
  await assert.rejects(
    provider.refreshModels(),
    (error) => error?.code === "catalog_refresh_failed" && !error.message.includes(secret)
  );
  assert.deepEqual(provider.listModels().map((model) => model.modelUid), ["swe-1"]);
});
