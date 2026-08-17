import assert from "node:assert/strict";
import test from "node:test";

import {
  beginWindsurfTokenLogin,
  buildWindsurfTokenLoginUrl,
  createWindsurfTokenImportPage,
  exchangeWindsurfToken
} from "../src/browser-token-import.js";

test("Windsurf 登录使用官方 token 展示回调而不是随机 localhost", () => {
  const state = "state-abcdefghijklmnopqrstuvwxyz-0123456789";
  const url = new URL(buildWindsurfTokenLoginUrl(state));
  assert.equal(url.origin, "https://windsurf.com");
  assert.equal(url.pathname, "/windsurf/signin");
  assert.equal(url.searchParams.get("redirect_uri"), "show-auth-token");
  assert.equal(url.searchParams.get("state"), state);
  assert.doesNotMatch(url.href, /127\.0\.0\.1|localhost/u);
});

test("本地导入页只把 token 以 POST body 送回本机", () => {
  const login = beginWindsurfTokenLogin({ timeoutMs: 60_000 });
  const page = createWindsurfTokenImportPage(login, "fixture-csp-nonce-123456");
  assert.match(page, /\/oauth\/windsurf\/token/u);
  assert.match(page, /method:'POST'/u);
  assert.match(page, /JSON\.stringify\(\{state,token\}\)/u);
  assert.doesNotMatch(page, /auth\/callback/u);
  assert.match(page, /社区非官方/u);
  assert.match(page, /-webkit-text-security:disc/u);
});

test("token 交换只返回长期凭据字段且不回显原 token", async () => {
  const token = `header.${"payload".repeat(12)}.signature`;
  const result = await exchangeWindsurfToken(token, {
    registerUser: async (received) => {
      assert.equal(received, token);
      return { apiKey: "long-lived-key", apiServerUrl: "https://server.codeium.com", name: "fixture-account" };
    }
  });
  assert.deepEqual(result, { apiKey: "long-lived-key", apiServerUrl: "https://server.codeium.com", accountName: "fixture-account" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("明显无效的短 token 在网络请求前拒绝", async () => {
  await assert.rejects(() => exchangeWindsurfToken("short", { registerUser: async () => assert.fail("不应调用 RegisterUser") }), /invalid_oauth_token/u);
});
