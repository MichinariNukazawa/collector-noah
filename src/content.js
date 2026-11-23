/* Collector Noah - content script */
const api = globalThis.browser ?? globalThis.chrome;

const SITES = globalThis.ATELIER_SITES || {};
const SOURCE_BY_HOST = globalThis.ATELIER_SOURCE_BY_HOST || {};
const DEFAULT_SITES = Object.fromEntries(Object.keys(SITES).map((id) => [id, true]));

const lastSent = new Map();
const commentDedup = new Map();
let enabled = false;
let sites = { ...DEFAULT_SITES };
let samplingEnabled = false;

function sourceForHost(host) {
  const h = String(host || "").toLowerCase();
  for (const [name, source] of Object.entries(SOURCE_BY_HOST)) {
    if (h === name || h.endsWith("." + name)) return source;
  }
  return "other";
}

function currentSite() {
  const source = sourceForHost(location.hostname);
  return { source, config: SITES[source] || null };
}

function surfaceForConfig(config) {
  const patterns = config?.surfacePatterns;
  if (!Array.isArray(patterns)) return undefined;
  for (const p of patterns) {
    if (!p || typeof p.pattern !== "string") continue;
    try {
      if (new RegExp(p.pattern).test(location.pathname)) return p.surface;
    } catch {
      /* ignore bad pattern */
    }
  }
  return undefined;
}

function safeUrl(value) {
  if (!value) return "";
  if (value.startsWith("data:")) return "[data]";
  if (value.startsWith("blob:")) return "[blob]";
  try {
    const url = new URL(value, location.href);
    url.search = "";
    url.hash = "";
    let path = url.pathname;
    if (url.hostname.endsWith("x.com") || url.hostname.endsWith("twitter.com")) {
      path = path.replace(/^\/[^/]+\/status\/\d+/, "/{user}/status/{id}");
      // プロフィールパス（単一セグメント）を赤化
      const knownRoutes = new Set(["", "/", "/home", "/explore", "/notifications", "/messages", "/settings", "/i", "/search", "/compose", "/login", "/signup", "/logout"]);
      if (!knownRoutes.has(path) && /^\/[^/]+$/.test(path)) {
        path = "/{user}";
      }
    }
    if (url.hostname.endsWith("pixiv.net")) {
      path = path.replace(/^\/artworks\/\d+/, "/artworks/{id}");
      path = path.replace(/^\/users\/\d+/, "/users/{id}");
    }
    if (url.hostname.endsWith("danbooru.donmai.us")) {
      path = path.replace(/^\/posts\/\d+/, "/posts/{id}");
    }
    path = path.replace(/\/\d{3,}/g, "/{id}");
    return `${url.origin}${path}`;
  } catch {
    return "";
  }
}

