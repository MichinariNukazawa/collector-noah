const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let lastReport = "";
let busy = false;

function clip(value, limit = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function redactUrl(value) {
  if (!value) return "";
  if (!/^https?:/i.test(String(value))) return "[url]";
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    let path = url.pathname;
    if (url.hostname.endsWith("x.com") || url.hostname.endsWith("twitter.com")) {
      path = path.replace(/^\/[^/]+\/status\/\d+/, "/{user}/status/{id}");
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
    return "[url]";
  }
}

function redactTitle(value) {
  return clip(value, 120).replace(/^.+? on X:/, "[post] on X:");
}

function redactEvent(event) {
  if (!event || typeof event !== "object") return null;
  const images = Array.isArray(event.images) ? event.images : [];
  const imageUrls = images.length
    ? images.map((image) => redactUrl(image?.url)).filter(Boolean)
    : [redactUrl(event.image_url)].filter(Boolean);
  const downloadErrors = [
    ...images.map((image) => image?.download_error),
    event.download_error,
  ].filter(Boolean);
  return {
    ts: event.created_at || event.ts || "",
    source: event.source || "",
    action: event.action || "",
    item: redactUrl(event.item?.url || event.page_url),
    images: imageUrls,
    image_hash: event.image_hash || "",
    download_error: downloadErrors.length
      ? clip(downloadErrors.join("; "), 200).replace(/https?:\/\/\S+/g, "[url]")
      : "",
  };
}

function setMessage(text, kind = "") {
  const el = $("message");
  el.textContent = text;
  el.className = `message ${kind}`.trim();
}

function setState(text, kind = "") {
  const el = $("state");
  el.textContent = text;
  el.className = `state ${kind}`.trim();
}

function formatReceivedAt(value) {
  if (!value) return "受信した記録はまだありません";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "受信した記録はまだありません";
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return time;
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  if (date.getFullYear() !== now.getFullYear()) {
    return `${date.getFullYear()}/${monthDay} ${time}`;
  }
  return `${monthDay} ${time}`;
}

async function sendStatus() {
  return api.runtime.sendMessage({ type: "status" });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function browserInfo() {
  const ua = navigator.userAgent;
  const match = ua.match(/(Chrome|Firefox|Edg|Safari)\/?([\d.]+)?/);
  return {
    browser: match ? `${match[1]} ${match[2] || ""}`.trim() : "unknown",
    os: /Windows/i.test(ua)
      ? "Windows"
      : /Mac OS/i.test(ua)
        ? "macOS"
        : /Linux/i.test(ua)
          ? "Linux"
          : "unknown",
  };
}

function buildSafeReport({ status, content }) {
  const selectorCount = (content?.selectorResults || []).reduce(
    (sum, item) => sum + Number(item.count || 0),
    0,
  );
  const errorCount = (content?.errors || []).length + (status?.backgroundErrors || []).length;
  return [
    "# Collector Noah 診断レポート（安全版）",
    [
      "schema: safe-1",
      `generated_at: ${new Date().toISOString()}`,
      `extension: ${status?.version || "unknown"}`,
      `sites_hash: ${status?.build?.sitesHash || "unknown"}`,
      `built_at: ${status?.build?.builtAt || "unknown"}`,
      `enabled: ${status?.enabled}`,
      `token_set: ${status?.tokenSet}`,
      `site_count: ${Object.keys(status?.sites || {}).length}`,
      `selector_matches: ${selectorCount}`,
      `error_count: ${errorCount}`,
    ].join("\n"),
    "## セレクタ一致数",
    (content?.selectorResults || [])
      .map((item) => `- ${item.count} matches`)
      .join("\n") || "(診断なし)",
    "## エラー種別",
    [
      ...(content?.errors || []).map((item) => `- content: ${item.where || "unknown"}`),
      ...(status?.backgroundErrors || []).map(() => "- background"),
    ].join("\n") || "(エラーなし)",
    "",
    "この安全版には、URL、ハンドル、alt、タイトル、ページ本文、サイト名、行動名、ブラウザ・OS、直近イベント、UA、ロケールを含めていません。",
  ].join("\n\n");
}

const GAP_DIAGNOSTICS_UNAVAILABLE = "収集の警告履歴を取得できませんでした。";

function hasGapDiagnostics(collector) {
  return Number.isInteger(collector?.gaps_count) && Array.isArray(collector.recent_gaps);
}

function buildFullReport({ status, content, collector, tab, collectorError }) {
  const page = content?.page || {
    url: redactUrl(tab?.url || ""),
    title: clip(tab?.title || "", 120),
    source: "unknown",
    site: "",
  };

  const sections = [];
  sections.push("# Collector Noah 診断レポート");
  sections.push("注意: この完全版にはページURL・アダプタ設定・セレクタ詳細・Collectorの直近イベント・欠落の警告履歴が含まれます。個人情報・閲覧情報が含まれる場合があるので、共有先に注意してください。");
  sections.push(
    [
      "schema: 1",
      `generated_at: ${new Date().toISOString()}`,
      `extension: ${status?.version || "unknown"}`,
      `sites_hash: ${status?.build?.sitesHash || "unknown"}`,
      `built_at: ${status?.build?.builtAt || "unknown"}`,
      `browser: ${browserInfo().browser}`,
      `os: ${browserInfo().os}`,
      `enabled: ${status?.enabled}`,
      `token_set: ${status?.tokenSet}`,
      `site_count: ${Object.keys(status?.sites || {}).length}`,
    ].join("\n"),
  );

  sections.push("## ページ");
  sections.push(
    [
      `url: ${page.url}`,
      `source: ${page.source}`,
      `site: ${page.site}`,
    ].join("\n"),
  );

  sections.push("## アダプタ設定（sites.json）");
  sections.push("```json\n" + formatJson(content?.adapter || null) + "\n```");

  sections.push("## セレクタ一致数");
  const selectorLines = (content?.selectorResults || []).map(
    (item) => `- ${item.action} | ${item.selector} | ${item.count} matches`,
  );
  const textLines = (content?.textResults || []).map(
    (item) => `- ${item.action} | text="${item.text}" | ${item.count} matches`,
  );
  sections.push([...selectorLines, ...textLines].join("\n") || "(診断なし)");

  sections.push("## 前回の成功例");
  sections.push("```json\n" + formatJson(content?.lastSuccess || {}) + "\n```");

  const suspects = Object.values(status.health?.suspects || {});
  const suspectLines = suspects.map(
    (item) =>
      `- ${item.site} | ${item.action} | \`${item.selector}\` | reason=${item.reason || "disappeared"} | baseline=${item.baseline} | since=${item.since}`,
  );
  sections.push("## 検出状態");
  sections.push(suspectLines.join("\n") || "(異常なし)");

  sections.push("## ミス履歴");
  sections.push("```json\n" + formatJson(content?.misses || []) + "\n```");

  sections.push("## 候補ボタン（近い順）");
  sections.push("```json\n" + formatJson(content?.candidates || []) + "\n```");

  sections.push("## 画像候補");
  sections.push("```json\n" + formatJson(content?.images || []) + "\n```");

  sections.push("## DOMスニペット（個人情報を除去）");
  sections.push("```html\n" + String(content?.html || "(取得できません)") + "\n```");

  sections.push("## エラー");
  const sanitizeError = (e) => ({
    ts: e.ts || "",
    where: e.where || "background",
    page: e.page ? redactUrl(e.page) : "",
    message: clip(e.message, 300).replace(/https?:\/\/\S+/g, "[url]"),
  });
  const errors = [
    ...(content?.errors || []).map((e) => sanitizeError({ ...e, where: e.where || "content" })),
    ...(status?.backgroundErrors || []).map((e) => sanitizeError({ ...e, where: "background" })),
  ];
  sections.push("```json\n" + formatJson(errors.slice(-20)) + "\n```");

  sections.push("## 収集の警告履歴");
  if (hasGapDiagnostics(collector)) {
    sections.push(`gaps_count: ${collector.gaps_count}`);
    sections.push("recent_gaps:\n\n```json\n" + formatJson(collector.recent_gaps) + "\n```");
  } else {
    sections.push(GAP_DIAGNOSTICS_UNAVAILABLE);
  }

  sections.push("## Collector");
  if (collectorError) {
    sections.push(`error: ${clip(collectorError, 300).replace(/https?:\/\/\S+/g, "[url]")}`);
  } else if (!collector) {
    sections.push("(未接続)");
  } else {
    sections.push(
      [
        `version: ${collector.version}`,
        `uptime_sec: ${collector.uptime_sec}`,
        `events_count: ${collector.events_count}`,
        `download: ${collector.download}`,
      ].join("\n"),
    );
    sections.push("### 直近イベント");
    sections.push(
      "```json\n" +
        formatJson((collector.recent || []).map(redactEvent).filter(Boolean)) +
        "\n```",
    );
  }

  sections.push("## 設定");
  sections.push(
    "```json\n" +
      formatJson({
        enabled: status?.enabled,
        tokenSet: status?.tokenSet,
        endpoint: status?.endpoint,
        sites: status?.sites,
      }) +
      "\n```",
  );

  let report = sections.join("\n\n");
  if (report.length > 60000) {
    report = report.slice(0, 60000) + "\n\n[truncated]\n";
  }
  return report;
}

async function fetchCollector(status) {
  if (!status?.tokenSet) return { collector: null, error: "" };
  if (status.endpointAllowed === false) return { collector: null, error: "bad_endpoint" };
  const { token = "" } = await api.storage.local.get({ token: "" });
  if (!token) return { collector: null, error: "" };
  try {
    const response = await fetch(`${String(status.endpoint).replace(/\/+$/, "")}/api/diagnostics`, {
      headers: { "X-Atelier-Token": token },
      redirect: "error",
    });
    if (response.status === 401) return { collector: null, error: "invalid token" };
    if (!response.ok) return { collector: null, error: `HTTP ${response.status}` };
    return { collector: await response.json(), error: "" };
  } catch (error) {
    return { collector: null, error: String(error) };
  }
}

function renderGapWarnings(warnings) {
  const descriptions = {
    action_missing: "操作を検出できません",
    image_limit_exceeded: "収集上限を超える画像があります",
  };
  const actions = { like: "いいね", save: "保存", bookmark: "ブックマーク", follow: "フォロー" };
  const rows = [...new Set(warnings.map(({ site, type, action }) => {
    const detail = action ? `（${actions[action]}）` : "";
    return `${site} — ${descriptions[type]}${detail}`;
  }))];
  const details = $("gap-details");
  const list = $("gap-reasons");
  if (JSON.stringify([...list.children].map((row) => row.textContent)) === JSON.stringify(rows)) return;
  const items = rows.map((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  });
  list.replaceChildren(...items);
  details.hidden = !items.length;
  if (items.length) $("report").setAttribute("aria-describedby", "gap-recovery");
  else $("report").removeAttribute("aria-describedby");
}

async function refresh() {
  try {
    const status = await sendStatus();
    if (!status || status.error) throw new Error(status?.error || "status failed");

    renderGapWarnings(status.gapWarnings || []);
    const queueFull = Boolean(status.queueFull);
    const { collector, error } = await fetchCollector(status);

    let state;
    let kind;
    if (!status.enabled) {
      state = "停止中";
      kind = "off";
    } else if (!status.tokenSet) {
      state = "Token未設定";
      kind = "off";
    } else if (status.endpointAllowed === false) {
      state = "受信先が不正です";
      kind = "off";
    } else if (queueFull) {
      state = "キュー満杯";
      kind = "off";
    } else if (error === "invalid token") {
      state = "Tokenが違います";
      kind = "off";
    } else if (collector) {
      state = "収集中";
      kind = "on";
    } else {
      state = "受信アプリに接続できません";
      kind = "off";
    }
    setState(state, kind);

    $("today").textContent = String(status.today ?? 0);
    $("pending").textContent = status.pending > 0 ? "あり" : "—";
    $("lastReceived").textContent = status.lastSuccessAt
      ? `最後の受信: ${formatReceivedAt(status.lastSuccessAt)}`
      : "受信した記録はまだありません";
    $("pause").textContent = status.enabled ? "一時停止" : "再開";
    $("retry").hidden = !status.enabled || !(status.pending > 0);
    $("clear").hidden = !(status.pending > 0);
    $("healthRetry").hidden = true;

    if (!status.enabled) {
      $("collector").textContent = "停止中";
      $("collector").className = "collector";
    } else if (!status.tokenSet) {
      $("collector").textContent = "Token未設定。設定を開いてください。";
      $("collector").className = "collector error";
    } else if (status.endpointAllowed === false) {
      $("collector").textContent = "受信先が不正です。127.0.0.1:8765 を確認してください。";
      $("collector").className = "collector error";
    } else if (queueFull) {
      $("collector").textContent = "キュー満杯。受信アプリを起動するか、未送信をクリアしてください。";
      $("collector").className = "collector error";
    } else if (error === "invalid token") {
      $("collector").textContent = "Tokenが違います。設定を開いてください。";
      $("collector").className = "collector error";
    } else if (collector) {
      $("collector").textContent = `受信アプリ ver ${collector.version}（接続OK）`;
      $("collector").className = "collector";
    } else {
      $("collector").textContent = "受信アプリに接続できません";
      $("collector").className = "collector error";
      $("healthRetry").hidden = false;
    }
  } catch (error) {
    setState("状態取得失敗", "off");
    setMessage(String(error), "error");
  }
}

async function report() {
  if (busy) return;
  busy = true;
  $("report").disabled = true;
  $("download").hidden = true;
  setMessage("診断レポートを作成中…");

  try {
    const status = await sendStatus();
    if (!status || status.error) throw new Error(status?.error || "status failed");

    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0] || null;

    let content = null;
    if (tab?.id) {
      try {
        content = await api.tabs.sendMessage(tab.id, { type: "diagnose" });
      } catch {
        content = null;
      }
    }

    const full = Boolean($("full-report")?.checked);
    const { collector, error } = full ? await fetchCollector(status) : {};
    lastReport = full
      ? buildFullReport({ status, content, collector, tab, collectorError: error })
      : buildSafeReport({ status, content });

    $("download").hidden = false;
    if (full) {
      if (hasGapDiagnostics(collector)) {
        setMessage(
          "完全版を作成しました。下のボタンでローカルに保存してください。クリップボードには書き込みません。",
          "ok",
        );
      } else {
        setMessage(
          GAP_DIAGNOSTICS_UNAVAILABLE + "再取得するには「問題を報告」を押してください。作成済みのレポートは保存できます。",
          "error",
        );
      }
      return;
    }
    const copied = await copyText(lastReport);
    setMessage(
      copied
        ? "安全版をコピーしました。共有できます。"
        : "レポートを作りました。下のボタンでダウンロードしてください。",
      copied ? "ok" : "error",
    );
  } catch (error) {
    setMessage(`レポート作成に失敗: ${String(error)}`, "error");
  } finally {
    busy = false;
    $("report").disabled = false;
  }
}

function download() {
  if (!lastReport) return;
  const blob = new Blob([lastReport], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `collector-noah-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function togglePause() {
  const { enabled = false } = await api.storage.local.get({ enabled: false });
  await api.storage.local.set({ enabled: !enabled });
  await refresh();
}

async function retryPending() {
  setMessage("再送しています…");
  try {
    await api.runtime.sendMessage({ type: "flush" });
  } catch (error) {
    setMessage(String(error), "error");
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  await refresh();
}

async function clearPending() {
  const { pending = [] } = await api.storage.local.get({ pending: [] });
  const count = pending.length;
  const ok = confirm(
    `${count} 件の未送信の記録を削除します。元に戻せません。\n` +
      "送信を始めた記録は受信先に届く場合があります。受信済みの記録は削除対象外です。",
  );
  if (!ok) return;
  try {
    await api.runtime.sendMessage({ type: "clear" });
    setMessage("未送信をクリアしました。", "ok");
    await refresh();
  } catch (error) {
    setMessage(String(error), "error");
  }
}

async function retryHealth() {
  setMessage("再接続しています…");
  await refresh();
}

$("report").addEventListener("click", report);
$("download").addEventListener("click", download);
$("pause").addEventListener("click", togglePause);
$("retry").addEventListener("click", retryPending);
$("clear").addEventListener("click", clearPending);
$("healthRetry").addEventListener("click", retryHealth);
$("settings").addEventListener("click", () => api.runtime.openOptionsPage());
const fullReportCheckbox = $("full-report");
const fullReportNote = $("full-report-note");
if (fullReportCheckbox && fullReportNote) {
  const syncFullReportNote = () => {
    fullReportNote.hidden = !fullReportCheckbox.checked;
  };
  fullReportCheckbox.addEventListener("change", syncFullReportNote);
  syncFullReportNote();
}
api.storage.onChanged.addListener((changes) => {
  if (changes.gapsState || changes.enabled || changes.sites) {
    sendStatus().then((status) => renderGapWarnings(status?.gapWarnings || [])).catch(() => {});
  }
});
refresh();
