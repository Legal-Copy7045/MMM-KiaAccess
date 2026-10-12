"""kia_client.REGION_INT must agree with the installed library's own region
numbering -- an off-by-one here silently sends an account to another
country's API.

Run: python test/region_map_test.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import kia_client  # noqa: E402
from hyundai_kia_connect_api.const import REGIONS  # noqa: E402

expected = {
    "EU": "Europe", "CA": "Canada", "USA": "USA", "CN": "China",
    "AU": "Australia", "IN": "India", "NZ": "New Zealand", "BR": "Brazil",
}
for code, lib_name in expected.items():
    num = kia_client.REGION_INT[code]
    assert REGIONS[num] == lib_name, f"{code} -> {num} is {REGIONS[num]!r}, want {lib_name!r}"
for alias, code in (("EUROPE", "EU"), ("INDIA", "IN"), ("BRAZIL", "BR"), ("US", "USA")):
    assert kia_client.REGION_INT[alias] == kia_client.REGION_INT[code], alias

spec = {"regions": ["EU", "AU", "NZ", "IN", "CN", "BR"]}
assert kia_client.command_allowed(spec, "EU")
assert kia_client.command_allowed(spec, "europe"), "aliases count"
assert not kia_client.command_allowed(spec, "USA")
assert not kia_client.command_allowed(spec, "CA")
assert not kia_client.command_allowed(spec, "Mars")
assert kia_client.command_allowed({}, "USA"), "no regions list = everywhere"
print("region map tests passed")
