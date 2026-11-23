import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixturePage, gapsFixtureConfig } from "./gaps-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-gaps-"));
const endpoint = "http://127.0.0.1:8765";
const token = "noah-gaps-fixture-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
let context, collector, proxy;

async function until(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(label);
}

try {
  const extension = path.join(temp, "extension");
  fs.cpSync(path.join(root, "dist/chrome"), extension, { recursive: true });
  const generated = path.join(extension, "sites.generated.js");
  fs.appendFileSync(generated, `\nATELIER_SITES.x = ${JSON.stringify(gapsFixtureConfig)};\n`);
  const data = path.join(temp, "data");
  fs.mkdirSync(data);
  collector = spawn(process.env.ATELIER_PYTHON || "python3", ["-B", "-u", "-c", `
from pathlib import Path
from sys import argv
from collector.server import Collector, Handler, ThreadingHTTPServer
with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    server.collector = Collector(Path(argv[1]), argv[2], download=False)
    print(server.server_port, flush=True)
    server.serve_forever()
`, data, token], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  const [chunk] = await once(collector.stdout, "data", { signal: AbortSignal.timeout(10000) });
  const port = Number(String(chunk).trim());
  assert.ok(port > 0);

  let rejectDiagnostics = false;
  proxy = http.createServer((request, response) => {
    const url = new URL(request.url, endpoint);
    if (url.origin !== endpoint || !["/api/diagnostics", "/api/gaps", "/api/collect"].includes(url.pathname)) {
      response.writeHead(403).end();
      return;
    }
    if (rejectDiagnostics && url.pathname === "/api/diagnostics") {
      response.writeHead(503).end();
      return;
    }
    const forward = http.request({
      host: "127.0.0.1", port, path: url.pathname, method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${port}` },
    }, (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    forward.on("error", () => response.writeHead(502).end());
    request.pipe(forward);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  context = await chromium.launchPersistentContext(path.join(temp, "browser"), {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
    headless: true,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`, "--proxy-bypass-list=<-loopback>",
    ],
  });
  const pages = new Map();
  await context.route("https://x.com/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/media/")) return route.fulfill({ contentType: "image/png", body: png });
    if (!pages.has(pathname)) return route.abort();
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: pages.get(pathname) });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionUrl = worker.url().split("/").slice(0, 3).join("/");
  await worker.evaluate((token) => chrome.storage.local.set({ enabled: true, token }), token);
  const page = await context.newPage();
  const visit = async (id, options = {}) => {
    const pathname = `/gaps/item/${id}`;
    pages.set(pathname, fixturePage(id, options));
    await page.goto("https://x.com" + pathname);
  };
  const local = () => worker.evaluate(async () => (await chrome.storage.local.get("gapsState")).gapsState);
  const diagnostic = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { headers: { "X-Atelier-Token": token } });
    assert.equal(res.status, 200);
    return res.json();
  };
  const failures = async () => Object.values((await local()).units).find((unit) => unit.failures)?.failures.length;
  await visit(1);
  await page.bringToFront();
  await until(async () => Object.keys((await local()).units).length === 2, "baseline");
  await visit(2, { like: false, save: false });
  await until(async () => await failures() === 1, "first missing item");
  await visit(2, { like: false, save: false });
  await visit(3, { like: false, save: false });
  await until(async () => await failures() === 2, "second distinct missing item");
  assert.equal((await diagnostic()).gaps_count, 0);
  await visit(4, { like: false, save: false, images: ["a", "a", "b"] });
  await until(async () => (await diagnostic()).gaps_count === 3, "three gaps reached Collector");

  const popup = await context.newPage();
  await popup.goto(extensionUrl + "/popup.html");
  const likeWarning = popup.getByRole("listitem").filter({ hasText: "X — 操作を検出できません（いいね）" });
  const saveWarning = popup.getByRole("listitem").filter({ hasText: "X — 操作を検出できません（保存）" });
  await likeWarning.waitFor();
  await saveWarning.waitFor();
  await popup.getByRole("listitem").filter({ hasText: "X — 収集上限を超える画像があります" }).waitFor();
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "!");
  const button = popup.getByRole("button", { name: "問題を報告" });
  const full = popup.getByLabel(/問題報告用レポートの完全版/);
  const readReport = async () => {
    const downloaded = popup.waitForEvent("download");
    await popup.getByRole("button", { name: "レポートをダウンロード" }).click();
    return fs.readFileSync(await (await downloaded).path(), "utf8");
  };
  await full.focus();
  await popup.keyboard.press("Tab");
  assert.ok(await button.evaluate((element) => element === document.activeElement && element.matches(":focus-visible")));
  assert.equal(await button.getAttribute("aria-describedby"), "gap-recovery");
  assert.match(await popup.locator("#gap-warnings").ariaSnapshot(), /status:[\s\S]*操作を検出できません[\s\S]*問題報告用レポートの完全版/);
  await popup.keyboard.press("Enter");
  assert.doesNotMatch(await readReport(), /gaps_count|recent_gaps|action_missing|image_limit_exceeded/);
  await full.focus();
  await popup.keyboard.press("Space");
  assert.equal(await full.isChecked(), true);
  await popup.keyboard.press("Tab");
  await popup.keyboard.press("Enter");
  const completeReport = await readReport();
  assert.match(completeReport, /gaps_count: 3/);
  assert.match(completeReport, /image_limit_exceeded/);
  assert.equal([...completeReport.matchAll(/action_missing/g)].length, 2);
  rejectDiagnostics = true;
  await button.click();
  await popup.getByRole("status").filter({ hasText: "収集の警告履歴を取得できませんでした" }).waitFor();
  assert.match(await readReport(), /収集の警告履歴を取得できませんでした/);
  rejectDiagnostics = false;

  await page.bringToFront();
  pages.set("/gaps/item/4", fixturePage(4, { save: false, images: ["a", "b"] }));
  await page.reload();
  await until(async () => (await worker.evaluate(() => getStatus())).gapWarnings.length === 2, "like recovered on reload");
  await popup.bringToFront();
  await likeWarning.waitFor({ state: "hidden" });
  await saveWarning.waitFor();
  await popup.getByRole("listitem").filter({ hasText: "収集上限を超える画像があります" }).waitFor();
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "!");
  await worker.evaluate(() => chrome.storage.local.set({
    queueFull: true, health: { suspects: { like: { source: "x", action: "like" } } },
  }));
  await page.bringToFront();
  await visit(6, { images: ["a", "a"] });
  await until(async () => (await worker.evaluate(() => getStatus())).gapWarnings.length === 0, "image recovered");
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "!", "queue warning survives");
  await worker.evaluate(() => chrome.storage.local.set({ queueFull: false }));
  await until(async () => await worker.evaluate(() => chrome.action.getBadgeText({})) === "", "legacy doubts appear in diagnostics only");
  await popup.bringToFront();
  await popup.getByRole("listitem").filter({ hasText: "収集上限を超える画像があります" }).waitFor({ state: "hidden" });
  assert.equal((await diagnostic()).gaps_count, 3);
  assert.equal((await diagnostic()).events_count, 0);
  await page.bringToFront();
  await page.locator("img").first().click();
  await until(async () => (await diagnostic()).events_count === 1, "normal event still collects");
  const [event] = (await diagnostic()).recent;
  assert.equal(event.action, "click");
  assert.equal(event.images.length, 1);
  assert.equal((await diagnostic()).gaps_count, 3);
  console.log("gaps E2E: browser observations, Collector, badge, keyboard, diagnostics, and independent recovery passed");
} finally {
  await context?.close();
  proxy?.closeAllConnections();
  proxy?.close();
  if (collector?.pid && collector.exitCode === null && collector.signalCode === null) {
    const exited = once(collector, "exit");
    collector.kill();
    await exited;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
