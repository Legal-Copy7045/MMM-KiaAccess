#!/usr/bin/env python3
"""Import the Kia Access integration against a real Home Assistant install and
check the pieces hassfest cares about, without a running HA instance.

Run: pip install homeassistant && python test/ha_import_check.py
"""
import importlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# a stand-in for hyundai_kia_connect_api so config_flow/coordinator import
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

pkg = "custom_components.kia_access"

manifest = json.load(open(os.path.join(ROOT, "custom_components/kia_access/manifest.json"), encoding="utf-8"))
assert manifest["domain"] == "kia_access"
assert manifest["config_flow"] is True
assert manifest["version"], "manifest needs a version"
assert any(r.startswith("hyundai_kia_connect_api") for r in manifest["requirements"])

for mod in ("const", "coordinator", "config_flow", "entity", "sensor", "binary_sensor", "button", "__init__"):
    importlib.import_module(f"{pkg}.{mod}" if mod != "__init__" else pkg)
    print("imported", mod)

const = importlib.import_module(f"{pkg}.const")
assert len(const.ENTITIES) >= 20
assert {c["key"] for c in const.COMMANDS} >= {"lock", "unlock", "start_climate"}

cf = importlib.import_module(f"{pkg}.config_flow")
assert hasattr(cf, "KiaAccessConfigFlow")
assert hasattr(cf.KiaAccessConfigFlow, "async_step_otp")

init = importlib.import_module(pkg)
assert hasattr(init, "_register_frontend")
assert os.path.exists(
    os.path.join(ROOT, "custom_components/kia_access/frontend/kia-access-card.js")
), "card bundle not vendored"

# strings.json <-> translations/en.json identical, and cover the flow steps
s = json.load(open(os.path.join(ROOT, "custom_components/kia_access/strings.json"), encoding="utf-8"))
e = json.load(open(os.path.join(ROOT, "custom_components/kia_access/translations/en.json"), encoding="utf-8"))
assert s == e, "strings.json and translations/en.json differ"
assert set(s["config"]["step"]) == {"user", "otp"}

print("ha_import_check: ok")
