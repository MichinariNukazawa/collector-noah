import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

from collector.server import Collector, Handler


class EventsApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        data_dir = Path(directory.name)
        records = [
            {"id": "before", "created_at": "2026-11-17T23:59:59.999Z"},
            {"id": "start", "created_at": "2026-11-18T00:00:00+00:00"},
            *(
                {"id": str(index), "created_at": "2026-11-18T12:00:00.123Z"}
                for index in range(10_000)
            ),
            {"id": "after", "created_at": "2026-11-19T00:00:00Z"},
        ]
        (data_dir / "events.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
        )
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.addClassCleanup(cls.server.server_close)
        cls.server.collector = Collector(data_dir, "test-token", download=False)
        thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(thread.join)
        cls.addClassCleanup(cls.server.shutdown)
        cls.day = "since=2026-11-18T00:00:00Z&until=2026-11-19T00:00:00%2B00:00"

    def request_events(self, query="", token="test-token"):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("GET", "/api/events?" + query, headers={"X-Atelier-Token": token})
            response = connection.getresponse()
            return response.status, json.load(response)
        finally:
            connection.close()

    def page(self, query, total):
        status, body = self.request_events(query)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["total"], total)
        return [event["id"] for event in body["events"]]

    def test_range_boundaries_total_and_cap(self):
        ids = self.page(self.day + "&limit=10001", 10_001)
        self.assertEqual(ids, [str(index) for index in range(10_000)])
        self.assertEqual(self.page(self.day + "&offset=10000", 10_001), ["start"])
        self.assertEqual(self.page(self.day + "&offset=10001", 10_001), [])
        self.assertEqual(self.page("since=2026-11-20T00:00:00Z", 0), [])

    def test_one_sided_ranges(self):
        self.assertEqual(self.page("since=2026-11-19T00:00:00Z", 1), ["after"])
        self.assertEqual(self.page("until=2026-11-18T00:00:00Z", 1), ["before"])

    def test_offset_pages_follow_append_order(self):
        self.assertEqual(self.page(self.day + "&limit=2", 10_001), ["9998", "9999"])
        self.assertEqual(self.page(self.day + "&limit=2&offset=2", 10_001), ["9996", "9997"])
        self.assertEqual(self.page("limit=2&offset=1", 10_003), ["9998", "9999"])

    def test_legacy_limit(self):
        self.assertEqual(len(self.page("", 10_003)), 50)
        self.assertEqual(len(self.page("limit=10000", 10_003)), 500)
        self.assertEqual(self.page("limit=0", 10_003), ["after"])
        self.assertEqual(self.page("limit=-1", 10_003), ["after"])

    def test_invalid_query(self):
        for query in (
            "since=bad", "since=", "since=2026-11-18",
            "until=2026-11-19T00:00:00%2B09:00",
            "since=2026-11-19T00:00:00Z&until=2026-11-18T00:00:00Z",
            "offset=-1", "offset=no", "offset=", "limit=no", "limit=",
        ):
            with self.subTest(query=query):
                status, body = self.request_events(query)
                self.assertEqual(status, 400)
                self.assertFalse(body["ok"])
                self.assertTrue(body["error"])

    def test_authentication_precedes_query_validation(self):
        status, body = self.request_events("offset=-1", token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(body, {"ok": False, "error": "invalid token"})
