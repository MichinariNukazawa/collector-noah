from __future__ import annotations

import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import json

from collector.server import Collector, disk_status, is_safe_url, canonical_url, referer_url


def _event(action: str) -> dict:
    return {
        "schema": 2,
        "source": "x",
        "action": action,
        "item": {"type": "post", "id": "1", "url": "https://example.com/post/1"},
        "images": [{"url": "https://example.com/a.jpg"}],
        "metadata": {},
    }


class CollectorImagePolicyTest(unittest.TestCase):
    def _run(self, action: str, download_all: bool = False) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=True, download_all=download_all)
            collector._fetch_image = lambda url, referer: (
                b"\x89PNG\r\n\x1a\n",
                "image/png",
            )
            return collector.handle_event(_event(action), "127.0.0.1")

    def test_click_keeps_url_only(self) -> None:
        event = self._run("click")
        self.assertNotIn("path", event["images"][0])

    def test_like_downloads(self) -> None:
        event = self._run("like")
        image = event["images"][0]
        self.assertIn("hash", image)
        self.assertEqual(image["content_type"], "image/png")
        self.assertNotIn("path", image)
        self.assertNotIn("remote", event)

    def test_download_all_overrides(self) -> None:
        event = self._run("click", download_all=True)
        self.assertIn("hash", event["images"][0])
        self.assertNotIn("path", event["images"][0])


class SafeUrlTest(unittest.TestCase):
    def test_public_urls_allowed(self) -> None:
        for url in ("https://example.com/a.jpg", "http://example.com:8080/x"):
            self.assertTrue(is_safe_url(url), url)

    def test_private_and_obfuscated_rejected(self) -> None:
        urls = (
            "http://127.0.0.1/x",
            "http://127.0.0.1./x",
            "http://127.1/x",
            "http://2130706433/x",
            "http://0x7f000001/x",
            "http://localhost/x",
            "http://localhost./x",
            "http://[::1]/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://metadata.google.internal/x",
            "http://printer.local/x",
            "http://service.internal/x",
            "file:///etc/passwd",
        )
        for url in urls:
            self.assertFalse(is_safe_url(url), url)


class FilePermissionTest(unittest.TestCase):
    def test_files_are_private(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=True)
            collector._fetch_image = lambda url, referer: (b"\x89PNG\r\n\x1a\n", "image/png")
            event = collector.handle_event(_event("like"), "127.0.0.1")

            digest = event["images"][0]["hash"]
            image_path = next(collector.images_dir.glob(f"{digest}.*"))
            self.assertEqual(stat.S_IMODE(image_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(collector.events_path.stat().st_mode), 0o600)


class TokenPathTest(unittest.TestCase):
    def test_custom_token_path_is_kept(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "custom-token"
            collector = Collector(Path(tmp), "token", download=False, token_path=path)
            self.assertEqual(collector.token_path, path)

    def test_default_token_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=False)
            self.assertEqual(collector.token_path, Path(tmp) / "token")


class EventIdempotencyTest(unittest.TestCase):
    def test_same_event_is_stored_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=False)
            event = _event("like")
            event["id"] = "same-id"

            first = collector.handle_event(dict(event), "127.0.0.1")
            second = collector.handle_event(dict(event), "127.0.0.1")

            self.assertNotIn("duplicate", first)
            self.assertTrue(second.get("duplicate"))
            self.assertEqual(len(collector.events_path.read_text(encoding="utf-8").splitlines()), 1)

    def test_recent_ids_are_loaded_after_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            event = _event("like")
            event["id"] = "same-id"
            collector = Collector(Path(tmp), "token", download=False)
            collector.handle_event(dict(event), "127.0.0.1")

            restarted = Collector(Path(tmp), "token", download=False)
            again = restarted.handle_event(dict(event), "127.0.0.1")
            self.assertTrue(again.get("duplicate"))

    def test_empty_event_id_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=False)
            first = _event("like")
            first["id"] = ""
            second = _event("like")
            second["id"] = ""

            stored_first = collector.handle_event(first, "127.0.0.1")
            stored_second = collector.handle_event(second, "127.0.0.1")

            self.assertTrue(stored_first["id"])
            self.assertTrue(stored_second["id"])
            self.assertNotEqual(stored_first["id"], stored_second["id"])
            self.assertEqual(
                len(collector.events_path.read_text(encoding="utf-8").splitlines()), 2
            )

    def test_non_string_event_id_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=False)
            event = _event("like")
            event["id"] = 123

            stored = collector.handle_event(event, "127.0.0.1")
            self.assertIsInstance(stored["id"], str)
            self.assertTrue(stored["id"])

    def test_concurrent_same_event_is_stored_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=False)
            results: list[dict] = []
            barrier = threading.Barrier(8)

            def send() -> None:
                event = _event("like")
                event["id"] = "race-id"
                barrier.wait()
                results.append(collector.handle_event(event, "127.0.0.1"))

            threads = [threading.Thread(target=send) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(
                len(collector.events_path.read_text(encoding="utf-8").splitlines()), 1
            )
            self.assertEqual(sum(1 for r in results if r.get("duplicate")), 7)


class DiskStatusTest(unittest.TestCase):
    def test_threshold_override_marks_low(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"ATELIER_LOW_DISK_MB": "999999999"}):
                status = disk_status(tmp)
        self.assertGreaterEqual(status["free_mb"], 0)
        self.assertTrue(status["low"])

    def test_zero_threshold_is_not_low(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"ATELIER_LOW_DISK_MB": "0"}):
                status = disk_status(tmp)
        self.assertFalse(status["low"])


