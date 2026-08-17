import { applyUpdate, parsePatch } from "./patch-engine.js";

export const name = "stardust-apply-patch";
export const inject = ["tools", "fs", "systemPrompt"];

function sessionCwd(exec, policy) {
  return policy?.workspaceRoot ?? exec.agent?.session?.header?.cwd;
}

function renderResult(value) {
  const files = value.files.map(file => `${file.operation === "create" ? "新增" : "更新"} ${file.path}`).join("\n");
  return [{ type: "text", text: `补丁已完整应用：\n${files}` }];
}

async function standingPolicy(ctx, exec) {
  if (ctx.fs.sandboxMode === undefined) return undefined;
  const resolver = ctx.get?.("sandboxPolicy");
  if (!resolver) throw new Error("apply_patch：文件系统启用了沙箱，但缺少 sandboxPolicy 服务");
  return resolver.resolve({ ...(exec.agent ? { session: exec.agent.session } : {}) });
}

async function preflight(ctx, operation, exec, policy) {
  const cwd = sessionCwd(exec, policy);
  const pathInfo = await ctx.fs.lstat(operation.path, { cwd }, exec.signal);
  if (pathInfo?.type === "symlink") throw new Error(`apply_patch 拒绝修改符号链接路径：${operation.path}`);
  const target = await ctx.fs.resolve(operation.path, { cwd, signal: exec.signal });
  const info = await ctx.fs.stat(target, exec.signal);

  if (operation.kind === "add") {
    if (info !== undefined) throw new Error(`新增文件已经存在：${operation.path}`);
    ctx.emit("fs/observed", target, { kind: "absent" }, exec);
    return { operation, target, before: null, after: operation.content };
  }
  if (!info) throw new Error(`更新文件不存在：${operation.path}`);
  if (info.type !== "file") throw new Error(`更新目标不是普通文件：${operation.path}`);
  const before = await ctx.fs.readText(target, exec.signal);
  const after = applyUpdate(before, operation.hunks, operation.path);
  if (after === before) throw new Error(`补丁没有改变文件：${operation.path}`);
  ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);
  return { operation, target, before, after };
}

async function rollback(ctx, committed, exec, policy) {
  const failures = [];
  for (const item of [...committed].reverse()) {
    if (item.before === null) {
      failures.push(`${item.operation.path} 是已新增文件，DSH rc.6 没有安全删除接口`);
      continue;
    }
    try {
      const restored = await ctx.fs.writeText(
        item.target,
        item.before,
        { kind: "replaceIfVersion", version: item.version },
        exec.signal,
        policy,
      );
      ctx.emit("fs/observed", item.target, { kind: "present", version: restored.version }, exec);
    } catch (error) {
      failures.push(`${item.operation.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

export async function apply(ctx, config = {}) {
  const defineTool = config.defineTool ?? (await import("@deepseek-ai/dsh-tools")).defineTool;

  ctx.systemPrompt.section({
    name: "tool:apply_patch",
    order: 102,
    text: "修改已有文本文件时优先使用 apply_patch。它会先校验整份补丁，再一次应用多个文件；单次简单创建可继续使用 write。主力模式不使用旧 edit 工具。",
  });
  const disposeAssembly = ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembly = await next();
    return {
      ...assembly,
      sections: assembly.sections.filter(section => section.name !== "tool:edit"),
      tools: assembly.tools.filter(tool => tool.name !== "edit"),
    };
  });
  const disposeGuard = ctx.tools.guard(exec => exec.name === "edit"
    ? "主力模式已停用旧 edit 工具，请改用 apply_patch；需要救援时可手动切换官方标准模式"
    : undefined);

  const disposeTool = ctx.tools.register(defineTool({
    name: "apply_patch",
    description: "先完整校验、再原子式应用一个或多个 UTF-8 文本文件补丁；失败时回滚已经更新的文件。",
    parameters: {
      patch: {
        type: "string",
        required: true,
        description: "使用 *** Begin Patch / *** End Patch 包裹的补丁正文。支持 Add File 与 Update File。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          files: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                operation: { type: "string", required: true },
                before: { type: "json", required: true },
                after: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderResult(value),
      presentationMeta: (_args, value) => ({
        diffs: value.files.map(file => ({ path: file.path, oldText: file.before, newText: file.after })),
      }),
    },
    async execute(args, exec) {
      const operations = parsePatch(args.patch);
      const policy = await standingPolicy(ctx, exec);
      const prepared = [];
      for (const operation of operations) prepared.push(await preflight(ctx, operation, exec, policy));

      const ordered = [
        ...prepared.filter(item => item.operation.kind === "update"),
        ...prepared.filter(item => item.operation.kind === "add"),
      ];
      const committed = [];
      try {
        for (const item of ordered) {
          const intent = await ctx.waterfall("fs/write-intent", item.target, exec, () => undefined);
          const outcome = await ctx.fs.writeText(item.target, item.after, intent, exec.signal, policy);
          committed.push({ ...item, version: outcome.version });
          ctx.emit("fs/observed", item.target, { kind: "present", version: outcome.version }, exec);
        }
      } catch (error) {
        const rollbackFailures = await rollback(ctx, committed, exec, policy);
        const cause = error instanceof Error ? error.message : String(error);
        if (rollbackFailures.length > 0) {
          throw new Error(`apply_patch 写入失败：${cause}；以下文件未能自动恢复：${rollbackFailures.join("；")}`);
        }
        throw new Error(`apply_patch 写入失败，已恢复先前更新：${cause}`);
      }
      return {
        files: committed.map(item => ({
          path: item.target.displayPath,
          operation: item.before === null ? "create" : "update",
          before: item.before,
          after: item.after,
        })),
      };
    },
    presentCall() {
      return { card: "diff", title: "Apply patch" };
    },
    presentResult(_args, result) {
      if (result.isError || !result.meta?.diffs) return undefined;
      return { card: "diff", title: "Apply patch", diffs: result.meta.diffs };
    },
  }));

  return async () => {
    await disposeTool?.();
    await disposeGuard?.();
    await disposeAssembly?.();
  };
}

export { applyUpdate, parsePatch };
