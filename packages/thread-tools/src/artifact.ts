import { createHash } from "node:crypto";

import type { ThreadArtifactRef, ThreadRound } from "./types.ts";

export interface ThreadArtifactWriter {
  write(chunk: string): Promise<void>;
  complete(): Promise<ThreadArtifactRef>;
  abort(reason?: unknown): Promise<void>;
}

export interface ThreadArtifactStore {
  createTextArtifact(): Promise<ThreadArtifactWriter>;
}

export async function writeThreadRound(
  writer: ThreadArtifactWriter,
  round: ThreadRound,
  prependSeparator: boolean,
): Promise<void> {
  if (prependSeparator) {
    await writer.write("\n\n");
  }
  await writer.write(`[round ${round.round}][${round.role}]\n`);
  await writer.write(round.content);
}

export async function putThreadRoundsArtifact(
  store: ThreadArtifactStore,
  rounds: Iterable<ThreadRound>,
): Promise<ThreadArtifactRef> {
  const writer = await store.createTextArtifact();
  let wroteRound = false;
  try {
    for (const round of rounds) {
      await writeThreadRound(writer, round, wroteRound);
      wroteRound = true;
    }
    return await writer.complete();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
    }
    throw error;
  }
}

/** Test/fixture store only. Production adapters must inject a host-managed streaming store. */
export class InMemoryThreadArtifactStore implements ThreadArtifactStore {
  private readonly contents = new Map<string, string>();
  private sequence = 0;

  async createTextArtifact(): Promise<ThreadArtifactWriter> {
    const chunks: string[] = [];
    const hash = createHash("sha256");
    let bytes = 0;
    let lineBreaks = 0;
    let hasContent = false;
    let closed = false;

    return {
      write: async chunk => {
        if (closed) {
          throw new Error("Artifact writer is already closed.");
        }
        chunks.push(chunk);
        hash.update(chunk, "utf8");
        bytes += Buffer.byteLength(chunk, "utf8");
        lineBreaks += chunk.split("\n").length - 1;
        hasContent ||= chunk.length > 0;
      },
      complete: async () => {
        if (closed) {
          throw new Error("Artifact writer is already closed.");
        }
        closed = true;
        const sha256 = hash.digest("hex");
        const artifactId = `thread-artifact-${++this.sequence}-${sha256.slice(0, 12)}`;
        this.contents.set(artifactId, chunks.join(""));
        return {
          artifactId,
          sha256,
          bytes,
          lines: hasContent ? lineBreaks + 1 : 0,
          mediaType: "text/plain",
        };
      },
      abort: async () => {
        closed = true;
        chunks.length = 0;
      },
    };
  }

  getText(artifactId: string): string | undefined {
    return this.contents.get(artifactId);
  }
}