def _v3_event() -> dict:
    return {
        "schema": 3,
        "id": "v3-id",
        "source": "x",
        "action": "like",
        "route": "action",
        "status": "confirmed",
        "item": {
            "type": "post",
            "id": "1",
            "url": "https://example.com/post/1",
            "body": "hello body",
            "body_truncated": True,
            "tags": ["tag1", "tag2"],
            "tags_truncated": True,
            "author": {"name": "Alice", "id": "alice", "truncated": True},
        },
        "images": [{"url": "https://example.com/a.jpg", "variant": "original", "targeted": True}],
        "sampling": {"selected": 1, "candidates": 2, "capped": False, "conditions": "cond"},
        "collector": {"schema_version": 3, "extension_version": "1.0", "build_hash": "abc"},
        "dwell_seconds": 5.5,
        "surface": "timeline",
        "removed": True,
        "search_term": "query",
        "comment": {"body": "my comment", "truncated": True},
        "gaps": {"dropped": 2},
        "metadata": {"via": "sample"},
    }


class SchemaV3Test(unittest.TestCase):
    def _run(self, payload: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=False)
            collector.handle_event(payload, "127.0.0.1")
            lines = collector.events_path.read_text(encoding="utf-8").splitlines()
            return json.loads(lines[-1])

    def test_v3_fields_preserved(self) -> None:
        payload = _v3_event()
        stored = self._run(payload)
        self.assertEqual(stored.get("route"), "action")
        self.assertEqual(stored.get("status"), "confirmed")
        self.assertEqual(stored.get("sampling"), payload["sampling"])
        self.assertEqual(stored.get("collector"), payload["collector"])
        self.assertEqual(stored.get("dwell_seconds"), 5.5)
        self.assertEqual(stored.get("surface"), "timeline")
        self.assertTrue(stored.get("removed"))
        self.assertEqual(stored.get("search_term"), "query")
        self.assertEqual(stored.get("comment"), payload["comment"])
        self.assertEqual(stored.get("gaps"), payload["gaps"])
        item = stored["item"]
        self.assertEqual(item.get("body"), "hello body")
        self.assertTrue(item.get("body_truncated"))
        self.assertEqual(item.get("tags"), ["tag1", "tag2"])
        self.assertTrue(item.get("tags_truncated"))
        self.assertEqual(item.get("author"), payload["item"]["author"])
        img = stored["images"][0]
        self.assertEqual(img.get("variant"), "original")
        self.assertTrue(img.get("targeted"))
        self.assertEqual(stored.get("observation_route"), "action")
        self.assertNotIn("metadata", stored)
        self.assertNotIn("title", item)
        self.assertNotIn("alt", item)

    def test_v2_backward_compat(self) -> None:
        payload = _event("like")
        payload["metadata"] = {"via": "item_link"}
        payload["id"] = "v2-id"
        stored = self._run(payload)
        self.assertEqual(stored.get("observation_route"), "item_link")
        self.assertNotIn("route", stored)
        self.assertNotIn("status", stored)

    def test_v3_route_priority(self) -> None:
        payload = _v3_event()
        payload["route"] = "page_collect"
        payload["metadata"] = {"via": "sample"}
        stored = self._run(payload)
        self.assertEqual(stored.get("observation_route"), "page_collect")
        self.assertEqual(stored.get("route"), "page_collect")


