#!/usr/bin/env node
/**
 * frontend-shot.mjs — 零依赖前端截图工具（Stage 11 前端壳专用）
 *
 * 只用于静态样式稿与本地页面的快速视觉迭代：
 *   - 不安装 playwright / puppeteer，不下载浏览器
 *   - 复用系统已安装的 Edge 或 Chrome，走原生 CDP（Node 原生 WebSocket）
 *   - 端口固定为 0 由系统分配，绝不与其它调试会话争抢端口
 *   - 截图前强制 prefers-reduced-motion: reduce 并等待字体就绪，保证同一份 CSS 每次像素一致
 *
 * 它不能替代真实候选验收：DSH 运行态的真实点击、事件、加载与失败态
 * 必须通过 web-fetcher 连接主人可见的真实 renderer 完成。
 *
 * 用法：
 *   node scripts/frontend-shot.mjs --config docs/evidence/stage11/frontend/mock/shots.json
 *   node scripts/frontend-shot.mjs --config <json> --only c-acct --widths 1440
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function resolveBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 Edge 或 Chrome，可用 --browser <exe 绝对路径> 显式指定");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevToolsPort(profileDir, timeoutMs = 20000) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, "utf8").split("\n");
      const port = Number.parseInt(raw[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await sleep(120);
  }
  throw new Error("等待浏览器写出 DevToolsActivePort 超时");
}

/** 极简 CDP 会话：id 自增 + Promise 表，不引入任何第三方库。 */
class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
        else entry.resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method);
      if (handlers === undefined) return;
      for (const handler of handlers.splice(0)) handler(message.params);
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`无法连接 CDP: ${this.url}`)), { once: true });
    });
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const handlers = this.listeners.get(method) ?? [];
      handlers.push(resolve);
      this.listeners.set(method, handlers);
    });
  }

  close() {
    if (this.socket !== undefined) this.socket.close();
  }
}

async function fetchJson(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status} ${route}`);
  return response.json();
}

async function boxOf(page, selector) {
  const { root } = await page.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) return undefined;
  const { model } = await page.send("DOM.getBoxModel", { nodeId });
  const [x1, y1, x2, , , y3] = model.border;
  return { x: x1, y: y1, width: x2 - x1, height: y3 - y1 };
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config;
  if (typeof configPath !== "string") throw new Error("必须提供 --config <json>");

  const repoRoot = process.cwd();
  const config = JSON.parse(await readFile(path.resolve(repoRoot, configPath), "utf8"));

  const pageUrl = config.url ?? pathToFileURL(path.resolve(repoRoot, config.file)).href;
  const outDir = path.resolve(repoRoot, args.out ?? config.out ?? ".");
  const scale = Number(args.scale ?? config.scale ?? 2);
  const padding = Number(config.padding ?? 8);
  const widths = (typeof args.widths === "string" ? args.widths.split(",") : config.widths ?? [1440])
    .map((value) => Number(value));
  const targets = config.targets.filter((target) => args.only === undefined || target.id === args.only);
  if (targets.length === 0) throw new Error("没有匹配的截图目标");

  await mkdir(outDir, { recursive: true });

  const browserPath = typeof args.browser === "string" ? args.browser : resolveBrowser();
  const profileDir = path.join(tmpdir(), `dsh-frontend-shot-${process.pid}-${Date.now()}`);
  await mkdir(profileDir, { recursive: true });

  const child = spawn(browserPath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--allow-file-access-from-files",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const written = [];
  let page;
  try {
    const port = await waitForDevToolsPort(profileDir);
    const list = await fetchJson(port, "/json/list");
    const target = list.find((entry) => entry.type === "page");
    if (target === undefined) throw new Error("浏览器没有可用的 page target");

    page = await new CdpSession(target.webSocketDebuggerUrl).open();
    await page.send("Page.enable");
    await page.send("DOM.enable");
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    for (const width of widths) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: Number(config.viewportHeight ?? 1000),
        deviceScaleFactor: 1,
        mobile: false,
      });

      const loaded = page.once("Page.loadEventFired");
      await page.send("Page.navigate", { url: pageUrl });
      await loaded;
      await page.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
      await sleep(Number(config.settleMs ?? 150));

      for (const item of targets) {
        const box = item.fullPage === true
          ? undefined
          : await boxOf(page, item.selector);
        if (item.fullPage !== true && box === undefined) {
          console.warn(`跳过 ${item.id}：选择器未命中 ${item.selector}`);
          continue;
        }

        const params = { format: "png", captureBeyondViewport: true, fromSurface: true };
        if (box !== undefined) {
          params.clip = {
            x: Math.max(0, box.x - padding),
            y: Math.max(0, box.y - padding),
            width: box.width + padding * 2,
            height: box.height + padding * 2,
            scale,
          };
        }

        const { data } = await page.send("Page.captureScreenshot", params);
        const file = path.join(outDir, `${item.id}-${width}.png`);
        await writeFile(file, Buffer.from(data, "base64"));
        written.push(path.relative(repoRoot, file).replaceAll("\\", "/"));
      }
    }
  } finally {
    if (page !== undefined) page.close();
    child.kill();
    await sleep(300);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`共写出 ${written.length} 张：`);
  for (const file of written) console.log(`  ${file}`);
}

main().catch((error) => {
  console.error(`截图失败：${error.message}`);
  process.exitCode = 1;
});
