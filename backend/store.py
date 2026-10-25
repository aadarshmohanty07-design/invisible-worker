"""SQLite persistence for the Invisible Worker mock backend.

Each table stores one contract payload as JSON under the UUID primary key
defined in schemas.json. No extra data fields are invented. Auxiliary
records without a UUID (lexicon entries) use a composite natural key.

Set INVISIBLE_WORKER_DB to override the database path (used by tests).
"""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT / "data" / "invisible_worker.db"
DB_PATH = Path(os.environ.get("INVISIBLE_WORKER_DB", DEFAULT_DB_PATH))

TABLE_NAMES = (
    "raw_events",
    "ledger_entries",
    "loss_distributions",
    "lexicon_entries",
    "devices",
)

CREATE_SQL = (
    """
    CREATE TABLE IF NOT EXISTS raw_events (
        event_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ledger_entries (
        transaction_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS loss_distributions (
        loss_distribution_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS lexicon_entries (
        local_term TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (local_term, version)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
    )
    """,
)


@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _dumps(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _loads(payload: str) -> dict:
    return json.loads(payload)


def init_db() -> None:
    with connection() as conn:
        for sql in CREATE_SQL:
            conn.execute(sql)


def _count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def _insert_events(conn: sqlite3.Connection, events: dict[str, dict]) -> None:
    conn.executemany(
        "INSERT OR REPLACE INTO raw_events (event_id, payload) VALUES (?, ?)",
        [(event["event_id"], _dumps(event)) for event in events.values()],
    )


def _insert_ledger(conn: sqlite3.Connection, ledger: dict[str, dict]) -> None:
    conn.executemany(
        "INSERT OR REPLACE INTO ledger_entries (transaction_id, payload) VALUES (?, ?)",
        [(entry["transaction_id"], _dumps(entry)) for entry in ledger.values()],
    )


def _insert_losses(conn: sqlite3.Connection, losses: dict[str, dict]) -> None:
    conn.executemany(
        "INSERT OR REPLACE INTO loss_distributions (loss_distribution_id, payload) VALUES (?, ?)",
        [(loss["loss_distribution_id"], _dumps(loss)) for loss in losses.values()],
    )


def _insert_lexicon(conn: sqlite3.Connection, entries: list[dict]) -> None:
    conn.executemany(
        "INSERT OR REPLACE INTO lexicon_entries (local_term, version, payload) VALUES (?, ?, ?)",
        [(entry["local_term"], entry["version"], _dumps(entry)) for entry in entries],
    )


def _insert_devices(conn: sqlite3.Connection, devices: dict[str, dict]) -> None:
    conn.executemany(
        "INSERT OR REPLACE INTO devices (device_id, payload) VALUES (?, ?)",
        [(device["device_id"], _dumps(device)) for device in devices.values()],
    )


def seed_if_empty(
    events: dict[str, dict],
    ledger: dict[str, dict],
    losses: dict[str, dict],
    lexicon: list[dict],
    devices: dict[str, dict],
) -> None:
    with connection() as conn:
        if _count(conn, "raw_events") == 0:
            _insert_events(conn, events)
        if _count(conn, "ledger_entries") == 0:
            _insert_ledger(conn, ledger)
        if _count(conn, "loss_distributions") == 0:
            _insert_losses(conn, losses)
        if _count(conn, "lexicon_entries") == 0:
            _insert_lexicon(conn, lexicon)
        if _count(conn, "devices") == 0:
            _insert_devices(conn, devices)


def reset_db(
    events: dict[str, dict],
    ledger: dict[str, dict],
    losses: dict[str, dict],
    lexicon: list[dict],
    devices: dict[str, dict],
) -> None:
    with connection() as conn:
        for table in TABLE_NAMES:
            conn.execute(f"DELETE FROM {table}")
        _insert_events(conn, events)
        _insert_ledger(conn, ledger)
        _insert_losses(conn, losses)
        _insert_lexicon(conn, lexicon)
        _insert_devices(conn, devices)


def load_events() -> dict[str, dict]:
    with connection() as conn:
        rows = conn.execute("SELECT payload FROM raw_events ORDER BY rowid").fetchall()
    return {event["event_id"]: event for event in (_loads(row[0]) for row in rows)}


def load_ledger() -> dict[str, dict]:
    with connection() as conn:
        rows = conn.execute("SELECT payload FROM ledger_entries ORDER BY rowid").fetchall()
    return {entry["transaction_id"]: entry for entry in (_loads(row[0]) for row in rows)}


def load_losses() -> dict[str, dict]:
    with connection() as conn:
        rows = conn.execute("SELECT payload FROM loss_distributions ORDER BY rowid").fetchall()
    return {loss["loss_distribution_id"]: loss for loss in (_loads(row[0]) for row in rows)}


def load_lexicon() -> list[dict]:
    with connection() as conn:
        rows = conn.execute("SELECT payload FROM lexicon_entries ORDER BY rowid").fetchall()
    return [_loads(row[0]) for row in rows]


def load_devices() -> dict[str, dict]:
    with connection() as conn:
        rows = conn.execute("SELECT payload FROM devices ORDER BY rowid").fetchall()
    return {device["device_id"]: device for device in (_loads(row[0]) for row in rows)}


def save_event(event: dict) -> None:
    with connection() as conn:
        conn.execute(
            "INSERT INTO raw_events (event_id, payload) VALUES (?, ?) "
            "ON CONFLICT(event_id) DO UPDATE SET payload = excluded.payload",
            (event["event_id"], _dumps(event)),
        )


def save_ledger_entry(entry: dict) -> None:
    with connection() as conn:
        conn.execute(
            "INSERT INTO ledger_entries (transaction_id, payload) VALUES (?, ?) "
            "ON CONFLICT(transaction_id) DO UPDATE SET payload = excluded.payload",
            (entry["transaction_id"], _dumps(entry)),
        )


def save_loss(loss: dict) -> None:
    with connection() as conn:
        conn.execute(
            "INSERT INTO loss_distributions (loss_distribution_id, payload) VALUES (?, ?) "
            "ON CONFLICT(loss_distribution_id) DO UPDATE SET payload = excluded.payload",
            (loss["loss_distribution_id"], _dumps(loss)),
        )


def save_lexicon_entry(entry: dict) -> None:
    with connection() as conn:
        conn.execute(
            "INSERT INTO lexicon_entries (local_term, version, payload) VALUES (?, ?, ?) "
            "ON CONFLICT(local_term, version) DO UPDATE SET payload = excluded.payload",
            (entry["local_term"], entry["version"], _dumps(entry)),
        )


def save_device(device: dict) -> None:
    with connection() as conn:
        conn.execute(
            "INSERT INTO devices (device_id, payload) VALUES (?, ?) "
            "ON CONFLICT(device_id) DO UPDATE SET payload = excluded.payload",
            (device["device_id"], _dumps(device)),
        )
