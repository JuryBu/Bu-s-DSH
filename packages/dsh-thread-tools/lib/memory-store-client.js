import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MemoryStoreCallError, MemoryStoreUnavailableError } from "./errors.js";

function toolText(result) {
  return (result?.content || [])
    .filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n");
}

export class BrokerMemoryStoreClient {
  constructor(options = {}) {
    this.endpoint = new URL(options.endpoint || "http://127.0.0.1:14588/memory-store/mcp");
    this.clientName = options.clientName || "dsh-native-thread-tools";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.client = undefined;
    this.connecting = undefined;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: this.clientName, version: "0.0.0-candidate" });
      try {
        await client.connect(new StreamableHTTPClientTransport(this.endpoint));
      } catch (error) {
        await client.close().catch(() => undefined);
        throw new MemoryStoreUnavailableError(`无法连接 Memory Store：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async callConversation(args) {
    const client = await this.connect();
    let timeout;
    try {
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new MemoryStoreUnavailableError(`Memory Store 调用超过 ${this.timeoutMs}ms`)), this.timeoutMs);
      });
      const result = await Promise.race([
        client.callTool({ name: "conversation_read_original", arguments: args }),
        deadline,
      ]);
      const text = toolText(result);
      if (result?.isError) throw new MemoryStoreCallError(text || "Memory Store 返回错误");
      return {
        text,
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        raw: result,
      };
    } catch (error) {
      if (error instanceof MemoryStoreCallError || error instanceof MemoryStoreUnavailableError) throw error;
      this.client = undefined;
      await client.close().catch(() => undefined);
      throw new MemoryStoreUnavailableError(`Memory Store 传输失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}
