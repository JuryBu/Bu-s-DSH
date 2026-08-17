import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  clearAllWindsurfCredentials,
  clearWindsurfCredential,
  getWindsurfStatus,
  saveWindsurfCredential,
  setWindsurfAuthenticationMode
} from "./runtime.js";
import { beginWindsurfTokenLogin, createWindsurfTokenImportPage, exchangeWindsurfToken } from "./browser-token-import.js";
import { ProviderBoundaryError } from "./errors.js";

const paths = Object.freeze({
  status: "/oauth/windsurf/status",
  login: "/oauth/windsurf/login",
  import: "/oauth/windsurf/import",
  token: "/oauth/windsurf/token",
  apiKey: "/oauth/windsurf/api-key",
  localImport: "/oauth/windsurf/local-import",
  mode: "/oauth/windsurf/mode",
  cancel: "/oauth/windsurf/cancel",
  logout: "/oauth/windsurf/logout"
});

function readLocalWindsurfCredential() {
  const roots = [
    ["Devin Desktop", process.env.APPDATA && join(process.env.APPDATA, "devin")],
    ["Windsurf Desktop", process.env.APPDATA && join(process.env.APPDATA, "Windsurf")],
    ["Windsurf Desktop", process.env.APPDATA && join(process.env.APPDATA, "Codeium", "Windsurf")]
  ].filter((entry) => entry[1]);
  for (const [source, root] of roots) {
    const dbPath = join(root, "User", "globalStorage", "state.vscdb");
    if (!existsSync(dbPath)) continue;
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get("windsurfAuthStatus");
      if (!row?.value) continue;
      const authStatus = JSON.parse(row.value);
      const apiKey = authStatus.apiKey ?? authStatus.api_key ?? authStatus.sessionToken ?? authStatus.session_token;
      if (typeof apiKey !== "string" || apiKey.trim().length === 0) continue;
      const selected = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get("codeium.windsurf-windsurf_auth")?.value;
      const accountName = authStatus.email ?? authStatus.name ?? authStatus.user?.email ?? authStatus.user?.name ?? selected ?? source;
      return { apiKey: apiKey.trim(), apiServerUrl: authStatus.apiServerUrl ?? authStatus.api_server_url, accountName, source };
    } finally {
      database.close();
    }
  }
  throw new Error("local_windsurf_credential_not_found");
}

async function launchDetached(executable, args, browser) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ opened: true, browser });
    });
  });
}

async function openAuthUrl(url) {
  if (process.env.DSH_WINDSURF_BROWSER === "none") return { opened: false, browser: "disabled" };
  try {
    return await launchDetached("rundll32.exe", ["url.dll,FileProtocolHandler", url], "default");
  } catch {
  }
  const candidates = [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return await launchDetached(candidate, [url], "chrome");
    } catch {
    }
  }
  return { opened: false, browser: "unavailable" };
}

function localRequest(request) {
  const remote = request.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

export function expectedLocalOrigin(request) {
  return `http://127.0.0.1:${request.socket.localPort}`;
}

export function trustedOrigin(request, required = false) {
  const origin = request.headers.origin;
  if (origin === undefined) return !required;
  return origin === expectedLocalOrigin(request);
}

export function jsonRequest(request) {
  return String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

export function buildHtmlSecurityHeaders(value, nonce) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(value),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  };
}

function sendHtml(response, status, value, nonce) {
  response.writeHead(status, buildHtmlSecurityHeaders(value, nonce));
  response.end(value);
}