class CanonicalUrlTest(unittest.TestCase):
    def test_userinfo_removed(self) -> None:
        self.assertEqual(
            canonical_url("http://user:pass@example.com/path"),
            "http://example.com/path",
        )
        self.assertEqual(
            canonical_url("http://user@example.com:8080/path?q=1#frag"),
            "http://example.com:8080/path",
        )


class RefererTest(unittest.TestCase):
    def test_referer_canonicalized_arg(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=True)
            captured = {}

            def fake(url, referer):
                captured["referer"] = referer
                return (b"\x89PNG\r\n\x1a\n", "image/png")

            collector._fetch_image = fake
            event = {
                "schema": 3,
                "source": "x",
                "action": "like",
                "item": {"type": "post", "id": "1", "url": "http://user:pass@example.com/post/1?q=secret#frag"},
                "images": [{"url": "https://example.com/a.jpg"}],
            }
            collector.handle_event(event, "127.0.0.1")
            ref = captured["referer"]
            self.assertNotIn("user:pass", ref)
            self.assertNotIn("?", ref)
            self.assertNotIn("#", ref)
            self.assertIn("example.com", ref)
            self.assertIn("/post/1", ref)

    def test_fetch_image_referer_header(self) -> None:
        captured = {}

        class FakeResp:
            class _Headers:
                def get_content_type(self):
                    return "image/png"

            headers = _Headers()

            def read(self, n):
                return b"\x89PNG\r\n\x1a\n"

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_open(request, timeout=30):
            captured["referer"] = request.get_header("Referer")
            return FakeResp()

        with patch("collector.server._OPENER.open", fake_open):
            with tempfile.TemporaryDirectory() as tmp:
                collector = Collector(Path(tmp), "token", download=False)
                collector._fetch_image(
                    "https://example.com/a.jpg",
                    "http://user:pass@example.com/post/1?q=1#frag",
                )
        ref = captured["referer"]
        self.assertNotIn("user:pass", ref)
        self.assertNotIn("?", ref)
        self.assertNotIn("#", ref)


class DownloadErrorTest(unittest.TestCase):
    def _run(self, de) -> str | None:
        with tempfile.TemporaryDirectory() as tmp:
            collector = Collector(Path(tmp), "token", download=False)
            event = {
                "schema": 3,
                "source": "x",
                "action": "seen",
                "item": {"type": "image", "id": None, "url": "https://example.com/post/1"},
                "images": [{"url": "https://example.com/a.jpg", "download_error": de}],
            }
            collector.handle_event(event, "127.0.0.1")
            stored = json.loads(collector.events_path.read_text(encoding="utf-8").splitlines()[0])
            return stored["images"][0].get("download_error")

    def test_word_only(self) -> None:
        self.assertEqual(self._run("not_displayed"), "not_displayed")

    def test_word_with_description(self) -> None:
        self.assertEqual(self._run("cors_blocked: 取得できません"), "cors_blocked: 取得できません")

    def test_url_replaced(self) -> None:
        self.assertEqual(self._run("failed: https://example.com/x.jpg"), "failed: [url]")


if __name__ == "__main__":
    unittest.main()
