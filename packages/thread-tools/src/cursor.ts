import { createHash } from "node:crypto";

import { CursorError } from "./errors.ts";

interface CursorEnvelope<TPayload> {
  version: 1;
  kind: string;
  payload: TPayload;
}

const CURSOR_PREFIX = "dsh-thread-v1";

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function fingerprintCursorRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function encodeCursor<TPayload>(kind: string, payload: TPayload): string {
  const envelope: CursorEnvelope<TPayload> = {
    version: 1,
    kind,
    payload,
  };
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}.${encoded}.${checksum(encoded)}`;
}

export function decodeCursor<TPayload>(cursor: string, expectedKind: string): TPayload {
  const [prefix, encoded, suppliedChecksum, extra] = cursor.split(".");
  if (prefix !== CURSOR_PREFIX || !encoded || !suppliedChecksum || extra) {
    throw new CursorError("Cursor shape is invalid.");
  }
  if (checksum(encoded) !== suppliedChecksum) {
    throw new CursorError("Cursor checksum does not match its payload.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new CursorError("Cursor payload is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CursorError("Cursor envelope must be an object.");
  }
  const envelope = parsed as Partial<CursorEnvelope<TPayload>>;
  if (envelope.version !== 1 || envelope.kind !== expectedKind || !("payload" in envelope)) {
    throw new CursorError(`Cursor does not belong to ${expectedKind}.`);
  }
  return envelope.payload as TPayload;
}
