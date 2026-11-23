import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");
const extension = path.join(root, "dist/chrome");
const receiver = process.env.ATELIER_ROOT || path.resolve(root, "../imagegen");
const checkImage = process.argv.includes("--offline-image");
const python = process.env.ATELIER_PYTHON || "python3";
const endpoint = "http://127.0.0.1:8765";
const fixture = "https://x.com/fixture/status/123456";
const image = "https://pbs.twimg.com/media/fixture.png";
const token = "noah-fixture-token";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-first-receipt-"));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let collector;
let proxy;
let context;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    throw new Error("テスト用 Chromium がありません。README の導入手順を実行してください。");
  }
  // Run the real receiver in a separate directory and on an available local port.
  // The receiver code now lives in this tree (noah/collector).
  const setup = `
from pathlib import Path
from sys import argv
from collector.server import Collector, Handler, ThreadingHTTPServer

def blocked(*args, **kwargs):
    raise AssertionError("Collector attempted an origin request")

Collector._fetch_image = blocked
with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    server.collector = Collector(Path(argv[1]), argv[2], download=False)
    print(server.server_port, flush=True)
    server.serve_forever()
`;
  collector = spawn(python, ["-B", "-u", "-c", setup, temp, token], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const collectorDone = once(collector, "exit");
  collectorDone.catch(() => {});
  const collectorPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("受信アプリの起動が時間切れになりました。")), 10000);
    collector.stdout.once("data", (line) => {
      clearTimeout(timer);
      const port = Number(String(line).trim());
      if (Number.isInteger(port) && port > 0) resolve(port);
      else reject(new Error("テスト用受信ポートを確認できません。"));
    });
    collectorDone.then(() => {
      clearTimeout(timer);
      reject(new Error("テスト用受信アプリが終了しました。"));
    }, reject);
  });
  collector.stdout.resume();

  // Preserve the extension's fixed destination without touching a running Collector.
  proxy = http.createServer((request, response) => {
    const url = new URL(request.url, endpoint);
    if (url.origin !== endpoint || !["/api/health", "/api/events", "/api/collect"].includes(url.pathname)) {
      response.writeHead(403).end();
      return;
    }
    const headers = { ...request.headers, host: `127.0.0.1:${collectorPort}` };
    const forward = http.request({
      hostname: "127.0.0.1", port: collectorPort, method: request.method,
      path: url.pathname + url.search, headers,
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
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`,
      "--proxy-bypass-list=<-loopback>",
    ],
  });
  let sourceBlocked = false;
  let blockedRequests = 0;
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (sourceBlocked && (url === fixture || url === image)) {
      blockedRequests++;
      return route.abort();
    }
    if (url === fixture) {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<article><a href="${fixture}"><time>fixture</time></a><img ${checkImage ? 'crossorigin="anonymous"' : ""} src="${image}" alt="テスト画像"></article>`,
      });
    }
    if (url === image) return route.fulfill({
      contentType: "image/png", body: png, headers: { "Access-Control-Allow-Origin": "*" },
    });
    if (url.startsWith("chrome-extension:") || url.startsWith(endpoint + "/")) return route.continue();
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionUrl = worker.url().split("/").slice(0, 3).join("/");
  const settings = await context.newPage();
  await settings.goto(extensionUrl + "/options.html");
  assert.equal(await settings.getByLabel("収集を有効にする").isChecked(), false);
  await settings.getByLabel("Token").fill(token);
  await settings.getByRole("button", { name: "接続テスト" }).click();
  await settings.getByText("接続OK（collector", { exact: false }).waitFor();
  await settings.getByLabel("収集を有効にする").check();
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await settings.getByText("保存しました。", { exact: true }).waitFor();

  const recent = async () => {
    const response = await fetch(`http://127.0.0.1:${collectorPort}/api/events?limit=10`, {
      headers: { "X-Atelier-Token": token },
    });
    assert.equal(response.status, 200);
    return (await response.json()).events;
  };
  assert.deepEqual(await recent(), []);
  const page = await context.newPage();
  await page.goto(fixture);
  const observed = page.getByRole("img", { name: "テスト画像" });
  await observed.evaluate((element) => element.decode());
  sourceBlocked = true;
  await observed.click();

  let events;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    events = await recent();
    if (events.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (events.length === 0) {
    throw new Error("テスト画像を受信できませんでした。");
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "x");
  assert.equal(events[0].action, "click");
  assert.equal(events[0].item.id, "123456");
  assert.equal(events[0].images[0].url, image);
  assert.equal(blockedRequests, 0);
  if (checkImage) {
    assert.equal(events[0].observation_route, "image_click");
    assert.match(events[0].images[0].hash, /^[0-9a-f]{64}$/);
    assert.equal(events[0].images[0].data, undefined);
    const useImage = `
from pathlib import Path
from sys import argv
from unittest.mock import patch

from app.core.inbox import InboxDB
from app.server import create_app
from fastapi.testclient import TestClient
from PIL import Image
from io import BytesIO

root = Path(argv[1])
with patch("socket.create_connection", side_effect=AssertionError("Atelier attempted a network request")):
    db = InboxDB(root / "atelier.sqlite")
    assert db.import_collector(root) == 1
    assert db.import_collector(root) == 1
    image, = db.queue()
    with TestClient(create_app(db, allowed_hosts={"testserver"}, auth_required=False)) as client:
        base = f"/api/images/{image['id']}"
        response = client.get(base + "/thumb")
        assert response.status_code == 200
        with Image.open(BytesIO(response.content)) as thumbnail:
            thumbnail.load()
            assert thumbnail.size == (1, 1)
        response = client.get(base + "/observations")
        assert response.status_code == 200
        observation, = response.json()["observations"]
        assert observation["source"] == "x" and observation["action"] == "click"
        assert observation["item"]["id"] == "123456"
        assert observation["created_at"] and observation["observation_route"] == "image_click"
        assert observation["image"]["hash"] == argv[2]
`;
    const result = spawnSync(python, ["-B", "-c", useImage, temp, events[0].images[0].hash], {
      cwd: receiver, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    console.log("取得元を遮断した状態で、Atelier の画像と観測記録を確認しました。");
  } else {
    assert.equal(fs.existsSync(path.join(temp, "images")), false);
  }
  console.log("新しい画像クリックを受信しました。");
} catch (error) {
  console.error(`初回受信の確認に失敗しました。
${error.message}
README の「最初の記録を確認する」を見直して再実行してください。`);
  process.exitCode = 1;
} finally {
  try {
    await context?.close();
  } finally {
    proxy?.closeAllConnections();
    proxy?.close();
    if (collector?.pid && collector.exitCode === null && collector.signalCode === null) {
      const ended = once(collector, "exit");
      collector.kill();
      await ended;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
