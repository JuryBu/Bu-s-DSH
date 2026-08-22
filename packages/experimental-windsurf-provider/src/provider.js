import { BrowserOAuthEntry, ManualApiKeyEntry } from "./auth.js";
import { DynamicModelCatalog } from "./catalog.js";
import { describeCredential } from "./credentials.js";
import { ProviderBoundaryError, safeErrorCode, toBoundaryError } from "./errors.js";
import { ExperimentalFeatureGate } from "./feature-gate.js";
import { windsurfFallbackCatalogModels } from "./pi-provider.js";
import { adaptNativeStream } from "./stream.js";

const defaultCredentialId = "experimental-windsurf-devin-provider";

export const DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG = Object.freeze({
  enabled: false,
  communityRiskAccepted: false,
  authenticationMode: "browser_oauth",
  credentialId: defaultCredentialId
});

function normalizeAuthenticationMode(value) {
  if (value !== "browser_oauth" && value !== "manual_api_key") {
    throw new ProviderBoundaryError("invalid_authentication_mode");
  }

  return value;
}

function resolveCredentialIds(credentialId, credentialIds) {
  if (typeof credentialId !== "string" || credentialId.length === 0) {
    throw new ProviderBoundaryError("invalid_credential_id");
  }

  const resolved = {
    browser_oauth: credentialIds?.browserOAuth ?? `${credentialId}:browser_oauth`,
    manual_api_key: credentialIds?.manualApiKey ?? `${credentialId}:manual_api_key`
  };
  if (typeof resolved.browser_oauth !== "string" || resolved.browser_oauth.length === 0 || typeof resolved.manual_api_key !== "string" || resolved.manual_api_key.length === 0) {
    throw new ProviderBoundaryError("invalid_credential_id");
  }
  if (resolved.browser_oauth === resolved.manual_api_key) {
    throw new ProviderBoundaryError("credential_ids_must_be_distinct");
  }

  return resolved;
}

class UnconfiguredCredentialStore {
  async read() {
    throw new ProviderBoundaryError("credential_store_not_configured");
  }

  async write() {
    throw new ProviderBoundaryError("credential_store_not_configured");
  }

  async remove() {
    throw new ProviderBoundaryError("credential_store_not_configured");
  }
}

class UnconfiguredCatalogSource {
  async fetch() {
    throw new ProviderBoundaryError("catalog_source_not_configured");
  }
}

class UnconfiguredTransport {
  stream() {
    throw new ProviderBoundaryError("transport_not_configured");
  }
}

export class ExperimentalWindsurfDevinProvider {
  #credentialStore;
  #credentialIds;
  #authenticationMode;
  #catalog;
  #transport;
  #clock;

  constructor({
    featureGate = new ExperimentalFeatureGate(),
    credentialStore = new UnconfiguredCredentialStore(),
    credentialId = defaultCredentialId,
    credentialIds,
    authenticationMode = DEFAULT_EXPERIMENTAL_WINDSURF_PROVIDER_CONFIG.authenticationMode,
    oauthFlow,
    catalogSource = new UnconfiguredCatalogSource(),
    capabilityResolver,
    transport = new UnconfiguredTransport(),
    clock = () => new Date(),
    oauthTimeoutMs
  } = {}) {
    this.id = "experimental-windsurf-devin";
    this.featureGate = featureGate;
    this.#credentialStore = credentialStore;
    this.#credentialIds = resolveCredentialIds(credentialId, credentialIds);
    this.#authenticationMode = normalizeAuthenticationMode(authenticationMode);
    this.#catalog = new DynamicModelCatalog({ source: catalogSource, capabilityResolver, clock, fallbackModels: windsurfFallbackCatalogModels() });
    this.#transport = transport;
    this.#clock = clock;
    this.browserOAuth = new BrowserOAuthEntry({
      featureGate,
      credentialStore,
      credentialId: this.#credentialIds.browser_oauth,
      oauthFlow,
      clock,
      oauthTimeoutMs
    });
    this.manualApiKey = new ManualApiKeyEntry({
      featureGate,
      credentialStore,
      credentialId: this.#credentialIds.manual_api_key,
      clock
    });
  }

  get authenticationMode() {
    return this.#authenticationMode;
  }

