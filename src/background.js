/* Collector Noah - background (Chrome MV3 / Firefox MV3) */
if (!globalThis.ATELIER_SITES && typeof importScripts === "function") {
  try {
    importScripts("sites.generated.js");
  } catch {
    /* build.py が未実行。sites は空になる */
  }
}

const api = globalThis.browser ?? globalThis.chrome;
const SITES = globalThis.ATELIER_SITES || {};
const SOURCE_BY_HOST = globalThis.ATELIER_SOURCE_BY_HOST || {};
const DEFAULT_SITES = Object.fromEntries(Object.keys(SITES).map((id) => [id, true]));

const DEFAULTS = {
  endpoint: "http://127.0.0.1:8765",
  token: "",
  enabled: false,
  inventory: false,
  sampling: false,
  sites: { ...DEFAULT_SITES },
};

const QUEUE_LIMIT = 200;
const CLICK_OPEN_WINDOW_MS = 5000;
const RECORD_LIMIT_BYTES = 32768;
const SAMPLE_QUEUE_LIMIT = 50;
const SAMPLE_DAILY_LIMIT = 100;
const SAMPLE_CANDIDATE_LIMIT = 1000;
const SAMPLE_GROUP_SIZE = 10;
const SAMPLE_RETAIN_DAYS = 30;
const ALLOWED_ENDPOINT_PORT = "8765";

const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i;
const IMAGE_FORMATS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const recentClicks = new Map();

let clearGeneration = 0;
let flushInFlight = false;
let sampleBuffer = [];

