import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStoredCredential } from "../src/credentials.js";
import { createWindsurfPiProvider, resetWindsurfRuntimeCaches } from "../src/pi-provider.js";
import { AtomicEncryptedRecordStore, WindowsDpapiCurrentUserProtector } from "../src/runtime-store.js";
import { loadWindsurfUpstream } from "../src/upstream.js";

test("扩展凭据保留租户地址与非秘密账号名", () => {
  const credential = createStoredCredential({
    kind: "browser_oauth",
    apiKey: "secret",
    createdAt: "2026-08-15T00:00:00.000Z",
    apiServerUrl: "https://server.codeium.com/",
    accountName: "测试账号"
  });
  assert.equal(credential.apiServerUrl, "https://server.codeium.com");
  assert.equal(credential.accountName, "测试账号");
  assert.throws(() => createStoredCredential({ kind: "manual_api_key", apiKey: "x", apiServerUrl: "http://example.com" }), /invalid_api_server_url/);
});

test("加密记录层使用不含凭据名的稳定文件并原子读写", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-windsurf-store-"));
  try {
    const store = new AtomicEncryptedRecordStore(root);
    const payload = new Uint8Array([1, 3, 3, 7, 255]);
    await store.write("windsurf:browser_oauth", payload);
    assert.deepEqual(await store.read("windsurf:browser_oauth"), payload);
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    assert.equal(files.some((name) => name.includes("browser_oauth")), false);
    assert.equal((await readFile(join(root, files.find((name) => name.endsWith(".credential"))), "utf8")).includes("secret"), false);
    await store.remove("windsurf:browser_oauth");
    assert.equal(await store.read("windsurf:browser_oauth"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows DPAPI CurrentUser 可逆且密文不等于原文", { skip: process.platform !== "win32" }, async () => {
  const protector = new WindowsDpapiCurrentUserProtector();
  const plaintext = new TextEncoder().encode("isolated-test-secret");
  const encrypted = await protector.protectCurrentUser(plaintext);
  assert.notDeepEqual(encrypted, plaintext);
  const restored = await protector.unprotectCurrentUser(encrypted);
  assert.equal(new TextDecoder().decode(restored), "isolated-test-secret");
});

test("上游依赖暴露真实云流、JWT 与 RegisterUser 实现", async () => {
  const upstream = await loadWindsurfUpstream();
  assert.equal(typeof upstream.streamChatEvents, "function");
  assert.equal(typeof upstream.getCachedUserJwt, "function");
  assert.equal(typeof upstream.registerUser, "function");
  assert.equal(typeof upstream.buildMetadata, "function");
  assert.equal(typeof upstream.iterFields, "function");
});

test("Pi Provider 在未登录时保留可见回退目录但认证保持未配置", async () => {
  resetWindsurfRuntimeCaches();
  const provider = createWindsurfPiProvider({
    apiKeyAuth: {
      name: "隔离测试认证",
      async check() { return void 0; },
      async resolve() { return void 0; }
    },
    async readCredential() { return void 0; }
  });
  assert.equal(provider.id, "windsurf");
  assert.ok(provider.getModels().some((model) => model.id === "claude-opus-4-8-high"));
  assert.equal(provider.getModels().some((model) => model.id.startsWith("gpt-5-6-")), false);
  const auth = await provider.auth.apiKey.resolve({});
  assert.equal(auth, undefined);
});
