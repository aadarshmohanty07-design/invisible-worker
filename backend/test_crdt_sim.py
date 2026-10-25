"""Unit tests for the hand-rolled CRDT simulation (Phase 5)."""

from __future__ import annotations

from backend.crdt_sim import (
    DeviceLedger,
    merge,
    merge_with_report,
    simulate_clock_reset,
    sort_by_logical,
)

MALICIOUS_CLOCK = "1970-01-01T00:00:00+05:30"


def _entry(transaction_id: str, logical_clock: int, device_id: str, payload: str = "original") -> dict:
    return {
        "transaction_id": transaction_id,
        "logical_clock": logical_clock,
        "device_id": device_id,
        "payload": payload,
    }


def test_merge_dedupes_and_chooses_highest_clock_winner() -> None:
    device_a = DeviceLedger(
        "device-a",
        [_entry("tx-1", 5, "device-a", "old"), _entry("tx-2", 4, "device-a")],
        next_clock=10,
    )
    device_b = DeviceLedger(
        "device-b",
        [_entry("tx-1", 7, "device-b", "new"), _entry("tx-3", 3, "device-b")],
        next_clock=20,
    )

    merged, report = merge_with_report(device_a, device_b)

    assert [entry["transaction_id"] for entry in merged.entries] == ["tx-3", "tx-2", "tx-1"]
    winner = next(entry for entry in merged.entries if entry["transaction_id"] == "tx-1")
    assert winner["payload"] == "new"
    assert report["conflicts"] == 1
    assert report["losses"] == 0
    assert merged.next_clock == 21
    assert len(merged.entries) == 3


def test_merge_breaks_ties_by_device_id() -> None:
    device_a = DeviceLedger("device-a", [_entry("tx-1", 5, "device-a", "from-a")], next_clock=6)
    device_b = DeviceLedger("device-b", [_entry("tx-1", 5, "device-b", "from-b")], next_clock=6)

    merged = merge(device_a, device_b)

    assert merged.entries[0]["payload"] == "from-b"


def test_merge_next_clock_and_does_not_mutate_inputs() -> None:
    entry_a = _entry("tx-1", 5, "device-a")
    entry_b = _entry("tx-2", 6, "device-b")
    device_a = DeviceLedger("device-a", [entry_a], next_clock=7)
    device_b = DeviceLedger("device-b", [entry_b], next_clock=4)

    merged = merge(device_a, device_b)
    merged.entries[0]["payload"] = "mutated"

    assert merged.next_clock == 8
    assert device_a.entries[0]["payload"] == "original"
    assert device_b.entries[0]["payload"] == "original"
    assert device_a.next_clock == 7
    assert device_b.next_clock == 4


def test_simulate_clock_reset_appends_probe_and_detects() -> None:
    device = DeviceLedger("device-b", [_entry("tx-1", 43, "device-b")], next_clock=45)
    original_length = len(device.entries)

    updated, detection = simulate_clock_reset(device, MALICIOUS_CLOCK)

    assert len(updated.entries) == original_length + 1
    assert len(device.entries) == original_length
    probe = updated.entries[-1]
    assert probe["logical_clock"] == 45
    assert probe["created_at"] == MALICIOUS_CLOCK
    assert probe["clock_suspect"] is True
    assert probe["device_id"] == "device-b"
    assert probe["event_ids"]
    assert updated.next_clock == 46
    assert detection["detected"] is True
    assert detection["wall_clock"] == MALICIOUS_CLOCK
    assert detection["logical_clock"] == 45
    assert "logical clock 45" in detection["message"]


def test_sort_by_logical_uses_full_triplet() -> None:
    entries = [
        _entry("tx-b", 2, "device-b"),
        _entry("tx-a", 2, "device-a"),
        _entry("tx-c", 1, "device-c"),
    ]

    ordered = sort_by_logical(entries)

    assert [entry["transaction_id"] for entry in ordered] == ["tx-c", "tx-a", "tx-b"]
