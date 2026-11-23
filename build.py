#!/usr/bin/env python3
"""Chrome/Firefox用の展開済みフォルダを作る。

- `sites.json` から content script の matches とサイト設定を生成する
- アダプタ追加は `sites.json` に1エントリ足すだけ
- リリース用zipは作らない

Chrome: chrome://extensions → デベロッパーモード → dist/chrome
Firefox: about:debugging → 一時的なアドオン → dist/firefox/manifest.json
"""
from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
SCHEMA = ROOT / "schemas" / "collection_event.schema.json"

# 未設定ホストのイベントが既定 true で通るため、これらの site id は使わない
FORBIDDEN_SITE_IDS = {"other", "folder"}
# 全サイト権限相当のマッチパターンは拒否する
FORBIDDEN_MATCHES = {"<all_urls>", "*://*/*", "*://*"}
ALLOWED_MATCH_SCHEMES = {"*", "http", "https", "file", "ftp", "urn"}


def valid_match(match: str) -> bool:
    if not isinstance(match, str) or match in FORBIDDEN_MATCHES:
        return False
    parts = match.split("://", 1)
    if len(parts) != 2:
        return False
    scheme, rest = parts
    if scheme not in ALLOWED_MATCH_SCHEMES:
        return False
    if not rest:
        return False
    host = rest.split("/", 1)[0]
    if not host or host in ("*", "*.*"):
        return False
    return True


def allowed_actions() -> set[str]:
    data = json.loads(SCHEMA.read_text(encoding="utf-8"))
    return set(data["properties"]["action"]["enum"])


def check_actions(sites: dict) -> None:
    allowed = allowed_actions()
    for site_id, cfg in sites.items():
        for action in cfg.get("actions", []):
            name = action.get("action")
            if name not in allowed:
                raise SystemExit(f"{site_id}: action {name!r} is not in schema enum")



def load_sites() -> dict:
    sites = json.loads((ROOT / "sites.json").read_text(encoding="utf-8"))
    if not isinstance(sites, dict) or not sites:
        raise SystemExit("sites.json must be a non-empty object")

    seen_hosts = {}
    for site_id, cfg in sites.items():
        if not isinstance(cfg, dict):
            raise SystemExit(f"{site_id}: entry must be an object")
        hosts = cfg.get("hosts")
        matches = cfg.get("matches")
        if not hosts or not isinstance(hosts, list) or not all(isinstance(x, str) for x in hosts):
            raise SystemExit(f"{site_id}: hosts[] is required")
        if not matches or not isinstance(matches, list) or not all(isinstance(x, str) for x in matches):
            raise SystemExit(f"{site_id}: matches[] is required")
        if site_id in FORBIDDEN_SITE_IDS:
            raise SystemExit(
                f"{site_id}: site id must not be one of {sorted(FORBIDDEN_SITE_IDS)}"
            )
        for match in matches:
            if not valid_match(match):
                raise SystemExit(f"{site_id}: match {match!r} is not allowed")
        for host in hosts:
            host = host.lower()
            if host in seen_hosts and seen_hosts[host] != site_id:
                raise SystemExit(f"duplicate host {host}: {seen_hosts[host]} and {site_id}")
            seen_hosts[host] = site_id
        actions = cfg.get("actions", [])
        if not isinstance(actions, list):
            raise SystemExit(f"{site_id}: actions must be an array")
        for action in actions:
            if not isinstance(action, dict):
                raise SystemExit(f"{site_id}: action must be an object")
            if not action.get("action") or not (action.get("selectors") or action.get("texts")):
                raise SystemExit(f"{site_id}: action needs action + selectors/texts")
            removal = action.get("removal")
            if removal is not None:
                if not isinstance(removal, dict):
                    raise SystemExit(f"{site_id}: removal must be an object")
                if not isinstance(removal.get("attribute"), str) or not removal.get("attribute"):
                    raise SystemExit(f"{site_id}: removal.attribute must be a non-empty string")
        # 新しい任意欄の型チェック
        if "tagSelectors" in cfg:
            ts = cfg.get("tagSelectors")
            if not isinstance(ts, list) or not all(isinstance(x, str) for x in ts):
                raise SystemExit(f"{site_id}: tagSelectors must be an array of strings")
        for field in ("bodySelector", "authorSelector", "authorIdPattern", "originalUrlPattern"):
            if field in cfg and not isinstance(cfg.get(field), str):
                raise SystemExit(f"{site_id}: {field} must be a string")
        sp = cfg.get("surfacePatterns")
        if sp is not None:
            if not isinstance(sp, list):
                raise SystemExit(f"{site_id}: surfacePatterns must be an array")
            for entry in sp:
                if not isinstance(entry, dict):
                    raise SystemExit(f"{site_id}: surfacePatterns entry must be an object")
                if not isinstance(entry.get("pattern"), str) or not isinstance(entry.get("surface"), str):
                    raise SystemExit(f"{site_id}: surfacePatterns entry needs pattern and surface strings")
        comment = cfg.get("comment")
        if comment is not None:
            if not isinstance(comment, dict):
                raise SystemExit(f"{site_id}: comment must be an object")
            for field in ("submitSelectors", "resultSelectors"):
                val = comment.get(field, [])
                if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
                    raise SystemExit(f"{site_id}: comment.{field} must be an array of strings")
            if "resultBodySelector" in comment and not isinstance(comment.get("resultBodySelector"), str):
                raise SystemExit(f"{site_id}: comment.resultBodySelector must be a string")
            if "confirmTimeoutMs" in comment and not isinstance(comment.get("confirmTimeoutMs"), int):
                raise SystemExit(f"{site_id}: comment.confirmTimeoutMs must be an int")
    return sites


