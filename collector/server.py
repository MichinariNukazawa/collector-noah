"""Collector Noah のローカル受信サーバー。

ブラウザ拡張から `POST /api/collect` を受け取り、JSONLに追記する。
必要なら画像をダウンロードして `images/` に保存する。

標準ライブラリのみ。Windows / macOS / Linux で動く。
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from collector.gaps import MAX_BODY as MAX_GAP_BODY
from collector.gaps import GapStore, decode_json, valid_submission

VERSION = "0.1.3"
MAX_BODY = 1_000_000
MAX_INLINE_IMAGE = 675_000
IMAGE_DATA_KEYS = ("data", "blob", "base64", "content", "image_data", "data_url")
OBSERVATION_ROUTES = {"image_click", "action", "sample", "page_collect", "context_menu", "tab", "item_link"}
MAX_IMAGE = 50 * 1024 * 1024
ACTIONS = {"seen", "like", "save", "bookmark", "click", "open", "comment", "follow"}
# 画像を保存する行動。click/open/seen はURLだけ残し、必要になったら後で取得する
DOWNLOAD_ACTIONS = {"like", "save", "bookmark", "comment"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}
IMAGE_RE = re.compile(r"\.(png|jpe?g|webp|gif|avif)(?:$|[?#])", re.I)
EXTENSION_ORIGIN = re.compile(r"(?:chrome|moz)-extension://[a-zA-Z0-9-]+")
ALLOWED_IMAGE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def disk_status(path: str | Path, threshold_mb: int | None = None) -> dict[str, Any]:
    """Return free space and the low-disk flag for a data directory.

    The threshold is in MiB. ``ATELIER_LOW_DISK_MB`` overrides the default
    (1024 MiB = 1 GiB) for tests and operations.
    """
    if threshold_mb is None:
        raw = os.environ.get("ATELIER_LOW_DISK_MB", "1024")
        try:
            threshold_mb = int(raw)
        except ValueError:
            threshold_mb = 1024
    threshold_mb = max(0, threshold_mb)
    try:
        free = shutil.disk_usage(str(path)).free
    except OSError:
        return {"free_mb": 0, "low": True}
    free_mb = int(free // (1024 * 1024))
    return {"free_mb": free_mb, "low": free_mb < threshold_mb}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _normalize_host(host: str) -> str:
    return host.strip().strip("[]").lower().rstrip(".")


def _ip_candidate(host: str):
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    try:
        return ipaddress.ip_address(socket.inet_ntoa(socket.inet_aton(host)))
    except OSError:
        return None


def _is_private_host(host: str) -> bool:
    host = _normalize_host(host)
    if not host:
        return True
    if host in {"localhost", "metadata.google.internal"}:
        return True
    if host.endswith(".local") or host.endswith(".internal"):
        return True
    ip = _ip_candidate(host)
    if ip is None:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def is_safe_url(url: str | None) -> bool:
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urllib.parse.urlparse(url)
        hostname = parsed.hostname
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if not hostname or _is_private_host(hostname):
        return False
    return True


def canonical_url(value: str | None) -> str:
    """Strip query/fragment and redact user/item identifiers in the path."""
    if not value:
        return ""
    try:
        parsed = urllib.parse.urlparse(str(value))
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    host = parsed.hostname.lower()
    path = parsed.path or "/"
    if host.endswith("x.com") or host.endswith("twitter.com"):
        path = re.sub(r"^/[^/]+/status/\d+", "/{user}/status/{id}", path)
    elif host.endswith("pixiv.net"):
        path = re.sub(r"^/artworks/\d+", "/artworks/{id}", path)
        path = re.sub(r"^/users/\d+", "/users/{id}", path)
    elif host.endswith("danbooru.donmai.us"):
        path = re.sub(r"^/posts/\d+", "/posts/{id}", path)
    path = re.sub(r"/\d{3,}", "/{id}", path)
    netloc = parsed.netloc
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[-1]
    return urllib.parse.urlunparse((parsed.scheme, netloc, path, "", "", ""))


def referer_url(value: str | None) -> str:
    """Strip userinfo, query, and fragment while keeping scheme/host/port/path."""
    if not value:
        return ""
    try:
        parsed = urllib.parse.urlparse(str(value))
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    netloc = parsed.netloc
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[-1]
    return urllib.parse.urlunparse((parsed.scheme, netloc, parsed.path or "/", "", "", ""))


def _clean_error(value: Any) -> str:
    text = str(value or "")[:500]
    return re.sub(r"https?://\S+", "[url]", text)


def public_event(event: dict[str, Any]) -> dict[str, Any]:
    """Remove local paths, client IP, raw metadata, and URL query strings."""
    item = event.get("item") if isinstance(event.get("item"), dict) else {}
    images = event.get("images") if isinstance(event.get("images"), list) else []
    return {
        "id": event.get("id", ""),
        "created_at": event.get("created_at", ""),
        "received_at": event.get("received_at", ""),
        "source": event.get("source", ""),
        "action": event.get("action", ""),
        "site": event.get("site", ""),
        "item": {
            "type": item.get("type", ""),
            "id": item.get("id"),
            "url": canonical_url(str(item.get("url") or "")),
        },
        "images": [
            {
                "url": canonical_url(str(image.get("url") or "")),
                "hash": image.get("hash", ""),
                "content_type": image.get("content_type", ""),
                "width": image.get("width"),
                "height": image.get("height"),
                "order": image.get("order"),
                "download_error": _clean_error(image.get("download_error")),
            }
            for image in images
            if isinstance(image, dict)
        ],
    }


def _looks_like_image(data: bytes, content_type: str) -> bool:
    ctype = (content_type or "").lower()
    if ctype == "image/svg+xml" or ctype not in ALLOWED_IMAGE_TYPES:
        return False
    head = data[:32]
    if ctype == "image/png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ctype == "image/jpeg":
        return head.startswith(b"\xff\xd8\xff")
    if ctype == "image/gif":
        return head.startswith(b"GIF8")
    if ctype == "image/webp":
        return len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if ctype == "image/avif":
        return b"ftypavif" in head or b"ftypavis" in head
    return False


def _sanitize_signature(value: str) -> str:
    """Drop free text and DOM paths from inventory signatures."""
    parts = []
    for part in str(value or "").split("|"):
        part = part.strip()
        if not part or part.startswith(("text=", "class=", "path=", "aria=")):
            continue
        parts.append(part[:120])
    return " | ".join(parts)[:300]


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_safe_url(newurl):
            raise urllib.error.HTTPError(newurl, code, "unsafe redirect", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SafeRedirectHandler())


def _append_jsonl(path: Path, record: dict[str, Any], lock: threading.Lock) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    with lock:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def _decode_jsonl_record(line: str) -> dict[str, Any] | None:
    try:
        value = json.loads(line.strip())
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _read_last_jsonl(path: Path, limit: int) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as fh:
        lines = fh.readlines()[-limit:]
    return [record for line in lines if (record := _decode_jsonl_record(line)) is not None]


def _event_datetime(value: Any) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:[.,][0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})",
        value,
    ):
        raise ValueError("expected an ISO 8601 timestamp with timezone")
    return datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)


def _event_bound(query: dict[str, list[str]], name: str) -> datetime | None:
    if name not in query:
        return None
    try:
        value = _event_datetime(query[name][0])
        if value.utcoffset() == timezone.utc.utcoffset(None):
            return value
    except ValueError:
        pass
    raise ValueError(f"{name} must be an ISO 8601 UTC timestamp")


def _guess_extension(content_type: str, url: str) -> str:
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
    }
    if content_type in mapping:
        return mapping[content_type]
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        return ".jpg" if suffix == ".jpeg" else suffix
    return mimetypes.guess_extension(content_type) or ".img"


class Collector:
    def __init__(
        self,
        data_dir: Path,
        token: str,
        download: bool = True,
        download_all: bool = False,
        token_path: Path | None = None,
    ) -> None:
        self.data_dir = data_dir
        self.events_path = data_dir / "events.jsonl"
        self.inventory_path = data_dir / "inventory.jsonl"
        self.images_dir = data_dir / "images"
        self.token = token
        self.token_path = token_path or (data_dir / "token")
        self.download = download
        self.download_all = download_all
        self.lock = threading.Lock()
        self.seen_lock = threading.Lock()
        self._seen = deque()
        self._seen_set: set[str] = set()
        self.started_at = time.time()
        self._load_seen_ids()
        self.gaps = GapStore(data_dir)
        self._maintain_gaps()

    def _maintain_gaps(self) -> None:
        try:
            self.gaps.maintain()
        except OSError:
            print("[collector] gaps storage unavailable")

    def maintain_gaps_hourly(self, stop: threading.Event) -> None:
        while not stop.wait(3600):
            self._maintain_gaps()

    def _load_seen_ids(self) -> None:
        if not self.events_path.exists():
            return
        try:
            with self.events_path.open("rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - 262144))
                data = fh.read().decode("utf-8", "ignore")
        except OSError:
            return
        for line in data.splitlines()[-2000:]:
            try:
                event_id = json.loads(line).get("id")
            except Exception:
                continue
            self._remember(event_id)

    def _remember(self, event_id: str | None) -> None:
        if not event_id:
            return
        with self.seen_lock:
            if event_id in self._seen_set:
                return
            if len(self._seen) >= 2000:
                old = self._seen.popleft()
                self._seen_set.discard(old)
            self._seen.append(event_id)
            self._seen_set.add(event_id)

    def _claim(self, event_id: str) -> bool:
        """IDを処理前に予約する。既に予約済みなら False。"""
        if not event_id:
            return True
        with self.seen_lock:
            if event_id in self._seen_set:
                return False
            self._seen.append(event_id)
            self._seen_set.add(event_id)
            if len(self._seen) > 2000:
                old = self._seen.popleft()
                self._seen_set.discard(old)
            return True

    def _forget(self, event_id: str) -> None:
        """処理に失敗したIDを解放し、再送を受け付けられるようにする。"""
        with self.seen_lock:
            if event_id not in self._seen_set:
                return
            self._seen_set.discard(event_id)
            try:
                self._seen.remove(event_id)
            except ValueError:
                pass

    def handle_event(self, payload: dict[str, Any], remote: str) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("event must be an object")

        action = str(payload.get("action") or "")
        if action not in ACTIONS:
            raise ValueError(f"unsupported action: {action!r}")

        event = self._normalize(payload)
        item = event["item"]
        item.pop("title", None)
        item.pop("alt", None)
        item_url = str(item.get("url") or "")
        if not is_safe_url(item_url):
            raise ValueError("item.url must be a public http(s) URL")

        images = event.get("images") or []
        for index, image in enumerate(images):
            image.setdefault("order", index)
            image.pop("alt", None)
            image.pop("title", None)
            image.pop("path", None)
            image.pop("referer", None)
            if not is_safe_url(str(image.get("url") or "")):
                raise ValueError("image url must be a public http(s) URL")

        if not isinstance(event.get("id"), str) or not event["id"].strip():
            event["id"] = secrets.token_hex(16)
        if not self._claim(event["id"]):
            return {"id": event["id"], "duplicate": True}

        try:
            event.setdefault("created_at", now_iso())
            event.setdefault("source", "other")
            event.setdefault(
                "site", urllib.parse.urlparse(item_url).hostname or ""
            )
            event["received_at"] = now_iso()
            # Do not persist client IP, raw metadata, or URL query strings.
            event.pop("remote", None)
            route = event.get("route")
            metadata = event.pop("metadata", None)
            via = metadata.get("via") if isinstance(metadata, dict) else None
            if isinstance(route, str) and route in OBSERVATION_ROUTES:
                event["observation_route"] = route
            elif isinstance(via, str) and via in OBSERVATION_ROUTES:
                event["observation_route"] = via
            item["url"] = canonical_url(item_url)

            referer = referer_url(item_url)

            for image in images:
                original_url = str(image["url"])
                image["url"] = canonical_url(original_url)
                image.pop("hash", None)
                de = image.get("download_error")
                if isinstance(de, str):
                    image["download_error"] = _clean_error(de)
                inline = image.get("data")
                for key in IMAGE_DATA_KEYS:
                    image.pop(key, None)
                if inline is not None:
                    self._save_inline_image(image, inline)
                elif not image.get("download_error") and self.download and (
                    self.download_all or action in DOWNLOAD_ACTIONS
                ):
                    try:
                        data, content_type = self._fetch_image(original_url, referer)
                        if not _looks_like_image(data, content_type):
                            raise ValueError("not a supported raster image")
                        self._save_image(image, data, content_type)
                    except Exception as exc:  # download failure is not fatal
                        image["download_error"] = _clean_error(exc)

            _append_jsonl(self.events_path, event, self.lock)
        except Exception:
            self._forget(event["id"])
            raise
        return event

    def _save_inline_image(self, image: dict[str, Any], encoded: Any) -> None:
        content_type = image.get("content_type")
        try:
            if not isinstance(encoded, str) or len(encoded) > 900_000:
                raise ValueError("invalid image data size")
            data = base64.b64decode(encoded, validate=True)
            if len(data) > MAX_INLINE_IMAGE or not isinstance(content_type, str):
                raise ValueError("invalid image size or type")
            if not _looks_like_image(data, content_type):
                raise ValueError("not a supported raster image")
        except (ValueError, binascii.Error):
            image["download_error"] = "invalid_image_data"
            return

        try:
            self._save_image(image, data, content_type.lower())
        except OSError:
            image["download_error"] = "image_write_failed"
        else:
            image.pop("download_error", None)

    def _save_image(self, image: dict[str, Any], data: bytes, content_type: str) -> None:
        digest = hashlib.sha256(data).hexdigest()
        extension = _guess_extension(content_type, str(image["url"]))
        self.images_dir.mkdir(parents=True, exist_ok=True)
        path = self.images_dir / f"{digest}{extension}"
        if not path.exists():
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=self.images_dir, delete=False) as output:
                    temporary = Path(output.name)
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        image["hash"] = digest
        image["content_type"] = content_type

    def handle_inventory(self, payload: dict[str, Any], remote: str) -> dict[str, Any]:
        """設計用の操作要素の棚卸し。本文は受け取らない。"""
        if not isinstance(payload, dict):
            raise ValueError("inventory must be an object")

        controls = payload.get("controls") or []
        if not isinstance(controls, list):
            raise ValueError("controls must be an array")

        cleaned = []
        for item in controls[:200]:
            if not isinstance(item, dict):
                continue
            signature = _sanitize_signature(str(item.get("signature") or ""))
            if not signature:
                continue
            try:
                count = int(item.get("count") or 0)
            except (TypeError, ValueError):
                count = 0
            cleaned.append({"signature": signature, "count": max(0, count)})

        try:
            total = int(payload.get("total") or 0)
        except (TypeError, ValueError):
            total = 0

        selectors = []
        raw_selectors = payload.get("selectors")
        if isinstance(raw_selectors, list):
            for item in raw_selectors[:100]:
                if not isinstance(item, dict):
                    continue
                selector = str(item.get("selector") or "").strip()[:300]
                if not selector:
                    continue
                try:
                    count = int(item.get("count") or 0)
                except (TypeError, ValueError):
                    count = 0
                selectors.append(
                    {
                        "action": str(item.get("action") or "")[:40],
                        "selector": selector,
                        "count": max(0, count),
                    }
                )

        record = {
            "ts": now_iso(),
            "url": canonical_url(str(payload.get("url") or "")),
            "site": str(payload.get("site") or "")[:200],
            "source": str(payload.get("source") or "other")[:40],
            "total": total,
            "controls": cleaned,
            "item_page": bool(payload.get("itemPage")),
            "selectors": selectors,
            "build_hash": str(payload.get("buildHash") or "")[:40],
        }
        _append_jsonl(self.inventory_path, record, self.lock)
        return record

    def _normalize(self, payload: dict[str, Any]) -> dict[str, Any]:
        """v2（item単位）を受け取る。旧形式（画像1枚）は持ち上げる。"""
        if isinstance(payload.get("item"), dict):
            EVENT_KEYS = (
                "schema",
                "action",
                "source",
                "site",
                "id",
                "created_at",
                "route",
                "status",
                "sampling",
                "collector",
                "dwell_seconds",
                "surface",
                "removed",
                "search_term",
                "comment",
                "gaps",
            )
            event = {}
            for key in EVENT_KEYS:
                if key in payload:
                    event[key] = payload.get(key)
            if "schema" not in event:
                event["schema"] = payload.get("schema", 2)
            event["item"] = dict(payload.get("item") or {})
            event["images"] = [dict(image) for image in (payload.get("images") or [])]
            event["metadata"] = dict(payload.get("metadata") or {})
            return event

        image_url = payload.get("image_url")
        page_url = payload.get("page_url")
        if not image_url and not page_url:
            raise ValueError("item is required")

        url = str(page_url or image_url)
        event: dict[str, Any] = {
            "schema": 2,
            "action": payload.get("action"),
            "source": payload.get("source") or "other",
            "site": payload.get("site") or "",
            "item": {"type": "image", "id": None, "url": url, "title": ""},
            "images": ([{"url": str(image_url)}] if image_url else []),
            "metadata": {**dict(payload.get("metadata") or {}), "legacy": True},
        }
        for key in ("id", "created_at"):
            if payload.get(key):
                event[key] = payload[key]
        for key in ("route", "status", "sampling", "collector", "dwell_seconds",
                    "surface", "removed", "search_term", "comment", "gaps"):
            if key in payload:
                event[key] = payload.get(key)
        return event

    def _fetch_image(self, url: str, referer: str) -> tuple[bytes, str]:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    f"Chrome/131 Safari/537.36 AtelierCapture/{VERSION}"
                ),
                "Referer": referer_url(referer),
                "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
            },
        )
        with _OPENER.open(request, timeout=30) as response:
            content_type = (response.headers.get_content_type() or "").lower()
            data = response.read(MAX_IMAGE + 1)
        if len(data) > MAX_IMAGE:
            raise ValueError("image too large")
        if content_type not in ALLOWED_IMAGE_TYPES:
            raise ValueError(f"not a supported raster image: {content_type or 'unknown'}")
        if not _looks_like_image(data, content_type):
            raise ValueError("image content does not match its type")
        return data, content_type

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        return _read_last_jsonl(self.events_path, max(1, min(limit, 500)))

    def events_page(
        self, limit: int, offset: int, since: datetime | None, until: datetime | None
    ) -> tuple[list[dict[str, Any]], int]:
        ranged = since is not None or until is not None
        limit = max(1, min(limit, 10_000 if ranged else 500))
        if not self.events_path.exists():
            return [], 0

        with self.events_path.open("r", encoding="utf-8") as fh:
            records = [_decode_jsonl_record(line) for line in fh]

        if ranged:
            matched = []
            for event in records:
                if event is None:
                    continue
                try:
                    created_at = _event_datetime(event.get("created_at"))
                except ValueError:
                    continue
                if (since is None or since <= created_at) and (until is None or created_at < until):
                    matched.append(event)
            records = matched

        # Without a range, retain the original tail slice even if a line is invalid.
        total = sum(record is not None for record in records)
        end = max(0, len(records) - offset)
        page = records[max(0, end - limit):end]
        return [record for record in page if record is not None], total

    def events_count(self) -> int:
        if not self.events_path.exists():
            return 0
        with self.events_path.open("r", encoding="utf-8") as fh:
            return sum(1 for line in fh if line.strip())

    def diagnostics(self) -> dict[str, Any]:
        return {
            "ok": True,
            "version": VERSION,
            "uptime_sec": int(time.time() - self.started_at),
            "events_count": self.events_count(),
            "recent": [public_event(event) for event in self.recent(10)],
            **self.gaps.diagnostics(),
        }


class Handler(BaseHTTPRequestHandler):
    server_version = f"AtelierCollector/{VERSION}"

    @property
    def collector(self) -> Collector:
        return self.server.collector  # type: ignore[attr-defined]

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if EXTENSION_ORIGIN.fullmatch(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header(
                "Access-Control-Allow-Headers", "Content-Type, X-Atelier-Token"
            )
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        token = self.headers.get("X-Atelier-Token", "")
        return bool(token) and secrets.compare_digest(
            token.encode("utf-8"), self.collector.token.encode("utf-8"),
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(HTTPStatus.OK, {"ok": True, "version": VERSION})
            return
        if parsed.path == "/api/events":
            if not self._authorized():
                self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "invalid token"})
                return
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            try:
                limit = int(query.get("limit", ["50"])[0])
                offset = int(query.get("offset", ["0"])[0])
                if offset < 0:
                    raise ValueError("offset must be non-negative")
                since = _event_bound(query, "since")
                until = _event_bound(query, "until")
                if since is not None and until is not None and since > until:
                    raise ValueError("since must be at or before until")
            except ValueError as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
                return
            events, total = self.collector.events_page(limit, offset, since, until)
            self._json(HTTPStatus.OK, {"ok": True, "events": events, "total": total})
            return
        if parsed.path == "/api/diagnostics":
            if not self._authorized():
                self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "invalid token"})
                return
            try:
                diagnostics = self.collector.diagnostics()
            except OSError:
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "storage_unavailable"})
                return
            self._json(HTTPStatus.OK, diagnostics)
            return
        self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/gaps":
            self._post_gap()
            return
        if parsed.path not in ("/api/collect", "/api/inventory"):
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "invalid token"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid body size"})
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid JSON"})
            return

        if parsed.path == "/api/inventory":
            try:
                record = self.collector.handle_inventory(payload, self.client_address[0])
            except ValueError as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
                return
            except Exception as exc:
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
                return
            self._json(HTTPStatus.CREATED, {"ok": True, "inventory": record})
            return

        try:
            event = self.collector.handle_event(payload, self.client_address[0])
        except ValueError as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
            return

        self._json(HTTPStatus.CREATED, {"ok": True, "event": event})

    def _gap_error(self, status: HTTPStatus, code: str) -> None:
        self._json(status, {"ok": False, "error": code})

    def _post_gap(self) -> None:
        if not self._authorized():
            self._gap_error(HTTPStatus.UNAUTHORIZED, "unauthorized")
            return
        if self.headers.get_content_type() != "application/json":
            self._gap_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > MAX_GAP_BODY:
            self._gap_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "payload_too_large")
            return
        if length <= 0:
            self._gap_error(HTTPStatus.BAD_REQUEST, "invalid_json")
            return
        raw = self.rfile.read(length)
        try:
            if len(raw) != length:
                raise ValueError("incomplete JSON")
            record = decode_json(raw)
        except (ValueError, RecursionError):
            self._gap_error(HTTPStatus.BAD_REQUEST, "invalid_json")
            return
        if not valid_submission(record):
            self._gap_error(HTTPStatus.BAD_REQUEST, "invalid_record")
            return
        try:
            duplicate = self.collector.gaps.put(record)
        except OSError:
            self._gap_error(HTTPStatus.SERVICE_UNAVAILABLE, "storage_unavailable")
            return
        if duplicate is None:
            self._gap_error(HTTPStatus.CONFLICT, "id_conflict")
            return
        status = HTTPStatus.OK if duplicate else HTTPStatus.CREATED
        self._json(status, {"ok": True, "id": record["id"], "duplicate": duplicate})

    def log_message(self, fmt: str, *args: Any) -> None:
        message = fmt % args
        message = message.split("?", 1)[0]
        print(f"[collector] {message}")


def load_or_create_token(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    path.write_text(token + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return token


def _harden_permissions(data_dir: Path, token_path: Path) -> None:
    targets = [
        (data_dir, 0o700),
        (data_dir / "images", 0o700),
        (token_path, 0o600),
        (data_dir / "events.jsonl", 0o600),
        (data_dir / "inventory.jsonl", 0o600),
        (data_dir / "gaps", 0o700),
        (data_dir / "gaps" / "records.jsonl", 0o600),
    ]
    for path, mode in targets:
        try:
            if path.exists():
                os.chmod(path, mode)
        except OSError:
            pass
    images_dir = data_dir / "images"
    if images_dir.exists():
        for root, dirs, files in os.walk(images_dir):
            for name in dirs:
                try:
                    os.chmod(Path(root) / name, 0o700)
                except OSError:
                    pass
            for name in files:
                try:
                    os.chmod(Path(root) / name, 0o600)
                except OSError:
                    pass


def main() -> None:
    os.umask(0o077)
    default_data = Path.home() / ".local" / "share" / "collector-noah"
    parser = argparse.ArgumentParser(description="Collector Noah local collector")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", default=str(default_data))
    parser.add_argument("--token-file", default="")
    download_mode = parser.add_mutually_exclusive_group()
    download_mode.add_argument("--no-download", action="store_true", help="取得元へ画像を要求しない（既定）")
    download_mode.add_argument("--download", action="store_true", help="従来どおり保存・いいね等の画像を取得元へ要求する")
    download_mode.add_argument("--download-all", action="store_true", help="click/open も含めて取得元へ画像を要求する")
    parser.add_argument("--show-token", action="store_true", help="後方互換。値は表示しない")
    args = parser.parse_args()

    if args.host.strip("[]").lower() not in LOOPBACK_HOSTS:
        parser.error("--host must be a loopback address (127.0.0.1, localhost, or ::1)")

    data_dir = Path(args.data_dir).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    token_path = Path(args.token_file).expanduser() if args.token_file else data_dir / "token"
    token = load_or_create_token(token_path)
    _harden_permissions(data_dir, token_path)
    collector = Collector(
        data_dir,
        token,
        download=args.download or args.download_all,
        download_all=args.download_all,
        token_path=token_path,
    )

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.collector = collector  # type: ignore[attr-defined]

    policy = "none" if not collector.download else ("all" if collector.download_all else "strong")
    print(f"Atelier collector {VERSION}")
    print(f"  endpoint: http://{args.host}:{args.port}")
    print(f"  collect:  POST /api/collect")
    print(f"  events:   {collector.events_path}")
    print(f"  images:   {collector.images_dir} (download={policy})")
    print("  token:    設定済み（値とパスは表示しません）")
    if args.download_all:
        print("  警告: --download-all はクリック／別タブの画像も保存します")
    print("  extension options に endpoint と token を入れてください")
    print("  Ctrl+C で停止")
    stop_maintenance = threading.Event()
    maintenance = threading.Thread(
        target=collector.maintain_gaps_hourly, args=(stop_maintenance,), daemon=True,
    )
    maintenance.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_maintenance.set()
        maintenance.join()
        server.server_close()


if __name__ == "__main__":
    main()
