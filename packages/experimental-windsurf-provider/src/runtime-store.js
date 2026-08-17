import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ProviderBoundaryError } from "./errors.js";

const STORE_HEADER = "DSH-WINDSURF-DPAPI-V1\n";
const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local");
export const windsurfStoreRoot = process.env.DSH_WINDSURF_STORE_DIR ?? join(localAppData, "DeepSeekHarness", "state", "windsurf");

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$plain = [Console]::OpenStandardInput()
$memory = [IO.MemoryStream]::new()
$plain.CopyTo($memory)
$cipher = [Security.Cryptography.ProtectedData]::Protect($memory.ToArray(), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$encoded = [Console]::In.ReadToEnd().Trim()
$cipher = [Convert]::FromBase64String($encoded)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::OpenStandardOutput().Write($plain, 0, $plain.Length)
`;

function runDpapi(script, input, outputEncoding) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new ProviderBoundaryError("dpapi_operation_failed", { cause: Buffer.concat(stderr).toString("utf8") }));
        return;
      }
      const value = Buffer.concat(stdout);
      resolve(outputEncoding === "base64" ? Buffer.from(value.toString("utf8").trim(), "base64") : value);
    });
    child.stdin.end(input);
  });
}

export class WindowsDpapiCurrentUserProtector {
  scope = "CurrentUser";

  async protectCurrentUser(plaintext) {
    return new Uint8Array(await runDpapi(protectScript, Buffer.from(plaintext), "base64"));
  }

  async unprotectCurrentUser(encryptedPayload) {
    return new Uint8Array(await runDpapi(unprotectScript, Buffer.from(encryptedPayload).toString("base64"), "binary"));
  }
}

function filenameFor(root, credentialId) {
  const digest = createHash("sha256").update(credentialId, "utf8").digest("hex");
  return join(root, `${digest}.credential`);
}

async function acquireLock(lockPath, timeoutMs = 5_000) {
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      return async () => {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lockPath).then((value) => value.mtimeMs).catch(() => Date.now()));
      if (age > 30_000) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new ProviderBoundaryError("credential_store_lock_timeout");
      await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 40)));
    }
  }
}

export class AtomicEncryptedRecordStore {
  #root;
  #chains = new Map();

  constructor(root = windsurfStoreRoot) {
    this.#root = root;
  }

  #enqueue(credentialId, operation) {
    const previous = this.#chains.get(credentialId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.#chains.set(credentialId, next.catch(() => undefined));
    return next;
  }

  async read(credentialId) {
    const path = filenameFor(this.#root, credentialId);
    try {
      const document = await readFile(path, "utf8");
      if (!document.startsWith(STORE_HEADER)) throw new ProviderBoundaryError("credential_store_header_invalid");
      return new Uint8Array(Buffer.from(document.slice(STORE_HEADER.length).trim(), "base64"));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  write(credentialId, encryptedPayload) {
    return this.#enqueue(credentialId, async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const path = filenameFor(this.#root, credentialId);
      const release = await acquireLock(`${path}.lock`);
      const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${STORE_HEADER}${Buffer.from(encryptedPayload).toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
        await release();
      }
    });
  }

  remove(credentialId) {
    return this.#enqueue(credentialId, async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const path = filenameFor(this.#root, credentialId);
      const release = await acquireLock(`${path}.lock`);
      try {
        await rm(path, { force: true });
      } finally {
        await release();
      }
    });
  }
}
