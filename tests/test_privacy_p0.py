from __future__ import annotations

import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

from collector.server import Collector, Handler, _harden_permissions


def _event() -> dict:
    return {
        "schema": 2,
        "source": "x",
        "action": "like",
        "item": {
            "type": "post",
            "id": "1",
            "url": "https://example.com/post/12345?token=secret",
            "title": "秘密のタイトル",
        },
        "images": [
            {"url": "https://example.com/a.jpg?token=secret", "alt": "秘密のalt"}
        ],
        "metadata": {"alt": "秘密の作品名", "title": "Alice"},
    }


class CollectorPrivacyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.collector = Collector(Path(self.tmp.name), "token", download=True)
        self.collector._fetch_image = lambda url, referer: (
            b"\x89PNG\r\n\x1a\n",
            "image/png",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_event_drops_query_alt_ip_and_path(self) -> None:
        event = self.collector.handle_event(_event(), "203.0.113.9")
        self.assertNotIn("remote", event)
        self.assertNotIn("metadata", event)
        self.assertNotIn("path", event["images"][0])
        self.assertNotIn("token=secret", event["item"]["url"])
        self.assertNotIn("token=secret", event["images"][0]["url"])
        stored = self.collector.events_path.read_text(encoding="utf-8")
        self.assertNotIn("token=secret", stored)
        self.assertNotIn("203.0.113.9", stored)
        self.assertNotIn("秘密の作品名", stored)
        self.assertNotIn("秘密のタイトル", stored)
        self.assertNotIn("秘密のalt", stored)
        self.assertNotIn(str(self.tmp.name), stored)

    def test_svg_is_not_saved(self) -> None:
        self.collector._fetch_image = lambda url, referer: (
            b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
            "image/svg+xml",
        )
        event = self.collector.handle_event(_event(), "127.0.0.1")
        self.assertNotIn("hash", event["images"][0])
        self.assertTrue(event["images"][0].get("download_error"))

    def test_existing_images_are_hardened(self) -> None:
        images = Path(self.tmp.name) / "images"
        images.mkdir()
        path = images / "old.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n")
        path.chmod(0o664)
        _harden_permissions(Path(self.tmp.name), Path(self.tmp.name) / "token")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_non_loopback_host_is_rejected(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "collector.server", "--host", "0.0.0.0"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("loopback", result.stderr)

    def test_health_and_cors(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.collector = self.collector  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = HTTPConnection("127.0.0.1", server.server_address[1], timeout=3)
            conn.request("GET", "/api/health")
            response = conn.getresponse()
            body = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertNotIn("token_path", body)
            self.assertNotIn("disk", body)
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)

            conn = HTTPConnection("127.0.0.1", server.server_address[1], timeout=3)
            conn.request(
                "OPTIONS",
                "/api/collect",
                headers={"Origin": "chrome-extension://abcdef"},
            )
            response = conn.getresponse()
            response.read()
            self.assertEqual(
                response.getheader("Access-Control-Allow-Origin"),
                "chrome-extension://abcdef",
            )

            conn = HTTPConnection("127.0.0.1", server.server_address[1], timeout=3)
            conn.request(
                "OPTIONS",
                "/api/collect",
                headers={"Origin": "https://evil.example"},
            )
            response = conn.getresponse()
            response.read()
            self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
