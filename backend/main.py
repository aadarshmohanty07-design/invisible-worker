"""Mock backend for the Invisible Worker demo.

Runs as a local FastAPI server that the Flutter app calls over Wi-Fi.
All successful responses are validated against schemas.json before they
leave the process, so the frontend is always talking to contract-valid data.

OCR/audio extraction is mocked, but the Monte Carlo fusion, Dirichlet loss,
uncertainty propagation and CRDT merge are real, reproducible simulations.
The contracts and the seed story are real.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import math
import random
import re
import statistics
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import BaseModel, ConfigDict, Field

from . import crdt_sim, store

# ---------------------------------------------------------------------------
# Schema loading and response validation
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas.json"
FRONTEND_DIR = ROOT / "frontend"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
DEFS = SCHEMA["$defs"]

CONTRACT_TYPES = (
    "TransactionEvent",
    "LedgerEntry",
    "LossDistribution",
    "ProfitSummary",
    "RecipeBurnRate",
    "CustomerCredit",
    "LexiconEntry",
    "DeviceSyncState",
    "MergeResult",
    "ClockResetResult",
    "EntryExplanation",
    "DailyTruth",
)


def _make_validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        {
            "$schema": SCHEMA["$schema"],
            "$id": SCHEMA["$id"],
            "$defs": DEFS,
            "$ref": f"#/$defs/{name}",
        },
        format_checker=FormatChecker(),
    )


VALIDATORS = {name: _make_validator(name) for name in CONTRACT_TYPES}


def validate(name: str, payload: dict) -> dict:
    errors = sorted(VALIDATORS[name].iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        detail = "; ".join(f"{list(e.path)}: {e.message}" for e in errors)
        raise RuntimeError(f"{name} contract violation: {detail}")
    return payload


def validate_many(name: str, payloads: list[dict]) -> list[dict]:
    for payload in payloads:
        validate(name, payload)
    return payloads


# ---------------------------------------------------------------------------
# Time helpers. Wall clocks are untrusted; logical clocks are authoritative.
# ---------------------------------------------------------------------------

IST = timezone(timedelta(hours=5, minutes=30))
SCHEMA_VERSION = "1.0.0"
MALICIOUS_CLOCK = "1970-01-01T00:00:00+05:30"


def now_ist() -> datetime:
    return datetime.now(IST)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return dt.astimezone(IST).replace(microsecond=0).isoformat()


def parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return dt


def is_suspect_wall_clock(value: str) -> bool:
    dt = parse_iso(value)
    return dt.year < 2000 or dt > now_ist() + timedelta(hours=24)


def business_date_from(events: list[dict]) -> str:
    trusted = [parse_iso(e["wall_clock"]) for e in events if not is_suspect_wall_clock(e["wall_clock"])]
    chosen = trusted[0] if trusted else now_ist()
    return chosen.astimezone(IST).date().isoformat()


# ---------------------------------------------------------------------------
# Seed story
# ---------------------------------------------------------------------------

AUDIO_EVENT_ID = "3f1b9c2e-5a4d-4f7a-8b6e-1c2d3e4f5a6b"
OCR_EVENT_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"
STOCK_EVENT_ID = "7c6b5a4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d"
SALE_EVENT_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
CREDIT_EVENT_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"
PENDING_AUDIO_ID = "4c5d6e7f-8a9b-4c1d-9e2f-3a4b5c6d7e8f"
PENDING_SMS_ID = "5d6e7f8a-9b0c-4d2e-8f3a-4b5c6d7e8f9a"

CANONICAL_TX_ID = "b7e6d5c4-3a2f-4e1d-9c8b-7a6f5e4d3c2b"
SALE_TX_ID = "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b"
CREDIT_TX_ID = "f2a3b4c5-d6e7-4f8a-9b0c-1d2e3f4a5b6c"
LOSS_ID = "d4c3b2a1-0f9e-4d8c-8b7a-6f5e4d3c2b1a"

SEED_EVENTS: dict[str, dict] = {
    AUDIO_EVENT_ID: {
        "event_id": AUDIO_EVENT_ID,
        "device_id": "device-a",
        "source": "audio",
        "raw_text": "Bhai 3 kilo tamatar liya 180 mein... Sharma ji ka 40 jama kar, aur 7 plate poha de.",
        "wall_clock": "2026-10-25T09:14:00+05:30",
        "logical_clock": 42,
        "confidence": 0.85,
        "currency": "INR",
        "language": "hi-IN",
        "lexicon_id": "lex-v3",
        "media_ref": "file:///data/user/0/app/evidence/audio_0914.m4a",
        "extracted_entities": [
            {
                "item": "tamatar",
                "qty": 3.0,
                "unit": "kg",
                "price": 180.0,
                "confidence": 0.88,
                "raw_span": {"start": 5, "end": 33},
            }
        ],
    },
    OCR_EVENT_ID: {
        "event_id": OCR_EVENT_ID,
        "device_id": "device-b",
        "source": "ocr",
        "raw_text": "TOMATO 3 KG 180\nONION 2 KG",
        "wall_clock": "1970-01-01T00:00:00+05:30",
        "logical_clock": 17,
        "confidence": 0.62,
        "currency": "INR",
        "media_ref": "file:///data/user/0/app/evidence/slip_0042.jpg",
        "extracted_entities": [
            {"item": "tomato", "qty": 3.0, "unit": "kg", "price": 180.0, "confidence": 0.9},
            {"item": "onion", "qty": 2.0, "unit": "kg", "price": None, "confidence": 0.3},
        ],
    },
    STOCK_EVENT_ID: {
        "event_id": STOCK_EVENT_ID,
        "device_id": "device-c",
        "source": "manual",
        "raw_text": "Stock count 21:00 - tomatoes 2.1 kg on hand",
        "wall_clock": "2026-10-25T21:00:00+05:30",
        "logical_clock": 39,
        "confidence": 0.9,
        "currency": "INR",
        "extracted_entities": [
            {"item": "tomatoes", "qty": 2.1, "unit": "kg", "price": None}
        ],
    },
    SALE_EVENT_ID: {
        "event_id": SALE_EVENT_ID,
        "device_id": "device-a",
        "source": "manual",
        "raw_text": "7 plate poha at 80 each = 560",
        "wall_clock": "2026-10-25T10:05:00+05:30",
        "logical_clock": 44,
        "confidence": 0.93,
        "currency": "INR",
        "extracted_entities": [
            {"item": "poha", "qty": 7.0, "unit": "plate", "price": 560.0}
        ],
    },
    CREDIT_EVENT_ID: {
        "event_id": CREDIT_EVENT_ID,
        "device_id": "device-c",
        "source": "sms",
        "raw_text": "Sharma ji ka 40 jama ho gaya",
        "wall_clock": "2026-10-25T18:20:00+05:30",
        "logical_clock": 40,
        "confidence": 0.9,
        "currency": "INR",
        "extracted_entities": [],
    },
    PENDING_AUDIO_ID: {
        "event_id": PENDING_AUDIO_ID,
        "device_id": "device-b",
        "source": "audio",
        "raw_text": "Do kilo pyaz chalis mein",
        "wall_clock": "2026-10-25T17:40:00+05:30",
        "logical_clock": 45,
        "confidence": 0.8,
        "currency": "INR",
        "language": "hi-IN",
        "extracted_entities": [
            {"item": "pyaz", "qty": 2.0, "unit": "kilo", "price": 40.0}
        ],
    },
    PENDING_SMS_ID: {
        "event_id": PENDING_SMS_ID,
        "device_id": "device-c",
        "source": "sms",
        "raw_text": "2 kg onion 40",
        "wall_clock": "2026-10-25T17:42:00+05:30",
        "logical_clock": 41,
        "confidence": 0.88,
        "currency": "INR",
        "extracted_entities": [
            {"item": "onion", "qty": 2.0, "unit": "kg", "price": 40.0}
        ],
    },
}

SEED_LEDGER: dict[str, dict] = {
    CANONICAL_TX_ID: {
        "transaction_id": CANONICAL_TX_ID,
        "status": "fused",
        "debit": {
            "account": "Inventory:Tomatoes",
            "amount_mean": 180.0,
            "amount_std_dev": 25.0,
            "qty_mean": 3.0,
            "qty_std_dev": 0.4,
            "unit": "kg",
        },
        "credit": {
            "account": "Cash",
            "amount_mean": 180.0,
            "amount_std_dev": 25.0,
        },
        "confidence": 0.82,
        "currency": "INR",
        "event_ids": [AUDIO_EVENT_ID, OCR_EVENT_ID],
        "logical_clock": 43,
        "device_id": "device-a",
        "business_date": "2026-10-25",
        "created_at": "2026-10-25T09:16:20+05:30",
        "clock_suspect": True,
    },
    SALE_TX_ID: {
        "transaction_id": SALE_TX_ID,
        "status": "posted",
        "debit": {
            "account": "Cash",
            "amount_mean": 560.0,
            "amount_std_dev": 0.0,
        },
        "credit": {
            "account": "Sales:Poha",
            "amount_mean": 560.0,
            "amount_std_dev": 0.0,
        },
        "confidence": 0.93,
        "currency": "INR",
        "event_ids": [SALE_EVENT_ID],
        "logical_clock": 44,
        "device_id": "device-a",
        "business_date": "2026-10-25",
        "created_at": "2026-10-25T10:05:20+05:30",
    },
    CREDIT_TX_ID: {
        "transaction_id": CREDIT_TX_ID,
        "status": "posted",
        "debit": {
            "account": "Cash",
            "amount_mean": 40.0,
            "amount_std_dev": 0.0,
        },
        "credit": {
            "account": "Udhaar:Sharma ji",
            "amount_mean": 40.0,
            "amount_std_dev": 0.0,
        },
        "confidence": 0.9,
        "currency": "INR",
        "event_ids": [CREDIT_EVENT_ID],
        "logical_clock": 40,
        "device_id": "device-c",
        "business_date": "2026-10-25",
        "created_at": "2026-10-25T18:20:20+05:30",
    },
}

SEED_LOSSES: dict[str, dict] = {
    LOSS_ID: {
        "loss_distribution_id": LOSS_ID,
        "account": "Inventory:Tomatoes",
        "period": {
            "start": "2026-10-25T00:00:00+05:30",
            "end": "2026-10-26T00:00:00+05:30",
        },
        "currency": "INR",
        "qty_lost": {"mean": 0.9, "std_dev": 0.25, "unit": "kg"},
        "value_lost": {
            "mean": 54.0,
            "std_dev": 15.0,
            "q05": 29.3,
            "q50": 54.0,
            "q95": 78.7,
        },
        "components": [
            {
                "cause": "spoilage",
                "share_mean": 0.55,
                "share_std_dev": 0.078,
                "driver": "34C heat and 9h unrefrigerated; tomatoes lose about 8% per day.",
            },
            {
                "cause": "theft",
                "share_mean": 0.2,
                "share_std_dev": 0.063,
                "driver": "4 fewer plate-sales than expected, yet no stock remained on hand.",
            },
            {
                "cause": "personal_consumption",
                "share_mean": 0.25,
                "share_std_dev": 0.068,
                "driver": "Household meals draw from the same tomato stock.",
            },
        ],
        "covariates": {
            "temperature_c": 34.0,
            "humidity_pct": 71.0,
            "hours_unrefrigerated": 9.0,
            "hours_since_receipt": 12.3,
            "sales_units_observed": 40.0,
            "expected_sales_units": 44.0,
        },
        "allocation": {"family": "dirichlet", "alpha": [22.0, 8.0, 10.0]},
        "confidence": 0.71,
        "evidence_event_ids": [AUDIO_EVENT_ID, OCR_EVENT_ID, STOCK_EVENT_ID],
        "method": "dirichlet_bayesian",
        "computed_at": "2026-10-25T21:30:00+05:30",
        "model_version": "loss-attribution-v1.0",
        "explanation": "Spoilage dominates: 34C heat and 9h unrefrigerated, plus 4 fewer plate-sales than expected.",
    }
}

SEED_PROFIT: dict = {
    "revenue_mean": 2400.0,
    "revenue_std_dev": 160.0,
    "cogs_mean": 1146.0,
    "cogs_std_dev": 80.0,
    "loss_mean": 54.0,
    "loss_std_dev": 15.0,
    "profit_mean": 1200.0,
    "profit_std_dev": 180.0,
    "time_period": "2026-10-25",
}

SEED_CREDITS: list[dict] = [
    {"customer_alias": "Sharma ji", "balance_mean": 160.0, "balance_std_dev": 25.0, "confidence": 0.78},
    {"customer_alias": "Ramesh", "balance_mean": 40.0, "balance_std_dev": 12.0, "confidence": 0.62},
    {"customer_alias": "Anita", "balance_mean": 0.0, "balance_std_dev": 5.0, "confidence": 0.51},
]

SEED_RECIPES: list[dict] = [
    {
        "dish_name": "Poha",
        "ingredient_name": "Rice flakes",
        "qty_per_plate_mean": 0.0525,
        "qty_per_plate_std_dev": 0.0075,
        "unit": "kg",
        "confidence": 0.72,
        "explanation": "About 2.1 kg +/- 0.3 kg per 40 plates, inferred from 84 kg purchased vs. 1,600 plates sold over 20 days.",
    },
    {
        "dish_name": "Poha",
        "ingredient_name": "Onions",
        "qty_per_plate_mean": 0.00875,
        "qty_per_plate_std_dev": 0.002,
        "unit": "kg",
        "confidence": 0.64,
        "explanation": "About 0.35 kg +/- 0.08 kg per 40 plates, inferred from raw-material burn and stock counts.",
    },
    {
        "dish_name": "Poha",
        "ingredient_name": "Oil",
        "qty_per_plate_mean": 0.0225,
        "qty_per_plate_std_dev": 0.00375,
        "unit": "L",
        "confidence": 0.66,
        "explanation": "About 0.9 L +/- 0.15 L per 40 plates, inferred from purchases and plate sales.",
    },
    {
        "dish_name": "Poha",
        "ingredient_name": "Tomatoes",
        "qty_per_plate_mean": 0.015,
        "qty_per_plate_std_dev": 0.005,
        "unit": "kg",
        "confidence": 0.61,
        "explanation": "About 0.6 kg +/- 0.2 kg per 40 plates; weaker estimate because tomatoes are also used at home.",
    },
    {
        "dish_name": "Chai",
        "ingredient_name": "Milk",
        "qty_per_plate_mean": 0.045,
        "qty_per_plate_std_dev": 0.00625,
        "unit": "L",
        "confidence": 0.7,
        "explanation": "About 1.8 L +/- 0.25 L per 40 cups, inferred from daily milk purchases vs. cups sold.",
    },
    {
        "dish_name": "Chai",
        "ingredient_name": "Sugar",
        "qty_per_plate_mean": 0.0125,
        "qty_per_plate_std_dev": 0.0025,
        "unit": "kg",
        "confidence": 0.68,
        "explanation": "About 0.5 kg +/- 0.1 kg per 40 cups, inferred from sugar purchases and cup sales.",
    },
]

SEED_DEVICES: dict[str, dict] = {
    "device-a": {
        "device_id": "device-a",
        "status": "online",
        "last_merged_logical_clock": 44,
        "conflicts_resolved": 0,
    },
    "device-b": {
        "device_id": "device-b",
        "status": "offline",
        "last_merged_logical_clock": 43,
        "conflicts_resolved": 1,
    },
    "device-c": {
        "device_id": "device-c",
        "status": "syncing",
        "last_merged_logical_clock": 40,
        "conflicts_resolved": 3,
    },
}

SEED_LEXICON: list[dict] = [
    {"local_term": "jama kar", "corrected_meaning": "Record as Customer Credit (Udhaar)", "category": "credit", "version": 1},
    {"local_term": "udhaar", "corrected_meaning": "Customer credit (money owed by a customer)", "category": "credit", "version": 1},
    {"local_term": "kharida", "corrected_meaning": "Purchase", "category": "purchase", "version": 1},
    {"local_term": "peti", "corrected_meaning": "Crate (24 kg)", "category": "unit", "version": 1},
    {"local_term": "tamatar", "corrected_meaning": "Tomato", "category": "item", "version": 1},
    {"local_term": "poha", "corrected_meaning": "Flattened rice dish", "category": "item", "version": 1},
    {"local_term": "chai", "corrected_meaning": "Tea", "category": "item", "version": 1},
]


# ---------------------------------------------------------------------------
# SQLite-backed state and reset
# ---------------------------------------------------------------------------

LOCK = threading.Lock()
EVENTS: dict[str, dict] = {}
LEDGER: dict[str, dict] = {}
LOSSES: dict[str, dict] = {}
DEVICES: dict[str, dict] = {}
LEXICON: list[dict] = []
CREDITS: list[dict] = []
RECIPES: list[dict] = []
STATE = {"next_clock": 100}
CRDT_STATE: dict[str, crdt_sim.DeviceLedger] = {}


def _next_clock_from(events: dict[str, dict]) -> int:
    return max([100] + [event["logical_clock"] + 1 for event in events.values()])


def _reload_from_db() -> None:
    EVENTS.clear()
    EVENTS.update(store.load_events())
    LEDGER.clear()
    LEDGER.update(store.load_ledger())
    LOSSES.clear()
    LOSSES.update(store.load_losses())
    DEVICES.clear()
    DEVICES.update(store.load_devices())
    LEXICON.clear()
    LEXICON.extend(store.load_lexicon())
    CREDITS.clear()
    CREDITS.extend(copy.deepcopy(SEED_CREDITS))
    RECIPES.clear()
    RECIPES.extend(copy.deepcopy(SEED_RECIPES))
    STATE["next_clock"] = _next_clock_from(EVENTS)


def _stale_canonical(device_id: str, logical_clock: int, confidence: float) -> dict:
    entry = copy.deepcopy(SEED_LEDGER[CANONICAL_TX_ID])
    entry.update(
        {
            "status": "pending",
            "confidence": confidence,
            "event_ids": [OCR_EVENT_ID],
            "logical_clock": logical_clock,
            "device_id": device_id,
            "created_at": "2026-10-25T09:15:00+05:30",
            "clock_suspect": True,
        }
    )
    entry["debit"]["amount_std_dev"] = 30.0
    entry["credit"]["amount_std_dev"] = 30.0
    return validate("LedgerEntry", entry)


def _stale_credit(device_id: str, logical_clock: int) -> dict:
    entry = copy.deepcopy(SEED_LEDGER[CREDIT_TX_ID])
    entry.update(
        {
            "status": "pending",
            "confidence": 0.55,
            "event_ids": [CREDIT_EVENT_ID],
            "logical_clock": logical_clock,
            "device_id": device_id,
            "created_at": "2026-10-25T18:19:00+05:30",
        }
    )
    entry["debit"]["amount_std_dev"] = 10.0
    entry["credit"]["amount_std_dev"] = 10.0
    return validate("LedgerEntry", entry)


def _init_crdt_state() -> None:
    current = [copy.deepcopy(entry) for entry in LEDGER.values()]
    replicas = {device_id: copy.deepcopy(current) for device_id in DEVICES}

    if "device-b" in replicas:
        replicas["device-b"] = [
            entry for entry in replicas["device-b"] if entry["transaction_id"] != CANONICAL_TX_ID
        ]
        replicas["device-b"].append(_stale_canonical("device-b", 17, 0.62))
        replicas["device-b"] = [
            entry for entry in replicas["device-b"] if entry["transaction_id"] != CREDIT_TX_ID
        ]
        replicas["device-b"].append(_stale_credit("device-b", 39))

    if "device-c" in replicas:
        replicas["device-c"] = [
            entry for entry in replicas["device-c"] if entry["transaction_id"] != CANONICAL_TX_ID
        ]
        replicas["device-c"].append(_stale_canonical("device-c", 39, 0.70))

    CRDT_STATE.clear()
    for device_id, entries in replicas.items():
        ordered = crdt_sim.sort_by_logical(entries)
        max_clock = max([0] + [entry["logical_clock"] for entry in ordered])
        last_merged = DEVICES.get(device_id, {}).get("last_merged_logical_clock", 0)
        CRDT_STATE[device_id] = crdt_sim.DeviceLedger(
            device_id=device_id,
            entries=ordered,
            next_clock=max(max_clock, last_merged) + 1,
        )


def _reconcile_crdt_with_ledger() -> None:
    if not CRDT_STATE:
        _init_crdt_state()
        return

    ledger_entries = [copy.deepcopy(entry) for entry in LEDGER.values()]
    ledger_max = max([0] + [entry["logical_clock"] for entry in ledger_entries])
    for device_id, device in CRDT_STATE.items():
        existing = {entry["transaction_id"] for entry in device.entries}
        for entry in ledger_entries:
            if entry["transaction_id"] in existing:
                continue
            author = entry.get("device_id")
            if author == device_id or author not in CRDT_STATE:
                device.entries.append(copy.deepcopy(entry))
                existing.add(entry["transaction_id"])
        device.entries = crdt_sim.sort_by_logical(device.entries)
        device.next_clock = max(device.next_clock, ledger_max + 1)


def _device_label(device_id: str) -> str:
    suffix = device_id.rsplit("-", 1)[-1]
    return f"Device {suffix.upper()}" if len(suffix) == 1 else f"Device {device_id}"


def _count_label(count: int, singular: str, plural: str | None = None) -> str:
    noun = singular if count == 1 else (plural or f"{singular}s")
    return f"{count} {noun}"


def _merge_report_line(
    left_label: str,
    left_clock: int,
    right_label: str,
    right_clock: int,
    report: dict,
) -> str:
    return (
        f"{left_label} (clock {left_clock}) merged with {right_label} (clock {right_clock}): "
        f"{_count_label(report['conflicts'], 'conflict')}, "
        f"{_count_label(report['losses'], 'loss', 'losses')}"
    )


def _adopt_merged_state(merged: crdt_sim.DeviceLedger, total_conflicts: int, clock_reset_target: str | None = None) -> None:
    for device in CRDT_STATE.values():
        device.entries = copy.deepcopy(merged.entries)
        device.next_clock = merged.next_clock

    for device_id, device in DEVICES.items():
        device["status"] = "online"
        device["last_merged_logical_clock"] = merged.next_clock - 1
        device["conflicts_resolved"] += total_conflicts
        if device_id == clock_reset_target:
            device["conflicts_resolved"] += 1
        store.save_device(device)

    for entry in merged.entries:
        LEDGER[entry["transaction_id"]] = copy.deepcopy(entry)
        store.save_ledger_entry(entry)


def _sorted_devices() -> list[dict]:
    return copy.deepcopy(sorted(DEVICES.values(), key=lambda device: device["device_id"]))


def reset_state() -> None:
    """Restore the demo database and caches to their initial seed state."""
    with LOCK:
        store.reset_db(SEED_EVENTS, SEED_LEDGER, SEED_LOSSES, SEED_LEXICON, SEED_DEVICES)
        _reload_from_db()
        _init_crdt_state()


# Fail fast if the seed story itself drifts from the contract.
validate_many("TransactionEvent", list(SEED_EVENTS.values()))
validate_many("LedgerEntry", list(SEED_LEDGER.values()))
validate_many("LossDistribution", list(SEED_LOSSES.values()))
validate("ProfitSummary", SEED_PROFIT)
validate_many("CustomerCredit", SEED_CREDITS)
validate_many("RecipeBurnRate", SEED_RECIPES)
validate_many("DeviceSyncState", list(SEED_DEVICES.values()))
validate_many("LexiconEntry", SEED_LEXICON)

store.init_db()
store.seed_if_empty(SEED_EVENTS, SEED_LEDGER, SEED_LOSSES, SEED_LEXICON, SEED_DEVICES)
_reload_from_db()
_init_crdt_state()


# ---------------------------------------------------------------------------
# Mock extraction helpers
# ---------------------------------------------------------------------------

HINDI_NUMBERS = {
    "ek": 1,
    "do": 2,
    "teen": 3,
    "char": 4,
    "paanch": 5,
    "chhah": 6,
    "saat": 7,
    "aath": 8,
    "nau": 9,
    "das": 10,
    "bees": 20,
    "chalis": 40,
    "pachaas": 50,
    "sau": 100,
    "hazaar": 1000,
}

ITEM_ALIASES = {
    "tamatar": "Tomatoes",
    "tomato": "Tomatoes",
    "tomatoes": "Tomatoes",
    "pyaz": "Onions",
    "onion": "Onions",
    "onions": "Onions",
    "aloo": "Potatoes",
    "potato": "Potatoes",
    "potatoes": "Potatoes",
    "poha": "Poha",
    "chai": "Chai",
    "milk": "Milk",
    "sugar": "Sugar",
    "rice": "Rice",
    "oil": "Oil",
    "atta": "Flour",
    "flour": "Flour",
}

DEFAULT_PRICE = {
    "Tomatoes": 60.0,
    "Onions": 40.0,
    "Potatoes": 30.0,
    "Poha": 80.0,
    "Chai": 15.0,
    "Milk": 55.0,
    "Sugar": 45.0,
    "Rice": 50.0,
    "Oil": 140.0,
    "Flour": 40.0,
}

UNIT_ALIASES = {
    "kg": "kg",
    "kilo": "kg",
    "kilos": "kg",
    "g": "g",
    "gram": "g",
    "grams": "g",
    "l": "L",
    "litre": "L",
    "liter": "L",
    "litres": "L",
    "liters": "L",
    "ml": "ml",
    "plate": "plate",
    "plates": "plate",
    "cup": "cup",
    "cups": "cup",
    "dozen": "dozen",
    "peti": "peti",
    "piece": "piece",
    "pieces": "piece",
    "pcs": "piece",
}

QTY_RE = re.compile(
    r"(?<!\d)(\d+(?:\.\d+)?)\s*"
    r"(kg|kilos?|g|grams?|litres?|liters?|l|ml|plates?|cups?|dozen|peti|pieces?|pcs)\b",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])")


def normalize_demo_numbers(text: str) -> str:
    """Small convenience so the 1970 demo can understand 'do kilo ... chalis'."""
    normalized = text
    for word, number in HINDI_NUMBERS.items():
        normalized = re.sub(rf"\b{re.escape(word)}\b", str(number), normalized, flags=re.IGNORECASE)
    return normalized


def find_item(text: str) -> tuple[str | None, str | None]:
    lower = text.lower()
    best: tuple[int, str] | None = None
    for alias in ITEM_ALIASES:
        index = lower.find(alias)
        if index < 0:
            continue
        if best is None or index < best[0] or (index == best[0] and len(alias) > len(best[1])):
            best = (index, alias)
    if best is None:
        return None, None
    index, alias = best
    return text[index : index + len(alias)], ITEM_ALIASES[alias]


def extract_entities(raw_text: str) -> list[dict]:
    normalized = normalize_demo_numbers(raw_text)
    lines = [line.strip() for line in normalized.splitlines() if line.strip()] or [normalized]
    entities: list[dict] = []

    for line in lines:
        qty_match = QTY_RE.search(line)
        qty = float(qty_match.group(1)) if qty_match else 1.0
        unit = qty_match.group(2) if qty_match else "unit"

        rest = line
        if qty_match:
            rest = line[: qty_match.start()] + " " + line[qty_match.end() :]

        item_token, _canonical = find_item(line)
        numbers = NUMBER_RE.findall(rest)
        price = float(numbers[0]) if numbers else None

        if item_token is None and price is None:
            continue

        entities.append(
            {
                "item": item_token or "unknown item",
                "qty": qty,
                "unit": unit,
                "price": price,
            }
        )

    return entities


def confidence_for(source: str, entities: list[dict], override: float | None) -> float:
    if override is not None:
        return round(override, 2)

    base = {"audio": 0.85, "ocr": 0.62, "sms": 0.78, "manual": 0.93}[source]
    if not entities:
        base -= 0.25
    elif any(entity["price"] is None for entity in entities):
        base -= 0.08
    if any(entity["item"] == "unknown item" for entity in entities):
        base -= 0.2
    return round(max(0.05, min(0.99, base)), 2)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class RawSpanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: int = Field(ge=0)
    end: int = Field(ge=0)


class EntityIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item: str = Field(min_length=1, max_length=120)
    qty: float = Field(gt=0)
    unit: str = Field(min_length=1, max_length=32)
    price: float | None = Field(default=None, ge=0)
    confidence: float | None = Field(default=None, ge=0, le=1)
    raw_span: RawSpanIn | None = None


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["audio", "ocr", "sms", "manual"]
    raw_text: str = Field(default="", max_length=20000)
    device_id: str = Field(default="device-a", min_length=1, max_length=64)
    wall_clock: datetime | None = None
    logical_clock: int | None = Field(default=None, ge=0)
    confidence: float | None = Field(default=None, ge=0, le=1)
    currency: str = Field(default="INR", pattern=r"^[A-Z]{3}$")
    language: str | None = Field(default=None, max_length=35)
    media_ref: str | None = Field(default=None, max_length=2048)
    lexicon_id: str | None = Field(default=None, min_length=1, max_length=64)
    extracted_entities: list[EntityIn] | None = None
    event_id: uuid.UUID | None = None


class FuseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_ids: list[uuid.UUID] = Field(min_length=1)
    device_id: str | None = Field(default=None, min_length=1, max_length=64)


class SyncIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_ids: list[str] | None = None


class ClockSimIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(default="device-b", min_length=1, max_length=64)


class LexiconIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    local_term: str = Field(min_length=1, max_length=120)
    corrected_meaning: str = Field(min_length=1, max_length=280)
    category: Literal["credit", "purchase", "unit", "item"]


# ---------------------------------------------------------------------------
# Helpers that build contract-valid records
# ---------------------------------------------------------------------------


def entity_to_dict(entity: EntityIn) -> dict:
    result = {
        "item": entity.item,
        "qty": entity.qty,
        "unit": entity.unit,
        "price": entity.price,
    }
    if entity.confidence is not None:
        result["confidence"] = entity.confidence
    if entity.raw_span is not None:
        result["raw_span"] = entity.raw_span.model_dump()
    return result


def build_event(payload: EventIn) -> dict:
    if payload.extracted_entities is None:
        entities = extract_entities(payload.raw_text)
    else:
        entities = [entity_to_dict(entity) for entity in payload.extracted_entities]

    wall_clock = payload.wall_clock or now_ist()
    if wall_clock.tzinfo is None:
        wall_clock = wall_clock.replace(tzinfo=IST)

    if payload.logical_clock is not None:
        logical_clock = payload.logical_clock
        STATE["next_clock"] = max(STATE["next_clock"], logical_clock + 1)
    else:
        logical_clock = STATE["next_clock"]
        STATE["next_clock"] += 1

    event = {
        "event_id": str(payload.event_id or uuid.uuid4()),
        "device_id": payload.device_id,
        "source": payload.source,
        "raw_text": payload.raw_text,
        "wall_clock": iso(wall_clock),
        "logical_clock": logical_clock,
        "confidence": confidence_for(payload.source, entities, payload.confidence),
        "currency": payload.currency,
        "extracted_entities": entities,
    }
    for key in ("language", "media_ref", "lexicon_id"):
        value = getattr(payload, key)
        if value is not None:
            event[key] = value

    return validate("TransactionEvent", event)


def canonical_account(item: str | None) -> str:
    return f"Inventory:{item or 'Unknown'}"


def _simulation_seed(event_ids: list[str]) -> int:
    key = "invisible-worker:" + "|".join(sorted(event_ids))
    return int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big")


def _ordered_events(events: list[dict]) -> list[dict]:
    return sorted(events, key=lambda event: (event["logical_clock"], event["device_id"], event["event_id"]))


def _item_key(item: str) -> str:
    return ITEM_ALIASES.get(item.lower(), item.lower())


def _simulate_fusion(event_ids: list[str], events: list[dict]) -> dict:
    """Run the 10k-draw Monte Carlo and return both the fused stats and its evidence."""
    ordered = _ordered_events(events)
    primary_event = next((event for event in ordered if event["extracted_entities"]), ordered[0])
    primary_entity = next(
        (line for line in primary_event["extracted_entities"] if line.get("price") is not None),
        primary_event["extracted_entities"][0] if primary_event["extracted_entities"] else None,
    )
    confidences = [event["confidence"] for event in ordered]
    mean_confidence = sum(confidences) / len(confidences)

    sources: list[dict] = []
    primary_source: dict | None = None
    account = "Inventory:Unknown"
    unit = "unit"

    if primary_entity is not None:
        primary_key = _item_key(primary_entity["item"])
        canonical_item = ITEM_ALIASES.get(primary_entity["item"].lower())
        account = canonical_account(canonical_item)
        unit = UNIT_ALIASES.get(primary_entity["unit"].lower(), primary_entity["unit"])

        for event in ordered:
            match = None
            for line in event["extracted_entities"]:
                if _item_key(line["item"]) != primary_key:
                    continue
                if match is None or (match.get("price") is None and line.get("price") is not None):
                    match = line
                if line.get("price") is not None:
                    break
            if match is None:
                continue

            qty = float(match["qty"])
            if match.get("price") is not None:
                price = float(match["price"])
                unit_price = price / qty if qty > 0 else 0.0
                price_cv = 0.12
            else:
                unit_price = DEFAULT_PRICE.get(ITEM_ALIASES.get(match["item"].lower()) or "", 60.0)
                price_cv = 0.36

            source = {
                "event_id": event["event_id"],
                "source": event["source"],
                "device_id": event["device_id"],
                "confidence": event["confidence"],
                "wall_clock": event["wall_clock"],
                "logical_clock": event["logical_clock"],
                "clock_suspect": is_suspect_wall_clock(event["wall_clock"]),
                "item": match["item"],
                "qty": qty,
                "unit": match["unit"],
                "price": match.get("price"),
                "unit_price": round(unit_price, 4),
                "price_cv": price_cv,
            }
            sources.append(source)
            if event is primary_event and match is primary_entity:
                primary_source = source

        if primary_source is None and sources:
            primary_source = sources[0]

    if not sources:
        confidence = mean_confidence - 0.08 if len(event_ids) == 1 else mean_confidence
        confidence = round(max(0.3, min(0.97, confidence)), 2)
        return {
            "amount_mean": 100.0,
            "amount_std_dev": 50.0,
            "qty_mean": 1.0,
            "qty_std_dev": 0.5,
            "unit": "unit",
            "account": "Inventory:Unknown",
            "has_entity": False,
            "sources": [],
            "per_source": {},
            "disagreement": 0.0,
            "price_spread_pct": 0.0,
            "std_multiplier": 1.0,
            "verdict": "single_source",
            "mean_source_confidence": round(mean_confidence, 3),
            "confidence": confidence,
            "confidence_adjustment": round(confidence - mean_confidence, 2),
        }

    seed = _simulation_seed(event_ids)
    rng = random.Random(seed)
    amount_samples: list[float] = []
    source_samples: list[list[float]] = [[] for _ in sources]
    qty_samples: list[float] = []

    for _ in range(10_000):
        for index, source in enumerate(sources):
            qty_sim = rng.gauss(source["qty"], source["qty"] * 0.15)
            price_sim = rng.gauss(source["unit_price"], source["unit_price"] * source["price_cv"])
            qty_sim = max(0.0, qty_sim)
            price_sim = max(0.0, price_sim)
            line_total = qty_sim * price_sim
            amount_samples.append(line_total)
            source_samples[index].append(line_total)
            if source is primary_source:
                qty_samples.append(qty_sim)

    amount_mean = statistics.fmean(amount_samples)
    amount_std = statistics.stdev(amount_samples)
    qty_mean = statistics.fmean(qty_samples) if qty_samples else primary_source["qty"]
    qty_std = statistics.stdev(qty_samples) if len(qty_samples) > 1 else qty_mean * 0.15

    per_source = {}
    for index, source in enumerate(sources):
        per_source[source["event_id"]] = {
            "amount_mean": round(statistics.fmean(source_samples[index]), 2),
            "amount_std_dev": round(statistics.stdev(source_samples[index]), 2),
        }

    unit_prices = [source["unit_price"] for source in sources]
    if len(unit_prices) >= 2:
        low = min(unit_prices)
        high = max(unit_prices)
        if low > 0:
            disagreement = (high - low) / low
        elif high > 0:
            disagreement = 1.0
        else:
            disagreement = 0.0
    else:
        disagreement = 0.0

    if len(event_ids) >= 2 and len(sources) >= 2:
        if disagreement < 0.15:
            std_multiplier = 0.85
            verdict = "agree"
            confidence = mean_confidence
        else:
            std_multiplier = 1.0 + min(1.0, disagreement)
            verdict = "disagree"
            confidence = mean_confidence - 0.5 * disagreement
    else:
        std_multiplier = 1.0
        verdict = "single_source"
        confidence = mean_confidence - 0.08 if len(event_ids) == 1 else mean_confidence

    confidence = round(max(0.3, min(0.97, confidence)), 2)
    return {
        "amount_mean": round(amount_mean, 2),
        "amount_std_dev": round(amount_std * std_multiplier, 2),
        "qty_mean": round(qty_mean, 3),
        "qty_std_dev": round(max(0.0, qty_std), 3),
        "unit": unit,
        "account": account,
        "has_entity": True,
        "sources": sources,
        "per_source": per_source,
        "disagreement": disagreement,
        "price_spread_pct": round(disagreement * 100, 2),
        "std_multiplier": round(std_multiplier, 4),
        "verdict": verdict,
        "mean_source_confidence": round(mean_confidence, 3),
        "confidence": confidence,
        "confidence_adjustment": round(confidence - mean_confidence, 2),
    }


def build_fused_entry(event_ids: list[str], events: list[dict], device_id: str | None) -> dict:
    simulation = _simulate_fusion(event_ids, events)
    amount = simulation["amount_mean"]
    amount_std = simulation["amount_std_dev"]
    suspect = any(is_suspect_wall_clock(event["wall_clock"]) for event in events)
    clock = max(event["logical_clock"] for event in events) + 1
    tx_key = "invisible-worker:" + "|".join(sorted(event_ids))

    debit = {
        "account": simulation["account"],
        "amount_mean": amount,
        "amount_std_dev": amount_std,
    }
    if simulation["has_entity"]:
        debit["qty_mean"] = simulation["qty_mean"]
        debit["qty_std_dev"] = simulation["qty_std_dev"]
        debit["unit"] = simulation["unit"]
    credit = {
        "account": "Cash",
        "amount_mean": amount,
        "amount_std_dev": amount_std,
    }

    entry = {
        "transaction_id": str(uuid.uuid5(uuid.NAMESPACE_URL, tx_key)),
        "status": "fused" if len(event_ids) >= 2 else "pending",
        "debit": debit,
        "credit": credit,
        "confidence": simulation["confidence"],
        "currency": events[0]["currency"],
        "event_ids": event_ids,
        "logical_clock": clock,
        "device_id": device_id or events[0]["device_id"],
        "business_date": business_date_from(events),
        "created_at": iso(now_ist()),
        "clock_suspect": suspect,
    }
    return validate("LedgerEntry", entry)


def compute_profit_summary() -> dict:
    summary = copy.deepcopy(SEED_PROFIT)
    summary["profit_mean"] = round(
        summary["revenue_mean"] - summary["cogs_mean"] - summary["loss_mean"], 2
    )
    summary["profit_std_dev"] = round(
        math.sqrt(
            summary["revenue_std_dev"] ** 2
            + summary["cogs_std_dev"] ** 2
            + summary["loss_std_dev"] ** 2
        ),
        2,
    )
    return validate("ProfitSummary", summary)


def compute_loss_distribution(loss: dict) -> dict:
    result = copy.deepcopy(loss)
    alpha = result["allocation"]["alpha"]
    rng = random.Random(
        int.from_bytes(hashlib.sha256(result["loss_distribution_id"].encode("utf-8")).digest()[:8], "big")
    )
    # TODO Phase 6: update alpha from observed covariates.
    draws = 10_000
    sums = [0.0] * len(alpha)
    sums_sq = [0.0] * len(alpha)

    for _ in range(draws):
        gammas = [rng.gammavariate(value, 1.0) for value in alpha]
        total = sum(gammas)
        shares = [value / total for value in gammas]
        for index, share in enumerate(shares):
            sums[index] += share
            sums_sq[index] += share * share

    means = [value / draws for value in sums]
    if abs(sum(means) - 1.0) > 0.001:
        raise RuntimeError("Dirichlet sample means do not form a probability simplex")

    stds = []
    for index, mean in enumerate(means):
        variance = max(0.0, (sums_sq[index] - draws * mean * mean) / (draws - 1))
        stds.append(min(0.5, math.sqrt(variance)))

    for component, mean, std in zip(result["components"], means, stds):
        component["share_mean"] = round(mean, 4)
        component["share_std_dev"] = round(std, 4)

    value_lost = result["value_lost"]
    value_lost["q05"] = round(value_lost["mean"] - 1.645 * value_lost["std_dev"], 2)
    value_lost["q50"] = round(value_lost["mean"], 2)
    value_lost["q95"] = round(value_lost["mean"] + 1.645 * value_lost["std_dev"], 2)
    return validate("LossDistribution", result)


def _ledger_fingerprint(entries: list[dict]) -> str:
    ordered = sorted(
        entries,
        key=lambda entry: (entry["logical_clock"], entry["device_id"], entry["transaction_id"]),
    )
    payload = json.dumps(ordered, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _explanation_narrative(entry: dict, simulation: dict, canonical_fallback: bool) -> str:
    parts: list[str] = []
    if canonical_fallback:
        parts.append("This canonical entry is pinned to the demo seed for rehearsal reliability.")
    if simulation["sources"]:
        count = len(simulation["sources"])
        if simulation["verdict"] == "agree":
            parts.append(
                f"{count} independent sources agree on the unit price, so fusion applies a 15% range discount."
            )
        elif simulation["verdict"] == "disagree":
            parts.append(
                f"The sources disagree by {simulation['price_spread_pct']:.1f}% on the unit price, "
                f"so the range widens by {simulation['std_multiplier']:.2f}x and confidence drops."
            )
        else:
            parts.append("Only one priced source is available, so no cross-source discount applies.")
        suspect_sources = [source["source"] for source in simulation["sources"] if source["clock_suspect"]]
        if suspect_sources:
            parts.append(
                f"A suspect wall clock from {', '.join(sorted(set(suspect_sources)))} is used as evidence "
                "but ignored for ordering."
            )
    else:
        parts.append("No priced entity was found, so the entry uses the conservative fallback range.")

    parts.append(
        f"Stored value: ₹{entry['debit']['amount_mean']:.2f} ± ₹{entry['debit']['amount_std_dev']:.2f}; "
        f"live Monte Carlo: ₹{simulation['amount_mean']:.2f} ± ₹{simulation['amount_std_dev']:.2f} "
        f"at confidence {simulation['confidence']:.2f}."
    )
    if canonical_fallback:
        parts.append("The simulated values show the real math behind the pinned seed.")
    return " ".join(parts)


def build_daily_truth(entries: list[dict], events: list[dict], losses: list[dict]) -> dict:
    purchase = next((entry for entry in entries if entry["transaction_id"] == CANONICAL_TX_ID), None)
    if purchase is None:
        purchase = next(
            (entry for entry in entries if entry["debit"]["account"] == "Inventory:Tomatoes"),
            None,
        )
    if purchase is None or not purchase["debit"].get("qty_mean"):
        raise HTTPException(status_code=409, detail="Tomato purchase evidence is missing")

    purchased_qty = float(purchase["debit"]["qty_mean"])
    unit_cost = float(purchase["debit"]["amount_mean"]) / purchased_qty
    unit = purchase["debit"].get("unit", "kg")
    item = purchase["debit"]["account"].split(":", 1)[-1]

    sale_event = next((event for event in events if event["event_id"] == SALE_EVENT_ID), None)
    sale_qty = 0.0
    if sale_event and sale_event["extracted_entities"]:
        sale_qty = float(sale_event["extracted_entities"][0]["qty"])

    recipe = next(
        (
            value
            for value in SEED_RECIPES
            if value["dish_name"].lower() == "poha"
            and value["ingredient_name"].lower() == "tomatoes"
        ),
        None,
    )
    if recipe is None:
        raise HTTPException(status_code=409, detail="Poha tomato recipe is missing")
    consumed_qty = sale_qty * recipe["qty_per_plate_mean"]

    stock_event = next((event for event in events if event["event_id"] == STOCK_EVENT_ID), None)
    counted_qty = 0.0
    if stock_event and stock_event["extracted_entities"]:
        counted_qty = float(stock_event["extracted_entities"][0]["qty"])

    loss = next((value for value in losses if value["loss_distribution_id"] == LOSS_ID), None)
    if loss is None:
        raise HTTPException(status_code=409, detail="Loss distribution is missing")
    computed_loss = compute_loss_distribution(loss)
    summary = compute_profit_summary()

    expected_qty = purchased_qty - consumed_qty
    missing_qty = max(0.0, expected_qty - counted_qty)
    missing_value = missing_qty * unit_cost
    modeled_qty_mean = loss["qty_lost"]["mean"]
    modeled_qty_std = loss["qty_lost"]["std_dev"]
    consistent = abs(missing_qty - modeled_qty_mean) <= modeled_qty_std

    evidence_ids: list[str] = []
    for event_id in [*purchase["event_ids"], STOCK_EVENT_ID, SALE_EVENT_ID]:
        if event_id not in evidence_ids:
            evidence_ids.append(event_id)

    components = computed_loss["components"]
    largest = max(components, key=lambda component: component["share_mean"])
    personal = next(
        (component for component in components if component["cause"] == "personal_consumption"),
        None,
    )
    actions = [
        f"{largest['cause'].replace('_', ' ').title()} is the largest driver "
        f"({largest['share_mean'] * 100:.0f}% of the modelled loss). {largest['driver']}"
    ]
    if personal is not None:
        actions.append(
            f"Confirm about {personal['share_mean'] * modeled_qty_mean:.2f} kg of household use with the family."
        )
    actions.append(
        "The physical gap is within 1 sigma of the model; no large theft signal."
        if consistent
        else "The physical gap is outside the model's 1 sigma band; recheck the stock count."
    )

    source_mix = {"audio": 0, "ocr": 0, "sms": 0, "manual": 0}
    for event in events:
        source_mix[event["source"]] += 1

    narrative = (
        f"You bought {purchased_qty:.3g} kg of {item.lower()}; {sale_qty:.0f} poha plates use "
        f"{consumed_qty:.3f} kg by recipe. Expected on hand is {expected_qty:.3f} kg, but "
        f"{counted_qty:.3f} kg was counted, so {missing_qty:.3f} kg (₹{missing_value:.2f}) is missing. "
        f"The model expects {modeled_qty_mean:.2f} ± {modeled_qty_std:.2f} kg, so the count is "
        f"{'consistent' if consistent else 'not consistent'} with the model. True profit after hidden loss is "
        f"₹{summary['profit_mean']:.2f} ± ₹{summary['profit_std_dev']:.2f}."
    )

    payload = {
        "business_date": summary["time_period"],
        "profit": summary,
        "loss_components": components,
        "reconciliation": {
            "item": item,
            "unit": unit,
            "purchased_qty": round(purchased_qty, 3),
            "consumed_qty": round(consumed_qty, 3),
            "expected_on_hand_qty": round(expected_qty, 3),
            "counted_qty": round(counted_qty, 3),
            "missing_qty": round(missing_qty, 3),
            "unit_cost": round(unit_cost, 2),
            "missing_value": round(missing_value, 2),
            "modeled_loss_qty_mean": modeled_qty_mean,
            "modeled_loss_qty_std_dev": modeled_qty_std,
            "modeled_loss_value_mean": loss["value_lost"]["mean"],
            "modeled_loss_value_std_dev": loss["value_lost"]["std_dev"],
            "consistent_within_1_sigma": consistent,
            "evidence_event_ids": evidence_ids,
            "method": "purchase quantity minus recipe consumption vs physical stock count",
        },
        "waterfall": [
            {
                "label": "Revenue",
                "amount_mean": summary["revenue_mean"],
                "amount_std_dev": summary["revenue_std_dev"],
            },
            {
                "label": "Less: COGS",
                "amount_mean": -summary["cogs_mean"],
                "amount_std_dev": summary["cogs_std_dev"],
            },
            {
                "label": "Less: hidden loss",
                "amount_mean": -summary["loss_mean"],
                "amount_std_dev": summary["loss_std_dev"],
            },
            {
                "label": "True profit",
                "amount_mean": summary["profit_mean"],
                "amount_std_dev": summary["profit_std_dev"],
            },
        ],
        "evidence_summary": {
            "total_events": len(events),
            "fused_entries": sum(1 for entry in entries if entry["status"] == "fused"),
            "single_source_entries": sum(1 for entry in entries if len(entry["event_ids"]) == 1),
            "average_confidence": round(
                sum(entry["confidence"] for entry in entries) / len(entries), 3
            )
            if entries
            else 0.0,
            "suspect_clock_events": sum(
                1 for event in events if is_suspect_wall_clock(event["wall_clock"])
            ),
            "hostile_clock_recoveries": sum(
                1 for entry in entries if "hostile-clock" in entry.get("notes", "").lower()
            ),
            "source_mix": source_mix,
        },
        "actions": actions,
        "narrative": narrative,
        "ledger_fingerprint": _ledger_fingerprint(entries),
    }
    return validate("DailyTruth", payload)


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Invisible Worker Mock API",
    version=SCHEMA_VERSION,
    description=(
        "Mock backend for the CASCADE '26 Invisible Worker demo. "
        "Successful responses are validated against schemas.json. "
        "Wall clocks are untrusted; ordering uses logical clocks."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "invisible-worker-mock",
        "version": SCHEMA_VERSION,
        "schema": str(SCHEMA_PATH.name),
    }


@app.post("/events", response_model=None)
def create_event(payload: EventIn) -> dict:
    with LOCK:
        event = build_event(payload)
        store.save_event(event)
        EVENTS[event["event_id"]] = copy.deepcopy(event)
    return event


@app.get("/events", response_model=None)
def list_events(pending: bool = Query(default=False, description="Only return raw events not yet used in any ledger entry.")) -> list[dict]:
    with LOCK:
        events = copy.deepcopy(list(EVENTS.values()))
        used = {event_id for entry in LEDGER.values() for event_id in entry["event_ids"]}
    if pending:
        events = [event for event in events if event["event_id"] not in used]
    events.sort(key=lambda event: (event["logical_clock"], event["device_id"], event["event_id"]))
    return validate_many("TransactionEvent", events)


@app.post("/fuse", response_model=None)
async def fuse(payload: FuseIn) -> dict:
    await asyncio.sleep(0.2)  # pretend the probabilistic engine is thinking

    event_ids: list[str] = []
    for raw_id in payload.event_ids:
        event_id = str(raw_id)
        if event_id not in event_ids:
            event_ids.append(event_id)

    with LOCK:
        events = []
        for event_id in event_ids:
            if event_id not in EVENTS:
                raise HTTPException(status_code=404, detail=f"Unknown event_id: {event_id}")
            events.append(copy.deepcopy(EVENTS[event_id]))

        canonical_ids = {AUDIO_EVENT_ID, OCR_EVENT_ID}
        # Canonical demo fallback. Real Monte Carlo path below.
        if set(event_ids) == canonical_ids:
            entry = copy.deepcopy(SEED_LEDGER[CANONICAL_TX_ID])
            entry["event_ids"] = event_ids
            validate("LedgerEntry", entry)
        else:
            entry = build_fused_entry(event_ids, events, payload.device_id)

        store.save_ledger_entry(entry)
        LEDGER[entry["transaction_id"]] = copy.deepcopy(entry)

    return entry


@app.get("/ledger", response_model=None)
def list_ledger() -> list[dict]:
    with LOCK:
        entries = copy.deepcopy(list(LEDGER.values()))
    entries.sort(key=lambda entry: (entry["logical_clock"], entry["device_id"], entry["transaction_id"]))
    return validate_many("LedgerEntry", entries)


@app.get("/ledger/{transaction_id}/explain", response_model=None)
def explain_ledger_entry(transaction_id: str) -> dict:
    with LOCK:
        entry = copy.deepcopy(LEDGER.get(transaction_id))
        events = (
            [copy.deepcopy(EVENTS[event_id]) for event_id in entry["event_ids"] if event_id in EVENTS]
            if entry is not None
            else []
        )

    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown transaction_id: {transaction_id}")
    if len(events) != len(entry["event_ids"]):
        raise HTTPException(status_code=404, detail="One or more source events are missing")

    simulation = _simulate_fusion(entry["event_ids"], events)
    canonical_fallback = transaction_id == CANONICAL_TX_ID and set(entry["event_ids"]) == {
        AUDIO_EVENT_ID,
        OCR_EVENT_ID,
    }
    sources = [
        {
            "event_id": source["event_id"],
            "source": source["source"],
            "device_id": source["device_id"],
            "confidence": source["confidence"],
            "wall_clock": source["wall_clock"],
            "clock_suspect": source["clock_suspect"],
            "logical_clock": source["logical_clock"],
            "item": source["item"],
            "qty": source["qty"],
            "unit": source["unit"],
            "price": source["price"],
            "unit_price": source["unit_price"],
        }
        for source in simulation["sources"]
    ]
    per_source_ranges = [
        {
            "event_id": source["event_id"],
            "source": source["source"],
            "amount_mean": simulation["per_source"][source["event_id"]]["amount_mean"],
            "amount_std_dev": simulation["per_source"][source["event_id"]]["amount_std_dev"],
        }
        for source in simulation["sources"]
    ]
    result = {
        "transaction_id": entry["transaction_id"],
        "status": entry["status"],
        "amount_mean": entry["debit"]["amount_mean"],
        "amount_std_dev": entry["debit"]["amount_std_dev"],
        "confidence": entry["confidence"],
        "sources": sources,
        "agreement": {
            "verdict": simulation["verdict"],
            "price_spread_pct": simulation["price_spread_pct"],
            "std_multiplier": simulation["std_multiplier"],
            "confidence_adjustment": simulation["confidence_adjustment"],
            "mean_source_confidence": simulation["mean_source_confidence"],
            "method": "relative unit-price spread; 15% agreement threshold",
        },
        "per_source_ranges": per_source_ranges,
        "canonical_fallback": canonical_fallback,
        "simulated_amount_mean": simulation["amount_mean"],
        "simulated_amount_std_dev": simulation["amount_std_dev"],
        "simulated_confidence": simulation["confidence"],
        "evidence_event_ids": entry["event_ids"],
        "narrative": _explanation_narrative(entry, simulation, canonical_fallback),
    }
    return validate("EntryExplanation", result)


@app.get("/summary", response_model=None)
def get_summary() -> dict:
    return compute_profit_summary()


@app.get("/loss", response_model=None)
def list_losses() -> list[dict]:
    with LOCK:
        losses = copy.deepcopy(list(LOSSES.values()))
    return validate_many("LossDistribution", [compute_loss_distribution(loss) for loss in losses])


@app.get("/truth/daily", response_model=None)
def daily_truth() -> dict:
    with LOCK:
        entries = copy.deepcopy(list(LEDGER.values()))
        events = copy.deepcopy(list(EVENTS.values()))
        losses = copy.deepcopy(list(LOSSES.values()))
    return build_daily_truth(entries, events, losses)


@app.get("/credits", response_model=None)
def list_credits() -> list[dict]:
    with LOCK:
        credits = copy.deepcopy(CREDITS)
    return validate_many("CustomerCredit", credits)


@app.get("/recipes", response_model=None)
def list_recipes() -> list[dict]:
    with LOCK:
        recipes = copy.deepcopy(RECIPES)
    return validate_many("RecipeBurnRate", recipes)


@app.get("/devices", response_model=None)
def list_devices() -> list[dict]:
    with LOCK:
        devices = copy.deepcopy(list(DEVICES.values()))
    return validate_many("DeviceSyncState", devices)


@app.post("/sync", response_model=None)
def sync_devices(payload: SyncIn | None = None) -> dict:
    """Merge the full three-device network. device_ids is accepted but ignored for a coherent result."""
    with LOCK:
        _reconcile_crdt_with_ledger()
        device_a = CRDT_STATE["device-a"]
        device_b = CRDT_STATE["device-b"]
        device_c = CRDT_STATE["device-c"]
        a_clock, b_clock, c_clock = device_a.next_clock, device_b.next_clock, device_c.next_clock

        merged_ab, report_ab = crdt_sim.merge_with_report(device_a, device_b)
        merged, report_final = crdt_sim.merge_with_report(merged_ab, device_c)
        total_conflicts = report_ab["conflicts"] + report_final["conflicts"]

        _adopt_merged_state(merged, total_conflicts)

        merge_log = [
            _merge_report_line(
                _device_label("device-a"), a_clock, _device_label("device-b"), b_clock, report_ab
            ),
            _merge_report_line(
                "Merged result", merged_ab.next_clock, _device_label("device-c"), c_clock, report_final
            ),
            f"Final: {len(CRDT_STATE)} devices, {len(merged.entries)} total entries, "
            f"{_count_label(total_conflicts, 'conflict')} resolved",
        ]
        result = {
            "devices": _sorted_devices(),
            "merge_log": merge_log,
            "ledger_after_merge": crdt_sim.sort_by_logical(merged.entries),
            "conflicts_resolved": total_conflicts,
        }
    return validate("MergeResult", result)


@app.post("/simulate-clock", response_model=None)
def simulate_clock(payload: ClockSimIn | None = None) -> dict:
    target = payload.device_id if payload else "device-b"
    with LOCK:
        if target not in DEVICES or target not in CRDT_STATE:
            raise HTTPException(status_code=404, detail=f"Unknown device_id: {target}")

        _reconcile_crdt_with_ledger()
        device = CRDT_STATE[target]
        ledger_max = max([0] + [entry["logical_clock"] for entry in LEDGER.values()])
        if device.next_clock <= ledger_max:
            device.next_clock = ledger_max + 1

        before_ids = {entry["transaction_id"] for entry in LEDGER.values()}
        updated_device, detection = crdt_sim.simulate_clock_reset(device, MALICIOUS_CLOCK)
        CRDT_STATE[target] = updated_device

        probe = next(
            entry
            for entry in updated_device.entries
            if entry["logical_clock"] == detection["logical_clock"]
            and str(entry.get("notes", "")).startswith("Simulated hostile-clock")
        )
        probe_event = {
            "event_id": probe["event_ids"][0],
            "device_id": target,
            "source": "manual",
            "raw_text": "Simulated hostile-clock probe: 1 kg onion 40",
            "wall_clock": MALICIOUS_CLOCK,
            "logical_clock": max(0, detection["logical_clock"] - 1),
            "confidence": 0.4,
            "currency": "INR",
            "extracted_entities": [
                {"item": "onion", "qty": 1.0, "unit": "kg", "price": 40.0}
            ],
        }
        validate("TransactionEvent", probe_event)

        device_a = CRDT_STATE["device-a"]
        device_b = CRDT_STATE["device-b"]
        device_c = CRDT_STATE["device-c"]
        a_clock, b_clock, c_clock = device_a.next_clock, device_b.next_clock, device_c.next_clock
        merged_ab, report_ab = crdt_sim.merge_with_report(device_a, device_b)
        merged, report_final = crdt_sim.merge_with_report(merged_ab, device_c)
        total_conflicts = report_ab["conflicts"] + report_final["conflicts"]

        _adopt_merged_state(merged, total_conflicts, clock_reset_target=target)
        store.save_event(probe_event)
        EVENTS[probe_event["event_id"]] = copy.deepcopy(probe_event)
        STATE["next_clock"] = max(STATE["next_clock"], probe_event["logical_clock"] + 1)

        final_ids = {entry["transaction_id"] for entry in merged.entries}
        history_preserved = before_ids.issubset(final_ids)
        lost_count = len(before_ids - final_ids)
        merge_log = [
            f"{_device_label(target)} wall clock {MALICIOUS_CLOCK} is implausible; "
            f"logical clock {detection['logical_clock']} assigned.",
            _merge_report_line(
                _device_label("device-a"), a_clock, _device_label("device-b"), b_clock, report_ab
            ),
            _merge_report_line(
                "Merged result", merged_ab.next_clock, _device_label("device-c"), c_clock, report_final
            ),
            f"Final: {len(merged.entries)} entries in logical-clock order; "
            f"{_count_label(lost_count, 'transaction')} lost.",
        ]
        result = {
            "device_id": target,
            "detected_wall_clock": MALICIOUS_CLOCK,
            "logical_clock_used": detection["logical_clock"],
            "history_preserved": history_preserved,
            "message": detection["message"],
            "merge_log": merge_log,
            "ledger_after_merge": crdt_sim.sort_by_logical(merged.entries),
        }
    return validate("ClockResetResult", result)


@app.post("/lexicon/teach", response_model=None)
def teach_word(payload: LexiconIn) -> dict:
    with LOCK:
        versions = [
            entry["version"]
            for entry in LEXICON
            if entry["local_term"].lower() == payload.local_term.lower()
        ]
        entry = {
            "local_term": payload.local_term,
            "corrected_meaning": payload.corrected_meaning,
            "category": payload.category,
            "version": max(versions, default=0) + 1,
        }
        validate("LexiconEntry", entry)
        store.save_lexicon_entry(entry)
        LEXICON.append(entry)
        result = copy.deepcopy(entry)
    return result


@app.get("/lexicon", response_model=None)
def list_lexicon() -> list[dict]:
    with LOCK:
        entries = copy.deepcopy(LEXICON)
    return validate_many("LexiconEntry", entries)


@app.post("/demo/reset", response_model=None)
def demo_reset() -> list[dict]:
    """Restore the seeded demo state so a rehearsal can be replayed."""
    reset_state()
    return list_ledger()


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    return RedirectResponse(url="/ui/")


if FRONTEND_DIR.is_dir():
    app.mount("/ui", StaticFiles(directory=FRONTEND_DIR, html=True), name="ui")
