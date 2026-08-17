import { getWindsurfStatus, readWindsurfCredential } from "@deepseek-harness/experimental-windsurf-provider/runtime";
import { openAICodexCredentialStore, openAICodexProviderId } from "@stardust/dsh-openai-codex-oauth/store";
import { createAccountUsageService } from "./index.js";

export const name = "account-usage";
export const inject = ["webServer"];
export const ACCOUNT_USAGE_PROVIDERS = Object.freeze(["deepseek-api-key", "openai-codex-oauth", "experimental-windsurf-devin"]);

function localRequest(request) {
  const remoteAddress = request.socket?.remoteAddress ?? "";
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function expectedLocalOrigin(request) {
  return `http://127.0.0.1:${request.socket?.localPort}`;
}

function trustedOrigin(request) {
  const origin = request.headers?.origin;
  return origin === undefined || origin === expectedLocalOrigin(request);
}

function trustedFetchSite(request) {
  const fetchSite = request.headers?.["sec-fetch-site"];
  return fetchSite === undefined || fetchSite === "same-origin";
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function guard(request, response) {
  if (!localRequest(request) || !trustedOrigin(request) || !trustedFetchSite(request)) {
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return false;
  }
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    sendJson(response, 405, { ok: false, error: "method-not-allowed" });
    return false;
  }
  return true;
}

async function resolveDeepSeekCredential(context) {
  const credentials = context.get?.("credentials");
  if (credentials !== undefined) return (await credentials.resolve("DEEPSEEK_API_KEY"))?.value;
  const ambient = process.env.DEEPSEEK_API_KEY;
  return typeof ambient === "string" && ambient.length > 0 ? ambient : undefined;
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return undefined;
  const segment = token.split(".")[1];
  if (!segment) return undefined;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function chatGPTAccountId(credential) {
  if (typeof credential?.accountId === "string" && credential.accountId.length > 0) return credential.accountId;
  const payload = decodeJwtPayload(credential?.access);
  const auth = payload?.["https://api.openai.com/auth"];
  const candidate = auth?.chatgpt_account_id ?? payload?.account_id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function unavailableResponse(status = 401) {
  return { ok: false, status, json: async () => ({}) };
}

function createDefaultDependencies(context) {
  return {
    fetchImpl: globalThis.fetch,
    resolveDeepSeekCredential: () => resolveDeepSeekCredential(context),
    readOpenAICredential: () => openAICodexCredentialStore.read(openAICodexProviderId),
    readWindsurfStatus: () => getWindsurfStatus(),
    readWindsurfCredential: () => readWindsurfCredential(),
  };
}

export function applyWithDependencies(context, dependencies) {
  const service = createAccountUsageService({
    secretBearingFetcher: async ({ providerId, url, method, headers, body, signal }) => {
      if (providerId === "deepseek-api-key") {
        const apiKey = await dependencies.resolveDeepSeekCredential();
        if (typeof apiKey !== "string" || apiKey.length === 0) return unavailableResponse();
        return dependencies.fetchImpl(url, { method, headers: { ...headers, authorization: `Bearer ${apiKey}` }, redirect: "error", signal });
      }
      if (providerId === "openai-codex-oauth") {
        const credential = await dependencies.readOpenAICredential();
        if (credential?.type !== "oauth" || typeof credential.access !== "string" || credential.access.length === 0) return unavailableResponse();
        const accountId = chatGPTAccountId(credential);
        return dependencies.fetchImpl(url, {
          method,
          headers: {
            ...headers,
            authorization: `Bearer ${credential.access}`,
            ...(accountId ? { "chatgpt-account-id": accountId } : {}),
            "openai-beta": "codex-1",
            "oai-language": "zh-CN",
            originator: "DeepSeek Harness",
            referer: "https://chatgpt.com/",
          },
          redirect: "error",
          signal,
        });
      }
      const credential = await dependencies.readWindsurfCredential();
      if (typeof credential?.apiKey !== "string" || credential.apiKey.length === 0) return unavailableResponse();
      return dependencies.fetchImpl(url, {
        method,
        headers,
        body: JSON.stringify({ ...body, metadata: { ...body?.metadata, apiKey: credential.apiKey } }),
        redirect: "error",
        signal,
      });
    },
    getProviderStatus: async (providerId) => {
      if (providerId === "deepseek-api-key") return { connected: typeof await dependencies.resolveDeepSeekCredential() === "string" };
      if (providerId === "openai-codex-oauth") {
        return { connected: Boolean(await dependencies.readOpenAICredential()), usageUrl: "https://chatgpt.com/codex/settings/usage" };
      }
      const [status, credential] = await Promise.all([dependencies.readWindsurfStatus(), dependencies.readWindsurfCredential()]);
      return {
        connected: status?.connected === true && typeof credential?.apiKey === "string",
        apiServerUrl: credential?.apiServerUrl,
        usageUrl: "https://app.windsurf.com/subscription/manage-plan",
      };
    },
  });

  const routes = ACCOUNT_USAGE_PROVIDERS.map((providerId) => ({
    kind: "exact",
    path: `/account-usage/${providerId}`,
    handler: async (request, response) => {
      if (!guard(request, response)) return;
      try {
        const requestUrl = new URL(request.url ?? `/account-usage/${providerId}`, expectedLocalOrigin(request));
        const snapshot = await service.getSnapshot(providerId, { forceRefresh: requestUrl.searchParams.get("refresh") === "1" });
        sendJson(response, 200, { ok: true, snapshot });
      } catch {
        sendJson(response, 503, { ok: false, error: "account-usage-unavailable" });
      }
    },
  }));

  context.effect(() => {
    const disposers = routes.map((route) => context.webServer.register(route));
    context.logger?.info?.("account-usage: local read-only provider status routes ready");
    return () => disposers.forEach((dispose) => dispose());
  }, "account-usage: local routes");
  return { routes, service };
}

export function apply(context) {
  return applyWithDependencies(context, createDefaultDependencies(context));
}

export * from "./index.js";
export default { name, inject, apply };
