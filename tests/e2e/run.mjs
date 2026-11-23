import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");
const extDir = path.join(root, "dist/chrome");
const realHome = os.userInfo().homedir;
const chromiumPath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  path.join(realHome, ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome");

// --- minimal PNG encoder（300px 以上のサンプル判定用） ---
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3), 0);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = (x * 7) & 0xff;
      raw[off + 1] = (y * 5) & 0xff;
      raw[off + 2] = 0x80;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = makePng(400, 400);
const LARGE_PNG = makePng(1200, 1200);
const PNG_PIXEL = makePng(1, 1);

const X_HTML = `<!doctype html>
<meta charset="utf-8">
<article data-testid="tweet" id="post1" title="ROOT_SECRET">
  <a class="author-link" href="https://x.com/someone"><span class="author-name">SECRETNAME</span></a>
  <span>@SECRETHANDLE</span>
  <a href="https://x.com/someone/status/111"><time>1分</time></a>
  <button data-testid="like" id="like1" aria-label="いいね" aria-pressed="false">5</button>
  <button data-testid="bookmark" id="save1" aria-label="ブックマーク" aria-pressed="false"></button>
  <a class="tag" href="https://x.com/hashtag/foo">#foo</a>
  <a class="tag" href="https://x.com/hashtag/bar">#bar</a>
  <img id="avatar" src="https://pbs.twimg.com/profile_images/1/avatar.jpg" alt="ALT_SECRET">
  <img id="media" crossorigin="anonymous" src="https://pbs.twimg.com/media/AAA?format=jpg" alt="画像" width="400" height="400">
  <img id="media2" src="https://pbs.twimg.com/media/BBB?format=jpg" alt="画像" width="400" height="400">
  <p>SECRETBODYTEXT</p>
  <button data-testid="tweetButton" id="replyBtn">Reply</button>
  <div class="own-comment" id="ownComment" style="display:none"><span class="comment-body">CONFIRMED_COMMENT_BODY</span></div>
  <div class="foreign-comment"><span class="comment-body">FOREIGN_COMMENT_BODY</span></div>
  <template><span title="TPL_SECRET">TEMPLATE_SECRET</span></template>
  <!--COMMENT_SECRET-->
</article>
<article data-testid="tweet" id="post2">
  <a href="https://x.com/someone/status/222"><time>2分</time></a>
  <img src="https://pbs.twimg.com/media/CCC?format=jpg" alt="画像">
  <button data-testid="like" id="like2" aria-label="いいね">7</button>
</article>
<article data-testid="tweet" id="post3">
  <a href="https://x.com/someone/status/333"><time>3分</time></a>
  <button data-testid="like" id="like3" aria-label="いいね">9</button>
  <img src="https://pbs.twimg.com/media/EEE?format=jpg" alt="画像" width="400" height="400">
  <p>${"あ".repeat(2100)}</p>
  <a class="tag" href="https://x.com/hashtag/longtag">${"あ".repeat(60)}</a>
  ${Array.from({ length: 32 }, (_, i) => `<a class="tag" href="https://x.com/hashtag/t${i}">#t${i}</a>`).join("\n  ")}
</article>
<script>
  const like1 = document.getElementById('like1');
  like1.addEventListener('click', () => {
    const pressed = like1.getAttribute('aria-pressed') === 'true';
    like1.setAttribute('aria-pressed', String(!pressed));
    like1.dataset.testid = pressed ? 'like' : 'unlike';
  });
  const save1 = document.getElementById('save1');
  save1.addEventListener('click', () => {
    const pressed = save1.getAttribute('aria-pressed') === 'true';
    save1.setAttribute('aria-pressed', String(!pressed));
    save1.dataset.testid = pressed ? 'bookmark' : 'removeBookmark';
  });
  document.getElementById('replyBtn').addEventListener('click', () => {
    setTimeout(() => { document.getElementById('ownComment').style.display = 'block'; }, 200);
  });
</script>`;

const SAMPLE_HTML = `<!doctype html>
<meta charset="utf-8">
<article data-testid="tweet" id="samplePost">
  <a href="https://x.com/someone/status/999"><time>1分</time></a>
  ${Array.from(
    { length: 10 },
    (_, i) =>
      `<img class="sample" src="https://pbs.twimg.com/media/SAMPLE${i}?format=jpg" alt="画像" width="400" height="400">`,
  ).join("\n  ")}
</article>`;

const X_HEALTH_OK = `<!doctype html>
<meta charset="utf-8">
<article data-testid="tweet">
  <a href="https://x.com/someone/status/222"><time>1分</time></a>
  <img src="https://pbs.twimg.com/media/DDD?format=jpg" alt="画像" width="400" height="400">
  <button data-testid="like" aria-label="いいね">1</button>
</article>`;

const X_HEALTH_BROKEN = `<!doctype html>
<meta charset="utf-8">
<article data-testid="tweet">
  <a href="https://x.com/someone/status/222"><time>1分</time></a>
  <img src="https://pbs.twimg.com/media/DDD?format=jpg" alt="画像" width="400" height="400">
</article>`;

const PIXIV_HTML = `<!doctype html>
<meta charset="utf-8">
<main>
  <a class="author-name" href="https://www.pixiv.net/users/12345">AUTHOR_NAME</a>
  <p class="caption">CAPTION_SECRET</p>
  <a class="tag">tagA</a>
  <a class="tag">tagB</a>
  <img id="image" crossorigin="anonymous" src="https://i.pximg.net/img/dom-fallback.jpg" alt="作品" width="400" height="400">
  <button title="ブックマーク" id="save" aria-pressed="false"></button>
