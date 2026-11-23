const api = globalThis.browser ?? globalThis.chrome;
const ALL_SITES = globalThis.ATELIER_SITES || {};

const DEFAULTS = {
  endpoint: "http://127.0.0.1:8765",
  token: "",
  enabled: false,
  inventory: false,
  sampling: false,
  sites: Object.fromEntries(Object.keys(ALL_SITES).map((id) => [id, true])),
};

const $ = (id) => document.getElementById(id);

function normalizeEndpoint(value) {
  return String(value || DEFAULTS.endpoint).trim().replace(/\/+$/, "");
}

function endpointIsValid(value) {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const loopback =
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    if (!loopback) return false;
    if (url.port !== "8765") return false;
    if (url.search || url.hash) return false;
    if (url.pathname !== "" && url.pathname !== "/") return false;
    return true;
  } catch {
    return false;
  }
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function renderSites() {
  const container = $("sites");
  container.innerHTML = "";
  for (const [id, config] of Object.entries(ALL_SITES)) {
    const label = document.createElement("label");
    label.className = "row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.site = id;
    label.append(input, document.createTextNode(` ${config.label || id}`));
    container.append(label);
  }
}

function readSites() {
  const sites = { ...DEFAULTS.sites };
  for (const input of document.querySelectorAll("input[data-site]")) {
    sites[input.dataset.site] = input.checked;
  }
  return sites;
}

function writeSites(sites) {
  const merged = { ...DEFAULTS.sites, ...(sites || {}) };
  for (const input of document.querySelectorAll("input[data-site]")) {
    input.checked = merged[input.dataset.site] !== false;
  }
}

async function load() {
  renderSites();
  const settings = await api.storage.local.get(DEFAULTS);
  $("endpoint").value = settings.endpoint || DEFAULTS.endpoint;
  $("token").value = settings.token || "";
  $("enabled").checked = Boolean(settings.enabled);
  $("inventory").checked = settings.inventory === true;
  $("sampling").checked = settings.sampling === true;
  writeSites(settings.sites);

  const { pending = [] } = await api.storage.local.get({ pending: [] });
  if (pending.length) {
    setStatus(`未送信のイベントが ${pending.length} 件あります。`);
  }
}

async function save() {
  const endpoint = normalizeEndpoint($("endpoint").value);
  const token = $("token").value.trim();
  const enabled = $("enabled").checked;
  if (enabled && !token) {
    setStatus("収集を始めるにはTokenが必要です。", "error");
    return;
  }
  if (!endpointIsValid(endpoint)) {
    setStatus("受信先は http://127.0.0.1:8765 のみ許可しています。", "error");
    return;
  }
  await api.storage.local.set({
    endpoint,
    token,
    enabled,
    inventory: $("inventory").checked,
    sampling: $("sampling").checked,
    sites: readSites(),
  });
  setStatus("保存しました。", "ok");
}

async function test() {
  const endpoint = normalizeEndpoint($("endpoint").value);
  const token = $("token").value.trim();
  if (!token) {
    setStatus("Tokenを入れてください。", "error");
    return;
  }
  if (!endpointIsValid(endpoint)) {
    setStatus("受信先は http://127.0.0.1:8765 のみ許可しています。", "error");
    return;
  }

  setStatus("確認中…");
  try {
    const health = await fetch(`${endpoint}/api/health`, { redirect: "error" });
    if (!health.ok) throw new Error(`health ${health.status}`);
    const info = await health.json();

    const events = await fetch(`${endpoint}/api/events?limit=1`, {
      headers: { "X-Atelier-Token": token },
      redirect: "error",
    });
    if (events.status === 401) {
      setStatus("受信アプリには繋がりましたが、Tokenが違います。", "error");
      return;
    }
    if (!events.ok) throw new Error(`events ${events.status}`);

    setStatus(`接続OK（Collector ver ${info.version}）`, "ok");
  } catch {
    setStatus(
      "接続できません。collectorを起動し、EndpointとTokenを確認してください。",
      "error",
    );
  }
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
load();