function clipText(value, limit = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function hashUrl(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeMessage(value, limit = 300) {
  return clipText(value, limit).replace(/https?:\/\/\S+/g, "[url]");
}

const SAFE_DATA_ATTR = /^data-(testid|test|click-action|action|type|role|component)$/i;

function send(event) {
  if (!enabled || sites[event.source] !== true) return;
  const images = (event.images || []).filter(
    (image) =>
      image?.url &&
      !image.url.startsWith("data:") &&
      !image.url.startsWith("blob:")
  );
  const pixivArtworkAction = event.source === "pixiv" &&
    event.item?.type === "artwork" && event.metadata?.via === "action";
  if (!images.length && event.action !== "open" && event.action !== "comment" && !pixivArtworkAction) return;
  event.images = images;

  const key = `${event.action}:${event.removed ? "removed" : "pressed"}:${event.item?.url || ""}:${images
    .map((image) => image.url)
    .join(",")}`;
  const now = Date.now();
  if (lastSent.get(key) && now - lastSent.get(key) < 3000) return;
  lastSent.set(key, now);
  if (lastSent.size > 500) {
    for (const [oldKey, at] of lastSent) {
      if (now - at > 60000) lastSent.delete(oldKey);
    }
  }

  try {
    const pending = api.runtime.sendMessage({ type: "collect", event });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    /* background not ready */
  }
}

function imageEntry(img) {
  const url = img.currentSrc || img.src || "";
  if (!url) return null;
  return {
    url,
    width: img.naturalWidth || null,
    height: img.naturalHeight || null,
  };
}

const MAX_CAPTURE_PIXELS = 16000000;
const MAX_CAPTURE_BYTES = 180_000;

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

// 表示済みの画像を Canvas から読み取り、追加通信なしで Blob にする。
// 同一オリジンまたは CORS を通して読み込んだ画像のみ成功する。
// CORS なし画像は null と理由を返し、再要求はしない。
async function captureImage(img) {
  if (!img || !img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) {
    return { blob: null, reason: "not_displayed" };
  }
  if (img.naturalWidth * img.naturalHeight > MAX_CAPTURE_PIXELS) {
    return { blob: null, reason: "size_limit" };
  }
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { blob: null, reason: "encode_failed" };
  }
  try {
    ctx.drawImage(img, 0, 0);
  } catch {
    return { blob: null, reason: "encode_failed" };
  }
  // 読み出し可否の確認。tainted なら例外になる。
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch {
    return { blob: null, reason: "cors_blocked" };
  }
  try {
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (png && png.size <= MAX_CAPTURE_BYTES) return { blob: png, reason: null };

    const webp = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
    if (webp && webp.size <= MAX_CAPTURE_BYTES) return { blob: webp, reason: null };
    if (png || webp) return { blob: null, reason: "size_limit" };
  } catch {
    // The browser could not encode the canvas.
  }
  return { blob: null, reason: "encode_failed" };
}

async function imageEntryWithCapture(img) {
  const entry = imageEntry(img);
  if (!entry) return null;
  const { blob, reason } = await captureImage(img);
  if (!blob) return { ...entry, download_error: reason };
  try {
    return { ...entry, data: await blobToBase64(blob), content_type: blob.type };
  } catch {
    return { ...entry, download_error: "encode_failed" };
  }
}

function enrichItem(item, config, container) {
  const root = container || document;

  // FR-22: サイトの構造化タグ
  const tagSelectors = config?.tagSelectors || [];
  if (Array.isArray(tagSelectors) && tagSelectors.length) {
    const allTags = [];
    for (const selector of tagSelectors) {
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch {
        nodes = [];
      }
      for (const node of nodes) {
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
        if (text) allTags.push(text);
      }
    }
    if (allTags.length) {
      let truncated = allTags.length > 30 || allTags.some((t) => t.length > 50);
      const tags = allTags.slice(0, 30).map((t) =>
        t.length > 50 ? t.slice(0, 50) : t
      );
      item.tags = tags;
      if (truncated) item.tags_truncated = true;
    }
  }

  // FR-21: 対象コンテナ内の付随本文
  if (config?.bodySelector) {
    let bodyEl = null;
    try {
      bodyEl = root.querySelector(config.bodySelector);
    } catch {
      bodyEl = null;
    }
    if (bodyEl) {
      const text = String(bodyEl.textContent || "").replace(/\s+/g, " ").trim();
      if (text) {
        if (text.length <= 2000) {
          item.body = text;
        } else {
          item.body = text.slice(0, 2000);
          item.body_truncated = true;
        }
      }
    }
  }

  // FR-23: 作者
  if (config?.authorSelector) {
    let nameEl = null;
    try {
      nameEl = root.querySelector(config.authorSelector);
    } catch {
      nameEl = null;
    }
    const nameRaw = nameEl
      ? String(nameEl.textContent || "").replace(/\s+/g, " ").trim()
      : "";
    let truncated = false;
    let name = nameRaw;
    if (name.length > 200) {
      name = name.slice(0, 200);
      truncated = true;
    }
    let id = null;
    let idFound = false;
    if (config?.authorIdPattern) {
      const candidates = [];
      try {
        for (const el of root.querySelectorAll("*")) {
          for (const attr of ["href", "data-user-id", "data-author-id", "data-id"]) {
            const v = el.getAttribute?.(attr);
            if (v) candidates.push(v);
          }
        }
      } catch {
        /* ignore */
      }
      candidates.push(location.href);
      for (const candidate of candidates) {
        let m = null;
        try {
          m = String(candidate).match(new RegExp(config.authorIdPattern));
        } catch {
          m = null;
        }
        if (m && m[1] !== undefined) {
          id = String(m[1]);
          idFound = true;
          break;
        }
      }
    }
    if (id && id.length > 200) {
      id = id.slice(0, 200);
      truncated = true;
    }
    const author = {};
    if (name) author.name = name;
    if (idFound) author.id = id;
    if (Object.keys(author).length) {
      if (truncated) author.truncated = true;
      item.author = author;
    }
  }
  return item;
}

function itemFor(el, config) {
  const spec = config?.item || {};
  const containerSelector = (config?.containerSelectors || []).join(",");
  const container = (containerSelector && el?.closest?.(containerSelector)) || document;

  let url = el?.closest?.("a[href]")?.href || null;
  if (!url && spec.urlSelector) {
    try {
      url = container.querySelector(spec.urlSelector)?.href || null;
    } catch {
      url = null;
    }
  }
  if (!url) url = location.href;

  let id = null;
  if (spec.idPattern) {
    try {
      const pattern = new RegExp(spec.idPattern);
      id = (url.match(pattern) || location.href.match(pattern))?.[1] || null;
    } catch {
      id = null;
    }
  }

  const item = {
    type: spec.type || "image",
    id,
    url,
    title: "",
    page_count: null,
  };

  enrichItem(item, config, container);
  return item;
}

function variantForUrl(url, pattern) {
  if (!pattern) return "displayed";
  try {
    return new RegExp(pattern).test(String(url || "")) ? "original" : "displayed";
  } catch {
    return "displayed";
  }
}

function targetedFor(route, imageCount) {
  const selfTarget = new Set(["image_click", "context_menu", "tab", "sample"]);
  if (selfTarget.has(route)) return true;
  if (route === "action") return imageCount === 1;
  return false;
}

function itemEvent(item, action, images, source, extra = {}) {
  const entries = (images || []).filter((image) => image && image.url);
  const route = extra.via && [
    "image_click",
    "item_link",
    "tab",
    "action",
    "page_collect",
    "context_menu",
    "sample",
  ].includes(extra.via)
    ? extra.via
    : extra.route;
  const imageCount = entries.length;
  const tgt = targetedFor(route, imageCount);
  const cfg = (currentSite && currentSite().config) || null;
  const originalPattern = cfg?.originalUrlPattern || "";
  const surface = extra.surface || surfaceForConfig(cfg);
  const event = {
    schema: 3,
    action,
    source,
    site: location.hostname,
    item,
    images: entries.map((image, order) => {
      const out = {
        url: image.url,
        width: image.width ?? null,
        height: image.height ?? null,
        order,
        variant: image.variant || variantForUrl(image.url, originalPattern),
        targeted: image.targeted !== undefined ? image.targeted : tgt,
        download_error: image.download_error ?? null,
      };
      if (image.content_type) out.content_type = image.content_type;
      if (image.data) out.data = image.data;
      return out;
    }),
    metadata: { ...extra },
  };
  if (route) event.route = route;
  if (extra.status) event.status = extra.status;
  if (extra.removed === true) event.removed = true;
  if (extra.comment) event.comment = extra.comment;
  if (extra.sample) {
    event.sampling = {
      selected: extra.sample.selected,
      candidates: extra.sample.candidates,
      capped: extra.sample.capped,
      conditions: extra.sample.conditions,
    };
  }
  if (extra.dwell_seconds !== undefined && extra.dwell_seconds !== null) {
    const n = Number(extra.dwell_seconds);
    if (Number.isFinite(n) && n >= 0) event.dwell_seconds = n;
  }
  if (surface) event.surface = surface;
  return event;
}

// --- 設計用の棚卸し（本文なし。操作要素の形だけ） ---

let inventoryEnabled = false;
let lastInventoryUrl = "";
let lastHealthUrl = "";
const SENSITIVE_PATH =
  /(^|\/)(mypage|mylibrary|forgot|login|reset|history|clipboard|wishlist|bookmarks?|favorites?|users?|settings|account|notifications?|messages?|likes|followers|following|communities|topics|search|i)(\/|$)/i;

function inventorySignature(el) {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") || "";
  const type = el.getAttribute("type") || "";
  const testid = el.getAttribute("data-testid") || "";
  const click = el.getAttribute("data-click-action") || "";

  return [
    tag,
    role && `role=${role}`,
    type && `type=${type}`,
    testid && `testid=${testid}`,
    click && `click=${click}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function collectInventory() {
  if (!enabled || !inventoryEnabled) return;
  const { source, config } = currentSite();
  if (!config || sites[source] !== true) return;
  if (SENSITIVE_PATH.test(location.pathname)) return;
  if (location.href === lastInventoryUrl) return;
  lastInventoryUrl = location.href;

  const nodes = document.querySelectorAll(
    "button, a, [role=button], input, select, [data-testid], [data-click-action]"
  );
  const counts = {};
  for (const el of nodes) {
    const signature = inventorySignature(el);
    if (!signature) continue;
    counts[signature] = (counts[signature] || 0) + 1;
  }

  const controls = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 150)
    .map(([signature, count]) => ({ signature, count }));

  const spec = config.item || {};
  let itemPage = false;
  if (spec.idPattern) {
    try {
      itemPage = new RegExp(spec.idPattern).test(location.pathname + location.search);
    } catch {
      itemPage = false;
    }
  }

  const selectors = [];
  if (itemPage) {
    for (const action of config.actions || []) {
      for (const selector of action.selectors || []) {
        let count = 0;
        try {
          count = document.querySelectorAll(selector).length;
        } catch {
          count = 0;
        }
        selectors.push({ action: action.action, selector, count });
      }
    }
  }

  const inventory = {
    url: safeUrl(location.href),
    urlKey: hashUrl(location.href),
    site: location.hostname,
    source,
    total: nodes.length,
    controls,
    itemPage,
    selectors,
    buildHash: globalThis.ATELIER_BUILD?.sitesHash || "",
  };

  try {
    const pending = api.runtime.sendMessage({ type: "inventory", inventory });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    /* background not ready */
  }
}

function collectHealth() {
  if (!enabled) return;
  const { source, config } = currentSite();
  if (!config || sites[source] !== true) return;
  if (SENSITIVE_PATH.test(location.pathname)) return;
  if (location.href === lastHealthUrl) return;
  lastHealthUrl = location.href;

  const spec = config.item || {};
  let itemPage = false;
  if (spec.idPattern) {
    try {
      itemPage = new RegExp(spec.idPattern).test(location.pathname + location.search);
    } catch {
      itemPage = false;
    }
  }
  if (!itemPage) return;

  const selectors = [];
  for (const action of config.actions || []) {
    for (const selector of action.selectors || []) {
      let count = 0;
      try {
        count = document.querySelectorAll(selector).length;
      } catch {
        count = 0;
      }
      selectors.push({ action: action.action, selector, count });
    }
  }

  try {
    const pending = api.runtime.sendMessage({
      type: "health",
      health: {
        site: location.hostname,
        source,
        urlKey: hashUrl(location.href),
        itemPage: true,
        selectors,
        buildHash: globalThis.ATELIER_BUILD?.sitesHash || "",
      },
    });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    /* background not ready */
  }
}

// --- 比較可能な詳細ページでの gaps 観測（FR-14） ---

const GAP_ACTIONS = new Set(["like", "save", "bookmark", "follow"]);
const GAP_INPUT_COOLDOWN_MS = 3000;
const GAP_DOM_COOLDOWN_MS = 2000;
let gapObserver = null;
let gapTimer;
let gapSnapshot = null;
let gapEmitted = false;
let gapLastInput = -Infinity;
let gapLastChange = -Infinity;

function gapMatchesInjection(config) {
  // The browser enforces initial injection. Recheck the current URL after SPA navigation.
  return config.matches.some((pattern) => {
    const match = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!match) return false;
    const [, scheme, host, path] = match;
    if (scheme === "*" ? !/^https?:$/.test(location.protocol) : location.protocol !== scheme + ":") return false;
    const domain = host.replace(/^\*\./, "");
    if (location.hostname !== domain &&
        !(host.startsWith("*.") && location.hostname.endsWith("." + domain))) return false;
    const pathPattern = path.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp("^" + pathPattern + "$").test(location.pathname + location.search);
  });
}

function gapVisible(element) {
  if (element.checkVisibility) {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
}

function gapVisibleMatches(root, selector) {
  return [...root.querySelectorAll(selector)].filter(gapVisible);
}

function gapActionMatches(container, definitions) {
  const matches = new Set();
  for (const definition of definitions) {
    for (const selector of definition.selectors || []) {
      for (const node of gapVisibleMatches(container, selector)) matches.add(node);
    }
    if (!definition.texts?.length) continue;
    for (const node of gapVisibleMatches(container, "button, a, [role='button']")) {
      const searchable = [node.innerText, node.getAttribute("aria-label"), node.getAttribute("title")].join(" ");
      if (definition.texts.some((candidate) => searchable.includes(candidate))) matches.add(node);
    }
  }
  return [...matches];
}

function gapPageEvidence(source, config) {
  const snapshot = [location.href];
  const observations = [];
  // Capture matching node identities so a replacement also restarts the SPA cooldown.
  function find(root, selector) {
    const nodes = gapVisibleMatches(root, selector);
    snapshot.push(nodes.length, ...nodes);
    return nodes;
  }

  try {
    if (SENSITIVE_PATH.test(location.pathname) || !gapMatchesInjection(config)) {
      return { snapshot, observations };
    }
    const itemId = new RegExp(config.item?.idPattern || "(?!)").exec(location.pathname + location.search)?.[1];
    if (!itemId) return { snapshot, observations };

    const pages = config.gaps.filter((page) => new RegExp(page.pathPattern).test(location.pathname));
    if (pages.length !== 1) return { snapshot, observations };
    const [page] = pages;
    const { pageType, containerSelector, itemIdAttribute, readySelector, loggedInSelector, loginRequiredSelector } = page;
    if (![pageType, containerSelector, itemIdAttribute, readySelector, loggedInSelector, loginRequiredSelector]
      .every((value) => typeof value === "string" && value)) return { snapshot, observations };

    if (find(document, "input[type=password]").length || find(document, loginRequiredSelector).length ||
        !find(document, loggedInSelector).length) return { snapshot, observations };
    const containers = [...document.querySelectorAll(containerSelector)]
      .filter((node) => node.getAttribute(itemIdAttribute) === itemId);
    snapshot.push(containers.length, ...containers);
    if (containers.length !== 1 || !gapVisible(containers[0])) return { snapshot, observations };
    const [container] = containers;
    if (!find(container, readySelector).length) return { snapshot, observations };

    for (const [action, condition] of Object.entries(page.actions || {})) {
      if (!GAP_ACTIONS.has(action)) continue;
      const { applicableSelector, unoperatedSelector, operatedSelector } = condition || {};
      if (![applicableSelector, unoperatedSelector, operatedSelector]
        .every((value) => typeof value === "string" && value)) continue;
      const definitions = (config.actions || []).filter((entry) =>
        entry.action === action && (entry.selectors?.length || entry.texts?.length));
      if (!definitions.length) continue;
      try {
        const applicable = find(container, applicableSelector).length;
        const unoperated = find(container, unoperatedSelector).length;
        const operated = find(container, operatedSelector).length;
        if (!applicable || !unoperated || operated) continue;
        const matches = gapActionMatches(container, definitions);
        snapshot.push(matches.length, ...matches);
        observations.push({ pageType, itemId, action, matched: matches.length > 0 });
      } catch {
        // An invalid selector makes this action's state unknown.
      }
    }

    const imageLimit = Object.hasOwn(config, "maxImages") ? config.maxImages : 1;
    if (page.imageReadySelector && Number.isSafeInteger(imageLimit) && imageLimit > 0 &&
        find(container, page.imageReadySelector).length) {
      const urlPattern = config.imageUrlPattern ? new RegExp(config.imageUrlPattern) : null;
      const urls = new Set();
      let loading = false;
      for (const img of container.querySelectorAll(config.imageSelector || "img")) {
        if (!(img instanceof HTMLImageElement) || (source === "pixiv" && !gapVisible(img))) continue;
        const url = img.currentSrc || img.src;
        if (!/^https?:/.test(url) || (urlPattern && !urlPattern.test(url))) continue;
        snapshot.push(img, url, img.complete, area(img));
        if (!img.complete) loading = true;
        else if (area(img) > 0) urls.add(url);
      }
      if (!loading) observations.push({ pageType, itemId, observedCount: urls.size, imageLimit });
    }
  } catch {
    // Incomplete or invalid site conditions must never be evidence of a gap.
  }
  return { snapshot, observations };
}

function checkGaps() {
  if (!gapObserver) return;
  clearTimeout(gapTimer);
  const { source, config } = currentSite();
  if (!enabled || sites[source] !== true) return;
  const { snapshot, observations } = gapPageEvidence(source, config);
  const now = performance.now();
  if (!gapSnapshot || gapSnapshot.length !== snapshot.length ||
      snapshot.some((value, index) => value !== gapSnapshot[index])) {
    if (gapSnapshot) gapLastChange = now;
    gapSnapshot = snapshot;
    gapEmitted = false;
  }
  if (document.readyState !== "complete" || document.visibilityState !== "visible" ||
      !observations.length || gapEmitted) return;

  const wait = Math.max(gapLastInput + GAP_INPUT_COOLDOWN_MS, gapLastChange + GAP_DOM_COOLDOWN_MS) - now;
  if (wait > 0) {
    gapTimer = setTimeout(checkGaps, Math.ceil(wait));
    return;
  }
  gapEmitted = true;
  const sentSnapshot = gapSnapshot;
  const retry = () => {
    if (gapSnapshot === sentSnapshot) gapEmitted = false;
  };
  try {
    api.runtime.sendMessage({ type: "gaps-observation", observations })?.then((response) => {
      if (response?.ok === false) retry();
    }, retry);
  } catch {
    retry();
  }
}

function configureGaps() {
  const { source, config } = currentSite();
  if (window !== window.top || !Array.isArray(config?.gaps) || !config.gaps.length) return;
  if (enabled && sites[source] === true) {
    if (gapObserver) return;
    gapObserver = new MutationObserver(checkGaps);
    gapObserver.observe(document.documentElement, {
      attributes: true, childList: true, characterData: true, subtree: true,
    });
    checkGaps();
  } else if (gapObserver) {
    gapObserver.disconnect();
    gapObserver = null;
    gapSnapshot = null;
    gapEmitted = false;
    gapLastChange = -Infinity;
    clearTimeout(gapTimer);
  }
}

if (window === window.top && currentSite().config?.gaps?.length) {
  for (const name of ["click", "keydown", "submit"]) {
    window.addEventListener(name, (event) => {
      if (!event.isTrusted) return;
      gapLastInput = performance.now();
      checkGaps();
    }, true);
  }
  for (const name of ["load", "error", "popstate", "hashchange"]) {
    window.addEventListener(name, checkGaps, true);
  }
  window.navigation?.addEventListener("currententrychange", checkGaps);
  document.addEventListener("readystatechange", checkGaps);
  document.addEventListener("visibilitychange", checkGaps);
}

function periodicProbe() {
  if (!enabled) return;
  checkGaps();
  if (inventoryEnabled) collectInventory();
  else collectHealth();
  if (samplingEnabled) observeSampleImages();
}

function scheduleProbe(delay = 1500) {
  setTimeout(periodicProbe, delay);
}

setInterval(periodicProbe, 5000);

// --- 閲覧サンプル（既定 OFF。design 決定5 / FR-10） ---
const SAMPLE_MIN_SIZE = 300;
const SAMPLE_VISIBLE_RATIO = 0.5;
const SAMPLE_VISIBLE_MS = 1000;
let sampleObserver = null;
const sampleTimers = new Map();
let sampleWatched = new WeakSet();

function qualifySampleImage(img) {
  if (!img || !img.complete) return false;
  if ((img.naturalWidth || 0) < SAMPLE_MIN_SIZE || (img.naturalHeight || 0) < SAMPLE_MIN_SIZE) {
    return false;
  }
  return true;
}

function reportSampleCandidate(img) {
  if (!samplingEnabled || !enabled) return;
  if (document.visibilityState !== "visible") return;
  const { source, config } = currentSite();
  if (!config || sites[source] !== true) return;
  const url = img.currentSrc || img.src || "";
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return;
  if (!matchesImageUrl(url, config.imageUrlPattern || "")) return;
  const dwellStart = img.__atelierSampleVisibleStart || Date.now();
  const dwellSeconds = Math.max(0, (Date.now() - dwellStart) / 1000);
  try {
    const pending = api.runtime.sendMessage({
      type: "sample-candidate",
      source,
      url,
      width: img.naturalWidth || null,
      height: img.naturalHeight || null,
      dwell_seconds: dwellSeconds,
    });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    /* background not ready */
  }
}

function onSampleIntersection(entries) {
  for (const entry of entries) {
    const target = entry.target;
    if (entry.intersectionRatio >= SAMPLE_VISIBLE_RATIO) {
      if (!sampleTimers.has(target)) {
        target.__atelierSampleVisibleStart = Date.now();
        const timer = setTimeout(() => {
          sampleTimers.delete(target);
          if (target.__atelierSampleVisible) reportSampleCandidate(target);
        }, SAMPLE_VISIBLE_MS);
        sampleTimers.set(target, timer);
      }
      target.__atelierSampleVisible = true;
    } else {
      target.__atelierSampleVisible = false;
      const timer = sampleTimers.get(target);
      if (timer) {
        clearTimeout(timer);
        sampleTimers.delete(target);
      }
    }
  }
}

function observeSampleImages() {
  if (!sampleObserver) return;
  for (const img of document.images) {
    if (sampleWatched.has(img)) continue;
    if (!qualifySampleImage(img)) continue;
    sampleWatched.add(img);
    sampleObserver.observe(img);
  }
}

function startSampling() {
  if (sampleObserver || typeof IntersectionObserver !== "function") return;
  sampleWatched = new WeakSet();
  sampleObserver = new IntersectionObserver(onSampleIntersection, {
    threshold: [0, 0.25, 0.5, 0.75, 1],
  });
  observeSampleImages();
}

function stopSampling() {
  if (sampleObserver) {
    sampleObserver.disconnect();
    sampleObserver = null;
  }
  for (const timer of sampleTimers.values()) clearTimeout(timer);
  sampleTimers.clear();
  sampleWatched = new WeakSet();
}

if (document.documentElement) {
  const sampleMutation = new MutationObserver(() => {
    if (samplingEnabled && enabled) observeSampleImages();
  });
  sampleMutation.observe(document.documentElement, { childList: true, subtree: true });
}

function area(img) {
  return (img.naturalWidth || 0) * (img.naturalHeight || 0);
}

function imagesIn(root, limit = 4, selector = "img", pattern = "") {
  const images = Array.from(root.querySelectorAll(selector))
    .filter((img) => area(img) > 0)
    .filter((img) => matchesImageUrl(img.currentSrc || img.src || "", pattern))
    .sort((a, b) => area(b) - area(a));
  return images.slice(0, limit);
}

function matchesImageUrl(src, pattern) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(src);
  } catch {
    return true;
  }
}

function largestImage(root, selector = "img", pattern = "") {
  return imagesIn(root, 1, selector, pattern)[0] || null;
}

function nodePath(el) {
  const parts = [];
  let node = el;
  for (let depth = 0; depth < 5 && node && node.nodeType === 1; depth++) {
    let part = node.tagName.toLowerCase();
    if (node.id) part += `#${node.id}`;
    const testId = node.getAttribute("data-testid");
    if (testId) part += `[data-testid="${testId}"]`;
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function fingerprint(el) {
  const data = [];
  for (const attr of el.attributes || []) {
    if (SAFE_DATA_ATTR.test(attr.name)) {
      data.push([attr.name, clipText(attr.value, 80)]);
    }
  }
  return {
    ts: new Date().toISOString(),
    tag: el.tagName.toLowerCase(),
    data,
  };
}

function actionFor(target, config) {
  const actions = config?.actions || [];

  for (const action of actions) {
    const selectors = action.selectors || [];
    if (!selectors.length) continue;
    const el = target.closest?.(selectors.join(","));
    if (el) {
      const matched = selectors.find((selector) => {
        try {
          return el.matches(selector);
        } catch {
          return false;
        }
      }) || selectors.join(",");
      return { action: action.action, el, matched };
    }
  }

  for (const action of actions) {
    const texts = action.texts || [];
    if (!texts.length) continue;
    let el = target;
    for (let depth = 0; depth < 6 && el; depth++, el = el.parentElement) {
      if (!el.matches?.("button, a, [role='button']")) continue;
      const haystack = [
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
      ].join(" ");
      const matched = texts.find((text) => haystack.includes(text));
      if (matched) {
        return { action: action.action, el, matched: `text:${matched}` };
      }
    }
  }

  return null;
}

function looksLikeAction(el) {
  const haystack = [
    el.innerText,
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.className,
    ...[...el.attributes].map((attr) => `${attr.name}=${attr.value}`),
  ].join(" ");
  return /like|save|bookmark|favorite|fav|いいね|保存|ブックマーク|お気に入り/i.test(haystack);
}

async function recordSuccess(source, action, el, matched = "") {
  if (!enabled || sites[source] !== true) return;
  // クリック直後にDOMが変わるので、待つ前に指紋を取る
  const snapshot = { ...fingerprint(el), matched };
  const { lastSuccess = {} } = await api.storage.local.get({ lastSuccess: {} });
  lastSuccess[`${source}:${action}`] = snapshot;
  await api.storage.local.set({ lastSuccess });
}

async function recordDiagnostic(entry) {
  if (!enabled) return;
  if (entry.source && sites[entry.source] !== true) return;
  const { diagnostics = [] } = await api.storage.local.get({ diagnostics: [] });
  diagnostics.push({ ts: new Date().toISOString(), ...entry });
  await api.storage.local.set({ diagnostics: diagnostics.slice(-30) });
}

function sanitizeElement(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);
  clone
    .querySelectorAll("script, style, svg, iframe, noscript, template")
    .forEach((node) => node.remove());

  const commentWalker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
  for (const node of comments) node.remove();

  const allowed = new Set([
    "class",
    "role",
    "aria-label",
    "data-testid",
    "data-click-action",
    "src",
    "href",
    "width",
    "height",
    "type",
  ]);
  const actionLabel = /(いいね|ブックマーク|保存|お気に入り|ほしい|フォロー|like|save|bookmark|follow)/i;

  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      const keepData = SAFE_DATA_ATTR.test(attr.name);
      if (!allowed.has(attr.name) && !keepData) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (attr.name === "aria-label" && !actionLabel.test(attr.value)) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (attr.name === "href") {
        node.setAttribute(attr.name, "[link]");
      } else if (attr.name === "src") {
        node.setAttribute(attr.name, safeUrl(attr.value));
      } else if (attr.value.length > 120) {
        node.setAttribute(attr.name, attr.value.slice(0, 120));
      }
    }
  }

  // ページ本文を持ち出さないため、テキストは落として属性だけ残す
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) node.textContent = "";

  return clone.outerHTML.slice(0, 4000);
}

