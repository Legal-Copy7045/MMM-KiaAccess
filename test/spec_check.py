#!/usr/bin/env python3
"""Validate the shared core/*.json specs. Run: python test/spec_check.py"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check(rel, list_key, required):
    path = os.path.join(ROOT, rel)
    data = json.load(open(path, encoding="utf-8"))
    rows = data.get(list_key)
    assert isinstance(rows, list) and rows, f"{rel}: missing '{list_key}' list"
    keys = [r["key"] for r in rows]
    assert len(keys) == len(set(keys)), f"{rel}: duplicate keys"
    for r in rows:
        for field in required:
            assert r.get(field) not in (None, ""), f"{rel}: {r.get('key')!r} missing {field}"
    print(f"{rel}: ok - {len(rows)} entries")


check("core/entities.json", "entities", ["key", "domain", "name"])
check("core/commands.json", "commands", ["key", "name", "method"])

# entities.json <-> ha-discovery must agree (JS side asserts the same in state.test.js)
ent = json.load(open(os.path.join(ROOT, "core/entities.json"), encoding="utf-8"))["entities"]
for e in ent:
    assert e["domain"] in ("sensor", "binary_sensor"), f"bad domain {e['domain']!r}"

print("spec_check: all specs valid")
sys.exit(0)