def generated_js(sites: dict) -> str:
    source_by_host = {}
    for site_id, cfg in sites.items():
        for host in cfg["hosts"]:
            source_by_host[str(host).lower()] = site_id
    payload = json.dumps(sites, ensure_ascii=False, indent=2)
    mapping = json.dumps(source_by_host, ensure_ascii=False, indent=2)
    sites_hash = hashlib.sha256((ROOT / "sites.json").read_bytes()).hexdigest()[:12]
    build_info = {
        "sitesHash": sites_hash,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    return (
        "/* generated by build.py; edit sites.json instead */\n"
        f"globalThis.ATELIER_SITES = {payload};\n"
        f"globalThis.ATELIER_SOURCE_BY_HOST = {mapping};\n"
        f"globalThis.ATELIER_BUILD = {json.dumps(build_info)};\n"
    )


def read_version() -> str:
    chrome = json.loads((ROOT / "manifest.chrome.json").read_text(encoding="utf-8"))
    firefox = json.loads((ROOT / "manifest.firefox.json").read_text(encoding="utf-8"))
    if chrome.get("version") != firefox.get("version"):
        raise SystemExit(
            "manifest versions differ: "
            f"chrome={chrome.get('version')!r} firefox={firefox.get('version')!r}"
        )
    return chrome["version"]


def build(browser: str, sites: dict, version: str) -> Path:
    out = DIST / browser
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SRC, out)

    generated = generated_js(sites)
    (out / "sites.generated.js").write_text(generated, encoding="utf-8")

    matches = []
    for cfg in sites.values():
        for match in cfg["matches"]:
            if match not in matches:
                matches.append(match)

    manifest = json.loads((ROOT / f"manifest.{browser}.json").read_text(encoding="utf-8"))
    manifest["version"] = version
    manifest["content_scripts"] = [
        {
            "matches": matches,
            "js": ["sites.generated.js", "content.js"],
            "run_at": "document_idle",
        }
    ]

    if browser == "firefox":
        manifest.setdefault("background", {})["scripts"] = [
            "sites.generated.js",
            "background.js",
        ]

    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return out


def main() -> None:
    sites = load_sites()
    check_actions(sites)
    version = read_version()
    DIST.mkdir(parents=True, exist_ok=True)
    for browser in ("chrome", "firefox"):
        out = build(browser, sites, version)
        print(f"{browser}: {out}")
    print("Chrome: chrome://extensions → デベロッパーモード → dist/chrome を読み込む")
    print("Firefox: about:debugging → 一時的なアドオン → dist/firefox/manifest.json")
    print(f"sites: {', '.join(sites)}")


if __name__ == "__main__":
    main()
