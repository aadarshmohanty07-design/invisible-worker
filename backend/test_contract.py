"""Contract tests for the Invisible Worker mock API.

Every successful endpoint response is validated against the matching
definition in schemas.json. The demo state is reset before each test so
mutating endpoints (fuse, sync, teach) cannot leak into one another.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker

from backend.main import (
    AUDIO_EVENT_ID,
    CANONICAL_TX_ID,
    OCR_EVENT_ID,
    PENDING_AUDIO_ID,
    PENDING_SMS_ID,
    app,
    reset_state,
)

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "schemas.json").read_text(encoding="utf-8"))
DEFS = SCHEMA["$defs"]
FORMAT_CHECKER = FormatChecker()


def validator_for(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        {
            "$schema": SCHEMA["$schema"],
            "$id": SCHEMA["$id"],
            "$defs": DEFS,
            "$ref": f"#/$defs/{name}",
        },
        format_checker=FORMAT_CHECKER,
    )


def assert_valid(name: str, payload: dict) -> None:
    errors = sorted(validator_for(name).iter_errors(payload), key=lambda error: list(error.path))
    assert not errors, (
        f"{name} response is not contract-valid:\n"
        + "\n".join(f"- {list(error.path)}: {error.message}" for error in errors)
    )


def assert_valid_list(name: str, payload: list[dict]) -> None:
    assert isinstance(payload, list), f"expected a list, got {type(payload).__name__}"
    for index, item in enumerate(payload):
        try:
            assert_valid(name, item)
        except AssertionError as exc:
            raise AssertionError(f"{name}[{index}] failed:\n{exc}") from exc


def assert_balanced(entry: dict) -> None:
    debit = entry["debit"]
    credit = entry["credit"]
    assert abs(debit["amount_mean"] - credit["amount_mean"]) <= 0.01
    assert abs(debit["amount_std_dev"] - credit["amount_std_dev"]) <= 0.01
    assert debit["account"] != credit["account"]


client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_demo_state() -> None:
    reset_state()
    yield


# ---------------------------------------------------------------------------
# Schema file itself
# ---------------------------------------------------------------------------


def test_schema_is_valid_2020_12() -> None:
    Draft202012Validator.check_schema(SCHEMA)


def test_every_schema_example_validates() -> None:
    checked = 0
    for name, definition in DEFS.items():
        for index, example in enumerate(definition.get("examples", [])):
            errors = sorted(validator_for(name).iter_errors(example), key=lambda error: list(error.path))
            assert not errors, (
                f"{name} example {index} invalid:\n"
                + "\n".join(f"- {list(error.path)}: {error.message}" for error in errors)
            )
            checked += 1
    assert checked >= 9


# ---------------------------------------------------------------------------
# Operational
# ---------------------------------------------------------------------------


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == "1.0.0"


def test_demo_ui_is_served() -> None:
    response = client.get("/ui/")
    assert response.status_code == 200
    assert "Invisible Worker" in response.text
    assert "app.js" in response.text


def test_root_redirects_to_demo_ui() -> None:
    response = client.get("/", follow_redirects=False)
    assert response.status_code in (307, 308)
    assert response.headers["location"] == "/ui/"


# ---------------------------------------------------------------------------
# Raw events
# ---------------------------------------------------------------------------


def test_create_audio_event_extracts_tomatoes() -> None:
    response = client.post(
        "/events",
        json={
            "source": "audio",
            "raw_text": "Bhai 3 kilo tamatar liya 180 mein",
            "device_id": "device-a",
            "wall_clock": "2026-10-25T09:14:00+05:30",
            "logical_clock": 42,
            "confidence": 0.85,
            "language": "hi-IN",
        },
    )
    assert response.status_code == 200, response.text
    event = response.json()
    assert_valid("TransactionEvent", event)
    assert event["currency"] == "INR"
    assert event["extracted_entities"][0]["item"] == "tamatar"
    assert event["extracted_entities"][0]["qty"] == 3.0
    assert event["extracted_entities"][0]["price"] == 180.0
    assert event["wall_clock"].startswith("2026-10-25T09:14:00")


def test_create_event_understands_demo_hindi_numbers() -> None:
    response = client.post(
        "/events",
        json={"source": "audio", "raw_text": "Do kilo pyaz chalis mein", "device_id": "device-b"},
    )
    assert response.status_code == 200, response.text
    event = response.json()
    assert_valid("TransactionEvent", event)
    entity = event["extracted_entities"][0]
    assert entity["item"] == "pyaz"
    assert entity["qty"] == 2.0
    assert entity["unit"] == "kilo"
    assert entity["price"] == 40.0


def test_create_event_accepts_hostile_1970_clock() -> None:
    response = client.post(
        "/events",
        json={
            "source": "ocr",
            "raw_text": "TOMATO 3 KG 180",
            "device_id": "device-b",
            "wall_clock": "1970-01-01T00:00:00+05:30",
        },
    )
    assert response.status_code == 200, response.text
    event = response.json()
    assert_valid("TransactionEvent", event)
    assert event["wall_clock"].startswith("1970-01-01T00:00:00")


def test_list_pending_events_excludes_already_fused_evidence() -> None:
    response = client.get("/events", params={"pending": "true"})
    assert response.status_code == 200, response.text
    events = response.json()
    assert_valid_list("TransactionEvent", events)
    ids = {event["event_id"] for event in events}
    assert PENDING_AUDIO_ID in ids
    assert PENDING_SMS_ID in ids
    assert AUDIO_EVENT_ID not in ids
    assert OCR_EVENT_ID not in ids


def test_list_all_events_is_clock_ordered() -> None:
    response = client.get("/events")
    assert response.status_code == 200, response.text
    events = response.json()
    assert_valid_list("TransactionEvent", events)
    keys = [(event["logical_clock"], event["device_id"], event["event_id"]) for event in events]
    assert keys == sorted(keys)


# ---------------------------------------------------------------------------
# Fusion and ledger
# ---------------------------------------------------------------------------


def test_fuse_canonical_pair_returns_tomato_money_shot() -> None:
    response = client.post("/fuse", json={"event_ids": [AUDIO_EVENT_ID, OCR_EVENT_ID]})
    assert response.status_code == 200, response.text
    entry = response.json()
    assert_valid("LedgerEntry", entry)
    assert entry["transaction_id"] == CANONICAL_TX_ID
    assert entry["status"] == "fused"
    assert entry["clock_suspect"] is True
    assert set(entry["event_ids"]) == {AUDIO_EVENT_ID, OCR_EVENT_ID}
    assert entry["debit"]["account"] == "Inventory:Tomatoes"
    assert entry["debit"]["amount_mean"] == 180.0
    assert entry["debit"]["amount_std_dev"] == 25.0
    assert entry["credit"] == {
        "account": "Cash",
        "amount_mean": 180.0,
        "amount_std_dev": 25.0,
    }
    assert_balanced(entry)


def test_fuse_single_event_is_pending_and_valid() -> None:
    response = client.post("/fuse", json={"event_ids": [PENDING_AUDIO_ID]})
    assert response.status_code == 200, response.text
    entry = response.json()
    assert_valid("LedgerEntry", entry)
    assert entry["status"] == "pending"
    assert entry["event_ids"] == [PENDING_AUDIO_ID]
    assert entry["logical_clock"] > 45
    assert_balanced(entry)

    ledger = client.get("/ledger").json()
    assert any(item["transaction_id"] == entry["transaction_id"] for item in ledger)


def test_fuse_two_pending_events_is_fused_and_valid() -> None:
    response = client.post("/fuse", json={"event_ids": [PENDING_AUDIO_ID, PENDING_SMS_ID]})
    assert response.status_code == 200, response.text
    entry = response.json()
    assert_valid("LedgerEntry", entry)
    assert entry["status"] == "fused"
    assert set(entry["event_ids"]) == {PENDING_AUDIO_ID, PENDING_SMS_ID}
    assert entry["logical_clock"] > 45
    assert entry["clock_suspect"] is False
    assert_balanced(entry)


def test_fuse_unknown_event_returns_404() -> None:
    response = client.post("/fuse", json={"event_ids": [str(uuid.uuid4())]})
    assert response.status_code == 404


def test_ledger_contains_canonical_entry_and_balances() -> None:
    response = client.get("/ledger")
    assert response.status_code == 200, response.text
    entries = response.json()
    assert_valid_list("LedgerEntry", entries)
    assert any(entry["transaction_id"] == CANONICAL_TX_ID for entry in entries)
    for entry in entries:
        assert_balanced(entry)
        if entry["status"] == "fused":
            assert len(entry["event_ids"]) >= 2


# ---------------------------------------------------------------------------
# Dashboard, loss, recipes, credits, devices
# ---------------------------------------------------------------------------


def test_summary_is_valid_and_arithmetic_holds() -> None:
    response = client.get("/summary")
    assert response.status_code == 200, response.text
    summary = response.json()
    assert_valid("ProfitSummary", summary)
    expected = summary["revenue_mean"] - summary["cogs_mean"] - summary["loss_mean"]
    assert abs(summary["profit_mean"] - expected) <= 0.01
    assert summary["time_period"] == "2026-10-25"


def test_loss_distribution_is_valid_and_sums_to_one() -> None:
    response = client.get("/loss")
    assert response.status_code == 200, response.text
    losses = response.json()
    assert_valid_list("LossDistribution", losses)
    loss = losses[0]
    shares = [component["share_mean"] for component in loss["components"]]
    assert len(loss["components"]) == 3
    assert abs(sum(shares) - 1.0) <= 0.001
    assert len(loss["allocation"]["alpha"]) == 3
    assert set(component["cause"] for component in loss["components"]) == {
        "spoilage",
        "theft",
        "personal_consumption",
    }
    assert loss["value_lost"]["q05"] <= loss["value_lost"]["q50"] <= loss["value_lost"]["q95"]


def test_credits_are_valid() -> None:
    response = client.get("/credits")
    assert response.status_code == 200, response.text
    credits = response.json()
    assert_valid_list("CustomerCredit", credits)
    assert any(credit["customer_alias"] == "Sharma ji" for credit in credits)


def test_recipes_are_valid() -> None:
    response = client.get("/recipes")
    assert response.status_code == 200, response.text
    recipes = response.json()
    assert_valid_list("RecipeBurnRate", recipes)
    assert len(recipes) >= 4
    assert all(0 <= recipe["confidence"] <= 1 for recipe in recipes)


def test_devices_are_valid() -> None:
    response = client.get("/devices")
    assert response.status_code == 200, response.text
    devices = response.json()
    assert_valid_list("DeviceSyncState", devices)
    assert {device["device_id"] for device in devices} == {"device-a", "device-b", "device-c"}
    assert {device["status"] for device in devices} <= {"online", "offline", "syncing"}


# ---------------------------------------------------------------------------
# Sync and hostile clock
# ---------------------------------------------------------------------------


def test_sync_merges_all_devices_without_breaking_history() -> None:
    before_ledger = client.get("/ledger").json()
    ledger_clock = max(entry["logical_clock"] for entry in before_ledger)
    before_ids = {entry["transaction_id"] for entry in before_ledger}

    response = client.post("/sync")
    assert response.status_code == 200, response.text
    result = response.json()
    assert_valid("MergeResult", result)

    devices = result["devices"]
    assert_valid_list("DeviceSyncState", devices)
    assert all(device["status"] == "online" for device in devices)
    assert all(device["last_merged_logical_clock"] >= ledger_clock for device in devices)
    assert result["conflicts_resolved"] == 3

    after_ids = {entry["transaction_id"] for entry in result["ledger_after_merge"]}
    assert before_ids <= after_ids
    assert CANONICAL_TX_ID in after_ids
    assert_valid_list("LedgerEntry", result["ledger_after_merge"])
    for entry in result["ledger_after_merge"]:
        assert_balanced(entry)


def test_hostile_clock_recovery_returns_valid_device_state() -> None:
    before_devices = client.get("/devices").json()
    before = next(device for device in before_devices if device["device_id"] == "device-b")
    prior_max = max(entry["logical_clock"] for entry in client.get("/ledger").json())

    response = client.post("/simulate-clock", json={"device_id": "device-b"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert_valid("ClockResetResult", result)
    assert result["device_id"] == "device-b"
    assert result["detected_wall_clock"].startswith("1970-01-01T00:00:00")
    assert result["logical_clock_used"] > prior_max
    assert result["history_preserved"] is True
    assert str(result["logical_clock_used"]) in result["message"]
    assert len(result["merge_log"]) >= 3

    probe = next(
        entry for entry in result["ledger_after_merge"] if entry.get("created_at", "").startswith("1970")
    )
    assert probe["logical_clock"] == result["logical_clock_used"]
    assert probe["clock_suspect"] is True
    assert probe["device_id"] == "device-b"

    device = next(device for device in client.get("/devices").json() if device["device_id"] == "device-b")
    assert device["status"] == "online"
    assert device["conflicts_resolved"] >= before["conflicts_resolved"] + 1
    assert device["last_merged_logical_clock"] >= result["logical_clock_used"]

    ledger = client.get("/ledger").json()
    assert any(entry["transaction_id"] == probe["transaction_id"] for entry in ledger)
    canonical = next(entry for entry in ledger if entry["transaction_id"] == CANONICAL_TX_ID)
    assert canonical["clock_suspect"] is True
    assert_balanced(canonical)


def test_hostile_clock_unknown_device_returns_404() -> None:
    response = client.post("/simulate-clock", json={"device_id": "device-z"})
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Phase 5 — CRDT merge log, history preservation, reset
# ---------------------------------------------------------------------------


def test_sync_merge_log_explains_conflicts() -> None:
    response = client.post("/sync")
    assert response.status_code == 200, response.text
    result = response.json()
    assert_valid("MergeResult", result)
    assert result["conflicts_resolved"] == 3
    assert len(result["devices"]) == 3
    assert any("2 conflicts" in line for line in result["merge_log"])
    assert any("1 conflict" in line for line in result["merge_log"])
    assert any("0 losses" in line for line in result["merge_log"])
    assert result["merge_log"][-1].startswith("Final:")


def test_clock_reset_history_preserved() -> None:
    before = client.get("/ledger").json()
    before_ids = {entry["transaction_id"] for entry in before}

    response = client.post("/simulate-clock", json={"device_id": "device-b"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert_valid("ClockResetResult", result)
    assert result["history_preserved"] is True
    assert before_ids <= {entry["transaction_id"] for entry in result["ledger_after_merge"]}

    ledger = client.get("/ledger").json()
    keys = [(entry["logical_clock"], entry["device_id"], entry["transaction_id"]) for entry in ledger]
    assert keys == sorted(keys)
    probe = next(entry for entry in ledger if entry.get("created_at", "").startswith("1970"))
    assert ledger[0]["transaction_id"] != probe["transaction_id"]
    assert probe["logical_clock"] == result["logical_clock_used"]
    assert any(entry["transaction_id"] == probe["transaction_id"] for entry in result["ledger_after_merge"])


def test_demo_reset_rearms_crdt_and_clears_probe() -> None:
    simulated = client.post("/simulate-clock", json={"device_id": "device-b"}).json()
    probe_id = next(
        entry["transaction_id"]
        for entry in simulated["ledger_after_merge"]
        if entry.get("created_at", "").startswith("1970")
    )

    response = client.post("/demo/reset")
    assert response.status_code == 200, response.text
    ledger = response.json()
    assert probe_id not in {entry["transaction_id"] for entry in ledger}
    assert all(not entry.get("created_at", "").startswith("1970") for entry in ledger)

    synced = client.post("/sync").json()
    assert_valid("MergeResult", synced)
    assert synced["conflicts_resolved"] == 3


# ---------------------------------------------------------------------------
# Lexicon Drop
# ---------------------------------------------------------------------------


def test_teach_word_versions_and_lists() -> None:
    response = client.post(
        "/lexicon/teach",
        json={
            "local_term": "jama kar",
            "corrected_meaning": "Treat as repayment of customer credit",
            "category": "credit",
        },
    )
    assert response.status_code == 200, response.text
    entry = response.json()
    assert_valid("LexiconEntry", entry)
    assert entry["version"] == 2  # the seed already has version 1

    new_response = client.post(
        "/lexicon/teach",
        json={"local_term": "bhaji", "corrected_meaning": "Green leafy vegetable", "category": "item"},
    )
    assert new_response.status_code == 200, new_response.text
    new_entry = new_response.json()
    assert_valid("LexiconEntry", new_entry)
    assert new_entry["version"] == 1

    listed = client.get("/lexicon")
    assert listed.status_code == 200, listed.text
    entries = listed.json()
    assert_valid_list("LexiconEntry", entries)
    assert any(item["local_term"] == "bhaji" for item in entries)
    assert sum(1 for item in entries if item["local_term"] == "jama kar") >= 2


# ---------------------------------------------------------------------------
# Phase 4 — probabilistic math
# ---------------------------------------------------------------------------


def _post_event(
    source: str,
    *,
    raw_text: str = "",
    device_id: str = "device-a",
    entities: list[dict] | None = None,
    confidence: float | None = None,
) -> dict:
    payload: dict = {"source": source, "raw_text": raw_text, "device_id": device_id}
    if entities is not None:
        payload["extracted_entities"] = entities
    if confidence is not None:
        payload["confidence"] = confidence
    response = client.post("/events", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _fuse_pair(
    first_price: float,
    second_price: float,
    *,
    item: str = "onion",
    qty: float = 2.0,
    unit: str = "kg",
) -> dict:
    first = _post_event(
        "manual",
        entities=[{"item": item, "qty": qty, "unit": unit, "price": first_price}],
    )
    second = _post_event(
        "manual",
        device_id="device-b",
        entities=[{"item": item, "qty": qty, "unit": unit, "price": second_price}],
    )
    response = client.post("/fuse", json={"event_ids": [first["event_id"], second["event_id"]]})
    assert response.status_code == 200, response.text
    entry = response.json()
    assert_valid("LedgerEntry", entry)
    return entry


def test_real_path_fuses_canonical_content_without_seed_fallback() -> None:
    audio = _post_event(
        "audio",
        raw_text="Bhai 3 kilo tamatar liya 180 mein",
        confidence=0.85,
    )
    receipt = _post_event(
        "ocr",
        raw_text="TOMATO 3 KG 180",
        device_id="device-b",
        confidence=0.62,
    )

    response = client.post("/fuse", json={"event_ids": [audio["event_id"], receipt["event_id"]]})
    assert response.status_code == 200, response.text
    entry = response.json()
    assert_valid("LedgerEntry", entry)
    assert entry["transaction_id"] != CANONICAL_TX_ID
    assert entry["status"] == "fused"
    assert abs(entry["debit"]["amount_mean"] - 180.0) <= 10.0
    assert_balanced(entry)


def test_noisier_input_produces_wider_range() -> None:
    tight = _fuse_pair(100.0, 100.0)["debit"]["amount_std_dev"]
    loose = _fuse_pair(100.0, 140.0)["debit"]["amount_std_dev"]
    assert loose > tight * 1.5


def test_direct_debit_credit_balances_after_monte_carlo() -> None:
    pairs = [
        (100.0, 100.0, "onion", 2.0),
        (100.0, 140.0, "tomato", 3.0),
        (560.0, 560.0, "poha", 7.0),
    ]
    for first_price, second_price, item, qty in pairs:
        entry = _fuse_pair(first_price, second_price, item=item, qty=qty)
        assert entry["status"] == "fused"
        assert entry["debit"]["amount_mean"] > 0
        assert_balanced(entry)


def test_loss_is_live_dirichlet_and_seed_unchanged() -> None:
    from backend.main import LOSS_ID, SEED_LOSSES

    seed_components = json.loads(json.dumps(SEED_LOSSES[LOSS_ID]["components"]))
    response = client.get("/loss")
    assert response.status_code == 200, response.text
    losses = response.json()
    assert_valid_list("LossDistribution", losses)

    loss = losses[0]
    shares = [component["share_mean"] for component in loss["components"]]
    assert abs(sum(shares) - 1.0) <= 0.001
    for share, expected in zip(shares, [0.55, 0.20, 0.25]):
        assert abs(share - expected) < 0.02

    value = loss["value_lost"]
    assert abs(value["q50"] - 54.0) <= 0.01
    assert abs(value["q05"] - (54.0 - 1.645 * 15.0)) <= 0.01
    assert abs(value["q95"] - (54.0 + 1.645 * 15.0)) <= 0.01
    assert SEED_LOSSES[LOSS_ID]["components"] == seed_components

    again = client.get("/loss").json()[0]
    assert [component["share_mean"] for component in again["components"]] == shares


def test_summary_uses_quadrature_uncertainty() -> None:
    response = client.get("/summary")
    assert response.status_code == 200, response.text
    summary = response.json()
    assert_valid("ProfitSummary", summary)
    assert summary["profit_mean"] == 1200.0
    expected = (160.0**2 + 80.0**2 + 15.0**2) ** 0.5
    assert abs(summary["profit_std_dev"] - expected) <= 0.01


# ---------------------------------------------------------------------------
# Phase 4.5 — Trust Receipt and Daily Truth
# ---------------------------------------------------------------------------


def test_entry_explanation_matches_stored_math() -> None:
    entry = _fuse_pair(100.0, 100.0)
    response = client.get(f"/ledger/{entry['transaction_id']}/explain")
    assert response.status_code == 200, response.text
    explanation = response.json()
    assert_valid("EntryExplanation", explanation)

    assert explanation["canonical_fallback"] is False
    assert len(explanation["sources"]) == 2
    assert explanation["agreement"]["verdict"] == "agree"
    assert abs(explanation["simulated_amount_mean"] - entry["debit"]["amount_mean"]) <= 0.01
    assert abs(explanation["simulated_amount_std_dev"] - entry["debit"]["amount_std_dev"]) <= 0.01
    assert explanation["simulated_confidence"] == entry["confidence"]
    assert len(explanation["per_source_ranges"]) == 2
    assert all(item["amount_mean"] > 0 for item in explanation["per_source_ranges"])
    assert explanation["narrative"]


def test_entry_explanation_canonical_fallback_is_transparent() -> None:
    response = client.get(f"/ledger/{CANONICAL_TX_ID}/explain")
    assert response.status_code == 200, response.text
    explanation = response.json()
    assert_valid("EntryExplanation", explanation)

    assert explanation["canonical_fallback"] is True
    assert explanation["amount_mean"] == 180.0
    assert explanation["amount_std_dev"] == 25.0
    assert abs(explanation["simulated_amount_mean"] - 180.0) <= 10.0
    assert len(explanation["sources"]) == 2
    assert any(source["clock_suspect"] for source in explanation["sources"])
    assert "pinned" in explanation["narrative"].lower()


def test_entry_explanation_unknown_transaction_returns_404() -> None:
    response = client.get(f"/ledger/{uuid.uuid4()}/explain")
    assert response.status_code == 404


def test_daily_truth_reconciles_ghost_inventory() -> None:
    response = client.get("/truth/daily")
    assert response.status_code == 200, response.text
    truth = response.json()
    assert_valid("DailyTruth", truth)

    reconciliation = truth["reconciliation"]
    assert reconciliation["purchased_qty"] == 3.0
    assert abs(reconciliation["consumed_qty"] - 0.105) <= 0.001
    assert abs(reconciliation["expected_on_hand_qty"] - 2.895) <= 0.001
    assert reconciliation["counted_qty"] == 2.1
    assert abs(reconciliation["missing_qty"] - 0.795) <= 0.001
    assert reconciliation["unit_cost"] == 60.0
    assert reconciliation["missing_value"] == 47.7
    assert reconciliation["consistent_within_1_sigma"] is True

    assert truth["profit"]["profit_mean"] == 1200.0
    assert abs(truth["profit"]["profit_std_dev"] - 179.51) <= 0.01
    shares = [component["share_mean"] for component in truth["loss_components"]]
    assert abs(sum(shares) - 1.0) <= 0.001
    assert len(truth["waterfall"]) == 4
    running_total = sum(step["amount_mean"] for step in truth["waterfall"][:3])
    assert abs(running_total - truth["waterfall"][3]["amount_mean"]) <= 0.01
    assert len(truth["ledger_fingerprint"]) == 64
    assert truth["actions"]


def test_daily_truth_fingerprint_tracks_ledger() -> None:
    before = client.get("/truth/daily").json()
    _fuse_pair(100.0, 100.0)
    after = client.get("/truth/daily").json()

    assert before["ledger_fingerprint"] != after["ledger_fingerprint"]
    assert after["evidence_summary"]["fused_entries"] == before["evidence_summary"]["fused_entries"] + 1
