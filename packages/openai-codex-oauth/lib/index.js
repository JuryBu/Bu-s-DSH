import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { openAICodexCredentialStore, openAICodexProviderId, oauthStorePath } from "./store.js";

const STATUS_PATH = "/oauth/openai-codex/status";
const LOGIN_PATH = "/oauth/openai-codex/login";
const LOGOUT_PATH = "/oauth/openai-codex/logout";
const models = createModels({ credentials: openAICodexCredentialStore });
models.setProvider(openaiCodexProvider());

async function launchDetached(executable, args, browser) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ opened: true, browser });
    });
  });
}

async function openAuthUrl(url) {
  if (process.env.DSH_OAUTH_BROWSER === "none") {
    return { opened: false, browser: "disabled" };
  }
  try {
    return await launchDetached("rundll32.exe", ["url.dll,FileProtocolHandler", url], "default");
  } catch {
  }
  const chromeCandidates = [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const chromePath of chromeCandidates) {
    try {
      await access(chromePath);
      return await launchDetached(chromePath, [url], "chrome");
    } catch {
    }
  }
  return { opened: false, browser: "unavailable" };
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(message)) return "登录已取消";
  if (/EADDRINUSE|1455/i.test(message)) return "OAuth 回调端口 1455 正在被占用";
  if (/network|fetch|ENOTFOUND|ECONN/i.test(message)) return "无法连接 OpenAI 授权服务";
  return "OAuth 登录失败，请重试";
}

function localRequest(req) {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function trustedOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

class OAuthController {
  state = "idle";
  error = null;
  url = null;
  loginTask = null;
  abortController = null;

  async status() {
    const credential = await openAICodexCredentialStore.read(openAICodexProviderId);
    if (credential !== undefined) {
      return {
        state: "connected",
        connected: true,
        expiresAt: credential.expires,
        storage: "windows-dpapi",
      };
    }
    return {
      state: this.state,
      connected: false,
      error: this.error,
      storage: "windows-dpapi",
    };
  }

  prompt(request) {
    if (request.type === "select") return Promise.resolve("browser");
    if (request.type !== "manual_code") return Promise.reject(new Error("Unsupported OAuth prompt"));
    return new Promise((resolve, reject) => {
      const signals = [request.signal, this.abortController?.signal].filter(Boolean);
      const cancel = () => reject(new Error("Login cancelled"));
      if (signals.some((signal) => signal.aborted)) return cancel();
      for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
    });
  }

  notify(event, resolveUrl) {
    if (event.type !== "auth_url") return;
    this.url = event.url;
    this.state = "waiting";
    resolveUrl(event.url);
  }

  async start() {
    if (this.loginTask !== null) {
      if (this.url !== null) return { url: this.url, reused: true };
      return { pending: true, reused: true };
    }
    this.state = "starting";
    this.error = null;
    this.url = null;
    this.abortController = new AbortController();
    let resolveUrl;
    const urlReady = new Promise((resolve) => {
      resolveUrl = resolve;
    });
    const interaction = {
      signal: this.abortController.signal,
      prompt: (request) => this.prompt(request),
      notify: (event) => this.notify(event, resolveUrl),
    };
    this.loginTask = models.login(openAICodexProviderId, "oauth", interaction).then(() => {
      this.state = "connected";
      this.error = null;
    }).catch((error) => {
      this.state = "error";
      this.error = safeMessage(error);
    }).finally(() => {
      this.loginTask = null;
      this.abortController = null;
    });
    const result = await Promise.race([
      urlReady.then((url) => ({ url, reused: false })),
      this.loginTask.then(() => ({ completed: this.state === "connected" })),
      new Promise((resolve) => setTimeout(() => resolve({ pending: true, reused: false }), 10_000)),
    ]);
    return result;
  }

  async logout() {
    const activeLogin = this.loginTask;
    this.abortController?.abort();
    if (activeLogin !== null) await activeLogin;
    await models.logout(openAICodexProviderId);
    this.state = "idle";
    this.error = null;
    this.url = null;
  }
}

const controller = new OAuthController();

function guard(req, res, method) {
  if (!localRequest(req) || !trustedOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }
  if (req.method !== method) {
    res.setHeader("allow", method);
    sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    return false;
  }
  return true;
}

export const inject = ["webServer"];
export const name = "openai-codex-oauth";

export function apply(ctx) {
  const routes = [
    {
      kind: "exact",
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          sendJson(res, 200, { ok: true, ...(await controller.status()) });
        } catch {
          sendJson(res, 500, { ok: false, error: "OAuth 凭据存储不可用" });
        }
      },
    },
    {
      kind: "exact",
      path: LOGIN_PATH,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        try {
          const result = await controller.start();
          const browser = typeof result.url === "string"
            ? await openAuthUrl(result.url)
            : { opened: false, browser: "not-ready" };
          sendJson(res, 202, {
            ok: true,
            ...result,
            browserOpened: browser.opened,
            browser: browser.browser,
          });
        } catch {
          sendJson(res, 500, { ok: false, error: "无法启动 OAuth 登录" });
        }
      },
    },
    {
      kind: "exact",
      path: LOGOUT_PATH,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        try {
          await controller.logout();
          sendJson(res, 200, { ok: true });
        } catch {
          sendJson(res, 500, { ok: false, error: "无法退出 OAuth 登录" });
        }
      },
    },
  ];
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    ctx.logger.info("openai-codex-oauth: local routes ready; credentials use Windows DPAPI at %s", oauthStorePath);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "openai-codex-oauth: local login routes");
}
