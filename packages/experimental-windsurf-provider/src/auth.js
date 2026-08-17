import { randomBytes, timingSafeEqual } from "node:crypto";

import { createStoredCredential, describeCredential } from "./credentials.js";
import { ProviderBoundaryError, toBoundaryError } from "./errors.js";

const defaultOAuthTimeoutMs = 120_000;
const loopbackHosts = new Set(["127.0.0.1", "[::1]"]);

function currentIsoTime(clock) {
  const value = clock();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ProviderBoundaryError("invalid_clock_time");
  }

  return parsed.toISOString();
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireBrowserStart(value, expectedState) {
  if (!value || typeof value.authorizationUrl !== "string" || value.authorizationUrl.length === 0 || typeof value.transactionId !== "string" || value.transactionId.length === 0 || typeof value.redirectUri !== "string") {
    throw new ProviderBoundaryError("invalid_oauth_start");
  }

  let authorizationUrl;
  let redirectUri;
  try {
    authorizationUrl = new URL(value.authorizationUrl);
    redirectUri = new URL(value.redirectUri);
  } catch {
    throw new ProviderBoundaryError("invalid_oauth_url");
  }

  if (authorizationUrl.protocol !== "https:") {
    throw new ProviderBoundaryError("oauth_authorization_must_use_https");
  }

  if (redirectUri.protocol !== "http:" || !loopbackHosts.has(redirectUri.hostname) || redirectUri.port.length === 0 || redirectUri.username || redirectUri.password) {
    throw new ProviderBoundaryError("oauth_redirect_must_be_loopback");
  }

  if (!safeEqual(authorizationUrl.searchParams.get("state"), expectedState)) {
    throw new ProviderBoundaryError("oauth_state_not_bound");
  }

  if (authorizationUrl.searchParams.get("redirect_uri") !== redirectUri.href) {
    throw new ProviderBoundaryError("oauth_redirect_not_bound");
  }

  return {
    authorizationUrl: authorizationUrl.href,
    redirectUri: redirectUri.href,
    transactionId: value.transactionId
  };
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 60_000) {
    throw new ProviderBoundaryError("invalid_oauth_timeout");
  }

  return value;
}

