// record_size.mjs — CollectionEvent (schema v3) の UTF-8 バイト数を実測する。
// 依存: Node 標準のみ。実行: node tests/record_size.mjs
// 画像の data フィールドは recordWithinLimit の計算対象外のため含めない（画像メタデータのみ）。

import { TextEncoder } from "node:util";

const RECORD_LIMIT_BYTES = 32768; // 32 KiB
const enc = new TextEncoder();

function utf8Bytes(obj) {
  return enc.encode(JSON.stringify(obj)).length;
}

function jp(n) {
  // 日本語 1 文字 = 3 UTF-8 バイト（'あ'）
  return "あ".repeat(n);
}

function tag(nChars) {
  return jp(nChars);
}

const baseImage = (i) => ({
  url: `https://example.com/img/${i}.jpg`,
  width: 1200,
  height: 800,
  order: i,
  variant: "displayed",
  targeted: false,
  hash: "0".repeat(64),
  path: null,
  content_type: "image/jpeg",
  download_error: null,
});

// (a) 画像クリック（v3・新欄ほぼなし）
const caseA = {
  schema: 3,
  source: "x",
  action: "click",
  route: "image_click",
  status: "unknown",
  item: { type: "post", url: "https://x.com/u/status/1", title: "" },
  images: [{ ...baseImage(1), targeted: true }],
};

// (b) いいね（タグ30個×50字、付随本文2000字、作者名・ID各200字、画像メタ4件）
const caseB = {
  schema: 3,
  source: "x",
  action: "like",
  route: "action",
  status: "pressed",
  item: {
    type: "post",
    url: "https://x.com/u/status/2",
    title: "",
    body: jp(2000),
    body_truncated: true,
    tags: Array.from({ length: 30 }, () => jp(50)),
    tags_truncated: true,
    author: { name: jp(200), id: "u".repeat(200), truncated: true },
  },
  images: [1, 2, 3, 4].map((i) => ({ ...baseImage(i), targeted: true })),
};

// (c) コメント（本文2000字）
const caseC = {
  schema: 3,
  source: "x",
  action: "comment",
  route: "action",
  status: "confirmed",
  item: { type: "post", url: "https://x.com/u/status/3", title: "" },
  images: [{ ...baseImage(1), targeted: true }],
  comment: { body: jp(2000), truncated: true },
};

// (d) 閲覧サンプル（sampling 集計・dwell_seconds・collector 付き）
const caseD = {
  schema: 3,
  source: "x",
  action: "seen",
  route: "sample",
  item: { type: "post", url: "https://x.com/u/status/4", title: "" },
  images: [{ ...baseImage(1), targeted: false }],
  dwell_seconds: 12.5,
  surface: "timeline",
  sampling: { selected: 1, candidates: 10, capped: false, conditions: "utc_daily_10pct" },
  collector: { schema_version: 3, extension_version: "0.0.0", build_hash: "0123456789ab" },
};

// (e) worst case: 上限値をすべて同時に積んだ
const caseE = {
  schema: 3,
  source: "x",
  action: "like",
  route: "action",
  status: "confirmed",
  item: {
    type: "post",
    url: "https://x.com/" + "u".repeat(100) + "/status/" + "9".repeat(20),
    title: jp(300),
    body: jp(2000),
    body_truncated: true,
    tags: Array.from({ length: 30 }, () => jp(50)),
    tags_truncated: true,
    author: { name: jp(200), id: "i".repeat(200), truncated: true },
  },
  images: [1, 2, 3, 4].map((i) => ({
    ...baseImage(i),
    url: `https://example.com/${"p".repeat(100)}/img/${i}.jpg`,
    targeted: true,
  })),
  comment: { body: jp(2000), truncated: true },
  removed: true,
  search_term: jp(200),
  surface: "s".repeat(40),
  dwell_seconds: 999.5,
  sampling: { selected: 100, candidates: 1000, capped: true, conditions: "c".repeat(300) },
  collector: { schema_version: 3, extension_version: "0.0.0", build_hash: "0".repeat(64) },
  gaps: { dropped: 50, site_off: true, unobserved_removals: "r".repeat(100) },
  metadata: { via: "action" },
};

const cases = [
  ["(a) 画像クリック（新欄ほぼなし）", caseA],
  ["(b) いいね（タグ・本文・作者・画像4）", caseB],
  ["(c) コメント（本文2000字）", caseC],
  ["(d) 閲覧サンプル（集計・dwell・collector）", caseD],
  ["(e) worst case（上限値をすべて同時）", caseE],
];

console.log(`RECORD_LIMIT_BYTES = ${RECORD_LIMIT_BYTES} (32 KiB)`);
console.log("");
console.log("| ケース | UTF-8 バイト数 | 32 KiB に対する余裕 | 判定 |");
console.log("|---|---:|---:|---|");
for (const [name, obj] of cases) {
  const bytes = utf8Bytes(obj);
  const margin = RECORD_LIMIT_BYTES - bytes;
  const verdict = bytes <= RECORD_LIMIT_BYTES ? "OK" : "超過";
  console.log(`| ${name} | ${bytes} | ${margin} | ${verdict} |`);
}
console.log("");
for (const [name, obj] of cases) {
  const bytes = utf8Bytes(obj);
  console.log(`${name}: ${bytes} bytes (margin ${RECORD_LIMIT_BYTES - bytes})`);
}