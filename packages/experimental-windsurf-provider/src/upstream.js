import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

let upstreamPromise;

function packageRoot() {
  const entry = fileURLToPath(import.meta.resolve("opencode-windsurf-auth"));
  return resolve(dirname(entry), "..");
}

function importInternal(root, relativePath) {
  return import(pathToFileURL(join(root, relativePath)).href);
}

export function loadWindsurfUpstream() {
  if (!upstreamPromise) {
    const root = packageRoot();
    upstreamPromise = Promise.all([
      importInternal(root, "dist/src/cloud-direct/index.js"),
      importInternal(root, "dist/src/cloud-direct/metadata.js"),
      importInternal(root, "dist/src/cloud-direct/wire.js"),
      importInternal(root, "dist/src/oauth/register-user.js")
    ]).then(([cloud, metadata, wire, registration]) => ({
      ...cloud,
      buildMetadata: metadata.buildMetadata,
      encodeMessage: wire.encodeMessage,
      iterFields: wire.iterFields,
      registerUser: registration.registerUser
    }));
  }
  return upstreamPromise;
}
