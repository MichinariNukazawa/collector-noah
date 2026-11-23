"""Validation and bounded storage for gap observations."""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

MAX_BODY = 4_096
MAX_RECORDS = 1_000
MAX_BYTES = 192 * 1024
RETENTION = timedelta(days=30)

SCHEMA = json.loads(
    (Path(__file__).resolve().parents[1] / "schemas" / "gaps_record.schema.json")
    .read_text(encoding="utf-8")
)
OBSERVATION = SCHEMA["$defs"]["observation"]
PROPERTIES = OBSERVATION["properties"]
COMMON_FIELDS = frozenset(OBSERVATION["required"])
STORED_FIELDS = frozenset(SCHEMA["required"])
ACTION_GAP = OBSERVATION["if"]["properties"]["gap_type"]["const"]
ACTION_FIELDS = frozenset(OBSERVATION["then"]["required"])
IMAGE_FIELDS = frozenset(OBSERVATION["else"]["required"])
UTC_PATTERN = re.compile(SCHEMA["$defs"]["utc_timestamp"]["pattern"])
ID_PATTERN = re.compile(PROPERTIES["id"]["pattern"])


def _utc_datetime(text: str) -> datetime:
    if not isinstance(text, str) or not UTC_PATTERN.fullmatch(text):
        raise ValueError("expected UTC timestamp")
    return datetime.fromisoformat(text[:-1] + "+00:00")


def _is_integer(value: Any) -> bool:
    # JSON Schema regards 1.0 as an integer and does not regard true as one.
    return type(value) is int or (type(value) is float and value.is_integer())


def _bounded_integer(value: Any, field: str) -> bool:
    limits = PROPERTIES[field]
    return _is_integer(value) and limits["minimum"] <= value <= limits["maximum"]


def _valid_record(record: Any, *, saved: bool) -> bool:
    """Apply the fixed submission or storage contract using the shipped schema."""
    if not isinstance(record, dict):
        return False
    gap_type = record.get("gap_type")
    if gap_type not in PROPERTIES["gap_type"]["enum"]:
        return False
    branch_fields = ACTION_FIELDS if gap_type == ACTION_GAP else IMAGE_FIELDS
    expected = COMMON_FIELDS | branch_fields
    if saved:
        expected |= STORED_FIELDS
    if record.keys() != expected:
        return False
    schema_version = record["schema"]
    record_id = record["id"]
    if (
        not _is_integer(schema_version) or schema_version != PROPERTIES["schema"]["const"]
        or not isinstance(record_id, str) or not ID_PATTERN.fullmatch(record_id)
        or record["source"] not in PROPERTIES["source"]["enum"]
    ):
        return False
    try:
        _utc_datetime(record["detected_at"])
        if saved:
            _utc_datetime(record["received_at"])
    except ValueError:
        return False
    if gap_type == ACTION_GAP:
        return record["action"] in PROPERTIES["action"]["enum"]
    return (
        _bounded_integer(record["observed_count"], "observed_count")
        and _bounded_integer(record["image_limit"], "image_limit")
        and record["observed_count"] > record["image_limit"]
    )


def _reject_constant(value: str) -> None:
    raise ValueError("invalid JSON constant")


def decode_json(raw: bytes) -> Any:
    return json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)


def valid_submission(record: Any) -> bool:
    return _valid_record(record, saved=False)


def valid_record(record: Any) -> bool:
    return _valid_record(record, saved=True)


def _encode(record: dict[str, Any]) -> bytes:
    return (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


class GapStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "gaps" / "records.jsonl"
        self._lock = threading.Lock()

    def _read(self, now: datetime) -> tuple[bytes, list[tuple[dict[str, Any], bytes]]]:
        try:
            original = self.path.read_bytes()
        except FileNotFoundError:
            return b"", []
        records = []
        try:
            for line in original.splitlines():
                record = decode_json(line)
                received = _utc_datetime(record["received_at"])
                if not isinstance(record["id"], str):
                    raise ValueError("invalid stored id")
                if now - received < RETENTION:
                    records.append((record, _encode(record)))
        except (KeyError, TypeError, ValueError, RecursionError) as exc:
            raise OSError("invalid gaps store") from exc
        return original, self._bounded(records)

    @staticmethod
    def _bounded(
        records: list[tuple[dict[str, Any], bytes]],
    ) -> list[tuple[dict[str, Any], bytes]]:
        kept = records[-MAX_RECORDS:]
        total = sum(len(line) for _, line in kept)
        first = 0
        while total > MAX_BYTES:
            total -= len(kept[first][1])
            first += 1
        return kept[first:]

    def _write_if_changed(
        self, original: bytes, records: list[tuple[dict[str, Any], bytes]],
    ) -> None:
        contents = b"".join(line for _, line in records)
        if original == contents:
            return
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=self.path.parent, prefix=".records-", delete=False,
            ) as tmp:
                temp_path = Path(tmp.name)
                tmp.write(contents)
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(temp_path, self.path)
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    def put(self, submission: dict[str, Any]) -> bool | None:
        """Return False for a new record, True for a duplicate, None for a conflict."""
        with self._lock:
            now = datetime.now(timezone.utc)
            original, records = self._read(now)
            for record, _ in records:
                if record["id"] == submission["id"]:
                    self._write_if_changed(original, records)
                    existing = {key: value for key, value in record.items() if key != "received_at"}
                    return True if existing == submission else None
            record = {
                **submission,
                "received_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            }
            records.append((record, _encode(record)))
            self._write_if_changed(original, self._bounded(records))
            return False

    def maintain(self) -> None:
        with self._lock:
            original, records = self._read(datetime.now(timezone.utc))
            self._write_if_changed(original, records)

    def diagnostics(self) -> dict[str, Any]:
        with self._lock:
            original, records = self._read(datetime.now(timezone.utc))
            recent = [record for record, _ in reversed(records[-10:])]
            if not all(valid_record(record) for record in recent):
                raise OSError("invalid gaps store")
            self._write_if_changed(original, records)
            return {"gaps_count": len(records), "recent_gaps": recent}
