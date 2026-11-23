import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { gapsFixtureConfig } from "./gaps-fixture.mjs";

const day = 86400000;
const start = Date.parse("2026-11-21T12:00:00Z");
let now = start;
class Clock extends Date {
  static now() { return now; }
}
const storage = { enabled: true, token: "fixture" };
const requests = [];
let status = 503;
let hang = false;
let version = "1";
let settingsChanged;
const noop = { addListener() {} };
const timers = new Map();
const browser = {
  action: { setBadgeText() {} },
  alarms: { create() {}, onAlarm: noop },
  contextMenus: { onClicked: noop },
  tabs: { onUpdated: noop },
  runtime: { getManifest: () => ({ version }), onMessage: noop, onInstalled: noop },
  storage: {
    onChanged: { addListener: (listener) => { settingsChanged = listener; } },
    local: {
      async get(keys) {
        if (typeof keys === "string") return structuredClone({ [keys]: storage[keys] });
        return structuredClone({ ...keys, ...storage });
      },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    },
  },
};
const code = fs.readFileSync(new URL("../../src/background.js", import.meta.url), "utf8");
function worker() {
  return vm.createContext({
    browser, self: { addEventListener() {} }, Date: Clock, URL, AbortController, crypto,
    ATELIER_SITES: { x: gapsFixtureConfig },
    ATELIER_SOURCE_BY_HOST: { "x.com": "x", "twitter.com": "x" },
    setTimeout: (fn, ms) => {
      const timer = Symbol();
      timers.set(timer, { fn, ms });
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    async fetch(url, options) {
      assert.equal(timers.size, 1);
      const [{ ms }] = timers.values();
      assert.equal(ms, 10000);
      assert.equal(url, "http://127.0.0.1:8765/api/gaps");
      assert.equal(options.redirect, "error");
      requests.push({ token: options.headers["X-Atelier-Token"], record: JSON.parse(options.body) });
      if (hang) {
        await new Promise((_resolve, reject) => options.signal.addEventListener(
          "abort", () => reject(options.signal.reason), { once: true },
        ));
      }
      return { ok: status === 201 || status === 200, status };
    },
  });
}

let context = worker();
const execute = (source) => vm.runInContext(source, context);
execute(code);
const observe = (id, value, host = "x.com") => execute(`observeGaps(
  [{pageType:"synthetic-detail", itemId:${JSON.stringify(String(id))}, ...${JSON.stringify(value)}}],
  {frameId:0,url:"https://${host}/gaps/item/${id}"})`);
const like = (id, matched, host) => observe(id, { action: "like", matched }, host);
const image = (id, observedCount) => observe(id, { observedCount, imageLimit: 1 });
const queue = () => storage.gapsState.queue;
async function set(key, value) {
  const oldValue = storage[key];
  storage[key] = value;
  settingsChanged({ [key]: { oldValue, newValue: value } });
  await execute("gapsWrites");
}

await like(1, false);
await like(2, false);
await like(3, false);
assert.equal(requests.length, 0, "baseline required");
await like(1, true);
await like(2, false, "twitter.com");
await like(3, false, "twitter.com");
await like(4, false, "twitter.com");
assert.equal(requests.length, 0, "baseline is host-specific");
now += day - 10;
await like(2, false);
now += day - 10;
await like(3, false);
await like(3, false);
assert.equal(requests.length, 0);
await like(4, false);
assert.equal(requests.length, 1, "deadline applies independently to baseline and first failure");
assert.equal(queue().length, 1);
const first = requests[0].record;
assert.deepEqual(Object.keys(first).sort(), ["action", "detected_at", "gap_type", "id", "schema", "source"]);
assert.match(first.id, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
assert.ok(Object.values(storage.gapsState.units).every((unit) => !unit.failures));
await like(5, false);
assert.equal(requests.length, 1, "confirmed condition triggers only once");

context = worker();
execute(code);
await execute("gapsWrites");
assert.equal((await execute("getStatus()")).gapWarnings.length, 1, "restarts preserve active warnings");
await execute("flushGaps()");
assert.deepEqual(requests.at(-1).record, first, "restarts retry with the same record");
status = 401;
await execute("flushGaps()");
const attempts = requests.length;
await execute("flushGaps()");
assert.equal(requests.length, attempts);
await set("token", "corrected");
status = 200;
await execute("flushGaps()");
assert.deepEqual(requests.at(-1), { token: "corrected", record: first });
assert.equal(queue().length, 0);

status = 409;
await image(6, 2);
assert.equal(queue().length, 0, "terminal client errors do not retry");
await image(6, 0);
assert.equal((await execute("getStatus()")).gapWarnings.length, 2, "zero images do not recover");
await image(6, 1);
assert.equal((await execute("getStatus()")).gapWarnings.length, 1);
await like(7, true);
assert.equal((await execute("getStatus()")).gapWarnings.length, 0);

status = 503;
await image(6, 2);
await set("sites", { x: false });
assert.equal(queue().length, 0);
assert.equal((await execute("getStatus()")).gapWarnings.length, 0);
await image(7, 2);
assert.equal(queue().length, 0);
await set("sites", { x: true });
await image(7, 2);
await set("enabled", false);
assert.equal(queue().length, 0);
await set("enabled", true);

hang = true;
const timedOut = image(8, 2);
await new Promise(setImmediate);
assert.equal(timers.size, 1);
const [{ fn: expireRequest }] = timers.values();
expireRequest();
await timedOut;
assert.equal(timers.size, 0);
assert.equal(queue().length, 1);
await image(8, 1);
const cancelled = image(9, 2);
await new Promise(setImmediate);
assert.equal(timers.size, 1);
await set("enabled", false);
await cancelled;
assert.equal(timers.size, 0);
assert.equal(queue().length, 0, "pause cancels active send and discards pending records");
hang = false;
await set("enabled", true);

await set("token", "");
for (let i = 0; i < 101; i++) {
  now += 1;
  await image(8, 2);
  await image(8, 1);
}
assert.equal(queue().length, 100);
assert.equal(Date.parse(queue()[0].record.detected_at), now - 99);
now += day - 99;
await execute("flushGaps()");
assert.equal(queue().length, 99, "24-hour expiry includes the boundary");

version = "2";
context = worker();
execute(code);
await execute("gapsWrites");
assert.equal(queue().length, 0, "changing version discards queued reports");
assert.deepEqual(storage.gapsState.units, {});

execute("ATELIER_SITES.x.maxImages = 2");
await observe(9, { observedCount: 2, imageLimit: 2 });
assert.equal(queue().length, 0);
await observe(9, { observedCount: 3, imageLimit: 2 });
assert.equal(queue().length, 1);
assert.equal(queue()[0].record.observed_count, 3);
assert.equal(queue()[0].record.image_limit, 2);
console.log("gaps background: baseline, windows, persistence, settings, and queue passed");
