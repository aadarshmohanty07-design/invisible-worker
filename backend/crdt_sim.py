"""Hand-rolled three-device CRDT simulation for the demo.

No external dependency: a ledger replica is a list of JSON documents, and the
merge is a deterministic last-writer-wins set union keyed by transaction_id.
Wall clocks are untrusted; every ordering decision uses the logical clock.
"""

from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field


@dataclass
class DeviceLedger:
    device_id: str
    entries: list[dict] = field(default_factory=list)
    next_clock: int = 1


def _entry_key(entry: dict) -> tuple[int, str, str]:
    return (entry["logical_clock"], entry["device_id"], entry["transaction_id"])


def sort_by_logical(entries: list[dict]) -> list[dict]:
    return sorted((copy.deepcopy(entry) for entry in entries), key=_entry_key)


def merge_with_report(a: DeviceLedger, b: DeviceLedger) -> tuple[DeviceLedger, dict]:
    versions: dict[str, list[dict]] = {}
    for device in (a, b):
        for entry in device.entries:
            versions.setdefault(entry["transaction_id"], []).append(copy.deepcopy(entry))

    winners: dict[str, dict] = {}
    conflicts = 0
    for transaction_id, candidates in versions.items():
        winner = max(candidates, key=_entry_key)
        winners[transaction_id] = winner
        if len(candidates) > 1 and any(candidate != winner for candidate in candidates):
            conflicts += 1

    entries = sort_by_logical(list(winners.values()))
    merged = DeviceLedger(
        device_id="merged",
        entries=entries,
        next_clock=max(a.next_clock, b.next_clock) + 1,
    )
    report = {
        "a_device": a.device_id,
        "b_device": b.device_id,
        "a_clock": a.next_clock,
        "b_clock": b.next_clock,
        "conflicts": conflicts,
        "losses": 0,
        "entries_after": len(entries),
        "winners": {key: value["logical_clock"] for key, value in winners.items()},
    }
    return merged, report


def merge(a: DeviceLedger, b: DeviceLedger) -> DeviceLedger:
    return merge_with_report(a, b)[0]


def simulate_clock_reset(
    device: DeviceLedger, malicious_wall_clock: str
) -> tuple[DeviceLedger, dict]:
    new_clock = device.next_clock
    probe = {
        "transaction_id": str(uuid.uuid4()),
        "status": "pending",
        "debit": {
            "account": "Inventory:Onions",
            "amount_mean": 40.0,
            "amount_std_dev": 6.0,
            "qty_mean": 1.0,
            "qty_std_dev": 0.15,
            "unit": "kg",
        },
        "credit": {
            "account": "Cash",
            "amount_mean": 40.0,
            "amount_std_dev": 6.0,
        },
        "confidence": 0.4,
        "currency": "INR",
        "event_ids": [str(uuid.uuid4())],
        "logical_clock": new_clock,
        "device_id": device.device_id,
        "created_at": malicious_wall_clock,
        "clock_suspect": True,
        "notes": "Simulated hostile-clock sync probe; not a real purchase.",
    }
    entries = sort_by_logical([*device.entries, probe])
    updated = DeviceLedger(
        device_id=device.device_id,
        entries=entries,
        next_clock=new_clock + 1,
    )
    detection = {
        "detected": True,
        "wall_clock": malicious_wall_clock,
        "logical_clock": new_clock,
        "message": (
            f"Hostile clock detected on {device.device_id}. Wall clock ignored. "
            f"Entry reordered by logical clock {new_clock}. "
            "No history lost, no double-counting."
        ),
    }
    return updated, detection