function isLoopbackHost(host) {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isAllowedEndpoint(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (!isLoopbackHost(url.hostname.toLowerCase())) return false;
  if (url.port !== ALLOWED_ENDPOINT_PORT) return false;
  if (url.search || url.hash) return false;
  if (url.pathname !== "" && url.pathname !== "/") return false;
  return true;
}

function isImageUrl(url) {
  if (!url) return false;
  if (IMAGE_RE.test(url)) return true;
  try {
    const parsed = new URL(url);
    const format = (
      parsed.searchParams.get("format") ||
      parsed.searchParams.get("fm") ||
      ""
    ).toLowerCase();
    return IMAGE_FORMATS.has(format);
  } catch {
    return false;
  }
}

function markClick(event, now) {
  for (const image of event.images || []) {
    if (image?.url) recentClicks.set(image.url, now);
  }
  if (recentClicks.size > 200) {
    for (const [url, at] of recentClicks) {
      if (now - at > CLICK_OPEN_WINDOW_MS * 2) recentClicks.delete(url);
    }
  }
}

function isRepeatOpen(event, now) {
  if (event.action !== "open") return false;
  return (event.images || []).some((image) => {
    const at = image?.url && recentClicks.get(image.url);
    return Boolean(at) && now - at <= CLICK_OPEN_WINDOW_MS;
  });
}

function sourceForHost(host) {
  const h = String(host || "").toLowerCase();
  for (const [name, source] of Object.entries(SOURCE_BY_HOST)) {
    if (h === name || h.endsWith("." + name)) return source;
  }
  return "other";
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const ROUTE_VALUES = new Set([
  "image_click",
  "item_link",
  "tab",
  "action",
  "page_collect",
  "context_menu",
  "sample",
]);

function safeRegexTest(pattern, value) {
  try {
    return new RegExp(pattern).test(String(value || ""));
  } catch {
    return false;
  }
}

function surfaceForUrl(source, url) {
  const cfg = SITES[source];
  const patterns = cfg?.surfacePatterns;
  if (!Array.isArray(patterns)) return undefined;
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = "";
  }
  for (const p of patterns) {
    if (!p || typeof p.pattern !== "string") continue;
    try {
      if (new RegExp(p.pattern).test(pathname)) return p.surface;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function ensureCollector(event) {
  if (!event || typeof event !== "object") return event;
  if (!event.collector || typeof event.collector !== "object") {
    event.collector = {
      schema_version: 3,
      extension_version: (api.runtime.getManifest && api.runtime.getManifest().version) || "",
      build_hash: (globalThis.ATELIER_BUILD && globalThis.ATELIER_BUILD.sitesHash) || "",
    };
  } else {
    if (event.collector.schema_version === undefined) event.collector.schema_version = 3;
    if (event.collector.extension_version === undefined)
      event.collector.extension_version = (api.runtime.getManifest && api.runtime.getManifest().version) || "";
    if (event.collector.build_hash === undefined)
      event.collector.build_hash = (globalThis.ATELIER_BUILD && globalThis.ATELIER_BUILD.sitesHash) || "";
  }
  return event;
}

function makeEvent(input) {
  const item =
    input.item ||
    {
      type: "image",
      id: null,
      url: input.page_url || input.image_url || "",
      title: "",
    };
  const host = hostOf(item.url || input.page_url || "");
  const source = input.source || sourceForHost(host);
  const cfg = SITES[source] || {};
  const originalPattern = cfg.originalUrlPattern || "";

  const routeCandidate = input.route || input.metadata?.via;
  const route = ROUTE_VALUES.has(routeCandidate) ? routeCandidate : undefined;

  const images = (input.images || []).map((image, index, arr) => {
    const out = { ...image };
    if (out.variant === undefined || out.variant === null) {
      out.variant = safeRegexTest(originalPattern, out.url) ? "original" : "displayed";
    }
    if (out.targeted === undefined) {
      const selfTarget = new Set(["image_click", "context_menu", "tab", "sample"]);
      if (selfTarget.has(route)) out.targeted = true;
      else if (route === "action") out.targeted = arr.length === 1;
      else out.targeted = false;
    }
    return out;
  });

  const event = {
    schema: 3,
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    created_at: new Date().toISOString(),
    source,
    site: input.site || host,
    action: input.action || "click",
    item,
    images,
    metadata: input.metadata || {},
  };

  if (route) event.route = route;
  if (input.status) event.status = input.status;
  if (input.removed === true) event.removed = true;
  if (input.comment) event.comment = input.comment;
  if (input.sampling) {
    event.sampling = input.sampling;
  } else if (input.metadata?.sample) {
    const s = input.metadata.sample;
    event.sampling = {
      selected: s.selected,
      candidates: s.candidates,
      capped: s.capped,
      conditions: s.conditions,
    };
  }
  if (input.dwell_seconds !== undefined && input.dwell_seconds !== null) {
    const n = Number(input.dwell_seconds);
    if (Number.isFinite(n) && n >= 0) event.dwell_seconds = n;
  }
  const surface = input.surface || surfaceForUrl(source, item.url || input.page_url || "");
  if (surface) event.surface = surface;

  ensureCollector(event);
  return event;
}

async function getSettings() {
  const value = await api.storage.local.get(DEFAULTS);
  return {
    ...DEFAULTS,
    ...value,
    sites: { ...DEFAULT_SITES, ...(value.sites || {}) },
  };
}

const GAPS_TTL = 24 * 60 * 60 * 1000;
const GAPS_ACTIONS = new Set(["like", "save", "bookmark", "follow"]);
const GAPS_BUILD = JSON.stringify([api.runtime.getManifest().version, globalThis.ATELIER_BUILD?.sitesHash]);
let gapsWrites = Promise.resolve();
let gapsSending = false;
let gapsActiveRequest;
let gapsSettingsRevision = 0;

function activeGaps(state, settings) {
  if (!settings.enabled || state?.buildHash !== GAPS_BUILD) return [];
  return Object.values(state.units)
    .filter(({ record }) => record && siteEnabled(settings, record.source))
    .map(({ record }) => ({
      site: SITES[record.source].label,
      type: record.gap_type,
      ...(record.action ? { action: record.action } : {}),
    }));
}

// Keep storage updates serial across tabs, alarms, requests and setting changes.
function changeGaps(change) {
  const operation = gapsWrites.then(async () => {
    const { gapsState } = await api.storage.local.get("gapsState");
    let revision, settings;
    do {
      revision = gapsSettingsRevision;
      settings = await getSettings();
    } while (revision !== gapsSettingsRevision);
    const before = JSON.stringify(gapsState);
    const state = gapsState?.buildHash === GAPS_BUILD
      ? gapsState : { buildHash: GAPS_BUILD, units: {}, queue: [] };
    const now = Date.now();
    const enabledFor = (source) => settings.enabled && siteEnabled(settings, source);
    for (const [key, unit] of Object.entries(state.units)) {
      if (!enabledFor(unit.source)) {
        delete state.units[key];
        continue;
      }
      if (unit.failures && now - unit.firstFailure >= GAPS_TTL) {
        delete unit.failures;
        delete unit.firstFailure;
      }
      if (!unit.record && now - unit.lastMatch >= GAPS_TTL && !unit.failures) {
        delete state.units[key];
      }
    }
    state.queue = state.queue
      .filter(({ record }) => enabledFor(record.source) && now - Date.parse(record.detected_at) < GAPS_TTL)
      .slice(-100);
    const result = change(state, settings, now);
    if (JSON.stringify(state) !== before) {
      await api.storage.local.set({ gapsState: state });
    }
    return result;
  });
  gapsWrites = operation.catch(() => {});
  return operation;
}

function applyGapObservation(state, observation, source, host, now) {
  const { pageType, itemId, action, matched, observedCount, imageLimit } = observation;
  const key = JSON.stringify([source, host, pageType, action ?? null]);
  const unit = state.units[key] ?? { source };
  const isAction = action !== undefined;
  if (isAction ? matched : observedCount >= 1 && observedCount <= imageLimit) {
    if (isAction) state.units[key] = { source, lastMatch: now };
    else delete state.units[key];
    return false;
  }
  if (unit.record || (!isAction && observedCount <= imageLimit)) return false;
  if (isAction) {
    if (!unit.failures) {
      if (unit.lastMatch === undefined || now - unit.lastMatch >= GAPS_TTL) return false;
      unit.failures = [];
      unit.firstFailure = now;
    }
    if (unit.failures.includes(itemId)) return false;
    unit.failures.push(itemId);
    state.units[key] = unit;
    if (unit.failures.length < 3) return false;
  }
  const record = {
    schema: 1,
    id: crypto.randomUUID(),
    source,
    gap_type: isAction ? "action_missing" : "image_limit_exceeded",
    detected_at: new Date(now).toISOString(),
    ...(isAction ? { action } : { observed_count: observedCount, image_limit: imageLimit }),
  };
  state.units[key] = { source, record };
  state.queue.push({ record });
  state.queue = state.queue.slice(-100);
  return true;
}

async function observeGaps(observations, sender) {
  if (sender.frameId !== 0 || !Array.isArray(observations)) return;
  if (!/^https?:\/\//.test(sender.url || "")) return;
  const url = new URL(sender.url);
  const host = url.hostname;
  const source = sourceForHost(host);
  const config = SITES[source];
  if (!Array.isArray(config?.gaps) || !config.item?.idPattern) return;
  const itemId = new RegExp(config.item.idPattern).exec(url.pathname + url.search)?.[1];
  if (!itemId) return;
  const added = await changeGaps((state, settings, now) => {
    if (!settings.enabled || !siteEnabled(settings, source)) return false;
    let confirmed = false;
    for (const input of observations) {
      const page = config.gaps.find((rule) =>
        rule.pageType === input?.pageType &&
        safeRegexTest(rule.pathPattern, url.pathname));
      if (!page || input.itemId !== itemId) continue;
      if (input.action !== undefined) {
        if (!GAPS_ACTIONS.has(input.action) || !page.actions?.[input.action] ||
            typeof input.matched !== "boolean") continue;
      } else {
        const limit = config.maxImages === undefined ? 1 : config.maxImages;
        if (!page.imageReadySelector || !Number.isSafeInteger(limit) || limit < 1 ||
            input.imageLimit !== limit || !Number.isSafeInteger(input.observedCount) ||
            input.observedCount < 0) continue;
      }
      if (applyGapObservation(state, input, source, host, now)) confirmed = true;
    }
    return confirmed;
  });
  if (added) await flushGaps();
}

async function sendGap(record, settings, controller) {
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const endpoint = String(settings.endpoint).replace(/\/+$/, "");
    const response = await fetch(`${endpoint}/api/gaps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Atelier-Token": settings.token },
      body: JSON.stringify(record),
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status === 401) return "unauthorized";
    if (response.ok || (response.status >= 400 && response.status < 500)) return "done";
    return "retry";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

async function flushGaps() {
  if (gapsSending) return;
  gapsSending = true;
  const attempted = new Set();
  try {
    while (true) {
      const request = await changeGaps((state, settings) => {
        if (!settings.enabled || !settings.token || !isAllowedEndpoint(settings.endpoint)) return null;
        const entry = state.queue.find(({ record, unauthorized }) => !unauthorized && !attempted.has(record.id));
        if (!entry) return null;
        const { record } = entry;
        attempted.add(record.id);
        const controller = new AbortController();
        gapsActiveRequest = { record, controller };
        return { record, settings, response: sendGap(record, settings, controller) };
      });
      if (!request) break;
      const { record, settings, response } = request;
      const result = await response;
      gapsActiveRequest = undefined;
      if (result === "retry") continue;
      await changeGaps((state, currentSettings) => {
        if (result === "done") {
          state.queue = state.queue.filter(({ record: pending }) => pending.id !== record.id);
        } else if (settings.token === currentSettings.token && settings.endpoint === currentSettings.endpoint) {
          const entry = state.queue.find(({ record: pending }) => pending.id === record.id);
          if (entry) entry.unauthorized = true;
        }
      });
    }
  } finally {
    gapsSending = false;
    gapsActiveRequest = undefined;
  }
}

function updateGapsSettings(changes) {
  gapsSettingsRevision += 1;
  const stopped = changes.enabled?.newValue === false;
  const disabledSites = Object.entries(changes.sites?.newValue || {})
    .filter(([, enabled]) => enabled === false).map(([source]) => source);
  const connectionChanged = Boolean(changes.token || changes.endpoint);
  const request = gapsActiveRequest;
  if (request && (stopped || disabledSites.includes(request.record.source) || connectionChanged)) {
    request.controller.abort();
  }
  return changeGaps((state) => {
    const discard = (source) => stopped || disabledSites.includes(source);
    for (const [key, unit] of Object.entries(state.units)) {
      if (discard(unit.source)) delete state.units[key];
    }
    state.queue = state.queue.filter(({ record }) => !discard(record.source));
    if (connectionChanged) {
      for (const entry of state.queue) delete entry.unauthorized;
    }
  });
}

async function getStatus() {
  const settings = await getSettings();
  const { gapsState, pending = [], counts = {}, backgroundErrors = [], health = {}, queueFull = false, lastSuccessAt = null } =
    await api.storage.local.get({
      pending: [],
      counts: {},
      backgroundErrors: [],
      health: {},
      queueFull: false,
      lastSuccessAt: null,
      gapsState: null,
    });
  const day = new Date().toISOString().slice(0, 10);
  return {
    version: api.runtime.getManifest().version,
    build: globalThis.ATELIER_BUILD || null,
    enabled: settings.enabled,
    tokenSet: Boolean(settings.token),
    endpoint: settings.endpoint,
    endpointAllowed: isAllowedEndpoint(settings.endpoint),
    sampling: Boolean(settings.sampling),
    sites: settings.sites,
    gapWarnings: activeGaps(gapsState, settings),
    pending: pending.length,
    queueFull: Boolean(queueFull) || pending.length >= QUEUE_LIMIT,
    today: counts[day] || 0,
    health,
    backgroundErrors: backgroundErrors.slice(-10),
    lastSuccessAt: lastSuccessAt || null,
  };
}

async function recordBackgroundError(message) {
  const { backgroundErrors = [] } = await api.storage.local.get({ backgroundErrors: [] });
  backgroundErrors.push({ ts: new Date().toISOString(), message: String(message || "").slice(0, 300) });
  await api.storage.local.set({ backgroundErrors: backgroundErrors.slice(-20) });
}

function siteEnabled(settings, source) {
  return settings.sites?.[source] === true;
}

function setBadge(text) {
  try {
    api.action.setBadgeText({ text: String(text || "") });
  } catch {
    /* Firefox without action badge support */
  }
}

async function updateBadge() {
  const {
    enabled = false,
    token = "",
    pending = [],
    counts = {},
    queueFull = false,
    endpoint = DEFAULTS.endpoint,
    gapsState,
    sites,
  } = await api.storage.local.get({
    enabled: false,
    token: "",
    pending: [],
    counts: {},
    queueFull: false,
    endpoint: DEFAULTS.endpoint,
    gapsState: null,
    sites: DEFAULT_SITES,
  });
  if (!enabled) {
    setBadge("–");
    return;
  }
  if (queueFull || pending.length || !token || !isAllowedEndpoint(endpoint)) {
    setBadge("!");
    return;
  }
  if (activeGaps(gapsState, { enabled, sites: { ...DEFAULT_SITES, ...sites } }).length) {
    setBadge("!");
    return;
  }
  // 成功時は何も出さない。今日の収集数は設定の詳細でだけ見せる。
  setBadge("");
}

async function bumpCount() {
  const { counts = {} } = await api.storage.local.get({ counts: {} });
  const day = new Date().toISOString().slice(0, 10);
  counts[day] = (counts[day] || 0) + 1;
  await api.storage.local.set({ counts });
  await updateBadge();
}

async function recordSuccess() {
  await api.storage.local.set({ lastSuccessAt: new Date().toISOString() });
}

const IMAGE_DATA_KEYS = ["data", "blob", "base64", "content", "image_data", "data_url"];
const IMAGE_EVENT_BUDGET = 900_000;
const PENDING_IMAGE_BUDGET = 4_000_000;

function boundedEvent(event, budget) {
  const images = (event.images || []).map((image) => {
    const data = image.data || image.base64 || image.image_data || image.blob || image.content;
    const entry = { ...image };
    for (const key of IMAGE_DATA_KEYS) delete entry[key];
    if (typeof data === "string" && data.length) {
      if (data.length <= budget) {
        entry.data = data;
        budget -= data.length;
      } else {
        entry.download_error = "size_limit";
      }
    }
    return entry;
  });
  return { ...event, images };
}

function recordWithinLimit(event) {
  try {
    const images = (event.images || []).map((image) => {
      const meta = { ...image };
      for (const key of IMAGE_DATA_KEYS) delete meta[key];
      return meta;
    });
    return new TextEncoder().encode(JSON.stringify({ ...event, images })).length <= RECORD_LIMIT_BYTES;
  } catch {
    return false;
  }
}

async function enqueue(event) {
  const { pending = [], queueFull = false } = await api.storage.local.get({
    pending: [],
    queueFull: false,
  });
  if (queueFull || pending.length >= QUEUE_LIMIT) {
    await api.storage.local.set({ queueFull: true });
    await updateBadge();
    return false;
  }
  if (event.metadata?.via === "sample") {
    const sampleCount = pending.filter((item) => item.metadata?.via === "sample").length;
    if (sampleCount >= SAMPLE_QUEUE_LIMIT) {
      await updateBadge();
      return false;
    }
  }
  ensureCollector(event);
  if (!recordWithinLimit(event)) {
    await recordBackgroundError("record exceeds 32 KiB or is not serializable; dropped");
    await updateBadge();
    return false;
  }
  const storedImageBytes = pending.reduce((total, item) => total + (item.images || []).reduce(
    (size, image) => size + IMAGE_DATA_KEYS.reduce(
      (sum, key) => sum + (typeof image[key] === "string" ? image[key].length : 0), 0
    ), 0
  ), 0);
  pending.push(boundedEvent(event, Math.max(0, PENDING_IMAGE_BUDGET - storedImageBytes)));
  await api.storage.local.set({ pending, queueFull: pending.length >= QUEUE_LIMIT });
  await updateBadge();
  return true;
}

async function sendRaw(event, settings) {
  if (!settings.token) {
    await updateBadge();
    return { ok: false, skipped: true, reason: "no_token" };
  }
  if (!isAllowedEndpoint(settings.endpoint)) {
    await updateBadge();
    return { ok: false, skipped: true, reason: "bad_endpoint" };
  }
  const endpoint = String(settings.endpoint).replace(/\/+$/, "");
  ensureCollector(event);
  const generation = clearGeneration;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${endpoint}/api/collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atelier-Token": settings.token,
      },
      body: JSON.stringify(boundedEvent(event, IMAGE_EVENT_BUDGET)),
      signal: controller.signal,
      redirect: "error",
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return { ok: true };
  } catch {
    if (generation !== clearGeneration) {
      return { ok: false, skipped: true, reason: "cleared" };
    }
    return { ok: false, skipped: false, reason: "send_failed" };
  }
}

async function postEvent(input) {
  const settings = await getSettings();
  if (!settings.enabled) return false;
  const { queueFull = false } = await api.storage.local.get({ queueFull: false });
  if (queueFull) return false;

  const event = makeEvent(input);
  if (!siteEnabled(settings, event.source)) return false;

  const now = Date.now();
  if (event.action === "click") {
    markClick(event, now);
  } else if (isRepeatOpen(event, now)) {
    // クリック直後に同じ画像を別タブで開いただけなら、click の1件にまとめる
    return false;
  }

  ensureCollector(event);
  if (!recordWithinLimit(event)) {
    await recordBackgroundError("record exceeds 32 KiB or is not serializable; dropped");
    return false;
  }

  const result = await sendRaw(event, settings);
  if (result.ok) {
    await bumpCount();
    await recordSuccess();
    return true;
  }
  if (result.skipped) {
    await updateBadge();
    return false;
  }
  await enqueue(event);
  await updateBadge();
  return false;
}

async function flush() {
  if (flushInFlight) return;
  flushInFlight = true;
  try {
    const settings = await getSettings();
    if (!settings.enabled || !settings.token) return;
    if (!isAllowedEndpoint(settings.endpoint)) return;

    const { pending = [], queueFull = false } = await api.storage.local.get({
      pending: [],
      queueFull: false,
    });
    if (!pending.length) {
      if (queueFull) await api.storage.local.set({ queueFull: false });
      return;
    }

    const remaining = [];
    const eventKey = (event) =>
      (event && typeof event.id === "string" && event.id) || JSON.stringify(event);
    const processed = new Set(pending.map(eventKey));
    const startGeneration = clearGeneration;
    let hadSuccess = false;
    for (const event of pending) {
      if (clearGeneration !== startGeneration) break;
      // 各送信の直前に 全体・サイト の停止を確認する
      const current = await getSettings();
      if (!current.enabled || !siteEnabled(current, event.source)) {
        remaining.push(event);
        continue;
      }
      const result = await sendRaw(event, current);
      if (result.skipped) {
        // 消去確定後に遅れて届いた失敗は復元しない
        if (result.reason !== "cleared") remaining.push(event);
        continue;
      }
      if (!result.ok) remaining.push(event);
      else hadSuccess = true;
    }
    if (hadSuccess) await recordSuccess();
    // flush 中に新しく追加された未送信を消さない
    const { pending: latest = [] } = await api.storage.local.get({ pending: [] });
    const added = latest.filter((event) => !processed.has(eventKey(event)));
    // 消去が入ったら、flush 中に保持した分は復元しない
    const next = clearGeneration !== startGeneration ? added : [...remaining, ...added];
    await api.storage.local.set({
      pending: next,
      queueFull: next.length >= QUEUE_LIMIT,
    });
    await updateBadge();
  } finally {
    flushInFlight = false;
  }
}

async function cleanupSamples() {
  const { pending = [] } = await api.storage.local.get({ pending: [] });
  if (!pending.length) return;
  const kept = pending.filter((event) => !sampleExpired(event));
  if (kept.length === pending.length) return;
  await api.storage.local.set({
    pending: kept,
    queueFull: kept.length >= QUEUE_LIMIT,
  });
  await updateBadge();
}

function sampleExpired(event) {
  if (event?.metadata?.via !== "sample") return false;
  const ts = Date.parse(event.created_at || "");
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > SAMPLE_RETAIN_DAYS * 86400000;
}

function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function sampleHash(key, url) {
  const input = `${key}|${String(url)}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function getSamplingState() {
  const { samplingState = null } = await api.storage.local.get({ samplingState: null });
  const day = utcDay();
  if (!samplingState || samplingState.day !== day) {
    sampleBuffer = [];
    return {
      day,
      key: `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
      seen: new Set(),
      selected: 0,
      candidates: 0,
      capped: false,
    };
  }
  return { ...samplingState, seen: new Set(samplingState.seen || []) };
}

async function saveSamplingState(state) {
  await api.storage.local.set({
    samplingState: { ...state, seen: [...state.seen] },
  });
}

async function handleSampleCandidate(candidate) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.sampling) return;
  if (!siteEnabled(settings, candidate.source)) return;

  const state = await getSamplingState();
  if (state.capped) return;

  const hash = sampleHash(state.key, candidate.url);
  if (state.seen.has(hash)) return;
  state.seen.add(hash);
  state.candidates += 1;
  if (state.candidates >= SAMPLE_CANDIDATE_LIMIT) state.capped = true;

  sampleBuffer.push({
    url: candidate.url,
    width: candidate.width ?? null,
    height: candidate.height ?? null,
    dwell_seconds: candidate.dwell_seconds ?? 0,
  });

  if (sampleBuffer.length >= SAMPLE_GROUP_SIZE) {
    const index = Math.floor(Math.random() * sampleBuffer.length);
    const adopted = sampleBuffer[index];
    sampleBuffer = [];
    state.selected += 1;
    if (state.selected >= SAMPLE_DAILY_LIMIT) state.capped = true;
    await saveSamplingState(state);
    await postSampleEvent(candidate.source, adopted, state);
    return;
  }

  await saveSamplingState(state);
}

async function postSampleEvent(source, adopted, state) {
  const event = makeEvent({
    source,
    action: "seen",
    item: { type: "image", id: null, url: adopted.url, title: "" },
    images: [{ url: adopted.url, width: adopted.width, height: adopted.height, order: 0 }],
    metadata: {
      via: "sample",
      sample: {
        selected: state.selected,
        candidates: state.candidates,
        capped: state.capped,
        conditions:
          "front-tab; >=300px; >=50% visible >=1s; UTC daily; 10% of deduped candidates",
      },
    },
    dwell_seconds: adopted.dwell_seconds ?? 0,
  });
  const settings = await getSettings();
  ensureCollector(event);
  if (!recordWithinLimit(event)) {
    await recordBackgroundError("sample record exceeds 32 KiB; dropped");
    return;
  }
  const result = await sendRaw(event, settings);
  if (result.ok) {
    await bumpCount();
    await recordSuccess();
    return;
  }
  if (result.skipped) return;
  await enqueue(event);
  await updateBadge();
}

async function updateHealth(inventory) {
  if (!inventory?.itemPage || !Array.isArray(inventory.selectors)) return;

  const { health = {} } = await api.storage.local.get({ health: {} });
  const hash = inventory.buildHash || globalThis.ATELIER_BUILD?.sitesHash || "";
  let state = health;
  if (!state.buildHash || state.buildHash !== hash) {
    state = { buildHash: hash, baseline: {}, streak: {}, suspects: {}, zeroUrls: {} };
  }
  if (!state.zeroUrls) state.zeroUrls = {};

  const anyMatched = inventory.selectors.some((sel) => (sel.count || 0) > 0);

  for (const sel of inventory.selectors) {
    const key = `${inventory.site}|${sel.action}|${sel.selector}`;
    const base = Math.max(state.baseline[key] || 0, sel.count || 0);
    state.baseline[key] = base;

    if ((sel.count || 0) > 0) {
      state.streak[key] = 0;
      state.zeroUrls[key] = [];
      delete state.suspects[key];
      continue;
    }

    if (base > 0) {
      state.streak[key] = (state.streak[key] || 0) + 1;
      if (state.streak[key] >= 3) {
        state.suspects[key] = {
          site: inventory.site,
          action: sel.action,
          selector: sel.selector,
          baseline: base,
          reason: "disappeared",
          since: state.suspects[key]?.since || new Date().toISOString(),
        };
      }
      continue;
    }

    const pageKey = inventory.urlKey || inventory.url;
    if (!anyMatched || !pageKey) continue;
    const urls = state.zeroUrls[key] || [];
    if (!urls.includes(pageKey)) {
      urls.push(pageKey);
      state.zeroUrls[key] = urls.slice(-10);
    }
    if (state.zeroUrls[key].length >= 3) {
      state.suspects[key] = {
        site: inventory.site,
        action: sel.action,
        selector: sel.selector,
        baseline: 0,
        reason: "never_matched",
        since: state.suspects[key]?.since || new Date().toISOString(),
      };
    }
  }

  await api.storage.local.set({ health: state });
}

async function handleInventory(inventory) {
  await api.storage.local.set({
    lastInventory: { ...inventory, ts: new Date().toISOString() },
  });
  await updateHealth(inventory);

  const settings = await getSettings();
  if (!settings.enabled || !settings.inventory || !settings.token) return;
  if (!isAllowedEndpoint(settings.endpoint)) return;

  const endpoint = String(settings.endpoint).replace(/\/+$/, "");
  try {
    await fetch(`${endpoint}/api/inventory`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atelier-Token": settings.token,
      },
      body: JSON.stringify(inventory),
      redirect: "error",
    });
  } catch {
    /* 棚卸しは設計用。失敗してもキューに残さない */
  }
}

function createMenus() {
  const make = () => {
    try {
      api.contextMenus.create({
        id: "atelier-collect-image",
        title: "この画像をCollector Noahに送る",
        contexts: ["image"],
      });
    } catch {
      /* already exists */
    }
    try {
      api.contextMenus.create({
        id: "atelier-collect-page",
        title: "このページの画像をまとめて送る",
        contexts: ["page"],
      });
    } catch {
      /* already exists */
    }
  };

  try {
    const pending = api.contextMenus.removeAll();
    if (pending && typeof pending.then === "function") {
      pending.then(make).catch(make);
    } else {
      setTimeout(make, 100);
    }
  } catch {
    make();
  }
}

api.runtime.onInstalled.addListener((details) => {
  createMenus();
  if (details.reason === "install") {
    api.runtime.openOptionsPage?.();
  }
});

api.runtime.onStartup?.addListener(() => {
  createMenus();
  flush();
});

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "status" || message?.type === "diagnostics") {
    getStatus()
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  }
  if (message?.type === "gaps-observation") {
    observeGaps(message.observations, _sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "collect" && message.event) {
    postEvent(message.event);
  } else if (message?.type === "inventory" && message.inventory) {
    handleInventory(message.inventory);
  } else if (message?.type === "health" && message.health) {
    updateHealth(message.health);
  } else if (message?.type === "sample-candidate" && message.source) {
    handleSampleCandidate(message);
  } else if (message?.type === "flush") {
    flush();
  } else if (message?.type === "clear") {
    clearGeneration += 1;
    sampleBuffer = [];
    api.storage.local
      .set({ pending: [], queueFull: false })
      .then(() => updateBadge())
      .catch(() => {});
  }
  return false;
});

self.addEventListener("error", (event) => {
  recordBackgroundError(event.message || event.error || "background error").catch(() => {});
});

self.addEventListener("unhandledrejection", (event) => {
  recordBackgroundError(event.reason || "unhandled rejection").catch(() => {});
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "atelier-collect-image" && info.srcUrl) {
    postEvent({
      action: "click",
      item: {
        type: "image",
        id: null,
        url: info.pageUrl || info.srcUrl,
        title: "",
      },
      images: [{ url: info.srcUrl }],
      metadata: { via: "context_menu" },
    });
  } else if (info.menuItemId === "atelier-collect-page" && tab?.id) {
    try {
      const pending = api.tabs.sendMessage(tab.id, { type: "atelier-collect-page" });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {
      /* restricted page */
    }
  }
});

api.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isImageUrl(tab.url)) return;

  (async () => {
    let pageUrl = tab.url;
    let source = sourceForHost(hostOf(tab.url));
    if (tab.openerTabId) {
      try {
        const opener = await api.tabs.get(tab.openerTabId);
        if (opener?.url) {
          pageUrl = opener.url;
          source = sourceForHost(hostOf(pageUrl));
        }
      } catch {
        /* opener may be closed */
      }
    }
    postEvent({
      source,
      action: "open",
      item: { type: "image", id: null, url: pageUrl, title: "" },
      images: [{ url: tab.url }],
      metadata: { via: "tab" },
    });
  })();
});

api.alarms.create("atelier-flush", { periodInMinutes: 1 });
api.alarms.create("atelier-maintenance", { periodInMinutes: 60 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "atelier-flush") {
    flush();
    flushGaps().catch(() => {});
  }
  if (alarm.name === "atelier-maintenance") cleanupSamples();
});

changeGaps(() => {}).catch(() => {});
updateBadge();

api.storage.onChanged.addListener((changes) => {
  if (changes.enabled || changes.sites || changes.token || changes.endpoint) {
    updateGapsSettings(changes).catch(() => {});
  }
  if (changes.enabled && changes.enabled.newValue) flush();
  if (changes.sampling && changes.sampling.newValue === false) sampleBuffer = [];
  if (
    changes.enabled ||
    changes.sites ||
    changes.gapsState ||
    changes.token ||
    changes.pending ||
    changes.counts ||
    changes.queueFull ||
    changes.health ||
    changes.endpoint
  ) {
    updateBadge();
  }
});
