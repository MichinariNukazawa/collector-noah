import json
import os
import stat
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from collector.gaps import (
    MAX_BODY, MAX_BYTES, MAX_RECORDS, SCHEMA, GapStore, _encode, valid_record, valid_submission,
)
from collector.server import Collector, Handler


def make_record(**changes):
    return {
        "schema": 1,
        "id": str(uuid.uuid4()),
        "source": "x",
        "gap_type": "action_missing",
        "detected_at": "2024-02-29T12:34:56.123Z",
        "action": "like",
        **changes,
    }


def image_record(**changes):
    record = make_record(gap_type="image_limit_exceeded", observed_count=2, image_limit=1)
    del record["action"]
    return {**record, **changes}


class GapSchemaTest(unittest.TestCase):
    def test_schema_accepts_both_types_and_separates_submission_and_storage(self):
        for record in (make_record(), image_record()):
            with self.subTest(type=record["gap_type"]):
                self.assertTrue(valid_submission(record))
                self.assertFalse(valid_record(record))
                saved = {**record, "received_at": "2024-03-01T00:00:00Z"}
                self.assertTrue(valid_record(saved))
                self.assertFalse(valid_submission(saved))
                self.assertFalse(valid_record({**saved, "received_at": "2024-02-30T00:00:00Z"}))

    def test_invalid_records(self):
        for record in (
            [], make_record(url="https://example.test/"),
            make_record(id="cfd91a6c-6819-11ee-ae1e-325096b39f47"), make_record(schema=True),
            make_record(source="other"), make_record(action="open"), make_record(observed_count=2),
            image_record(action="like"), image_record(image_limit=0), image_record(observed_count=1),
            image_record(image_limit=2**53), image_record(observed_count=2.5),
            make_record(detected_at="2023-02-29T12:34:56Z"),
            make_record(detected_at="2024-04-31T12:34:56Z"),
            make_record(detected_at="0000-02-29T12:34:56Z"),
            make_record(detected_at="2024-02-29T24:34:56Z"),
            make_record(detected_at="2024-02-29T12:34:56+00:00"),
            make_record(detected_at="2024-02-29T12:34:56Z\n"),
        ):
            with self.subTest(record=record):
                self.assertFalse(valid_submission(record))
        self.assertFalse(valid_submission(image_record(observed_count=2, image_limit=2)))
        self.assertFalse(valid_submission(image_record(observed_count=2, image_limit=3)))

    def test_optional_draft202012_schema_oracle(self):
        try:
            from jsonschema import Draft202012Validator
        except ImportError:
            self.skipTest("optional independent JSON Schema validator is unavailable")
        Draft202012Validator.check_schema(SCHEMA)
        saved = Draft202012Validator(SCHEMA)
        submitted = Draft202012Validator({
            "$schema": SCHEMA["$schema"],
            "$defs": SCHEMA["$defs"],
            "$ref": "#/$defs/submission",
        })
        inputs = [
            make_record(), image_record(), image_record(image_limit=1.0),
            [], make_record(url="https://example.test/"), make_record(schema=True),
            make_record(id="invalid"), make_record(source="invalid"), make_record(observed_count=2),
            image_record(action="like"), image_record(image_limit=0), image_record(observed_count=1),
            image_record(observed_count=2**53), image_record(observed_count=2.5),
        ]
        for record in inputs:
            self.assertEqual(submitted.is_valid(record), valid_submission(record))
            if isinstance(record, dict):
                stored = {**record, "received_at": "2024-03-01T00:00:00Z"}
                self.assertEqual(saved.is_valid(stored), valid_record(stored))
                self.assertFalse(submitted.is_valid(stored))


class GapApiTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.data_dir = Path(directory.name)

        class QuietHandler(Handler):
            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.addCleanup(self.server.server_close)
        self.restart_collector()
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)

    def restart_collector(self):
        self.server.collector = Collector(self.data_dir, "test-token", download=False)
        self.gaps = self.server.collector.gaps

    def request(self, method, path, body=None, token="test-token", origin=None, media="application/json"):
        headers = {}
        if token is not None:
            headers["X-Atelier-Token"] = token
        if origin is not None:
            headers["Origin"] = origin
        if media is not None:
            headers["Content-Type"] = media
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request(method, path, headers=headers, body=body)
            response = conn.getresponse()
            raw = response.read()
            return response.status, response.headers, json.loads(raw) if raw else None
        finally:
            conn.close()

    def post(self, record, **kwargs):
        raw = record if isinstance(record, bytes) else json.dumps(record).encode("utf-8")
        status, _, body = self.request("POST", "/api/gaps", raw, **kwargs)
        return status, body

    def assert_error(self, record, status, code, **kwargs):
        self.assertEqual(self.post(record, **kwargs), (status, {"ok": False, "error": code}))

    def test_create_duplicate_conflict_restart_and_diagnostics(self):
        record = make_record()
        self.assertEqual(self.post(record), (201, {"ok": True, "id": record["id"], "duplicate": False}))
        first_write = self.gaps.path.read_bytes()
        reordered = dict(reversed(list(record.items())))
        with patch("collector.gaps.os.replace", side_effect=AssertionError("duplicate rewritten")):
            self.assertEqual(self.post(reordered), (200, {"ok": True, "id": record["id"], "duplicate": True}))
        self.restart_collector()
        self.assertEqual(self.post(record)[0], 200)
        self.assert_error({**record, "action": "save"}, 409, "id_conflict")
        self.assertEqual(self.gaps.path.read_bytes(), first_write)
        identifiers = [record["id"]]
        for _ in range(12):
            extra = image_record()
            self.assertEqual(self.post(extra)[0], 201)
            identifiers.append(extra["id"])
        status, _, body = self.request("GET", "/api/diagnostics")
        self.assertEqual(status, 200)
        self.assertEqual(body["gaps_count"], 13)
        self.assertEqual([entry["id"] for entry in body["recent_gaps"]], identifiers[-10:][::-1])
        self.assertTrue(all(valid_record(entry) for entry in body["recent_gaps"]))
        self.assertEqual(body["events_count"], 0)
        self.assertEqual(list(self.data_dir.iterdir()), [self.data_dir / "gaps"])
        self.assertEqual(self.request("GET", "/api/diagnostics", token=None)[0], 401)

    def test_cors_and_authentication(self):
        for origin in ("chrome-extension://abcdefgh", "moz-extension://00000000-a000-b000-c000-000000000000"):
            with self.subTest(origin=origin):
                status, headers, _ = self.request("OPTIONS", "/api/gaps", token=None, origin=origin)
                self.assertEqual(status, 204)
                self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)
                self.assertEqual(headers.get("Vary"), "Origin")
                self.assertEqual(headers.get("Access-Control-Allow-Headers"), "Content-Type, X-Atelier-Token")
                self.assertEqual(headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS")
                self.assert_error({}, 401, "unauthorized", token=None, origin=origin)
                status, headers, _ = self.request("POST", "/api/gaps", _encode(make_record()), origin=origin)
                self.assertEqual(status, 201)
                self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)
        status, headers, _ = self.request("OPTIONS", "/api/gaps", token=None, origin="https://example.test")
        self.assertEqual(status, 204)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        self.assert_error({}, 401, "unauthorized", token="wrong")
        self.assert_error({}, 401, "unauthorized", token="café")

    def test_media_body_limit_and_validation(self):
        record = make_record()
        raw = _encode(record)
        self.assert_error(raw, 415, "unsupported_media_type", media="text/plain")
        self.assert_error(raw, 415, "unsupported_media_type", media=None)
        self.assertEqual(self.post(raw.ljust(MAX_BODY), media="application/json; charset=utf-8")[0], 201)
        self.assert_error(raw.ljust(MAX_BODY + 1), 413, "payload_too_large")
        for invalid_bytes in (b"", b"{", b"\xff", b'{"a": NaN}', b"[" * 1500):
            self.assert_error(invalid_bytes, 400, "invalid_json")
        for invalid_record in (
            [], make_record(detected_at="2026-02-29T00:00:00Z"),
            make_record(received_at="2026-02-28T00:00:00Z"),
            make_record(item_id="123"), image_record(image_limit=2),
        ):
            self.assert_error(invalid_record, 400, "invalid_record")

    def test_failed_replacement_preserves_previous_records_and_retry_succeeds(self):
        self.assertEqual(self.post(make_record())[0], 201)
        before = self.gaps.path.read_bytes()
        record = make_record()
        for operation in ("fsync", "replace"):
            with patch(f"collector.gaps.os.{operation}", side_effect=OSError("private detail")):
                self.assert_error(record, 503, "storage_unavailable")
            self.assertEqual(self.gaps.path.read_bytes(), before)
            self.assertEqual(list(self.gaps.path.parent.iterdir()), [self.gaps.path])
        self.assertEqual(self.post(record)[0], 201)
        self.assertEqual(self.post(record)[0], 200)
        with patch.object(self.gaps.path.__class__, "read_bytes", side_effect=OSError("private detail")):
            self.assert_error(make_record(), 503, "storage_unavailable")
            status, _, body = self.request("GET", "/api/diagnostics")
            self.assertEqual((status, body), (503, {"ok": False, "error": "storage_unavailable"}))


class GapRetentionTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.data_dir = Path(directory.name)
        self.gaps = GapStore(self.data_dir)
        self.now = datetime(2026, 11, 21, 12, tzinfo=timezone.utc)
        clock = patch("collector.gaps.datetime", wraps=datetime)
        clock.start().now.return_value = self.now
        self.addCleanup(clock.stop)

    def saved(self, record, *, age=timedelta(0)):
        received = self.now - age
        return {**record, "received_at": received.isoformat(timespec="milliseconds").replace("+00:00", "Z")}

    def seed(self, records):
        self.gaps.path.parent.mkdir(exist_ok=True)
        self.gaps.path.write_bytes(b"".join(_encode(record) for record in records))

    def test_startup_and_read_prune_exact_deadline_and_allow_expired_id(self):
        old, fresh = make_record(), make_record()
        self.seed([
            self.saved(old, age=timedelta(days=30)),
            self.saved(fresh, age=timedelta(days=30, milliseconds=-1)),
        ])
        collector = Collector(self.data_dir, "test-token", download=False)
        self.assertEqual(self.gaps.path.read_bytes().count(b"\n"), 1)
        self.assertEqual(collector.diagnostics()["recent_gaps"][0]["id"], fresh["id"])
        self.assertFalse(collector.gaps.put(old))
        self.seed([self.saved(fresh, age=timedelta(days=31))])
        self.assertEqual(collector.diagnostics()["gaps_count"], 0)
        self.assertEqual(self.gaps.path.read_bytes(), b"")

    def test_hourly_maintenance_prunes(self):
        collector = Collector(self.data_dir, "test-token", download=False)
        self.seed([self.saved(make_record(), age=timedelta(days=31))])
        stop = Mock()
        stop.wait.side_effect = [False, True]
        collector.maintain_gaps_hourly(stop)
        self.assertEqual([call.args for call in stop.wait.call_args_list], [(3600,), (3600,)])
        self.assertEqual(self.gaps.path.read_bytes(), b"")

    def test_count_and_byte_caps_evict_oldest_by_save_order(self):
        # Compact action records with the seconds-only form allow the count cap to bind first.
        records = [
            {**make_record(detected_at="2026-11-21T12:00:00Z"), "received_at": "2026-11-21T12:00:00Z"}
            for _ in range(MAX_RECORDS + 1)
        ]
        self.assertLess(sum(len(_encode(record)) for record in records), MAX_BYTES)
        self.seed(records)
        self.gaps.maintain()
        self.assertEqual(self.gaps.diagnostics()["gaps_count"], MAX_RECORDS)
        self.assertEqual(self.gaps.path.read_bytes().splitlines()[0], _encode(records[1]).rstrip(b"\n"))

        records = [
            self.saved(image_record(observed_count=2**53 - 1, image_limit=2**53 - 2))
            for _ in range(MAX_RECORDS - 1)
        ]
        self.assertGreater(sum(len(_encode(record)) for record in records), MAX_BYTES)
        self.seed(records)
        self.gaps.maintain()
        kept = self.gaps.path.read_bytes()
        self.assertLessEqual(len(kept), MAX_BYTES)
        actual_count = len(kept.splitlines())
        self.assertGreater(len(kept) + len(_encode(records[-actual_count - 1])), MAX_BYTES)
        self.assertEqual(kept, b"".join(_encode(record) for record in records[-actual_count:]))

    def test_put_prunes_and_reuses_evicted_id(self):
        expired = make_record()
        self.seed([self.saved(expired, age=timedelta(days=31))])
        self.assertFalse(self.gaps.put({**expired, "action": "follow"}))
        self.assertEqual(self.gaps.diagnostics()["gaps_count"], 1)
        self.assertEqual(self.gaps.diagnostics()["recent_gaps"][0]["action"], "follow")


