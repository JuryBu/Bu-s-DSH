import { randomBytes } from "node:crypto";

import { ProviderBoundaryError } from "./errors.js";
import { loadWindsurfUpstream } from "./upstream.js";

export const DEFAULT_WINDSURF_REGION = Object.freeze({
  website: "https://windsurf.com",
  registerApiServerUrl: "https://register.windsurf.com",
  oauthClientId: "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u"
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

export function buildWindsurfTokenLoginUrl(state, region = DEFAULT_WINDSURF_REGION) {
  if (typeof state !== "string" || state.length < 32) throw new ProviderBoundaryError("invalid_oauth_state");
  const params = new URLSearchParams([
    ["response_type", "token"],
    ["client_id", region.oauthClientId],
    ["redirect_uri", "show-auth-token"],
    ["state", state],
    ["prompt", "login"],
    ["redirect_parameters_type", "query"],
    ["workflow", ""]
  ]);
  return `${region.website.replace(/\/$/u, "")}/windsurf/signin?${params}`;
}

export function beginWindsurfTokenLogin({ timeoutMs = 5 * 60_000, region = DEFAULT_WINDSURF_REGION } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 10 * 60_000) {
    throw new ProviderBoundaryError("invalid_oauth_timeout");
  }
  const state = randomBytes(32).toString("base64url");
  return {
    state,
    authorizationUrl: buildWindsurfTokenLoginUrl(state, region),
    expiresAt: new Date(Date.now() + timeoutMs).toISOString()
  };
}

export function createWindsurfTokenImportPage({ authorizationUrl, state, expiresAt, submitPath = "/oauth/windsurf/token" }, nonce) {
  if (typeof nonce !== "string" || nonce.length < 16) throw new ProviderBoundaryError("invalid_csp_nonce");
  const safeAuthorizationUrl = escapeHtml(authorizationUrl);
  const safeState = escapeHtml(state);
  const safeExpiresAt = escapeHtml(expiresAt);
  const safeSubmitPath = escapeHtml(submitPath);
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Windsurf 社区授权导入</title>
  <style nonce="${safeNonce}">
    body{font:15px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e7e9ee}
    main{width:min(680px,calc(100vw - 40px));padding:30px;border:1px solid #2b3040;border-radius:18px;background:#151823;box-shadow:0 24px 70px #0008}
    h1{font-size:24px;margin:0 0 12px}p{color:#aeb5c2;line-height:1.65}ol{line-height:1.8;padding-left:22px}
    a,button{color:#fff;background:#356df3;border:0;border-radius:10px;padding:11px 16px;text-decoration:none;display:inline-block;cursor:pointer}
    textarea{box-sizing:border-box;width:100%;min-height:130px;margin:12px 0;padding:12px;border-radius:10px;border:1px solid #394054;background:#0f1118;color:#fff;resize:vertical;-webkit-text-security:disc}
    button[disabled]{opacity:.55;cursor:wait}.secondary{background:#272c3a}.status{min-height:24px;margin-top:12px;color:#9fd0ff}.error{color:#ff9999}.success{color:#79dd98}
  </style>
</head>
<body>
  <main>
    <h1>连接 Windsurf / Devin 订阅</h1>
    <p>这是社区非官方的浏览器 token 导入，不是 Windsurf 官方第三方 OAuth。Windsurf 页面显示的一次性 token 只会 POST 到本机 DSH；本机换得长期 API Key 后使用 Windows DPAPI 加密保存。</p>
    <ol>
      <li><a href="${safeAuthorizationUrl}" target="_blank" rel="noreferrer">重新打开 Windsurf 授权页</a></li>
      <li>登录并复制页面显示的完整 token。</li>
      <li>粘贴到下方，点击「安全导入」。</li>
    </ol>
    <textarea id="token" autocomplete="off" spellcheck="false" aria-label="Windsurf token" placeholder="在此粘贴 Windsurf 页面显示的 token"></textarea>
    <button id="submit">安全导入</button>
    <span class="secondary" style="margin-left:8px;padding:11px 16px;border-radius:10px">有效期至 ${safeExpiresAt}</span>
    <div id="status" class="status"></div>
  </main>
  <script nonce="${safeNonce}">
    const state = ${JSON.stringify(safeState)};
    const submitPath = ${JSON.stringify(safeSubmitPath)};
    const button = document.getElementById('submit');
    const status = document.getElementById('status');
    button.addEventListener('click', async () => {
      const tokenInput = document.getElementById('token');
      const token = tokenInput.value.trim();
      if (!token) { status.className='status error'; status.textContent='请先粘贴 token。'; return; }
      button.disabled = true; status.className='status'; status.textContent='正在由本机换取长期凭据…';
      try {
        const response = await fetch(submitPath, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({state,token}) });
        tokenInput.value='';
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '导入失败');
        status.className='status success'; status.textContent='连接成功，可以关闭此页并返回 DeepSeek Harness。';
      } catch (error) {
        tokenInput.value='';
        status.className='status error'; status.textContent=error instanceof Error ? error.message : '导入失败';
      } finally { button.disabled = false; }
    });
  </script>
</body>
</html>`;
}

export async function exchangeWindsurfToken(token, { signal, region = DEFAULT_WINDSURF_REGION, registerUser } = {}) {
  const normalized = typeof token === "string" ? token.trim() : "";
  if (normalized.length < 32 || normalized.length > 24 * 1024) throw new ProviderBoundaryError("invalid_oauth_token");
  if (signal?.aborted) throw new ProviderBoundaryError("oauth_transaction_cancelled");
  const exchange = registerUser ?? (await loadWindsurfUpstream()).registerUser;
  const registered = await exchange(normalized, region, signal);
  if (signal?.aborted) throw new ProviderBoundaryError("oauth_transaction_cancelled");
  return {
    apiKey: registered.apiKey,
    apiServerUrl: registered.apiServerUrl,
    accountName: registered.name
  };
}
