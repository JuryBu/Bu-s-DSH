import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "../lib/index.js";
import { applyUpdate, parsePatch } from "../lib/patch-engine.js";

test("解析并应用多文件更新与单个新增", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: a.txt
@@
 alpha
-beta
+BETA
*** Add File: b.txt
+hello
+world
*** End Patch`);
  assert.equal(operations.length, 2);
  assert.equal(applyUpdate("alpha\nbeta\ngamma\n", operations[0].hunks, "a.txt"), "alpha\nBETA\ngamma\n");
  assert.equal(operations[1].content, "hello\nworld\n");
});

test("重复匹配时拒绝猜测", () => {
  const [operation] = parsePatch(`*** Begin Patch
*** Update File: a.txt
@@
-same
+changed
*** End Patch`);
  assert.throws(() => applyUpdate("same\nother\nsame\n", operation.hunks, "a.txt"), /匹配多处/u);
});

test("删除和多个新增在写入前失败", () => {
  assert.throws(() => parsePatch(`*** Begin Patch
*** Delete File: a.txt
*** End Patch`), /没有安全删除接口/u);
  assert.throws(() => parsePatch(`*** Begin Patch
*** Add File: a.txt
+a
*** Add File: b.txt
+b
*** End Patch`), /最多新增一个文件/u);
});

function createFakeContext() {
  let assemblyHook;
  let guard;
  let tool;
  const files = new Map([
    ["a.txt", { text: "alpha\none\n", version: 1 }],
    ["b.txt", { text: "beta\ntwo\n", version: 1 }],
  ]);
  const ctx = {
    systemPrompt: { section() {} },
    on(name, callback) {
      assert.equal(name, "system-prompt/assemble");
      assemblyHook = callback;
      return () => {};
    },
    tools: {
      guard(callback) {
        guard = callback;
        return () => {};
      },
      register(value) {
        tool = value;
        return () => {};
      },
    },
    fs: {
      sandboxMode: undefined,
      async lstat(path) {
        return files.has(path) ? { type: "file" } : undefined;
      },
      async resolve(path) {
        return { key: path, displayPath: path };
      },
      async stat(target) {
        const file = files.get(target.key);
        return file ? { type: "file", version: file.version } : undefined;
      },
      async readText(target) {
        return files.get(target.key).text;
      },
      async writeText(target, text, intent) {
        const file = files.get(target.key);
        if (target.key === "b.txt" && text.includes("TWO")) throw new Error("模拟第二个文件写入失败");
        if (intent?.kind === "replaceIfVersion") assert.equal(intent.version, file.version);
        const next = { text, version: file.version + 1 };
        files.set(target.key, next);
        return { version: next.version };
      },
    },
    emit() {},
    async waterfall(_name, _target, _exec, fallback) {
      return fallback();
    },
  };
  return {
    ctx,
    files,
    values: () => ({ assemblyHook, guard, tool }),
  };
}

test("主力模式隐藏旧 edit，并在多文件失败时恢复已写入文件", async () => {
  const fixture = createFakeContext();
  await apply(fixture.ctx, { defineTool: value => value });
  const { assemblyHook, guard, tool } = fixture.values();
  const filtered = await assemblyHook({}, {}, async () => ({
    sections: [{ name: "tool:edit" }, { name: "tool:read" }],
    tools: [{ name: "edit" }, { name: "read" }],
  }));
  assert.deepEqual(filtered.sections, [{ name: "tool:read" }]);
  assert.deepEqual(filtered.tools, [{ name: "read" }]);
  assert.match(guard({ name: "edit" }), /改用 apply_patch/u);
  assert.equal(guard({ name: "read" }), undefined);
  assert.equal(tool.output.schema.properties.files.items.type, "object");
  assert.equal(tool.output.schema.properties.files.items.properties.path.type, "string");

  await assert.rejects(
    tool.execute({ patch: `*** Begin Patch
*** Update File: a.txt
@@
-one
+ONE
*** Update File: b.txt
@@
-two
+TWO
*** End Patch` }, { signal: undefined, agent: { session: { header: { cwd: "C:/workspace" } } } }),
    /已恢复先前更新/u,
  );
  assert.equal(fixture.files.get("a.txt").text, "alpha\none\n");
  assert.equal(fixture.files.get("b.txt").text, "beta\ntwo\n");
});
