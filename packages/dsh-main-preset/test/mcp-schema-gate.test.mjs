import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.DSH_MCP_CANDIDATE_ROOT;

const endpoints = [
  ["sandbox", "http://127.0.0.1:14588/sandbox/mcp"],
  ["memory-store", "http://127.0.0.1:14588/memory-store/mcp"],
  ["web-fetcher", "http://127.0.0.1:14588/web-fetcher/mcp"],
  ["exa", "http://127.0.0.1:14588/exa/mcp"],
  ["sequential-thinking", "http://127.0.0.1:14588/sequential-thinking/mcp"],
];

function candidateModule(packageName, modulePath = "lib/index.js") {
  return pathToFileURL(join(candidateRoot, "node_modules", "@deepseek-ai", packageName, modulePath)).href;
}

test("五个共享 MCP 真实同步后均进入 DSH 工具 Schema", { skip: !candidateRoot }, async () => {
  const { Context } = await import(candidateModule("cordis"));
  const { ToolRuntime } = await import(candidateModule("dsh-tools"));
  const { createScope, scopeOf } = await import(candidateModule("dsh-scope"));
  const mcpClient = await import(candidateModule("dsh-mcp-client"));
  const context = new Context();
  const fibers = [];
  let profileScope;
  let agentScope;

  context.provide("systemPrompt", { tools() {}, section() {} });
  try {
    const toolRuntime = context.plugin(ToolRuntime, { mode: "both" });
    fibers.push(toolRuntime);
    await toolRuntime;

    const scopeHost = context.inject(["tools"], (toolsCtx) => {
      profileScope = createScope(toolsCtx, { kind: "profile" });
      agentScope = createScope(toolsCtx, { kind: "agent" });
    });
    fibers.push(scopeHost);
    await scopeHost;
    profileScope.ctx.tools.register({
      name: "profile_only_sentinel",
      description: "只用于证明相邻 Agent 不会继承 Profile 私有工具。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
        render: () => [{ type: "text", text: "ok" }],
      },
      execute: async () => ({ ok: true }),
    });

    for (const [serverName, url] of endpoints) {
      const fiber = profileScope.ctx.plugin(mcpClient, {
        transport: "streamable-http",
        serverName,
        url,
        toolCallTimeoutMs: 15_000,
        failOnStartupError: true,
        reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 1 },
      });
      fibers.push(fiber);
      await fiber;
    }

    const agentCtx = agentScope.ctx.extend({ agent: { id: "schema-gate-agent" } });
    const profileNames = profileScope.ctx.tools.schemas(scopeOf(profileScope.ctx)).map((schema) => schema.name);
    const agentNames = agentCtx.tools.schemas(scopeOf(agentCtx)).map((schema) => schema.name);
    assert.ok(profileNames.includes("profile_only_sentinel"), "Profile 应看到自己的私有哨兵工具");
    assert.ok(!agentNames.includes("profile_only_sentinel"), "相邻 Agent 不得看到 Profile 私有哨兵工具");
    for (const [serverName] of endpoints) {
      const prefixes = [`mcp__${serverName}__`, `mcp__${serverName.replaceAll("-", "_")}__`];
      assert.ok(agentNames.some((name) => prefixes.some((prefix) => name.startsWith(prefix))), `相邻 Agent 缺少 ${serverName} 的模型工具 Schema`);
    }
  } finally {
    await agentScope?.dispose();
    await profileScope?.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose?.();
  }
});
