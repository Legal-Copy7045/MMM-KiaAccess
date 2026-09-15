"""kia_client's account-scoped token file: identity, isolation, and the
one-time migration off the old shared token.json.

Run: python test/token_file_test.py

Before this, EVERY account (MM module block, or a second enroll.py run)
shared the exact same token.json -- two accounts running side by side would
each rotate/overwrite the other's saved refresh token on every fetch,
breaking whichever account polled less recently. This pins down: (1) two
different accounts always get different files, (2) a pre-upgrade single
shared token.json is carried forward automatically for whichever account
touches it first, (3) that migration never lets a SECOND account adopt a
file already tagged for a different one, and (4) alternating between two
already-set-up accounts (A -> B -> A) never mixes up which token belongs to
which.
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import kia_client  # noqa: E402


class _Token:
    """Stand-in for hyundai_kia_connect_api.Token -- only what _save_token reads."""

    def __init__(self, value):
        self._value = value

    def to_dict(self):
        return {"refresh_token": self._value}


class _Vm:
    def __init__(self, token_value):
        self.token = _Token(token_value) if token_value is not None else None


def with_tmp_module_dir(fn):
    """Runs `fn(tmp_dir)` with kia_client._HERE / DEFAULT_TOKEN_FILE pointed
    at a throwaway directory, then restores the real module paths -- so this
    test never touches the actual repo's own token file(s)."""
    tmp = tempfile.mkdtemp(prefix="kia-token-test-")
    orig_here, orig_default = kia_client._HERE, kia_client.DEFAULT_TOKEN_FILE
    kia_client._HERE = tmp
    kia_client.DEFAULT_TOKEN_FILE = os.path.join(tmp, "token.json")
    try:
        fn(tmp)
    finally:
        kia_client._HERE, kia_client.DEFAULT_TOKEN_FILE = orig_here, orig_default
        shutil.rmtree(tmp, ignore_errors=True)


# ---- account_token_file(): same account -> same file; different account ->
# different file, case-insensitively ----
def _identity(tmp):
    jobA = {"region": "USA", "brand": "KIA", "username": "alice@example.com"}
    jobA_case = {"region": "usa", "brand": "kia", "username": "ALICE@EXAMPLE.COM"}
    jobB = {"region": "USA", "brand": "KIA", "username": "bob@example.com"}

    fileA = kia_client.account_token_file(jobA)
    fileA_case = kia_client.account_token_file(jobA_case)
    fileB = kia_client.account_token_file(jobB)

    assert fileA == fileA_case, "region/brand/username must hash case-insensitively"
    assert fileA != fileB, "two different usernames must never share a token file"


with_tmp_module_dir(_identity)


# ---- _migrate_legacy_token(): a genuinely untagged (pre-v2.63) token.json
# is adopted for whichever account first calls connect()-equivalent logic ----
def _migration_adopts_untagged(tmp):
    legacy = kia_client.DEFAULT_TOKEN_FILE
    with open(legacy, "w", encoding="utf-8") as fh:
        json.dump({"refresh_token": "OLD"}, fh)

    jobA = {"region": "USA", "brand": "KIA", "username": "alice@example.com"}
    fileA = kia_client.account_token_file(jobA)
    hashA = kia_client._account_hash("USA", "KIA", "alice@example.com")

    kia_client._migrate_legacy_token(fileA, hashA)

    assert os.path.exists(fileA), "the untagged legacy file must have been adopted"
    assert not os.path.exists(legacy), "adopting renames it, not copies it"
    with open(fileA, encoding="utf-8") as fh:
        assert json.load(fh)["refresh_token"] == "OLD"


with_tmp_module_dir(_migration_adopts_untagged)


# ---- _migrate_legacy_token(): once a legacy file is tagged for account A,
# account B's own migration attempt must NEVER adopt it -- this is the exact
# bug this whole scheme exists to prevent: B silently taking over A's
# still-in-use saved token. ----
def _migration_never_steals_a_tagged_file(tmp):
    jobA = {"region": "USA", "brand": "KIA", "username": "alice@example.com"}
    jobB = {"region": "USA", "brand": "KIA", "username": "bob@example.com"}
    hashA = kia_client._account_hash("USA", "KIA", "alice@example.com")
    hashB = kia_client._account_hash("USA", "KIA", "bob@example.com")
    fileA = kia_client.account_token_file(jobA)
    fileB = kia_client.account_token_file(jobB)

    # A already has its own real (tagged) file -- as if A logged in first
    with open(fileA, "w", encoding="utf-8") as fh:
        json.dump({"refresh_token": "A-TOKEN", "_kiaAccessAccountHash": hashA}, fh)

    # simulate a DIFFERENT leftover untagged legacy file still present
    # (unusual, but not impossible -- e.g. a manually restored backup)
    # actually tagged for account A specifically, sitting at the legacy path
    with open(kia_client.DEFAULT_TOKEN_FILE, "w", encoding="utf-8") as fh:
        json.dump({"refresh_token": "A-TOKEN", "_kiaAccessAccountHash": hashA}, fh)

    kia_client._migrate_legacy_token(fileB, hashB)

    assert not os.path.exists(fileB), (
        "a legacy file already tagged for a DIFFERENT account must never be adopted -- "
        "otherwise setting up account B would silently steal account A's saved token"
    )
    assert os.path.exists(kia_client.DEFAULT_TOKEN_FILE), "A's tagged file must be left untouched"


with_tmp_module_dir(_migration_never_steals_a_tagged_file)


# ---- _save_token(): two accounts saving concurrently-ish must never
# clobber each other's file, and switching context A -> B -> A must read
# back exactly what each account itself last saved (not the other's) ----
def _a_b_a_isolation(tmp):
    jobA = {"region": "USA", "brand": "KIA", "username": "alice@example.com"}
    jobB = {"region": "USA", "brand": "KIA", "username": "bob@example.com"}
    hashA = kia_client._account_hash("USA", "KIA", "alice@example.com")
    hashB = kia_client._account_hash("USA", "KIA", "bob@example.com")
    fileA = kia_client.account_token_file(jobA)
    fileB = kia_client.account_token_file(jobB)

    def read(f):
        with open(f, encoding="utf-8") as fh:
            return json.load(fh)

    # A logs in / rotates its token
    kia_client._save_token(fileA, _Vm("A-TOKEN-1"), None, hashA)
    assert read(fileA)["refresh_token"] == "A-TOKEN-1"
    assert not os.path.exists(fileB), "B's file must not exist yet -- A's save must not create it"

    # B logs in / rotates its token
    kia_client._save_token(fileB, _Vm("B-TOKEN-1"), None, hashB)
    assert read(fileB)["refresh_token"] == "B-TOKEN-1"
    assert read(fileA)["refresh_token"] == "A-TOKEN-1", "B's save must not touch A's file"

    # A rotates again (e.g. the next poll cycle) -- back to A's context
    kia_client._save_token(fileA, _Vm("A-TOKEN-2"), None, hashA)
    assert read(fileA)["refresh_token"] == "A-TOKEN-2", "A must see its own latest token, not B's"
    assert read(fileB)["refresh_token"] == "B-TOKEN-1", "A's rotation must not touch B's file"

    # both files carry their OWN account's tag, never swapped
    assert read(fileA)["_kiaAccessAccountHash"] == hashA
    assert read(fileB)["_kiaAccessAccountHash"] == hashB


with_tmp_module_dir(_a_b_a_isolation)

print("all token_file tests passed")