async function buildDiagnostics() {
  const { source, config } = currentSite();
  const storage = await api.storage.local.get({ lastSuccess: {}, diagnostics: [] });

  const selectorResults = [];
  const textResults = [];
  for (const action of config?.actions || []) {
    for (const selector of action.selectors || []) {
      selectorResults.push({
        action: action.action,
        selector,
        count: document.querySelectorAll(selector).length,
      });
    }
    for (const text of action.texts || []) {
      const count = [...document.querySelectorAll("button, a, [role='button']")]
        .filter((el) => {
          const haystack = [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")].join(" ");
          return haystack.includes(text);
        }).length;
      textResults.push({ action: action.action, text, count });
    }
  }

  const controls = [...document.querySelectorAll("button, a, [role='button']")];
  let candidates = controls.filter(looksLikeAction).slice(0, 20);
  if (!candidates.length) candidates = controls.slice(0, 20);
  candidates = candidates.map(fingerprint);

  const images = [...document.images]
    .filter((img) => /^https?:/i.test(img.currentSrc || img.src || ""))
    .filter((img) => !/\.svg(?:[?#]|$)/i.test(img.currentSrc || img.src || ""))
    .sort((a, b) => area(b) - area(a))
    .slice(0, 12)
    .map((img) => ({
      src: safeUrl(img.currentSrc || img.src),
      width: img.naturalWidth || null,
      height: img.naturalHeight || null,
    }));

  const containerSelector = (config?.containerSelectors || []).join(",") || "article, main";
  const container = document.querySelector(containerSelector) || document.body;

  const lastSuccess = {};
  for (const [key, value] of Object.entries(storage.lastSuccess || {})) {
    if (key.startsWith(source + ":")) lastSuccess[key] = value;
  }

  return {
    page: {
      url: safeUrl(location.href),
      source,
      site: location.hostname,
    },
    adapter: config || null,
    selectorResults,
    textResults,
    candidates,
    images,
    html: sanitizeElement(container),
    lastSuccess,
    misses: (storage.diagnostics || []).filter((item) => item.type === "miss" && item.source === source),
    errors: (storage.diagnostics || []).filter((item) => item.type === "error"),
  };
}

async function collectPixiv(action, extra = {}) {
  if (!enabled || sites.pixiv !== true) return;
  const match = location.pathname.match(/\/artworks\/(\d+)/);
  if (!match) return;

  const illustId = match[1];
  const config = SITES.pixiv || {};
  // DOM に既にある情報だけ使う。追加の API 要求はしない。
  const img = largestImage(
    document,
    config.imageSelector || "img",
    config.imageUrlPattern || "",
  );
  const entry = img ? await imageEntryWithCapture(img) : null;

  const item = {
    type: "artwork",
    id: illustId,
    url: location.href.split("#")[0],
    title: "",
    page_count: null,
  };
  const containerSelector = (config.containerSelectors || []).join(",");
  const container = (containerSelector && document.querySelector(containerSelector)) || document;
  enrichItem(item, config, container);
  const payload = itemEvent(item, action, entry ? [entry] : [], "pixiv", {
    via: extra.via || "action",
    illust_id: illustId,
    status: "pressed",
  });
  if (payload) send(payload);
}

async function onImageClick(event) {
  if (!enabled || !event.isTrusted) return;
  const img = event.target.closest?.("img");
  if (!img) return;
  const { source, config } = currentSite();
  if (!matchesImageUrl(img.currentSrc || img.src || "", config?.imageUrlPattern || "")) return;

  // item が特定できない場合も、明示的な画像クリックは image として記録する
  const spec = config?.item || {};
  let onItemPage = false;
  if (spec.idPattern) {
    try {
      onItemPage = new RegExp(spec.idPattern).test(location.pathname + location.search);
    } catch {
      onItemPage = false;
    }
  }
  const anchored = Boolean(img.closest?.("a[href]"));
  const item = itemFor(img, config);
  if (!anchored && !onItemPage) {
    item.type = "image";
    item.id = null;
  }

  const entry = await imageEntryWithCapture(img);
  if (!entry) return;
  const payload = itemEvent(item, "click", [entry], source, { via: "image_click" });
  if (payload) send(payload);
}

function onItemLinkClick(event) {
  if (!enabled || !event.isTrusted) return;
  const link = event.target.closest?.("a[href]");
  if (!link) return;
  // 画像つきリンクは onImageClick が扱う（二重に記録しない）
  if (link.querySelector("img")) return;

  const { source, config } = currentSite();
  if (!config?.item?.idPattern) return;
  // いいね・保存などの操作リンクは onActionClick が扱う
  if (actionFor(event.target, config)) return;
  let matches = false;
  try {
    matches = new RegExp(config.item.idPattern).test(link.href);
  } catch {
    return;
  }
  if (!matches) return;

  const payload = itemEvent(itemFor(link, config), "open", [], source, {
    via: "item_link",
  });
  if (payload) send(payload);
}

async function onActionClick(event) {
  if (!enabled || !event.isTrusted) return;
  const { source, config } = currentSite();
  if (!config) return;

  const hit = actionFor(event.target, config);
  if (!hit) {
    const candidate = event.target.closest?.("button, a, [role='button']");
    if (candidate && looksLikeAction(candidate)) {
      recordDiagnostic({
        type: "miss",
        source,
        fingerprint: fingerprint(candidate),
      }).catch(() => {});
    }
    return;
  }

  recordSuccess(source, hit.action, hit.el, hit.matched).catch(() => {});

  const actionCfg = (config.actions || []).find((a) => a.action === hit.action);
  const removalAttr = actionCfg?.removal?.attribute;
  let initialPressed = false;
  if (removalAttr) {
    const val = hit.el.getAttribute?.(removalAttr);
    initialPressed = val === "true" || val === true;
  }

  const isPressedAction = ["like", "save", "bookmark", "follow"].includes(hit.action);

  if (config.pageApi === "pixiv") {
    // Pixiv は removal 設定を持たない前提。従来どおり。
    collectPixiv(hit.action, { via: "action" });
    return;
  }

  const containerSelector = (config.containerSelectors || []).join(",");
  const container = (containerSelector && hit.el.closest(containerSelector)) || document;

  const gatherImages = async () => {
    const capturedImages = [];
    for (const img of imagesIn(
      container,
      config.maxImages || 1,
      config.imageSelector || "img",
      config.imageUrlPattern || ""
    )) {
      const entry = await imageEntryWithCapture(img);
      if (entry) capturedImages.push(entry);
    }
    return capturedImages;
  };

  if (removalAttr && initialPressed) {
    // 解除の可能性: 700ms 後に属性変化を確認してから送る
    const capturedImages = await gatherImages();
    const item = itemFor(hit.el, config);
    setTimeout(() => {
      let nowPressed = false;
      try {
        const val = hit.el.getAttribute?.(removalAttr);
        nowPressed = val === "true" || val === true;
      } catch {
        nowPressed = false;
      }
      if (nowPressed) {
        return; // 変化なし: 通常の押下ではない
      }
      const payload = itemEvent(item, hit.action, capturedImages, source, {
        via: "action",
        matched: hit.matched,
        removed: true,
        status: isPressedAction ? "pressed" : undefined,
      });
      if (payload) send(payload);
    }, 700);
    return;
  }

  const capturedImages = await gatherImages();
  const payload = itemEvent(itemFor(hit.el, config), hit.action, capturedImages, source, {
    via: "action",
    matched: hit.matched,
    status: isPressedAction ? "pressed" : undefined,
  });
  if (payload) send(payload);
}

document.addEventListener("click", onImageClick, true);
document.addEventListener("click", onItemLinkClick, true);
document.addEventListener("click", onActionClick, true);

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "atelier-collect-page" && enabled) {
    const { source, config } = currentSite();
    if (config?.pageApi === "pixiv" && /\/artworks\//.test(location.pathname)) {
      collectPixiv("seen", { via: "page_collect" });
      return false;
    }
    (async () => {
      const groups = new Map();
      for (const img of document.images) {
        if ((img.naturalWidth || 0) < 300 || (img.naturalHeight || 0) < 300) continue;
        if (!matchesImageUrl(img.currentSrc || img.src || "", config?.imageUrlPattern || "")) continue;
        const entry = await imageEntryWithCapture(img);
        if (!entry) continue;
        const item = itemFor(img, config);
        const key = `${item.url}|${item.id || ""}`;
        if (!groups.has(key)) groups.set(key, { item, images: [] });
        groups.get(key).images.push(entry);
      }
      for (const group of groups.values()) {
        const payload = itemEvent(
          group.item,
          "seen",
          group.images.slice(0, config?.maxImages || 4),
          source,
          { via: "page_collect" }
        );
        if (payload) send(payload);
      }
    })();
    return false;
  }

  if (message?.type === "diagnose") {
    buildDiagnostics()
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  }

  return false;
});

window.addEventListener("error", (event) => {
  recordDiagnostic({
    type: "error",
    where: "content",
    source: currentSite().source,
    page: safeUrl(location.href),
    message: safeMessage(event.message || event.error || ""),
  }).catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  recordDiagnostic({
    type: "error",
    where: "content",
    source: currentSite().source,
    page: safeUrl(location.href),
    message: safeMessage(event.reason || ""),
  }).catch(() => {});
});

// --- FR-11: 本人コメントの本文（送信成立が表示から確認できる経路のみ） ---
function tryDetectComment(config, source, submitEl) {
  const c = config?.comment;
  if (!c) return;
  const submitSelectors = c.submitSelectors || [];
  const matched = submitSelectors.some((sel) => {
    try {
      return submitEl.matches(sel);
    } catch {
      return false;
    }
  });
  if (!matched) return;

  const timeout = Number(c.confirmTimeoutMs) || 3000;
  const resultSelectors = c.resultSelectors || [];
  const bodySelector = c.resultBodySelector;
  const item = itemFor(submitEl, config);
  const start = Date.now();

  const poll = () => {
    let resultEl = null;
    for (const sel of resultSelectors) {
      try {
        resultEl = document.querySelector(sel);
      } catch {
        resultEl = null;
      }
      if (resultEl) break;
    }
    if (!resultEl) {
      if (Date.now() - start < timeout) setTimeout(poll, 100);
      return;
    }
    let bodyEl = resultEl;
    if (bodySelector) {
      try {
        const q = resultEl.querySelector(bodySelector);
        if (q) bodyEl = q;
      } catch {
        /* ignore */
      }
    }
    const text = String(bodyEl.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) {
      if (Date.now() - start < timeout) setTimeout(poll, 100);
      return;
    }
    const key = `${item.url}|${hashUrl(text)}`;
    const now = Date.now();
    const last = commentDedup.get(key);
    if (last && now - last < 60000) return;
    commentDedup.set(key, now);

    let body = text;
    let truncated = false;
    if (body.length > 2000) {
      body = body.slice(0, 2000);
      truncated = true;
    }
    const comment = { body };
    if (truncated) comment.truncated = true;

    const payload = itemEvent(item, "comment", [], source, {
      via: "action",
      status: "confirmed",
      comment,
    });
    if (payload) send(payload);
  };

  setTimeout(poll, 100);
}

document.addEventListener(
  "click",
  (event) => {
    if (!enabled) return;
    const { source, config } = currentSite();
    if (!config?.comment) return;
    const submitSelectors = config.comment.submitSelectors || [];
    if (!submitSelectors.length) return;
    let el = event.target;
    let submitEl = null;
    for (let depth = 0; depth < 6 && el; depth++, el = el.parentElement) {
      if (
        submitSelectors.some((sel) => {
          try {
            return el.matches?.(sel);
          } catch {
            return false;
          }
        })
      ) {
        submitEl = el;
        break;
      }
    }
    if (!submitEl) return;
    tryDetectComment(config, source, submitEl);
  },
  true
);

api.storage.local.get({ enabled: false, sites: DEFAULT_SITES, inventory: false, sampling: false }).then((value) => {
  enabled = Boolean(value.enabled);
  sites = { ...DEFAULT_SITES, ...(value.sites || {}) };
  inventoryEnabled = value.inventory === true;
  samplingEnabled = value.sampling === true;
  scheduleProbe(1500);
  configureGaps();
  if (samplingEnabled) startSampling();
});

api.storage.onChanged.addListener((changes) => {
  if (changes.enabled) enabled = Boolean(changes.enabled.newValue);
  if (changes.sites) sites = { ...DEFAULT_SITES, ...(changes.sites.newValue || {}) };
  if (changes.enabled || changes.sites) configureGaps();
  if (changes.inventory) inventoryEnabled = changes.inventory.newValue === true;
  if (changes.sampling) {
    samplingEnabled = changes.sampling.newValue === true;
    if (samplingEnabled) startSampling();
    else stopSampling();
  }
});