  async getStatus() {
    const experimental = this.featureGate.getStatus();
    if (!experimental.enabled) {
      return {
        providerId: this.id,
        experimental,
        authentication: {
          configured: false,
          mode: "not_checked",
          selectedMode: this.#authenticationMode,
          expiresAt: null,
          methods: {
            browser_oauth: { configured: false, mode: "not_checked", expiresAt: null },
            manual_api_key: { configured: false, mode: "not_checked", expiresAt: null }
          }
        },
        catalog: this.#catalog.getStatus(),
        communityProvider: true
      };
    }

    const [browserOAuth, manualApiKey] = await Promise.all([
      this.#readCredentialSummary("browser_oauth"),
      this.#readCredentialSummary("manual_api_key")
    ]);
    const methods = {
      browser_oauth: browserOAuth,
      manual_api_key: manualApiKey
    };
    const selected = methods[this.#authenticationMode];
    return {
      providerId: this.id,
      experimental,
      authentication: {
        ...selected,
        selectedMode: this.#authenticationMode,
        methods
      },
      catalog: this.#catalog.getStatus(),
      communityProvider: true
    };
  }

  listModels() {
    return this.featureGate.isEnabled() ? this.#catalog.list() : [];
  }

  async refreshModels({ signal } = {}) {
    this.featureGate.assertEnabled();
    if (signal?.aborted) {
      throw new ProviderBoundaryError("aborted");
    }

    try {
      const apiKey = await this.#resolveApiKey();
      return await this.#catalog.refresh({ apiKey, signal });
    } catch (error) {
      throw toBoundaryError(error, "catalog_refresh_failed");
    }
  }

  async clearCredentials() {
    await Promise.all([
      this.#credentialStore.remove(this.#credentialIds.browser_oauth),
      this.#credentialStore.remove(this.#credentialIds.manual_api_key)
    ]);
    this.#catalog.clear();
  }

  async *stream({ modelUid, messages = [], tools = [], signal } = {}) {
    const experimental = this.featureGate.getStatus();
    if (!experimental.enabled) {
      yield { type: "error", code: experimental.reason };
      return;
    }

    if (signal?.aborted) {
      yield { type: "error", code: "aborted" };
      return;
    }

    const model = this.#catalog.get(modelUid);
    if (!model || model.availability !== "available") {
      yield { type: "error", code: "model_not_available" };
      return;
    }

    let apiKey;
    try {
      apiKey = await this.#resolveApiKey();
    } catch (error) {
      yield { type: "error", code: safeErrorCode(error, "credential_store_unavailable") };
      return;
    }

    const request = {
      providerId: this.id,
      modelUid: model.modelUid,
      messages,
      tools,
      apiKey,
      signal
    };

    for await (const event of adaptNativeStream({ transport: this.#transport, request })) {
      yield event;
    }
  }

  async #resolveApiKey() {
    let credential;
    try {
      credential = await this.#credentialStore.read(this.#credentialIds[this.#authenticationMode]);
    } catch (error) {
      throw toBoundaryError(error, "credential_store_read_failed");
    }
    if (!credential || typeof credential.apiKey !== "string" || credential.apiKey.length === 0) {
      throw new ProviderBoundaryError("credential_not_configured");
    }
    if (credential.kind !== this.#authenticationMode) {
      throw new ProviderBoundaryError("credential_kind_mismatch");
    }

    if (credential.expiresAt && this.#credentialExpiry(credential.expiresAt) <= this.#currentTime()) {
      throw new ProviderBoundaryError("credential_expired");
    }

    return credential.apiKey;
  }

  async #readCredentialSummary(kind) {
    try {
      const credential = await this.#credentialStore.read(this.#credentialIds[kind]);
      if (credential && credential.kind !== kind) {
        return { configured: false, mode: "unavailable", expiresAt: null, reason: "credential_kind_mismatch" };
      }
      const summary = describeCredential(credential);
      if (credential?.expiresAt && this.#credentialExpiry(credential.expiresAt) <= this.#currentTime()) {
        summary.configured = false;
        summary.reason = "credential_expired";
      }
      return summary;
    } catch (error) {
      return { configured: false, mode: "unavailable", expiresAt: null, reason: safeErrorCode(error, "credential_store_unavailable") };
    }
  }

  #currentTime() {
    const parsed = new Date(this.#clock());
    if (Number.isNaN(parsed.valueOf())) {
      throw new ProviderBoundaryError("invalid_clock_time");
    }

    return parsed.valueOf();
  }

  #credentialExpiry(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) {
      throw new ProviderBoundaryError("invalid_credential_time");
    }

    return parsed.valueOf();
  }
}

export function createExperimentalWindsurfDevinProvider(options) {
  return new ExperimentalWindsurfDevinProvider(options);
}
