import { open, rm } from "node:fs/promises";

const lockPath = process.argv[2];
let handle;

try {
  handle = await open(lockPath, "wx");
  await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
  await handle.sync();
  process.send?.({ type: "locked" });
  process.on("message", async message => {
    if (message?.type !== "release") return;
    await handle?.close();
    await rm(lockPath, { force: true });
    process.exit(0);
  });
} catch (error) {
  process.send?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