async function runBounded(operation, { signal, timeoutMs, timeoutCode, failureCode }) {
  if (signal?.aborted) {
    throw new ProviderBoundaryError("aborted");
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signal?.aborted) {
    abortFromCaller();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback) => {
        if (settled) {
          return;
        }
        settled = true;
        controller.signal.removeEventListener("abort", rejectOnAbort);
        callback();
      };
      const abortError = () => new ProviderBoundaryError(timedOut ? timeoutCode : "aborted");
      const rejectOnAbort = () => settle(() => reject(abortError()));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      if (controller.signal.aborted) {
        rejectOnAbort();
      }
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) {
            throw abortError();
          }
          return operation(controller.signal);
        })
        .then(
          (value) => settle(() => resolve(value)),
          (error) => settle(() => reject(error))
        );
    });
  } catch (error) {
    throw toBoundaryError(error, failureCode);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function removeCredentialKind(credentialStore, credentialId, kind) {
  let credential;
  try {
    credential = await credentialStore.read(credentialId);
  } catch (error) {
    throw toBoundaryError(error, "credential_store_read_failed");
  }

  if (!credential || credential.kind !== kind) {
    return false;
  }

  try {
    await credentialStore.remove(credentialId);
    return true;
  } catch (error) {
    throw toBoundaryError(error, "credential_store_remove_failed");
  }
}

export class BrowserOAuthEntry {
  #featureGate;
  #credentialStore;
  #credentialId;
  #oauthFlow;
  #clock;
  #oauthTimeoutMs;
  #transactions = new Map();

  async #cancelFlow(transactionId) {
    if (typeof transactionId !== "string" || transactionId.length === 0 || typeof this.#oauthFlow?.cancel !== "function") {
      return;
    }

    try {
      await this.#oauthFlow.cancel({ transactionId });
    } catch {
    }
  }

  constructor({ featureGate, credentialStore, credentialId, oauthFlow, clock = () => new Date(), oauthTimeoutMs = defaultOAuthTimeoutMs } = {}) {
    this.#featureGate = featureGate;
    this.#credentialStore = credentialStore;
    this.#credentialId = credentialId;
    this.#oauthFlow = oauthFlow;
    this.#clock = clock;
    this.#oauthTimeoutMs = normalizeTimeout(oauthTimeoutMs);
  }

  async start({ openBrowser, signal } = {}) {
    this.#featureGate.assertEnabled();
    if (!this.#oauthFlow || typeof this.#oauthFlow.begin !== "function") {
      throw new ProviderBoundaryError("oauth_flow_not_configured");
    }

    if (typeof openBrowser !== "function") {
      throw new ProviderBoundaryError("browser_launcher_not_configured");
    }

    const state = randomBytes(32).toString("base64url");
    const started = await runBounded(
      (boundedSignal) => this.#oauthFlow.begin({ state, signal: boundedSignal }),
      {
        signal,
        timeoutMs: this.#oauthTimeoutMs,
        timeoutCode: "oauth_start_timeout",
        failureCode: "oauth_start_failed"
      }
    );
    let validated;
    try {
      validated = requireBrowserStart(started, state);
    } catch (error) {
      await this.#cancelFlow(started?.transactionId);
      throw error;
    }
    if (this.#transactions.has(validated.transactionId)) {
      throw new ProviderBoundaryError("duplicate_oauth_transaction");
    }

    const expiresAt = new Date(new Date(currentIsoTime(this.#clock)).valueOf() + this.#oauthTimeoutMs).toISOString();
    const expirationTimer = setTimeout(() => {
      const expired = this.#transactions.get(validated.transactionId);
      if (!expired || expired.state !== state) {
        return;
      }

      this.#transactions.delete(validated.transactionId);
      void this.#cancelFlow(validated.transactionId);
    }, this.#oauthTimeoutMs);
    expirationTimer.unref?.();
    this.#transactions.set(validated.transactionId, {
      state,
      redirectUri: validated.redirectUri,
      expiresAt,
      expirationTimer
    });

    try {
      await runBounded(
        (boundedSignal) => openBrowser(validated.authorizationUrl, { signal: boundedSignal }),
        {
          signal,
          timeoutMs: this.#oauthTimeoutMs,
          timeoutCode: "browser_open_timeout",
          failureCode: "browser_open_failed"
        }
      );
    } catch (error) {
      clearTimeout(expirationTimer);
      this.#transactions.delete(validated.transactionId);
      await this.#cancelFlow(validated.transactionId);
      throw error;
    }

    return {
      authorizationUrl: validated.authorizationUrl,
      transactionId: validated.transactionId,
      expiresAt
    };
  }

  async complete({ transactionId, callbackParameters = {}, signal } = {}) {
    this.#featureGate.assertEnabled();
    if (!this.#oauthFlow || typeof this.#oauthFlow.complete !== "function") {
      throw new ProviderBoundaryError("oauth_flow_not_configured");
    }

    if (typeof transactionId !== "string" || transactionId.length === 0 || !callbackParameters || typeof callbackParameters !== "object") {
      throw new ProviderBoundaryError("invalid_oauth_completion");
    }

    const transaction = this.#transactions.get(transactionId);
    this.#transactions.delete(transactionId);
    if (!transaction) {
      throw new ProviderBoundaryError("oauth_transaction_not_found");
    }
    clearTimeout(transaction.expirationTimer);

    const now = new Date(currentIsoTime(this.#clock)).valueOf();
    const expiresAt = new Date(transaction.expiresAt).valueOf();
    if (now >= expiresAt) {
      await this.#cancelFlow(transactionId);
      throw new ProviderBoundaryError("oauth_transaction_expired");
    }

    if (!safeEqual(callbackParameters.state, transaction.state)) {
      await this.#cancelFlow(transactionId);
      throw new ProviderBoundaryError("oauth_state_mismatch");
    }

    let result;
    try {
      result = await runBounded(
        (boundedSignal) => this.#oauthFlow.complete({
          transactionId,
          callbackParameters,
          redirectUri: transaction.redirectUri,
          signal: boundedSignal
        }),
        {
          signal,
          timeoutMs: Math.max(1, expiresAt - now),
          timeoutCode: "oauth_completion_timeout",
          failureCode: "oauth_completion_failed"
        }
      );
    } catch (error) {
      await this.#cancelFlow(transactionId);
      throw error;
    }
    const credential = createStoredCredential({
      kind: "browser_oauth",
      apiKey: result?.apiKey,
      createdAt: currentIsoTime(this.#clock),
      expiresAt: result?.expiresAt,
      apiServerUrl: result?.apiServerUrl,
      accountName: result?.accountName
    });

    try {
      await this.#credentialStore.write(this.#credentialId, credential);
    } catch (error) {
      throw toBoundaryError(error, "credential_store_write_failed");
    }
    return describeCredential(credential);
  }

  async clear() {
    return removeCredentialKind(this.#credentialStore, this.#credentialId, "browser_oauth");
  }

  async cancel({ transactionId } = {}) {
    if (typeof transactionId !== "string" || transactionId.length === 0) {
      throw new ProviderBoundaryError("invalid_oauth_transaction");
    }

    const transaction = this.#transactions.get(transactionId);
    const existed = this.#transactions.delete(transactionId);
    if (transaction) {
      clearTimeout(transaction.expirationTimer);
    }
    if (existed && typeof this.#oauthFlow?.cancel === "function") {
      await runBounded(
        (boundedSignal) => this.#oauthFlow.cancel({ transactionId, signal: boundedSignal }),
        {
          timeoutMs: Math.min(this.#oauthTimeoutMs, 5_000),
          timeoutCode: "oauth_cancel_timeout",
          failureCode: "oauth_cancel_failed"
        }
      );
    }

    return existed;
  }
}

export class ManualApiKeyEntry {
  #featureGate;
  #credentialStore;
  #credentialId;
  #clock;

  constructor({ featureGate, credentialStore, credentialId, clock = () => new Date() } = {}) {
    this.#featureGate = featureGate;
    this.#credentialStore = credentialStore;
    this.#credentialId = credentialId;
    this.#clock = clock;
  }

  async save({ apiKey, expiresAt, apiServerUrl, accountName } = {}) {
    this.#featureGate.assertEnabled();
    const credential = createStoredCredential({
      kind: "manual_api_key",
      apiKey,
      createdAt: currentIsoTime(this.#clock),
      expiresAt,
      apiServerUrl,
      accountName
    });

    try {
      await this.#credentialStore.write(this.#credentialId, credential);
    } catch (error) {
      throw toBoundaryError(error, "credential_store_write_failed");
    }
    return describeCredential(credential);
  }

  async clear() {
    return removeCredentialKind(this.#credentialStore, this.#credentialId, "manual_api_key");
  }
}
