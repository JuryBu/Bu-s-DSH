import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createMessageBranchRoutes } from "../lib/http.js";
import { branchError } from "../lib/errors.js";

function response() {
  return {
    status: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers }; },
    end(body) { this.body = body ?? ""; },
  };
}

function request(method, path, body, overrides = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  return Object.assign(Readable.from(payload), {
    method,
    url: path,
    headers: {
      origin: "http://127.0.0.1:3119",
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    socket: { remoteAddress: "127.0.0.1", localPort: 3119 },
    ...overrides,
  });
}

function service(overrides = {}) {
  return {
    availability: async sessionId => ({ allowed: true, sessionId, sourceMessageId: "user-1", draft: { text: "原文", images: [], files: [] } }),
    editAndResend: async value => ({ state: "created", childSessionId: "child-1", operationId: value.operationId }),
    ...overrides,
  };
}

test("本地同源页面可以读取可用性并提交编辑重发", async () => {
  const routes = createMessageBranchRoutes(service());
  const availability = response();
  await routes[0].handler(request("GET", "/message-branch/availability?sessionId=session-1"), availability);
  assert.equal(availability.status, 200);
  assert.equal(JSON.parse(availability.body).availability.sourceMessageId, "user-1");

  const resend = response();
  await routes[1].handler(request("POST", "/message-branch/edit-and-resend", {
    operationId: "op-1",
    sessionId: "session-1",
    expectedSourceMessageId: "user-1",
    draft: { text: "修改后", images: [], files: [] },
  }), resend);
  assert.equal(resend.status, 201);
  assert.equal(JSON.parse(resend.body).result.childSessionId, "child-1");
});

test("本地转发候选按浏览器可见 Host 校验来源", async () => {
  const routes = createMessageBranchRoutes(service());
  const availability = response();
  await routes[0].handler(request("GET", "/message-branch/availability?sessionId=session-1", undefined, {
    headers: {
      host: "127.0.0.1:3099",
      origin: "http://127.0.0.1:3099",
      "sec-fetch-site": "same-site",
    },
    socket: { remoteAddress: "127.0.0.1", localPort: 39123 },
  }), availability);
  assert.equal(availability.status, 200);
});

test("约 106K 文本编辑请求低于默认本地接口大小上限并能进入服务", async () => {
  let seenTextLength = 0;
  const routes = createMessageBranchRoutes(service({
    editAndResend: async value => {
      seenTextLength = value.draft.text.length;
      return { state: "created", childSessionId: "child-large", operationId: value.operationId };
    },
  }));
  const largeText = "x".repeat(106 * 1024);
  const resend = response();
  await routes[1].handler(request("POST", "/message-branch/edit-and-resend", {
    operationId: "op-large-text",
    sessionId: "session-1",
    expectedSourceMessageId: "user-1",
    draft: { text: largeText, images: [], files: [], order: [{ type: "text" }] },
  }), resend);
  assert.equal(resend.status, 201);
  assert.equal(seenTextLength, largeText.length);
  assert.equal(JSON.parse(resend.body).result.childSessionId, "child-large");
});

test("跨站、远程和错误方法在调用服务前被拒绝", async () => {
  let calls = 0;
  const routes = createMessageBranchRoutes(service({
    availability: async () => { calls += 1; return {}; },
    editAndResend: async () => { calls += 1; return {}; },
  }));
  for (const [route, incoming, expected] of [
    [routes[0], request("GET", routes[0].path, undefined, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), 403],
    [routes[0], request("GET", routes[0].path, undefined, { socket: { remoteAddress: "192.0.2.5", localPort: 3119 } }), 403],
    [routes[1], request("GET", routes[1].path), 405],
  ]) {
    const outgoing = response();
    await route.handler(incoming, outgoing);
    assert.equal(outgoing.status, expected);
  }
  assert.equal(calls, 0);
});

test("请求大小、媒体类型和业务竞态返回稳定错误且不泄漏内部异常", async () => {
  const routes = createMessageBranchRoutes(service({
    editAndResend: async () => { throw branchError("session_running", "源会话正在运行"); },
  }), { maxBodyBytes: 32 });

  const tooLarge = response();
  await routes[1].handler(request("POST", routes[1].path, { text: "x".repeat(64) }), tooLarge);
  assert.equal(tooLarge.status, 413);

  const wrongType = response();
  await routes[1].handler(request("POST", routes[1].path, "{}", { headers: { origin: "http://127.0.0.1:3119", "sec-fetch-site": "same-origin", "content-type": "text/plain" } }), wrongType);
  assert.equal(wrongType.status, 415);

  const conflictRoutes = createMessageBranchRoutes(service({
    editAndResend: async () => { throw branchError("session_running", "源会话正在运行"); },
  }));
  const conflict = response();
  await conflictRoutes[1].handler(request("POST", conflictRoutes[1].path, { operationId: "op" }), conflict);
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.body).error.code, "session_running");

  const internalRoutes = createMessageBranchRoutes(service({ editAndResend: async () => { throw new Error("secret path C:\\private"); } }));
  const internal = response();
  await internalRoutes[1].handler(request("POST", internalRoutes[1].path, { operationId: "op" }), internal);
  assert.equal(internal.status, 500);
  assert.equal(internal.body.includes("secret path"), false);
});