class GapConcurrencyTest(unittest.TestCase):
    def test_sync_and_replace_private_file_and_serialize_concurrent_access(self):
        with tempfile.TemporaryDirectory() as temp:
            gaps = GapStore(Path(temp))
            first = make_record()
            gaps.put(first)
            original = gaps.path.read_bytes()
            second = make_record()
            synced = threading.Event()
            at_replace = threading.Event()
            release = threading.Event()
            real_fsync = os.fsync
            real_replace = os.replace

            def sync(fd):
                self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), 0o600)
                real_fsync(fd)
                synced.set()

            def replace(temp_path, target):
                self.assertTrue(synced.is_set())
                self.assertEqual(temp_path.parent, target.parent)
                if not at_replace.is_set():
                    self.assertEqual(target.read_bytes(), original)
                    self.assertEqual(len(temp_path.read_bytes().splitlines()), 2)
                    at_replace.set()
                    self.assertTrue(release.wait(5))
                real_replace(temp_path, target)

            with (
                patch("collector.gaps.os.fsync", side_effect=sync),
                patch("collector.gaps.os.replace", side_effect=replace),
                ThreadPoolExecutor(max_workers=8) as pool,
            ):
                creating = pool.submit(gaps.put, second)
                try:
                    self.assertTrue(at_replace.wait(5))
                    duplicate = pool.submit(gaps.put, second)
                    diagnostic = pool.submit(gaps.diagnostics)
                    extra = [pool.submit(gaps.put, make_record()) for _ in range(10)]
                    self.assertFalse(duplicate.done())
                    self.assertFalse(diagnostic.done())
                    self.assertEqual(gaps.path.read_bytes(), original)
                finally:
                    release.set()
                self.assertFalse(creating.result(timeout=5))
                self.assertTrue(duplicate.result(timeout=5))
                self.assertGreaterEqual(diagnostic.result(timeout=5)["gaps_count"], 2)
                self.assertTrue(all(f.result(timeout=5) is False for f in extra))
            records = [json.loads(line) for line in gaps.path.read_bytes().splitlines()]
            self.assertEqual(len(records), 12)
            self.assertEqual(len({record["id"] for record in records}), 12)
            self.assertTrue(all(valid_record(record) for record in records))
            self.assertEqual(stat.S_IMODE(gaps.path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(gaps.path.parent.stat().st_mode), 0o700)