</main>`;

const MELON_HTML = `<!doctype html>
<meta charset="utf-8">
<main>
  <a href="https://www.melonbooks.co.jp/detail/detail.php?product_id=999">
    <img id="cover" src="https://melonbooks.akamaized.net/item/999.jpg" alt="商品">
  </a>
  <a href="https://www.melonbooks.co.jp/detail/detail.php?product_id=999"
     class="fav-button fav-button--favorite" id="fav" onclick="return false">お気に入り</a>
  <a href="https://www.melonbooks.co.jp/detail/detail.php?product_id=999"
     class="fav-button fav-button--wishlist" id="wish" onclick="return false">ほしいもの</a>
</main>`;

const DLSITE_HTML = `<!doctype html>
<meta charset="utf-8">
<main>
  <a href="https://www.dlsite.com/maniax/work/=/product_id/RJ123.html">
    <img src="https://img.dlsite.jp/modpub/images2/work/doujin/RJ123.jpg" alt="作品">
  </a>
  <a href="https://www.dlsite.com/maniax/work/=/product_id/RJ123.html"
     class="btn_favorite" id="dlfav" onclick="return false">お気に入り</a>
  <a href="https://www.dlsite.com/maniax/work/=/product_id/RJ123.html"
     class="btn_follow" id="dlfollow" onclick="return false">フォロー</a>
</main>`;

const DMM_HTML = `<!doctype html>
<meta charset="utf-8">
<main>
  <img src="https://pics.dmm.co.jp/digital/doujin/d_123/d_123ps.jpg" alt="作品">
  <a href="https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_123/"
     class="addToFavorite__btn fn-addToBookmark" id="dmmfav" onclick="return false">お気に入り</a>
</main>`;

const MELON_LIST_HTML = `<!doctype html>
<meta charset="utf-8">
<main>
  <a href="https://www.melonbooks.co.jp/detail/detail.php?product_id=999" onclick="return false">
    <img id="linked" src="https://melonbooks.akamaized.net/item/999.jpg" alt="商品" width="400" height="400">
  </a>
  <img id="unlinked" src="https://melonbooks.akamaized.net/item/888.jpg" alt="商品" width="400" height="400">
  <a id="titlelink" href="https://www.melonbooks.co.jp/detail/detail.php?product_id=999" onclick="return false">商品名</a>
