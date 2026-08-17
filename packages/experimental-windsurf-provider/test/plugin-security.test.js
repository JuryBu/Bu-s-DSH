import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHtmlSecurityHeaders,
  expectedLocalOrigin,
  jsonRequest,
  trustedOrigin,
  WindsurfController
} from "../src/plugin.js";

function fakeRequest({ origin, contentType = "application/json; charset=utf-8", localPort = 3101 } = {}) {
  return {
    headers: {
      ...(origin === undefined ? {} : { origin }),
      "content-type": contentType
    },
    socket: { localPort, remoteAddress: "127.0.0.1" }
  };
}

const fakeStatus = async () => ({ connected: false, authenticationMode: "browser_oauth", methods: {}, storage: "fixture", communityProvider: true });

test("写入路由只接受精确本机来源和 JSON", () => {
  const expected = fakeRequest({ origin: "http://127.0.0.1:3101" });
  assert.equal(expectedLocalOrigin(expected), "http://127.0.0.1:3101");
  assert.equal(trustedOrigin(expected, true), true);
  assert.equal(jsonRequest(expected), true);
  assert.equal(trustedOrigin(fakeRequest(), true), false);
  assert.equal(trustedOrigin(fakeRequest({ origin: "http://localhost:3101" }), true), false);
  assert.equal(trustedOrigin(fakeRequest({ origin: "http://127.0.0.1:3102" }), true), false);
  assert.equal(jsonRequest(fakeRequest({ origin: "http://127.0.0.1:3101", contentType: "text/plain" })), false);
});

test("导入页使用 nonce CSP 并禁止嵌入", () => {
  const nonce = "fixture-nonce-123456789";
  const headers = buildHtmlSecurityHeaders("<p>fixture</p>", nonce);
  assert.match(headers["content-security-policy"], new RegExp(`script-src 'nonce-${nonce}'`, "u"));
  assert.match(headers["content-security-policy"], /connect-src 'self'/u);
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/u);
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["referrer-policy"], "no-referrer");
});

test("重新登录会中止旧交换且迟到结果不能写入凭据", async () => {
  let resolveExchange;
  const saved = [];
  const opened = [];
  const controller = new WindsurfController({
    exchangeToken: (_token, { signal }) => new Promise((resolve) => {
      resolveExchange = () => resolve({ apiKey: "late-key", apiServerUrl: "https://server.codeium.com" });
      signal.addEventListener("abort", () => undefined, { once: true });
    }),
    saveCredential: async (...args) => saved.push(args),
    clearCredential: async () => undefined,
    clearAllCredentials: async () => undefined,
    getStatus: fakeStatus,
    openUrl: async (url) => { opened.push(url); return { opened: true, browser: "fixture" }; }
  });
  const first = await controller.start("http://127.0.0.1:3101");
  assert.equal(opened.length, 2);
  assert.equal(opened[0], first.url);
  assert.equal(opened[1], first.authorizationUrl);
  const pending = controller.complete(first.url.split("state=")[1], "x".repeat(64), "http://127.0.0.1:3101");
  await controller.start("http://127.0.0.1:3101");
  resolveExchange();
  await assert.rejects(pending, /token_exchange_failed/u);
  assert.equal(saved.length, 0);
});

test("注销会让正在交换的迟到结果失效并最终保持清除", async () => {
  let resolveExchange;
  const saved = [];
  let cleared = 0;
  const controller = new WindsurfController({
    exchangeToken: () => new Promise((resolve) => { resolveExchange = () => resolve({ apiKey: "late-key", apiServerUrl: "https://server.codeium.com" }); }),
    saveCredential: async (...args) => saved.push(args),
    clearCredential: async () => undefined,
    clearAllCredentials: async () => { cleared += 1; },
    getStatus: fakeStatus,
    openUrl: async () => ({ opened: true, browser: "fixture" })
  });
  const login = await controller.start("http://127.0.0.1:3101");
  const pending = controller.complete(login.url.split("state=")[1], "x".repeat(64), "http://127.0.0.1:3101");
  await controller.logout("all");
  resolveExchange();
  await assert.rejects(pending, /token_exchange_failed/u);
  assert.equal(saved.length, 0);
  assert.equal(cleared, 1);
  assert.equal((await controller.status()).state, "idle");
});

test("上游错误只能变成固定错误码", async () => {
  const secret = "sensitive-upstream-body";
  const controller = new WindsurfController({
    exchangeToken: async () => { throw new Error(secret); },
    saveCredential: async () => assert.fail("不应保存"),
    clearCredential: async () => undefined,
    clearAllCredentials: async () => undefined,
    getStatus: fakeStatus,
    openUrl: async () => ({ opened: true, browser: "fixture" })
  });
  const login = await controller.start("http://127.0.0.1:3101");
  await assert.rejects(
    () => controller.complete(login.url.split("state=")[1], "x".repeat(64), "http://127.0.0.1:3101"),
    (error) => error?.code === "token_exchange_failed" && !String(error).includes(secret)
  );
  const status = await controller.status();
  assert.equal(status.error, "token_exchange_failed");
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret, "u"));
});