async function readJson(request, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function guard(request, response, method, { requireOrigin = method !== "GET", requireJson = method !== "GET" } = {}) {
  if (!localRequest(request) || !trustedOrigin(request, requireOrigin)) {
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return false;
  }
  if (request.method !== method) {
    response.setHeader("allow", method);
    sendJson(response, 405, { ok: false, error: "method-not-allowed" });
    return false;
  }
  if (requireJson && !jsonRequest(request)) {
    sendJson(response, 415, { ok: false, error: "content-type-must-be-application-json" });
    return false;
  }
  return true;
}

export class WindsurfController {
  state = "idle";
  error = null;
  pending = null;
  generation = 0;
  exchangeAbort = null;
  mutation = Promise.resolve();

  constructor({
    exchangeToken = exchangeWindsurfToken,
    saveCredential = saveWindsurfCredential,
    clearCredential = clearWindsurfCredential,
    clearAllCredentials = clearAllWindsurfCredentials,
    getStatus = getWindsurfStatus,
    openUrl = openAuthUrl
  } = {}) {
    this.exchangeToken = exchangeToken;
    this.saveCredential = saveCredential;
    this.clearCredential = clearCredential;
    this.clearAllCredentials = clearAllCredentials;
    this.getStatus = getStatus;
    this.openUrl = openUrl;
  }

  cancelInFlight() {
    this.generation += 1;
    this.exchangeAbort?.abort();
    this.exchangeAbort = null;
    this.pending = null;
    return this.generation;
  }

  runMutation(operation) {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  async status() {
    return {
      state: this.state,
      error: this.error,
      tokenImportRequired: this.state === "waiting",
      expiresAt: this.pending?.expiresAt ?? null,
      ...(await this.getStatus())
    };
  }

  async start(localOrigin) {
    const generation = this.cancelInFlight();
    await this.mutation;
    if (generation !== this.generation) throw new ProviderBoundaryError("oauth_transaction_cancelled");
    const login = beginWindsurfTokenLogin();
    const importUrl = `${localOrigin}${paths.import}?state=${encodeURIComponent(login.state)}`;
    this.pending = { ...login, importUrl, localOrigin, generation };
    this.state = "waiting";
    this.error = null;
    const importBrowser = await this.openUrl(importUrl);
    const authorizationBrowser = await this.openUrl(login.authorizationUrl);
    return {
      state: this.state,
      url: importUrl,
      authorizationUrl: login.authorizationUrl,
      browserOpened: importBrowser.opened,
      browser: importBrowser.browser,
      authorizationBrowserOpened: authorizationBrowser.opened,
      tokenImportRequired: true,
      expiresAt: login.expiresAt,
      reused: false
    };
  }

  importPage(state, nonce) {
    if (!this.pending || state !== this.pending.state || Date.now() >= Date.parse(this.pending.expiresAt)) {
      throw new Error("oauth_transaction_expired");
    }
    return createWindsurfTokenImportPage(this.pending, nonce);
  }

  async complete(state, token, requestOrigin) {
    const transaction = this.pending;
    if (!transaction || state !== transaction.state || requestOrigin !== transaction.localOrigin || Date.now() >= Date.parse(transaction.expiresAt)) {
      throw new Error("oauth_transaction_expired");
    }
    this.pending = null;
    this.state = "starting";
    this.error = null;
    const abortController = new AbortController();
    this.exchangeAbort = abortController;
    try {
      const credential = await this.exchangeToken(token, { signal: abortController.signal });
      if (abortController.signal.aborted || this.generation !== transaction.generation) {
        throw new ProviderBoundaryError("oauth_transaction_cancelled");
      }
      const result = await this.runMutation(async () => {
        if (abortController.signal.aborted || this.generation !== transaction.generation) {
          throw new ProviderBoundaryError("oauth_transaction_cancelled");
        }
        return this.saveCredential("browser_oauth", credential);
      });
      if (abortController.signal.aborted || this.generation !== transaction.generation) {
        throw new ProviderBoundaryError("oauth_transaction_cancelled");
      }
      this.state = "connected";
      this.error = null;
      return result;
    } catch {
      if (this.generation === transaction.generation) {
        this.state = "error";
        this.error = "token_exchange_failed";
      }
      throw new ProviderBoundaryError("token_exchange_failed");
    } finally {
      if (this.exchangeAbort === abortController) this.exchangeAbort = null;
    }
  }

  async logout(mode) {
    this.cancelInFlight();
    await this.runMutation(async () => {
      if (mode === "all") await this.clearAllCredentials();
      else await this.clearCredential(mode);
    });
    this.state = "idle";
    this.error = null;
  }

  async cancel() {
    this.cancelInFlight();
    this.state = "idle";
    this.error = null;
    return this.status();
  }

  dispose() {
    this.cancelInFlight();
    this.state = "idle";
    this.error = null;
  }
}

const controller = new WindsurfController();

export const inject = ["webServer"];
export const name = "windsurf-auth";

export function apply(context) {
  const routes = [
    {
      kind: "exact",
      path: paths.status,
      handler: async (request, response) => {
        if (!guard(request, response, "GET")) return;
        try {
          sendJson(response, 200, { ok: true, ...(await controller.status()) });
        } catch {
          sendJson(response, 500, { ok: false, error: "Windsurf 凭据存储不可用" });
        }
      }
    },
    {
      kind: "exact",
      path: paths.login,
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          const localOrigin = expectedLocalOrigin(request);
          sendJson(response, 202, { ok: true, ...(await controller.start(localOrigin)) });
        } catch {
          sendJson(response, 500, { ok: false, error: "无法启动 Windsurf 浏览器授权" });
        }
      }
    },
    {
      kind: "exact",
      path: paths.import,
      handler: async (request, response) => {
        if (!guard(request, response, "GET")) return;
        try {
          const nonce = randomBytes(18).toString("base64");
          const url = new URL(request.url ?? paths.import, expectedLocalOrigin(request));
          sendHtml(response, 200, controller.importPage(url.searchParams.get("state") ?? "", nonce), nonce);
        } catch {
          const nonce = randomBytes(18).toString("base64");
          sendHtml(response, 410, `<!doctype html><meta charset="utf-8"><style nonce="${nonce}">body{font:16px system-ui;padding:30px}</style><p>本次 Windsurf 授权已失效，请返回 DSH 重新开始。</p>`, nonce);
        }
      }
    },
    {
      kind: "exact",
      path: paths.token,
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          const body = await readJson(request, 32 * 1024);
          const status = await controller.complete(body.state, body.token, request.headers.origin);
          sendJson(response, 200, { ok: true, ...status });
        } catch {
          sendJson(response, 400, { ok: false, error: "Windsurf token 无效、已过期或无法换取长期凭据" });
        }
      }
    },
    {
      kind: "exact",
      path: paths.apiKey,
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          const body = await readJson(request);
          const status = await saveWindsurfCredential("manual_api_key", { apiKey: body.apiKey, apiServerUrl: body.apiServerUrl });
          sendJson(response, 200, { ok: true, ...status });
        } catch {
          sendJson(response, 400, { ok: false, error: "API Key 或服务器地址无效" });
        }
      }
    },
    {
      kind: "exact",
      path: paths.localImport,
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          const local = readLocalWindsurfCredential();
          const status = await saveWindsurfCredential("browser_oauth", local);
          sendJson(response, 200, { ok: true, ...status, source: local.source });
        } catch {
          sendJson(response, 404, { ok: false, error: "未在 Devin/Windsurf 本机客户端中找到可导入的登录状态" });
        }
      }
    },
    {
      kind: "exact",
      path: paths.mode,
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          const body = await readJson(request);
          await setWindsurfAuthenticationMode(body.authenticationMode);
          sendJson(response, 200, { ok: true, ...(await controller.status()) });
        } catch {
          sendJson(response, 400, { ok: false, error: "认证方式无效" });
        }
      }
    },
    {
      kind: "exact",
      path: paths.cancel,
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          sendJson(response, 200, { ok: true, ...(await controller.cancel()) });
        } catch {
          sendJson(response, 400, { ok: false, error: "无法取消 Windsurf 浏览器授权" });
        }
      }
    },
    {
      kind: "exact",
      path: paths.logout,
      handler: async (request, response) => {
        if (!guard(request, response, "POST")) return;
        try {
          const body = await readJson(request);
          const mode = body.authenticationMode ?? "all";
          if (mode !== "all" && mode !== "browser_oauth" && mode !== "manual_api_key") throw new Error("invalid_mode");
          await controller.logout(mode);
          sendJson(response, 200, { ok: true, ...(await controller.status()) });
        } catch {
          sendJson(response, 400, { ok: false, error: "无法清除 Windsurf 登录" });
        }
      }
    }
  ];
  context.effect(() => {
    const disposers = routes.map((route) => context.webServer.register(route));
    context.logger.info("windsurf-auth: local OAuth/API key routes ready; credentials use Windows DPAPI");
    return () => {
      controller.dispose();
      disposers.forEach((dispose) => dispose());
    };
  }, "windsurf-auth: local routes");
}

export default { name, inject, apply };