</main>`;

// --- モック受信アプリ（127.0.0.1:8765） ---
const received = [];
const inventories = [];
let receiverEnabled = true;
let redirectMode = false;
let diagnosticsPayload = {
  ok: true,
  version: "test-collector",
  uptime_sec: 1,
  events_count: 0,
  download: false,
  recent: [],
};

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Atelier-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = req.url || "";
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && url === "/api/health") {
    return send(200, { ok: true, version: "test-collector" });
  }
  if (req.method === "GET" && url.startsWith("/api/diagnostics")) {
    return send(200, diagnosticsPayload);
  }
  if (req.method === "GET" && url.startsWith("/api/events")) {
    return send(200, { ok: true, events: [] });
  }
  if (req.method === "POST" && url === "/api/collect") {
    if (redirectMode) {
      res.writeHead(302, { Location: "http://127.0.0.2:8765/api/collect-redirected" });
      res.end();
      return;
    }
    if (!receiverEnabled) {
      res.writeHead(503);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const event = JSON.parse(body);
        received.push(event);
        send(201, { ok: true, event });
      } catch {
        send(400, { ok: false });
      }
    });
    return;
  }
  if (req.method === "POST" && url === "/api/inventory") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        inventories.push(JSON.parse(body));
      } catch {
        /* ignore */
      }
      send(201, { ok: true });
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const failures = [];
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((resolve) => server.listen(8765, "127.0.0.2", resolve));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-e2e-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: chromiumPath,
  viewport: { width: 1280, height: 1200 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const clearReceived = () => {
  received.length = 0;
  inventories.length = 0;
};

const pending = () =>
  worker.evaluate(async () => {
    const { pending = [] } = await chrome.storage.local.get({ pending: [] });
    return pending.map((e) => ({
      schema: e.schema,
      source: e.source,
      action: e.action,
      item: e.item,
      images: (e.images || []).map((image) => image.url),
      via: e.metadata?.via || null,
    }));
  });

const setStorage = (values) =>
  worker.evaluate((v) => chrome.storage.local.set(v), values);

const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));

let worker;
let xHtml = X_HTML;

try {
  worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });

  await worker.evaluate(() => chrome.storage.local.clear());
  await setStorage({
    enabled: true,
    token: "test-token",
    endpoint: "http://127.0.0.2:8765",
    inventory: false,
    sampling: false,
    sites: { x: true, pixiv: true, danbooru: true, dmm: true, dlsite: true, melonbooks: true },
  });

  await context.route("https://x.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: xHtml }),
  );
  await context.route("https://www.pixiv.net/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: PIXIV_HTML,
    }),
  );
  await context.route("https://pbs.twimg.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: PNG,
    }),
  );
  await context.route("https://i.pximg.net/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: LARGE_PNG,
    }),
  );
  await context.route("https://www.melonbooks.co.jp/**", (route) => {
    const url = route.request().url();
    const body = url.includes("/book/list.php") ? MELON_LIST_HTML : MELON_HTML;
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  await context.route("https://melonbooks.akamaized.net/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
  await context.route("https://www.dlsite.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: DLSITE_HTML }),
  );
  await context.route("https://img.dlsite.jp/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
  await context.route("https://www.dmm.co.jp/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: DMM_HTML }),
  );
  await context.route("https://pics.dmm.co.jp/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );

  // --- ポップアップ: 未受信の区別 ---
  const earlyPopup = await context.newPage();
  await earlyPopup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await earlyPopup.waitForSelector("#lastReceived", { timeout: 10000 });
  const earlyReceivedText = await earlyPopup.textContent("#lastReceived");
  check(
    "ポップアップ: 未受信は区別表示",
    String(earlyReceivedText).trim() === "受信した記録はまだありません",
    String(earlyReceivedText),
  );
  await earlyPopup.close();

  // --- X: 通常の送信 ---
  const page = await context.newPage();
  await page.goto("https://x.com/home?secret=1");
  await page.waitForSelector("#like1", { timeout: 10000 });

  await page.evaluate(() => document.getElementById("like2").click());
  await sleep(300);
  check("合成クリックは記録しない", received.length === 0, JSON.stringify(received));

  clearReceived();
  await page.click("#like1");
  await page.click("#save1");
  await sleep(700);

  const popupAfterLike = await context.newPage();
  await popupAfterLike.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await popupAfterLike.waitForSelector("#today", { timeout: 10000 });
  const todayAfterLike = await popupAfterLike.textContent("#today");
  check("ポップアップ: 操作後に今日の件数が増える", String(todayAfterLike).trim() === "2", String(todayAfterLike));
  await popupAfterLike.close();

  check("X: like と save を受信", received.length === 2, JSON.stringify(received));
  check(
    "X: like と save を検出",
    received.some((e) => e.action === "like") && received.some((e) => e.action === "save"),
    JSON.stringify(received.map((e) => e.action)),
  );
  check(
    "X: 画像は media のみ（アイコン除外）",
    received.every((e) => e.images.every((image) => String(image.url).includes("/media/"))),
    JSON.stringify(received.map((e) => e.images)),
  );
  const likeEvent = received.find((e) => e.action === "like");
  check("X: schema は 3", likeEvent?.schema === 3, String(likeEvent?.schema));
  check("X: route は action", likeEvent?.route === "action", String(likeEvent?.route));
  check("X: status は pressed", likeEvent?.status === "pressed", String(likeEvent?.status));
  check("X: collector がある", likeEvent?.collector?.schema_version === 3, JSON.stringify(likeEvent?.collector));
  check("X: surface は timeline", likeEvent?.surface === "timeline", String(likeEvent?.surface));
  check("X: tags を取得", JSON.stringify(likeEvent?.item?.tags) === JSON.stringify(["#foo", "#bar"]), JSON.stringify(likeEvent?.item?.tags));
  check("X: body を取得", likeEvent?.item?.body === "SECRETBODYTEXT", String(likeEvent?.item?.body));
  check("X: author を取得", likeEvent?.item?.author?.name === "SECRETNAME" && likeEvent?.item?.author?.id === "someone", JSON.stringify(likeEvent?.item?.author));
  check("X: variant は displayed", (likeEvent?.images || []).every((i) => i.variant === "displayed"), JSON.stringify(likeEvent?.images?.map((i) => i.variant)));
  check("X: targeted は false（複数画像）", (likeEvent?.images || []).every((i) => i.targeted === false), JSON.stringify(likeEvent?.images?.map((i) => i.targeted)));
  check("X: item は post", likeEvent?.item?.type === "post", JSON.stringify(likeEvent?.item));
  check("X: item.id は status ID", likeEvent?.item?.id === "111", String(likeEvent?.item?.id));
  check("X: 複数枚を1件にまとめる", likeEvent?.images?.length === 2, JSON.stringify(likeEvent?.images));
  check(
    "X: CORS画像はbase64を含む",
    likeEvent?.images?.some((image) => typeof image.data === "string" && image.data.length > 10),
    JSON.stringify(likeEvent?.images?.map((image) => ({ data: image.data?.slice(0, 12), download_error: image.download_error }))),
  );
  check(
    "X: 非CORS画像は理由を記録",
    likeEvent?.images?.some((image) => typeof image.download_error === "string" && image.download_error.length > 0),
    JSON.stringify(likeEvent?.images?.map((image) => image.download_error)),
  );

  // --- X: 切り詰め（上限の明示） ---
  clearReceived();
  await page.click("#like3");
  await sleep(900);
  const truncEvent = received.find((e) => e.item?.id === "333");
  check(
    "X: 切り詰め: body は 2000 字 + フラグ",
    truncEvent?.item?.body?.length === 2000 && truncEvent?.item?.body_truncated === true,
    JSON.stringify({ len: truncEvent?.item?.body?.length, truncated: truncEvent?.item?.body_truncated }),
  );
  check(
    "X: 切り詰め: タグは 30 個 + フラグ",
    Array.isArray(truncEvent?.item?.tags) &&
      truncEvent?.item?.tags.length === 30 &&
      truncEvent?.item?.tags_truncated === true,
    JSON.stringify({ n: truncEvent?.item?.tags?.length, truncated: truncEvent?.item?.tags_truncated }),
  );
  check(
    "X: 切り詰め: 長いタグは 50 字",
    truncEvent?.item?.tags?.[0]?.length === 50,
    String(truncEvent?.item?.tags?.[0]?.length),
  );

  // --- X: 本人コメント（FR-11） ---
  clearReceived();
  await page.click("#replyBtn");
  await sleep(500);
  const commentEvent = received.find((e) => e.action === "comment");
  check("X: コメントを受信", Boolean(commentEvent), JSON.stringify(received));
  check("X: コメント status は confirmed", commentEvent?.status === "confirmed", String(commentEvent?.status));
  check("X: コメント本文は表示DOMから", commentEvent?.comment?.body === "CONFIRMED_COMMENT_BODY", JSON.stringify(commentEvent?.comment));
  check("X: コメント route は action", commentEvent?.route === "action", String(commentEvent?.route));
  check(
    "X: 他人のコメントは記録しない",
    received.filter((e) => e.action === "comment").length === 1 &&
      !String(JSON.stringify(received)).includes("FOREIGN_COMMENT_BODY"),
    JSON.stringify(received.filter((e) => e.action === "comment")),
  );

  const receivedPopup = await context.newPage();
  await receivedPopup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await receivedPopup.waitForSelector("#lastReceived", { timeout: 10000 });
  const receivedText = await receivedPopup.textContent("#lastReceived");
  check(
    "ポップアップ: 受信時刻を表示",
    String(receivedText).includes("最後の受信:"),
    String(receivedText),
  );
  await receivedPopup.close();

  const diag = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => String(t.url || "").startsWith("https://x.com/"));
    if (!tab) return null;
    return chrome.tabs.sendMessage(tab.id, { type: "diagnose" });
  });
  check("X: 診断を取得", Boolean(diag));
  if (diag) {
    const last = diag.lastSuccess?.["x:like"];
    check("X: 成功例はクリック前の like", JSON.stringify(last?.data || []).includes('"like"'), JSON.stringify(last?.data));
    check("X: 一致セレクタを記録", last?.matched === '[data-testid="like"]', String(last?.matched));
    check(
      "X: DOMに本文/名前が無い",
      !String(diag.html).includes("SECRETNAME") &&
        !String(diag.html).includes("SECRETHANDLE") &&
        !String(diag.html).includes("SECRETBODYTEXT"),
    );
    check(
      "X: DOMに属性の秘密が無い",
      !/ROOT_SECRET|ALT_SECRET|TPL_SECRET|TEMPLATE_SECRET|COMMENT_SECRET/.test(String(diag.html)),
      String(diag.html).slice(0, 200),
    );
    check("X: DOMに属性は残る", String(diag.html).includes("data-testid"));
    check("X: DOMは4000字以内", String(diag.html).length <= 4000, String(diag.html).length);
    check("X: 画像候補にSVGが無い", (diag.images || []).every((i) => !/\.svg(?:[?#]|$)/i.test(i.src)));
  }

  // --- X: 解除（aria-pressed 変化） ---
  clearReceived();
  await page.evaluate(() => {
    const b = document.getElementById("like1");
    b.setAttribute("aria-pressed", "true");
    b.dataset.testid = "like";
  });
  await page.click("#like1");
  await sleep(900);
  const removedEvent = received.find((e) => e.action === "like" && e.removed === true);
  check("X: 解除で removed: true", Boolean(removedEvent), JSON.stringify(received));
  check("X: 解除イベントに removed: false はない", received.filter((e) => e.action === "like").every((e) => e.removed !== false), JSON.stringify(received));

  // --- 停止 ---
  await setStorage({ enabled: false });
  await sleep(300);
  check("停止: バッジは –", (await badge()) === "–", await badge());
  clearReceived();
  await page.click("#like2");
  await sleep(400);
  check("停止: クリックしても送らない", received.length === 0, JSON.stringify(received));

  await setStorage({ enabled: true });
  await sleep(300);
  check("再開: バッジは – に戻らない", (await badge()) !== "–", await badge());

  // --- サイト OFF ---
  await setStorage({ sites: { x: false } });
  await sleep(300);
  clearReceived();
  await page.click("#like2");
  await sleep(400);
  check("サイトOFF: 送らない", received.length === 0, JSON.stringify(received));
  await setStorage({
    sites: { x: true, pixiv: true, danbooru: true, dmm: true, dlsite: true, melonbooks: true },
  });

  // --- 画像クリックと別タブのまとめ ---
  clearReceived();
  await page.click("#media");
  await sleep(400);
  check("クリック: 画像クリックを記録", received.length === 1, JSON.stringify(received));
  check(
    "クリック: CORS画像はbase64を含む",
    received[0]?.images?.[0]?.data?.length > 10,
    JSON.stringify(received[0]?.images?.[0]?.data?.slice(0, 12)),
  );
  const sameImageTab = await context.newPage();
  await sameImageTab.goto("https://pbs.twimg.com/media/AAA?format=jpg");
  await sleep(700);
  check(
    "クリック直後の別タブ: 1件にまとめる",
    received.length === 1 && received[0]?.action === "click",
    JSON.stringify(received),
  );
  await sameImageTab.close();

  // --- 直接開いた画像タブ ---
  clearReceived();
  const queryImageTab = await context.newPage();
  await queryImageTab.goto("https://pbs.twimg.com/media/DDD?format=jpg&name=large");
  await sleep(700);
  check(
    "別タブ: ?format= の画像を拾う",
    received.length === 1 && received[0]?.action === "open",
    JSON.stringify(received),
  );
  check(
    "別タブ: ?format= の画像URL",
    String(received[0]?.images?.[0]?.url || "").includes("DDD"),
    JSON.stringify(received),
  );
  await queryImageTab.close();

  // --- Pixiv: DOM 限定（API を呼ばない） ---
  clearReceived();
  const pixiv = await context.newPage();
  await pixiv.goto("https://www.pixiv.net/artworks/12345");
  await pixiv.waitForSelector("#save", { timeout: 10000 });
  await pixiv.click("#save");
  await sleep(700);

  check("Pixiv: 1件", received.length === 1, JSON.stringify(received));
  check("Pixiv: save を検出", received[0]?.action === "save", String(received[0]?.action));
  check("Pixiv: source は pixiv", received[0]?.source === "pixiv", String(received[0]?.source));
  check("Pixiv: item は artwork", received[0]?.item?.type === "artwork", JSON.stringify(received[0]?.item));
  check("Pixiv: item.id は illust ID", received[0]?.item?.id === "12345", String(received[0]?.item?.id));
  check(
    "Pixiv: DOM の画像だけを使う",
    received[0]?.images?.length === 1 &&
      String(received[0].images[0].url).includes("dom-fallback"),
    JSON.stringify(received[0]?.images),
  );
  check(
    "Pixiv: CORS画像はbase64を含む",
    received[0]?.images?.[0]?.data?.length > 10,
    JSON.stringify(received[0]?.images?.[0]?.data?.slice(0, 12)),
  );
  check("Pixiv: page_count は不明", received[0]?.item?.page_count == null, String(received[0]?.item?.page_count));
  check("Pixiv: schema は 3", received[0]?.schema === 3, String(received[0]?.schema));
  check("Pixiv: surface は detail", received[0]?.surface === "detail", String(received[0]?.surface));
  check("Pixiv: tags を取得", JSON.stringify(received[0]?.item?.tags) === JSON.stringify(["tagA", "tagB"]), JSON.stringify(received[0]?.item?.tags));
  check("Pixiv: body を取得", received[0]?.item?.body === "CAPTION_SECRET", String(received[0]?.item?.body));
  check("Pixiv: author を取得", received[0]?.item?.author?.name === "AUTHOR_NAME" && received[0]?.item?.author?.id === "12345", JSON.stringify(received[0]?.item?.author));
  const pixivImage = received[0]?.images?.[0];
  check("Pixiv: 大きい合成画像を圧縮して送信",
    ["image/png", "image/webp"].includes(pixivImage?.content_type) &&
    pixivImage.width === 1200 && Buffer.from(pixivImage.data, "base64").length <= 180_000,
    JSON.stringify({ type: pixivImage?.content_type, width: pixivImage?.width, encoded: pixivImage?.data?.length }));

  clearReceived();
  await pixiv.reload();
  await pixiv.locator("img").evaluateAll((images) => images.forEach((image) => image.remove()));
  await pixiv.click("#save");
  await sleep(700);
  check("Pixiv: 画像が無いときも作品保存の押下を記録", received[0]?.action === "save" &&
    received[0]?.item?.id === "12345" && received[0]?.images?.length === 0, JSON.stringify(received));

  // Pixiv サイト OFF では API も事件も出ない
  await setStorage({ sites: { pixiv: false } });
  await sleep(300);
  clearReceived();
  await pixiv.reload();
  await pixiv.waitForSelector("#save", { timeout: 10000 });
  await pixiv.click("#save");
  await sleep(700);
  check("Pixiv OFF: 送らない", received.length === 0, JSON.stringify(received));
  await setStorage({
    sites: { x: true, pixiv: true, danbooru: true, dmm: true, dlsite: true, melonbooks: true },
  });

  // --- Melonbooks ---
  clearReceived();
  const melonPage = await context.newPage();
  await melonPage.goto("https://www.melonbooks.co.jp/detail/detail.php?product_id=999");
  await melonPage.waitForSelector("#wish", { timeout: 10000 });
  await melonPage.click("#wish");
  await melonPage.click("#fav");
  await sleep(700);

  check("Melonbooks: 2件", received.length === 2, JSON.stringify(received));
  check(
    "Melonbooks: save と follow",
    received.some((e) => e.action === "save") && received.some((e) => e.action === "follow"),
    JSON.stringify(received.map((e) => e.action)),
  );
  const melonSave = received.find((e) => e.action === "save");
  check("Melonbooks: item は product", melonSave?.item?.type === "product", JSON.stringify(melonSave?.item));
  check("Melonbooks: item.id は product_id", melonSave?.item?.id === "999", String(melonSave?.item?.id));
  check(
    "Melonbooks: 画像は商品画像",
    String(melonSave?.images?.[0]?.url || "").includes("akamaized.net"),
    String(melonSave?.images?.[0]?.url),
  );
  await melonPage.close();

  // --- Melonbooks 一覧 ---
  clearReceived();
  const listPage = await context.newPage();
  await listPage.goto("https://www.melonbooks.co.jp/book/list.php?category_id=9");
  await listPage.waitForSelector("#linked", { timeout: 10000 });
  await sleep(400);

  await listPage.click("#linked");
  await sleep(400);
  check(
    "一覧: リンク内の画像は item 付き",
    received.length === 1 && received[0]?.item?.id === "999",
    JSON.stringify(received),
  );

  await listPage.click("#unlinked");
  await sleep(400);
  check(
    "一覧: 非リンク画像も image として記録",
    received.some((e) => e.item?.type === "image"),
    JSON.stringify(received),
  );

  await listPage.click("#titlelink");
  await sleep(400);
  check(
    "一覧: itemリンクは open で記録",
    received.some((e) => e.action === "open" && e.item?.id === "999"),
    JSON.stringify(received),
  );
  check("一覧: 合計3件", received.length === 3, JSON.stringify(received));
  await listPage.close();

  // --- DLsite ---
  clearReceived();
  const dlPage = await context.newPage();
  await dlPage.goto("https://www.dlsite.com/maniax/work/=/product_id/RJ123.html");
  await dlPage.waitForSelector("#dlfav", { timeout: 10000 });
  await dlPage.click("#dlfav");
  await dlPage.click("#dlfollow");
  await sleep(700);

  check("DLsite: 2件", received.length === 2, JSON.stringify(received));
  check(
    "DLsite: save と follow",
    received.some((e) => e.action === "save") && received.some((e) => e.action === "follow"),
    JSON.stringify(received.map((e) => e.action)),
  );
  const dlSave = received.find((e) => e.action === "save");
  check("DLsite: item.id", dlSave?.item?.id === "RJ123", String(dlSave?.item?.id));
  check(
    "DLsite: 画像は img.dlsite.jp",
    String(dlSave?.images?.[0]?.url || "").includes("img.dlsite.jp"),
    String(dlSave?.images?.[0]?.url),
  );
  await dlPage.close();

  // --- DMM / FANZA ---
  clearReceived();
  const dmmPage = await context.newPage();
  await dmmPage.goto("https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_123/");
  await dmmPage.waitForSelector("#dmmfav", { timeout: 10000 });
  await dmmPage.click("#dmmfav");
  await sleep(700);

  check("DMM: 1件", received.length === 1, JSON.stringify(received));
  check("DMM: save", received[0]?.action === "save", String(received[0]?.action));
  check("DMM: item.id は cid", received[0]?.item?.id === "d_123", String(received[0]?.item?.id));
  await dmmPage.close();

  // --- 棚卸し（本文を送らない） ---
  await setStorage({ inventory: true });
  await page.reload();
  await page.waitForSelector("#like1", { timeout: 10000 });
  await sleep(2200);
  const xInventories = inventories.filter((i) => i.source === "x");
  const inv = xInventories[xInventories.length - 1] || null;
  check("棚卸し: 受信できる", Boolean(inv), JSON.stringify(inventories).slice(0, 120));
  check("棚卸し: クエリを送らない", String(inv?.url || "").endsWith("/home"), String(inv?.url));
  const invText = JSON.stringify(inv || {});
  check("棚卸し: like を検出", invText.includes("testid=like"), invText.slice(0, 200));
  check("棚卸し: bookmark を検出", invText.includes("testid=bookmark"), invText.slice(0, 200));
  check("棚卸し: 本文を含まない", !invText.includes("SECRETNAME") && !invText.includes("SECRETBODYTEXT"));

  const sensitivePage = await context.newPage();
  await sensitivePage.goto("https://x.com/i/history");
  await sleep(2400);
  const afterSensitive = inventories.filter((i) => i.source === "x");
  check(
    "棚卸し: 履歴ページを送らない",
    !afterSensitive.some((i) => String(i.url).includes("/i/history")),
    JSON.stringify(afterSensitive.map((i) => i.url)),
  );
  await sensitivePage.close();
  await setStorage({ inventory: false });

  // --- health: inventory 非依存 ---
  xHtml = X_HEALTH_OK;
  const healthPage = await context.newPage();
  await healthPage.goto("https://x.com/someone/status/222");
  await sleep(2500);
  let health = await worker.evaluate(async () => (await chrome.storage.local.get({ health: {} })).health);
  check(
    "検出: inventory OFF でも基準を記録",
    Object.values(health.baseline || {}).some((value) => value > 0),
    JSON.stringify(health.baseline),
  );

  xHtml = X_HEALTH_BROKEN;
  await healthPage.reload();
  await sleep(2400);
  health = await worker.evaluate(async () => (await chrome.storage.local.get({ health: {} })).health);
  check("検出: 1回では疑わない", Object.keys(health.suspects || {}).length === 0, JSON.stringify(health.suspects));

  await healthPage.reload();
  await sleep(2400);
  await healthPage.reload();
  await sleep(2400);
  health = await worker.evaluate(async () => (await chrome.storage.local.get({ health: {} })).health);
  check(
    "検出: 3回0件で疑い",
    Object.values(health.suspects || {}).some((item) => item.action === "like"),
    JSON.stringify(health.suspects),
  );

  xHtml = X_HEALTH_OK;
  for (const id of ["331", "332", "333"]) {
    await healthPage.goto(`https://x.com/someone/status/${id}`);
    await sleep(2400);
  }
  health = await worker.evaluate(async () => (await chrome.storage.local.get({ health: {} })).health);
  check(
    "検出: 新セレクタの初回0件を疑う",
    Object.values(health.suspects || {}).some(
      (item) => String(item.selector).includes("bookmark") && item.reason === "never_matched",
    ),
    JSON.stringify(health.suspects),
  );
  await healthPage.close();

  // --- ページ一括（右クリックメニューが送るメッセージ） ---
  xHtml = X_HTML;
  clearReceived();
  const collectPage = await context.newPage();
  await collectPage.goto("https://x.com/home");
  await collectPage.waitForSelector("#media", { timeout: 10000 });
  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => String(t.url || "").startsWith("https://x.com/"));
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: "atelier-collect-page" });
  });
  await sleep(700);
  const pageCollect = received.filter((e) => e.action === "seen" && e.metadata?.via === "page_collect");
  check("ページ一括: seen を記録", pageCollect.length >= 1, JSON.stringify(received));
  check(
    "ページ一括: 複数画像をまとめる",
    pageCollect.some((e) => e.images.length >= 2),
    JSON.stringify(pageCollect),
  );
  await collectPage.close();

  // --- 閲覧サンプル ---
  await setStorage({ sampling: true });
  clearReceived();
  xHtml = SAMPLE_HTML;
  const samplePage = await context.newPage();
  await samplePage.goto("https://x.com/home");
  await samplePage.waitForSelector(".sample", { timeout: 10000 });
  await samplePage.waitForFunction(() => [...document.images].every((img) => img.complete));
  await sleep(6000);
  const samples = received.filter((e) => e.metadata?.via === "sample");
  check("サンプル: ON で1件選ばれる", samples.length >= 1, JSON.stringify(received).slice(0, 300));
  if (samples.length) {
    check(
      "サンプル: メタデータに範囲と上限がある",
      samples[0].metadata?.sample?.conditions?.includes("10%") &&
        typeof samples[0].metadata?.sample?.selected === "number",
      JSON.stringify(samples[0].metadata),
    );
    check("サンプル: dwell_seconds がある", typeof samples[0].dwell_seconds === "number" && samples[0].dwell_seconds >= 0, String(samples[0].dwell_seconds));
    check("サンプル: sampling 集計が昇格", samples[0].sampling?.selected >= 1, JSON.stringify(samples[0].sampling));
  }
  await samplePage.close();
  await setStorage({ sampling: false });

  // --- 送信先の検証（content の重複排除を避けて background から直接送る） ---
  const sendDirect = (tag) =>
    worker.evaluate(
      async (name) => {
        await postEvent({
          action: "click",
          source: "x",
          item: { type: "image", id: null, url: `https://x.com/validation-${name}`, title: "" },
          images: [{ url: `https://pbs.twimg.com/media/VALID-${name}?format=jpg` }],
        });
      },
      tag,
    );

  clearReceived();
  await setStorage({ endpoint: "http://127.0.0.1:8799", pending: [] });
  await sendDirect("port");
  await sleep(400);
  check("送信先: 別ポートは送らない", received.length === 0, JSON.stringify(received));
  check("送信先: 別ポートはキューにも入れない", (await pending()).length === 0, JSON.stringify(await pending()));

  await setStorage({ endpoint: "http://example.com:8765", pending: [] });
  await sendDirect("external");
  await sleep(400);
  check("送信先: 外部ホストは送らない", received.length === 0, JSON.stringify(received));
  check("送信先: 外部ホストはキューにも入れない", (await pending()).length === 0, JSON.stringify(await pending()));

  await setStorage({ endpoint: "http://user:pass@127.0.0.1:8765", pending: [] });
  await sendDirect("userinfo");
  await sleep(400);
  check("送信先: 資格情報付きは送らない", received.length === 0, JSON.stringify(received));

  await setStorage({ endpoint: "http://127.0.0.2:8765/nope", pending: [] });
  await sendDirect("path");
  await sleep(400);
  check("送信先: パス付きは送らない", received.length === 0, JSON.stringify(received));

  // リダイレクトは追従しない（失敗としてキューに残る）
  await setStorage({ endpoint: "http://127.0.0.2:8765", pending: [] });
  redirectMode = true;
  await sendDirect("redirect");
  await sleep(600);
  check("送信先: リダイレクトは追従しない", received.length === 0, JSON.stringify(received));
  check("送信先: リダイレクトはキューに残る", (await pending()).length === 1, JSON.stringify(await pending()));
  redirectMode = false;

  // --- flush: 停止中のサイトは送らない ---
  await setStorage({
    enabled: true,
    endpoint: "http://127.0.0.2:8765",
    sites: { x: true, pixiv: false },
    pending: [
      {
        schema: 2,
        action: "click",
        source: "x",
        item: { type: "image", id: null, url: "https://x.com/flush-x", title: "" },
        images: [{ url: "https://pbs.twimg.com/media/FLUSHX?format=jpg", order: 0 }],
        metadata: {},
      },
      {
        schema: 2,
        action: "click",
        source: "pixiv",
        item: { type: "artwork", id: "1", url: "https://www.pixiv.net/artworks/1", title: "" },
        images: [{ url: "https://i.pximg.net/img/flush-p.jpg", order: 0 }],
        metadata: {},
      },
    ],
    queueFull: false,
  });
  clearReceived();
  await worker.evaluate(async () => {
    await flush();
  });
  await sleep(800);
  const flushedSources = received.map((e) => e.source);
  check(
    "flush: 有効サイトだけ送る",
    flushedSources.includes("x") && !flushedSources.includes("pixiv"),
    JSON.stringify(flushedSources),
  );
  const remaining = await pending();
  check(
    "flush: 停止サイトは残る",
    remaining.length === 1 && remaining[0].source === "pixiv",
    JSON.stringify(remaining),
  );
  await setStorage({
    sites: { x: true, pixiv: true, danbooru: true, dmm: true, dlsite: true, melonbooks: true },
    pending: [],
  });

  // --- キュー満杯（受信を止める） ---
  receiverEnabled = false;
  await worker.evaluate(async () => {
    const pending = Array.from({ length: 200 }, (_, index) => ({
      schema: 2,
      action: "click",
      source: "x",
      item: { type: "image", id: null, url: `https://x.com/${index}`, title: "" },
      images: [],
      metadata: {},
    }));
    await chrome.storage.local.set({ pending, queueFull: false, enabled: true });
  });
  await page.bringToFront();
  await sleep(3500);
  await page.click("#like2");
  await sleep(500);

  let queue = await worker.evaluate(async () => {
    const { pending = [], queueFull = false } = await chrome.storage.local.get({
      pending: [],
      queueFull: false,
    });
    const badge = await chrome.action.getBadgeText({});
    return { count: pending.length, queueFull, badge };
  });
  check("キュー満杯: 収集を一時停止", queue.queueFull === true, JSON.stringify(queue));
  check("キュー満杯: 件数は増えない", queue.count === 200, String(queue.count));
  check("キュー満杯: バッジは !", queue.badge === "!", queue.badge);

  const extensionId = new URL(worker.url()).host;
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  popupPage.on("dialog", (dialog) => dialog.accept());
  await popupPage.waitForSelector("#clear", { timeout: 10000 });
  await popupPage.click("#clear");
  await sleep(600);
  await popupPage.close();
  queue = await worker.evaluate(async () => {
    const { pending = [], queueFull = false } = await chrome.storage.local.get({
      pending: [],
      queueFull: false,
    });
    return { count: pending.length, queueFull };
  });
  check("クリアで再開", queue.count === 0 && queue.queueFull === false, JSON.stringify(queue));

  // --- バッジ: 成功時は空 ---
  const today = new Date().toISOString().slice(0, 10);
  receiverEnabled = true;
  await setStorage({
    counts: { [today]: 120 },
    pending: [],
    queueFull: false,
    enabled: true,
    health: {},
  });
  await sleep(400);
  check("バッジ: 成功時は空", (await badge()) === "", await badge());

  const countPopup = await context.newPage();
  await countPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await countPopup.waitForSelector("#today", { timeout: 10000 });
  const todayCountText = await countPopup.textContent("#today");
  check("ポップアップ: 今日の件数を実データから表示", String(todayCountText).trim() === "120", String(todayCountText));
  const pendingCountText = await countPopup.textContent("#pending");
  check("ポップアップ: 未送信なしは —", String(pendingCountText).trim() === "—", String(pendingCountText));
  await countPopup.close();

  // --- 診断レポート ---
  diagnosticsPayload = {
    ok: true,
    version: "test",
    uptime_sec: 1,
    events_count: 1,
    download: false,
    recent: [
      {
        schema: 2,
        id: "e1",
        created_at: "2026-11-08T00:00:00+00:00",
        source: "x",
        action: "like",
        item: {
          type: "post",
          id: "111",
          url: "https://x.com/someone/status/111?secret=1",
          title: "",
        },
        images: [
          {
            url: "https://pbs.twimg.com/media/AAA?format=jpg",
            download_error: "404 https://x.com/error?secret=1",
          },
        ],
        metadata: {},
      },
    ],
  };
  await setStorage({
    endpoint: "http://127.0.0.2:8765",
    token: "test-token",
    enabled: true,
    pending: [],
  });
  const reportPage = await context.newPage();
  await reportPage.addInitScript(() => {
    globalThis.__copiedReport = "";
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            globalThis.__copiedReport = text;
          },
        },
      });
    } catch {
      /* fallback copy is not asserted */
    }
  });
  await reportPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await reportPage.waitForSelector("#report", { timeout: 10000 });
  await reportPage.click("#report");
  await reportPage.waitForFunction(
    () => !document.getElementById("download").hidden,
    null,
    { timeout: 10000 },
  );
  const report = await reportPage.evaluate(() => globalThis.__copiedReport || "");
  check("診断: 安全版を既定にする", report.includes("安全版"), report.slice(0, 300));
  check(
    "診断: 安全版にURL・画像・イベントを載せない",
    !report.includes("x.com") &&
      !report.includes("pbs.twimg.com") &&
      !report.includes("someone") &&
      !report.includes("secret=1") &&
      !report.includes("404"),
    report.slice(-600),
  );
  check(
    "診断: 安全版に行動名を載せない",
    !/like|save|bookmark|follow/.test(report),
    report.slice(0, 600),
  );
  check(
    "診断: 安全版にブラウザ/OSを載せない",
    !report.includes("Chrome") && !report.includes("Firefox") && !report.includes("Linux"),
    report.slice(0, 600),
  );

  await reportPage.check("#full-report");
  await reportPage.click("#report");
  await reportPage.waitForTimeout(600);
  const full = await reportPage.evaluate(() => globalThis.__copiedReport || "");
  check(
    "診断: 完全版はクリップボードに書かない",
    full === "" || full === report,
    `copied=${full.length} chars`,
  );
  await reportPage.close();
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
  server.close();
}

console.log(`\n${failures.length ? `FAILED: ${failures.length}` : "all passed"}`);
process.exit(failures.length ? 1 : 0);
