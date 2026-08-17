import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import type { FixtureZstdDecoder } from "../../src/fixture-fallback.ts";

const MAGIC = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]);
const REGISTERED_FRAMES: Uint8Array[] = [];

function startsWithMagic(input: Uint8Array, offset: number): boolean {
  return MAGIC.every((value, index) => input[offset + index] === value);
}

export function encodeSyntheticZstdFrame(text: string): Uint8Array {
  const frame = zstdCompressSync(new TextEncoder().encode(text));
  REGISTERED_FRAMES.push(frame.slice());
  return frame;
}

export function encodeSyntheticZstdFrames(texts: string[]): Uint8Array {
  const parts = texts.map(encodeSyntheticZstdFrame);
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export const syntheticZstdDecoder: FixtureZstdDecoder = {
  async decodeAvailable(input, absoluteOffset) {
    const frames = [];
    let offset = 0;
    let committedThroughOffset = absoluteOffset;
    while (offset < input.byteLength) {
      if (offset + MAGIC.byteLength > input.byteLength) {
        break;
      }
      if (!startsWithMagic(input, offset)) {
        throw new Error("Synthetic fixture does not start at a registered Zstandard frame boundary.");
      }
      const remaining = input.slice(offset);
      const frame = REGISTERED_FRAMES.find(candidate =>
        remaining.byteLength >= candidate.byteLength
        && candidate.every((value, index) => remaining[index] === value),
      );
      if (!frame) {
        break;
      }
      const end = offset + frame.byteLength;
      const text = new TextDecoder().decode(zstdDecompressSync(frame));
      frames.push({
        sourceStartOffset: absoluteOffset + offset,
        sourceEndOffset: absoluteOffset + end,
        text,
      });
      offset = end;
      committedThroughOffset = absoluteOffset + end;
    }
    return { frames, committedThroughOffset };
  },
};
