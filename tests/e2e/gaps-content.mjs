import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixturePage, gapsFixtureConfig } from "./gaps-fixture.mjs";

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  path.join(os.userInfo().homedir, ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome");
const source = await fs.readFile(new URL("../../src/content.js", import.meta.url), "utf8");
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
  "base64",
);
const browser = await chromium.launch({
  executablePath: chromiumPath,
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage();
  await page.clock.install();
  let markup = fixturePage(10);
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).hostname !== "x.com") return route.abort();
    if (route.request().resourceType() === "document") {
      return route.fulfill({ body: markup, contentType: "text/html" });
    }
    if (route.request().resourceType() === "image") {
      return route.fulfill({ body: image, contentType: "image/png" });
    }
    return route.abort();
  });

  async function go(url, html = fixturePage(10), options = {}) {
    markup = html;
    await page.goto("https://x.com" + url);
    await page.evaluate(({ config, enabled, readyState, visibilityState }) => {
      globalThis.ATELIER_SITES = { x: config };
      globalThis.ATELIER_SOURCE_BY_HOST = { "x.com": "x" };
      globalThis.gapMessages = [];
      globalThis.failFirstGap = false;
      globalThis.onSettingsChange = null;
      globalThis.browser = {
        runtime: {
          sendMessage: async (message) => {
            if (message.type !== "gaps-observation") return;
            if (failFirstGap) {
              failFirstGap = false;
              return { ok: false };
            }
            gapMessages.push(...message.observations);
            return { ok: true };
          },
          onMessage: { addListener() {} },
        },
        storage: {
          local: { get: async () => ({ enabled }) },
          onChanged: { addListener(listener) { globalThis.onSettingsChange = listener; } },
        },
      };
      if (readyState) Object.defineProperty(document, "readyState", { value: readyState, configurable: true });
      if (visibilityState) Object.defineProperty(document, "visibilityState", { value: visibilityState, configurable: true });
    }, {
      config: options.config || gapsFixtureConfig,
      enabled: options.enabled ?? true,
      readyState: options.readyState,
      visibilityState: options.visibilityState,
    });
    await page.addScriptTag({ content: source });
  }

  const observations = () => page.evaluate(() => gapMessages.splice(0));
  const like = (matched) => ({ pageType: "synthetic-detail", itemId: "10", action: "like", matched });
  const save = { ...like(true), action: "save" };
  const count = (observedCount, imageLimit = 1) => ({
    pageType: "synthetic-detail", itemId: "10", observedCount, imageLimit,
  });
  const current = "/gaps/item/10";

  await go(current);
  assert.deepEqual(await observations(), [like(true), save, count(1)]);
  await page.locator("[data-like-button]").evaluate((node) => node.remove());
  await page.clock.runFor(1800);
  assert.deepEqual(await observations(), []);
  await page.clock.runFor(400);
  assert.deepEqual(await observations(), [like(false), save, count(1)]);
  await page.clock.runFor(10000);
  assert.deepEqual(await observations(), []);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.setAttribute("data-like-button", "");
    button.textContent = "Like";
    document.querySelector("article").append(button);
  });
  await page.clock.runFor(2200);
  assert.deepEqual(await observations(), [like(true), save, count(1)]);

  await page.evaluate(() => history.pushState({}, "", "/gaps/profile"));
  await page.clock.runFor(5500);
  assert.deepEqual(await observations(), []);
  await page.evaluate((url) => history.pushState({}, "", url), current);
  await page.clock.runFor(1500);
  assert.deepEqual(await observations(), []);
  await page.clock.runFor(600);
  assert.deepEqual(await observations(), [like(true), save, count(1)]);

  for (const [url, options] of [
    ["/gaps/login/item/10", {}],
    ["/gaps/profile", {}],
    ["/out-of-injection/item/10", {}],
    [current, { loginRequired: true }],
    [current, { password: true }],
    [current, { signedIn: false }],
    [current, { ready: false }],
    [current, { duplicateContainer: true }],
  ]) {
    await go(url, fixturePage(10, { like: false, ...options }));
    await page.clock.runFor(5100);
    assert.deepEqual(await observations(), [], `${url} ${JSON.stringify(options)}`);
  }

  for (const likeState of ["operated", "unknown"]) {
    await go(current, fixturePage(10, { like: false, likeState }));
    assert.deepEqual(await observations(), [save, count(1)]);
  }

  await go(current, fixturePage(10, { like: false }), { readyState: "interactive" });
  await page.clock.runFor(5100);
  assert.deepEqual(await observations(), []);
  await page.evaluate(() => {
    delete document.readyState;
    document.dispatchEvent(new Event("readystatechange"));
  });
  await page.clock.runFor(2200);
  assert.deepEqual(await observations(), [like(false), save, count(1)]);

  await go(current, fixturePage(10, { like: false }), { visibilityState: "hidden" });
  assert.deepEqual(await observations(), []);
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(2200);
  assert.deepEqual(await observations(), [like(false), save, count(1)]);

  // Changes in a hidden tab still have a cooldown once it becomes visible.
  await go(current, fixturePage(10), { visibilityState: "hidden" });
  await page.locator("[data-like-button]").evaluate((node) => node.remove());
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1800);
  assert.deepEqual(await observations(), []);
  await page.clock.runFor(400);
  assert.deepEqual(await observations(), [like(false), save, count(1)]);

  // A temporary failure to persist the background observation allows a retry.
  await go(current);
  await observations();
  await page.evaluate(() => {
    failFirstGap = true;
    document.querySelector("[data-like-button]").remove();
  });
  await page.clock.runFor(2200);
  assert.deepEqual(await observations(), []);
  await page.clock.runFor(5000);
  assert.deepEqual(await observations(), [like(false), save, count(1)]);

  for (const control of ["click", "keydown", "submit"]) {
    const extra = control === "submit" ?
      '<form onsubmit="event.preventDefault()"><button id="input">Submit</button></form>' :
      '<button id="input">Input</button>';
    await go(current, fixturePage(10, { like: true, extra }));
    await observations();
    if (control === "keydown") await page.locator("#input").press("Space");
    else await page.locator("#input").click();
    await page.locator("[data-like-button]").evaluate((node) => node.remove());
    await page.clock.runFor(2600);
    assert.deepEqual(await observations(), [], control);
    await page.clock.runFor(600);
    assert.deepEqual(await observations(), [like(false), save, count(1)]);
  }

  const config = (maxImages) => ({ ...gapsFixtureConfig, maxImages });
  await go(current, fixturePage(10, { images: ["a", "a", "b"] }));
  assert.deepEqual(await observations(), [like(true), save, count(2)]);
  await go(current, fixturePage(10, { images: ["a", "a", "b"] }), { config: config(2) });
  assert.deepEqual(await observations(), [like(true), save, count(2, 2)]);
  await go(current, fixturePage(10, { images: ["a", "a", "b", "c"] }), { config: config(2) });
  assert.deepEqual(await observations(), [like(true), save, count(3, 2)]);
  await go(current, fixturePage(10), { config: config(null) });
  assert.deepEqual(await observations(), [like(true), save]);
  await go(current, fixturePage(10, { imageReady: false }));
  assert.deepEqual(await observations(), [like(true), save]);

  await go(current, fixturePage(10, { like: false }), { config: { ...gapsFixtureConfig, gaps: undefined } });
  assert.deepEqual(await observations(), []);
  await go(current, fixturePage(10, { like: true }), { enabled: false });
  assert.deepEqual(await observations(), []);
  await page.evaluate(() => onSettingsChange({ enabled: { newValue: true } }));
  assert.deepEqual(await observations(), [like(true), save, count(1)]);
  await page.evaluate(() => onSettingsChange({ sites: { newValue: { x: false } } }));
  await page.locator("[data-like-button]").evaluate((node) => node.remove());
  await page.clock.runFor(5100);
  assert.deepEqual(await observations(), []);

  console.log("gaps content: comparisons, exclusion gates, input/SPA cooldown, and image eligibility passed");
} finally {
  await browser.close();
}
