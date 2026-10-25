"""Persistence tests for the SQLite layer (Phase 2)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import store
from backend.main import (
    DEVICES,
    EVENTS,
    LEDGER,
    LEXICON,
    LOSSES,
    PENDING_AUDIO_ID,
    PENDING_SMS_ID,
    _reload_from_db,
    app,
    reset_state,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_demo_state() -> None:
    reset_state()
    yield


def rows(table: str) -> list[tuple]:
    with store.connection() as conn:
        return conn.execute(f"SELECT * FROM {table}").fetchall()


def test_exactly_the_five_agreed_tables_exist() -> None:
    with store.connection() as conn:
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
    assert names == set(store.TABLE_NAMES)


def test_seed_rows_are_persisted() -> None:
    assert set(store.load_events()) == set(EVENTS)
    assert set(store.load_ledger()) == set(LEDGER)
    assert set(store.load_losses()) == set(LOSSES)
    assert set(store.load_devices()) == set(DEVICES)
    assert len(store.load_lexicon()) == len(LEXICON)


def test_save_event_upserts_by_event_id() -> None:
    event = dict(next(iter(EVENTS.values())))
    event["confidence"] = 0.11
    store.save_event(event)
    event["confidence"] = 0.99
    store.save_event(event)

    matches = [row for row in rows("raw_events") if row[0] == event["event_id"]]
    assert len(matches) == 1
    assert store.load_events()[event["event_id"]]["confidence"] == 0.99


def test_lexicon_versions_use_a_composite_key() -> None:
    entry = dict(LEXICON[0])
    first = dict(entry, version=101)
    second = dict(entry, version=102)
    store.save_lexicon_entry(first)
    store.save_lexicon_entry(second)

    versions = {item["version"] for item in store.load_lexicon() if item["local_term"] == entry["local_term"]}
    assert {101, 102} <= versions


def test_posted_event_survives_a_database_reload() -> None:
    response = client.post(
        "/events",
        json={"source": "sms", "raw_text": "2 kilo pyaz 40", "device_id": "device-a"},
    )
    assert response.status_code == 200
    event_id = response.json()["event_id"]

    assert event_id in store.load_events()
    # Dropping the cache and reloading proves the row is on disk, not just in memory.
    EVENTS.pop(event_id)
    _reload_from_db()
    assert event_id in EVENTS


def test_fused_entry_is_saved_to_ledger_entries() -> None:
    response = client.post(
        "/fuse",
        json={"event_ids": [PENDING_AUDIO_ID, PENDING_SMS_ID], "device_id": "device-a"},
    )
    assert response.status_code == 200
    entry = response.json()
    assert entry["status"] == "fused"

    persisted = store.load_ledger()[entry["transaction_id"]]
    assert persisted["event_ids"] == entry["event_ids"]
    assert persisted["debit"]["amount_mean"] == entry["debit"]["amount_mean"]


def test_sync_and_clock_simulation_persist_device_state() -> None:
    client.post("/sync", json={"device_ids": ["device-b"]})
    assert store.load_devices()["device-b"]["status"] == "online"

    before = store.load_devices()["device-c"]["conflicts_resolved"]
    client.post("/simulate-clock", json={"device_id": "device-c"})
    after = store.load_devices()["device-c"]["conflicts_resolved"]
    assert after == before + 1


def test_taught_word_is_persisted_with_next_version() -> None:
    payload = {"local_term": "bhaji", "corrected_meaning": "vegetable", "category": "item"}
    assert client.post("/lexicon/teach", json=payload).status_code == 200
    assert client.post("/lexicon/teach", json=payload).status_code == 200

    taught = [item for item in store.load_lexicon() if item["local_term"] == "bhaji"]
    assert sorted(item["version"] for item in taught) == [1, 2]


def test_demo_reset_restores_seed_state_and_clears_new_rows() -> None:
    created = client.post(
        "/events",
        json={"source": "sms", "raw_text": "1 kilo chini 50", "device_id": "device-a"},
    ).json()

    response = client.post("/demo/reset")
    assert response.status_code == 200
    assert {entry["transaction_id"] for entry in response.json()} == set(LEDGER)

    assert created["event_id"] not in store.load_events()
    assert set(store.load_events()) == set(EVENTS)
    assert set(store.load_devices()) == set(DEVICES)
