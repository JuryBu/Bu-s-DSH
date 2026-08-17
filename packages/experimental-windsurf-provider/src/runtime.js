import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createStoredCredential, describeCredential, WindowsDpapiCurrentUserCredentialStore } from "./credentials.js";
import { AtomicEncryptedRecordStore, WindowsDpapiCurrentUserProtector, windsurfStoreRoot } from "./runtime-store.js";
import { loadWindsurfUpstream } from "./upstream.js";

export const windsurfCredentialIds = Object.freeze({
  browser_oauth: "windsurf:browser_oauth",
  manual_api_key: "windsurf:manual_api_key"
});

const preferencePath = process.env.DSH_WINDSURF_PREFERENCE_PATH ?? join(windsurfStoreRoot, "preference.json");
export const windsurfCredentialStore = new WindowsDpapiCurrentUserCredentialStore({
  encryptedRecordStore: new AtomicEncryptedRecordStore(windsurfStoreRoot),
  currentUserProtector: new WindowsDpapiCurrentUserProtector()
});

async function readPreference() {
  try {
    const parsed = JSON.parse(await readFile(preferencePath, "utf8"));
    return parsed?.version === 1 && (parsed.authenticationMode === "browser_oauth" || parsed.authenticationMode === "manual_api_key")
      ? parsed.authenticationMode
      : "browser_oauth";
  } catch (error) {
    if (error?.code === "ENOENT") return "browser_oauth";
    return "browser_oauth";
  }
}

async function writePreference(authenticationMode) {
  await mkdir(windsurfStoreRoot, { recursive: true, mode: 0o700 });
  const temporary = join(windsurfStoreRoot, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, authenticationMode })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, preferencePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function setWindsurfAuthenticationMode(authenticationMode) {
  if (authenticationMode !== "browser_oauth" && authenticationMode !== "manual_api_key") throw new Error("invalid_authentication_mode");
  await writePreference(authenticationMode);
}

export async function readWindsurfCredential(authenticationMode) {
  const selected = authenticationMode ?? await readPreference();
  const first = await windsurfCredentialStore.read(windsurfCredentialIds[selected]);
  if (first) return first;
  const fallbackMode = selected === "browser_oauth" ? "manual_api_key" : "browser_oauth";
  return windsurfCredentialStore.read(windsurfCredentialIds[fallbackMode]);
}

export async function saveWindsurfCredential(authenticationMode, input) {
  const credential = createStoredCredential({ kind: authenticationMode, ...input });
  await windsurfCredentialStore.write(windsurfCredentialIds[authenticationMode], credential);
  await writePreference(authenticationMode);
  const upstream = await loadWindsurfUpstream();
  upstream.clearCachedUserJwt?.();
  return describeCredential(credential);
}

export async function clearWindsurfCredential(authenticationMode) {
  await windsurfCredentialStore.remove(windsurfCredentialIds[authenticationMode]);
  const upstream = await loadWindsurfUpstream();
  upstream.clearCachedUserJwt?.();
}

export async function clearAllWindsurfCredentials() {
  await Promise.all(Object.keys(windsurfCredentialIds).map((mode) => clearWindsurfCredential(mode)));
}

export async function getWindsurfStatus() {
  const authenticationMode = await readPreference();
  const entries = await Promise.all(Object.entries(windsurfCredentialIds).map(async ([mode, credentialId]) => [mode, describeCredential(await windsurfCredentialStore.read(credentialId))]));
  const methods = Object.fromEntries(entries);
  return {
    connected: methods[authenticationMode].configured,
    authenticationMode,
    methods,
    storage: "windows-dpapi-current-user",
    communityProvider: true
  };
}

export const windsurfApiKeyAuth = Object.freeze({
  name: "Windsurf 订阅或 API Key",
  async check() {
    const credential = await readWindsurfCredential();
    return credential ? { type: "api_key", source: credential.kind === "browser_oauth" ? "Windsurf OAuth" : "Windsurf API Key" } : undefined;
  },
  async resolve() {
    const credential = await readWindsurfCredential();
    if (!credential) return undefined;
    return {
      auth: {
        apiKey: credential.apiKey,
        baseUrl: credential.apiServerUrl ?? "https://server.codeium.com"
      },
      source: credential.kind === "browser_oauth" ? "Windsurf OAuth" : "Windsurf API Key"
    };
  }
});
