import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic, withFileLock } from "@deepseek-ai/dsh-atomic-write";

const PROVIDER_ID = "openai-codex";
const STORE_HEADER = "DSH-OAUTH-DPAPI-V1\n";
const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local");
export const oauthStorePath = process.env.DSH_OAUTH_STORE_PATH ?? join(localAppData, "DeepSeekHarness", "state", "openai-codex-oauth.dpapi");

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$encoded = [Console]::In.ReadToEnd().Trim()
$cipher = [Convert]::FromBase64String($encoded)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`;

function runDpapi(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.resume();
    child.on("error", () => reject(new Error("Windows DPAPI helper could not start")));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("Windows DPAPI operation failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input, "utf8");
  });
}

function cloneCredential(credential) {
  return credential === undefined ? undefined : structuredClone(credential);
}

function validateCredential(credential) {
  if (credential?.type !== "oauth") throw new Error("OAuth store contains an unsupported credential type");
  if (typeof credential.access !== "string" || credential.access.length === 0) throw new Error("OAuth store access token is invalid");
  if (typeof credential.refresh !== "string" || credential.refresh.length === 0) throw new Error("OAuth store refresh token is invalid");
  if (!Number.isFinite(credential.expires) || credential.expires <= 0) throw new Error("OAuth store expiry is invalid");
  return structuredClone(credential);
}

async function readDocument(filename) {
  let encoded;
  try {
    encoded = await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  if (!encoded.startsWith(STORE_HEADER)) throw new Error("OAuth store header is invalid");
  const plain = await runDpapi(unprotectScript, encoded.slice(STORE_HEADER.length));
  let document;
  try {
    document = JSON.parse(plain);
  } catch {
    throw new Error("OAuth store payload is invalid");
  }
  if (document?.version !== 1 || typeof document.credentials !== "object" || document.credentials === null || Array.isArray(document.credentials)) {
    throw new Error("OAuth store schema is unsupported");
  }
  const credentials = new Map();
  const candidate = document.credentials[PROVIDER_ID];
  if (candidate !== undefined) credentials.set(PROVIDER_ID, validateCredential(candidate));
  return credentials;
}

async function writeDocument(filename, credentials) {
  const document = {
    version: 1,
    credentials: Object.fromEntries([...credentials].map(([providerId, credential]) => [providerId, cloneCredential(credential)])),
  };
  const cipher = await runDpapi(protectScript, JSON.stringify(document));
  await writeFileAtomic(filename, STORE_HEADER + cipher.trim() + "\n", {
    mode: 0o600,
    dirMode: 0o700,
  });
}

class DpapiCredentialStore {
  filename;
  credentials = new Map();
  loaded = false;
  chains = new Map();

  constructor(filename) {
    this.filename = filename;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.credentials = await readDocument(this.filename);
    this.loaded = true;
  }

  enqueue(providerId, operation) {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.chains.set(providerId, next.catch(() => undefined));
    return next;
  }

  async read(providerId) {
    await this.ensureLoaded();
    return cloneCredential(this.credentials.get(providerId));
  }

  async list() {
    await this.ensureLoaded();
    return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId, fn) {
    if (providerId !== PROVIDER_ID) return Promise.reject(new Error(`OAuth store does not own provider ${providerId}`));
    return this.enqueue(providerId, async () => {
      await this.ensureLoaded();
      const current = cloneCredential(this.credentials.get(providerId));
      const candidate = await fn(current);
      if (candidate === undefined) return current;
      const next = validateCredential(candidate);
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      await withFileLock(this.filename, async () => {
        this.credentials.set(providerId, next);
        try {
          await writeDocument(this.filename, this.credentials);
        } catch (error) {
          if (current === undefined) this.credentials.delete(providerId);
          else this.credentials.set(providerId, current);
          throw error;
        }
      });
      return cloneCredential(next);
    });
  }

  delete(providerId) {
    if (providerId !== PROVIDER_ID) return Promise.resolve();
    return this.enqueue(providerId, async () => {
      await this.ensureLoaded();
      const current = cloneCredential(this.credentials.get(providerId));
      if (current === undefined) return;
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      await withFileLock(this.filename, async () => {
        this.credentials.delete(providerId);
        try {
          await writeDocument(this.filename, this.credentials);
        } catch (error) {
          this.credentials.set(providerId, current);
          throw error;
        }
      });
    });
  }
}

export const openAICodexCredentialStore = new DpapiCredentialStore(oauthStorePath);
export const openAICodexProviderId = PROVIDER_ID;
export const oauthStoreInstanceId = randomUUID();
