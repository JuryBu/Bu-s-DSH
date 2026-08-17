import { ProviderBoundaryError, toBoundaryError } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requireCredentialId(credentialId) {
  if (typeof credentialId !== "string" || credentialId.length === 0) {
    throw new ProviderBoundaryError("invalid_credential_id");
  }
}

function normalizeOptionalTime(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ProviderBoundaryError("invalid_credential_time");
  }

  return parsed.toISOString();
}

function cloneCredential(credential) {
  return {
    kind: credential.kind,
    apiKey: credential.apiKey,
    createdAt: credential.createdAt,
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    ...(credential.apiServerUrl ? { apiServerUrl: credential.apiServerUrl } : {}),
    ...(credential.accountName ? { accountName: credential.accountName } : {})
  };
}

function normalizeApiServerUrl(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderBoundaryError("invalid_api_server_url");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new ProviderBoundaryError("invalid_api_server_url");
  }
  return parsed.href.replace(/\/$/u, "");
}

function normalizeAccountName(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.length > 256) {
    throw new ProviderBoundaryError("invalid_account_name");
  }
  return value;
}

export function createStoredCredential({ kind, apiKey, createdAt, expiresAt, apiServerUrl, accountName } = {}) {
  if (kind !== "browser_oauth" && kind !== "manual_api_key") {
    throw new ProviderBoundaryError("invalid_credential_kind");
  }

  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new ProviderBoundaryError("invalid_api_key");
  }

  const normalizedCreatedAt = normalizeOptionalTime(createdAt ?? new Date()) ?? new Date().toISOString();
  const normalizedExpiresAt = normalizeOptionalTime(expiresAt);
  if (normalizedExpiresAt && new Date(normalizedExpiresAt).valueOf() <= new Date(normalizedCreatedAt).valueOf()) {
    throw new ProviderBoundaryError("credential_expired");
  }

  return {
    kind,
    apiKey,
    createdAt: normalizedCreatedAt,
    ...(normalizedExpiresAt ? { expiresAt: normalizedExpiresAt } : {}),
    ...(normalizeApiServerUrl(apiServerUrl) ? { apiServerUrl: normalizeApiServerUrl(apiServerUrl) } : {}),
    ...(normalizeAccountName(accountName) ? { accountName: normalizeAccountName(accountName) } : {})
  };
}

export function describeCredential(credential) {
  if (!credential) {
    return { configured: false, mode: "none", expiresAt: null };
  }

  return {
    configured: true,
    mode: credential.kind,
    expiresAt: credential.expiresAt ?? null,
    accountName: credential.accountName ?? null,
    apiServerUrl: credential.apiServerUrl ?? null
  };
}

export class InMemoryFakeCredentialStore {
  #records = new Map();

  async read(credentialId) {
    requireCredentialId(credentialId);
    const credential = this.#records.get(credentialId);
    return credential ? cloneCredential(credential) : undefined;
  }

  async write(credentialId, credential) {
    requireCredentialId(credentialId);
    this.#records.set(credentialId, createStoredCredential(credential));
  }

  async remove(credentialId) {
    requireCredentialId(credentialId);
    this.#records.delete(credentialId);
  }
}

export class WindowsDpapiCurrentUserCredentialStore {
  #encryptedRecordStore;
  #currentUserProtector;

  constructor({ encryptedRecordStore, currentUserProtector } = {}) {
    if (!encryptedRecordStore || typeof encryptedRecordStore.read !== "function" || typeof encryptedRecordStore.write !== "function" || typeof encryptedRecordStore.remove !== "function") {
      throw new ProviderBoundaryError("invalid_encrypted_record_store");
    }

    if (!currentUserProtector || typeof currentUserProtector.protectCurrentUser !== "function" || typeof currentUserProtector.unprotectCurrentUser !== "function") {
      throw new ProviderBoundaryError("invalid_dpapi_current_user_protector");
    }

    if (currentUserProtector.scope !== "CurrentUser") {
      throw new ProviderBoundaryError("dpapi_scope_must_be_current_user");
    }

    this.#encryptedRecordStore = encryptedRecordStore;
    this.#currentUserProtector = currentUserProtector;
  }

  async read(credentialId) {
    requireCredentialId(credentialId);
    let encryptedPayload;
    try {
      encryptedPayload = await this.#encryptedRecordStore.read(credentialId);
    } catch (error) {
      throw toBoundaryError(error, "credential_store_read_failed");
    }
    if (encryptedPayload === undefined || encryptedPayload === null) {
      return undefined;
    }

    if (!(encryptedPayload instanceof Uint8Array)) {
      throw new ProviderBoundaryError("invalid_encrypted_credential_payload");
    }

    let plaintext;
    try {
      plaintext = await this.#currentUserProtector.unprotectCurrentUser(new Uint8Array(encryptedPayload));
    } catch (error) {
      throw toBoundaryError(error, "credential_unprotect_failed");
    }
    if (!(plaintext instanceof Uint8Array)) {
      throw new ProviderBoundaryError("invalid_dpapi_plaintext_payload");
    }

    try {
      return createStoredCredential(JSON.parse(decoder.decode(plaintext)));
    } catch {
      throw new ProviderBoundaryError("invalid_protected_credential");
    } finally {
      plaintext.fill(0);
    }
  }

  async write(credentialId, credential) {
    requireCredentialId(credentialId);
    const normalizedCredential = createStoredCredential(credential);
    const plaintext = encoder.encode(JSON.stringify(normalizedCredential));
    let encryptedPayload;

    try {
      const protectedValue = await this.#currentUserProtector.protectCurrentUser(plaintext);
      if (!(protectedValue instanceof Uint8Array)) {
        throw new ProviderBoundaryError("invalid_dpapi_encrypted_payload");
      }
      if (protectedValue.buffer === plaintext.buffer) {
        throw new ProviderBoundaryError("dpapi_ciphertext_must_not_alias_plaintext");
      }
      encryptedPayload = new Uint8Array(protectedValue);
    } catch (error) {
      throw toBoundaryError(error, "credential_protect_failed");
    } finally {
      plaintext.fill(0);
    }

    try {
      await this.#encryptedRecordStore.write(credentialId, encryptedPayload);
    } catch (error) {
      throw toBoundaryError(error, "credential_store_write_failed");
    }
  }

  async remove(credentialId) {
    requireCredentialId(credentialId);
    try {
      await this.#encryptedRecordStore.remove(credentialId);
    } catch (error) {
      throw toBoundaryError(error, "credential_store_remove_failed");
    }
  }
}
