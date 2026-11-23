"""受信側と契約（schema・sites.json）の語彙が一致することを確認する。"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from collector.server import ACTIONS

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schemas" / "collection_event.schema.json"
SITES = ROOT / "sites.json"


def _schema_actions() -> set[str]:
    data = json.loads(SCHEMA.read_text(encoding="utf-8"))
    return set(data["properties"]["action"]["enum"])


class ContractTest(unittest.TestCase):
    def test_schema_and_collector_actions_match(self) -> None:
        self.assertEqual(_schema_actions(), ACTIONS)

    def test_sites_use_known_actions(self) -> None:
        sites = json.loads(SITES.read_text(encoding="utf-8"))
        for site_id, cfg in sites.items():
            for action in cfg.get("actions", []):
                self.assertIn(action["action"], _schema_actions(), site_id)


if __name__ == "__main__":
    unittest.main()
