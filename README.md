# Invisible Worker — Backend (CASCADE '26, Theme 1, Problem 2)

Offline-first probabilistic ledger for street vendors. This repo holds the **non-frontend**
workstream: the shared JSON contracts, a FastAPI mock server, SQLite persistence, real Monte
Carlo / Dirichlet math, and a hand-rolled three-device CRDT simulation.

The Flutter app is built separately and talks to this server over local Wi-Fi during the demo.

The AI extraction layer (speech / OCR) is replaceable. This repo builds what sits under it: the
uncertainty math, offline SQLite storage, the three-device CRDT sync, and the daily reconciliation
that accounts for missing stock.

## Demo architecture

```
Flutter app or web control panel (phone/laptop)
        --HTTP over LAN-->  FastAPI on laptop (0.0.0.0:8000)
                                      |          |
                                      |          +--> data/invisible_worker.db (SQLite)
                                      +--------------> /ui  (built-in rehearsal dashboard)

CRDT simulation: three in-memory ledger replicas (device-a / device-b / device-c)
```

Everything runs on-device in the production story. For the demo we run the API on a laptop:
embedding Python with Chaquopy or porting the engine to Dart is out of scope right now.

## Quickstart

```bash
py -3 -m pip install -r backend/requirements.txt

# start the server (LAN-accessible, single worker)
py -3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# contract + persistence + CRDT tests
py -3 -m pytest backend -v
```

Interactive API docs: <http://127.0.0.1:8000/docs>

Demo control panel: <http://127.0.0.1:8000/ui/> (or `http://<laptop-lan-ip>:8000/ui/` from a
phone on the same Wi-Fi).

The CRDT state is in-process. Run **one uvicorn worker**; multiple workers would each have their
own replica state.

## Flutter connection

Point the app at the laptop's Wi-Fi IPv4 address:

```
http://<laptop-lan-ip>:8000
```

The address is whatever `ipconfig` reports as the Wi-Fi adapter's IPv4 on the demo machine —
re-check it if you switch networks. The phone must be on the same Wi-Fi.

If the phone cannot connect:

- Allow Python through Windows Defender Firewall for **Private** networks (port 8000).
- Cloudflare WARP is active on this laptop and can block LAN traffic; disable it or exclude the
  local subnet (`192.168.0.0/16`) while demoing.
- Confirm the phone can open `http://<laptop-lan-ip>:8000/health` in its browser.

The same base URL with `/ui/` opens the web control panel on the phone:
`http://<laptop-lan-ip>:8000/ui/`.

## Demo app (`/ui/`)

A no-build, Android-style app is served by the same FastAPI process from `frontend/`. Plain
HTML/CSS/JavaScript, no external assets, works over the LAN. It is a rehearsal and demo surface;
the Flutter app consumes the same API and contracts.

**Install it like an app:** on an Android phone, open `/ui/` in Chrome and choose *Add to Home
screen* (manifest + service worker + app icon are included). It then launches full-screen with its
own icon. On a laptop (window wider than 700 px) the same page renders inside a phone frame so the
demo still reads as an app.

**Layout:** top app bar with live API status, a FAB with quick actions, and a bottom tab bar —

- **Today** — true profit ₹1,200 ± ₹179.51 with a confidence ring, the canonical ₹180 ± ₹25 money
  shot, the ghost-inventory gap (2.1 kg counted vs 2.895 kg expected = 0.795 kg / ₹47.7 missing,
  inside the model's 1σ band), the profit waterfall, the Dirichlet loss split, and the evidence
  summary with the SHA-256 ledger fingerprint.
- **Ledger** — every entry as a card with filter chips (All / Fused / Pending / 1970 clock); tap
  any entry for the **Trust Receipt** bottom sheet: evidence cards, agreement/disagreement math,
  per-source counterfactuals, stored vs simulated values, and the plain-language narrative.
- **Sync** — device cards, the derived merge log, the hostile-clock result, and the logical-order
  proof that the 1970 probe lands at the bottom, not the top.
- **More** — the six demo scenarios (money shot, noisy quotes, pending pair, sync, 1970 clock,
  reset), udhaar and recipe panels, raw events with a pending-only switch, seed IDs with copy
  buttons, the API-base setting, and a dark-theme toggle (follows the system by default).

Suggested rehearsal sequence:

1. Open `/ui/` on the phone or laptop.
2. **Money shot** → open the Trust Receipt and show the pinned seed vs live simulation.
3. **Noisy quotes** → show the range widening from about ₹16 to ₹43 at 40% price disagreement.
4. **Reset demo** → **Sync phones** → show the two-step merge log and 3 resolved conflicts.
5. **1970 clock** → show the probe at the bottom of the logical order, not the top.

## Endpoints

All successful responses are validated at runtime against `schemas.json`. A schema violation
raises a server error instead of returning bad data.

| Method | Path                                | Returns                 | Purpose |
|--------|-------------------------------------|-------------------------|---------|
| GET    | `/ui/`                              | HTML app                | Built-in Android-style demo app (PWA) |
| GET    | `/`                                 | redirect                | Redirects to `/ui/` |
| GET    | `/health`                           | untyped status          | Liveness probe |
| POST   | `/events`                           | `TransactionEvent`      | Accept raw audio/OCR/SMS/manual evidence; mock entity extraction with Hindi numerals |
| GET    | `/events`                           | `TransactionEvent[]`    | Clock-ordered evidence; `?pending=true` excludes events already fused |
| POST   | `/fuse`                             | `LedgerEntry`           | Monte Carlo fusion of 1+ events (10k seeded draws, ~200 ms "thinking" delay) |
| GET    | `/ledger`                           | `LedgerEntry[]`         | All entries, sorted by `(logical_clock, device_id, transaction_id)` |
| GET    | `/ledger/{transaction_id}/explain`  | `EntryExplanation`      | Trust Receipt: evidence, agreement, per-source counterfactuals, narrative |
| GET    | `/summary`                          | `ProfitSummary`         | Accrual profit from revenue − COGS − loss; σ combined in quadrature |
| GET    | `/loss`                             | `LossDistribution[]`    | Live Dirichlet split into spoilage / theft / personal consumption |
| GET    | `/truth/daily`                      | `DailyTruth`            | Ghost-inventory reconciliation + loss split + profit waterfall + fingerprint |
| GET    | `/credits`                          | `CustomerCredit[]`      | Udhaar balances per customer alias (seed data) |
| GET    | `/recipes`                          | `RecipeBurnRate[]`      | Zero-shot per-plate ingredient burn rates (seed data) |
| GET    | `/devices`                          | `DeviceSyncState[]`     | CRDT sync state for the three family devices |
| POST   | `/sync`                             | `MergeResult`           | Merge the three replicas, resolve conflicts, return a derived merge log |
| POST   | `/simulate-clock`                   | `ClockResetResult`      | Append a 1970-clocked probe, merge it, prove history is preserved |
| POST   | `/lexicon/teach`                    | `LexiconEntry`          | Lexicon Drop; versions a local term |
| GET    | `/lexicon`                          | `LexiconEntry[]`        | Taught vocabulary |
| POST   | `/demo/reset`                       | `LedgerEntry[]`         | Restore seed state and re-arm the CRDT simulation |

CORS is open (`*`) because the demo only runs on a trusted LAN. There is no authentication. The
`/ui/` and `/` rows are served by the static dashboard; every other row is a JSON API endpoint
validated against `schemas.json`.

## The demo money shot

`GET /ledger` always contains the canonical entry after a reset:

- Audio event: "Bhai 3 kilo tamatar liya 180 mein…" (device-a, logical clock 42)
- OCR event: same slip, `1970-01-01` wall clock (device-b, logical clock 17)
- Fused entry: `Inventory:Tomatoes` debit ₹180 ± ₹25, `Cash` credit ₹180 ± ₹25,
  `status: fused`, `clock_suspect: true`, logical clock 43

The canonical audio+OCR pair is pinned to the seed entry so the demo always shows ₹180 ± ₹25.
Fusing the same content under different event IDs exercises the real Monte Carlo path and returns
a mean within ₹10 of ₹180. `/ledger/{CANONICAL_TX_ID}/explain` is explicit about the pinned value
and shows the live simulated range next to it.

The 1970 clock is accepted as input and ignored for ordering. History is sorted by
`(logical_clock, device_id, transaction_id)`.

Seed data also includes a poha sale (7 plates, ₹560), a Sharma ji udhaar repayment (₹40),
one loss distribution, six recipe burn rates, three customer credits, three devices, and seven
lexicon entries.

## Probabilistic engine (Phase 4)

- `POST /fuse` runs **10,000 Monte Carlo draws per contributing source**. Quantity is
  `Normal(qty, 0.15*qty)`. In this contract `price` is the **extended line total** (schema:
  qty × unit price), so the engine samples the implied unit price
  `Normal(price/qty, 0.12*(price/qty))` and multiplies by the simulated quantity. A missing price
  uses `DEFAULT_PRICE` with a tripled (36%) price CV, never zero uncertainty.
- The fused entry pools source samples for the amount range; the primary entity supplies the
  quantity range. If two or more sources agree on the unit price (spread < 15%), the amount σ is
  reduced by 15%. If they disagree, σ is multiplied by `1 + spread` (capped at 2×) and confidence
  becomes `mean(source_confidences) − 0.5*spread`, floored at 0.3.
- Monte Carlo is seeded from a SHA-256 of the sorted event IDs, so the same evidence always
  reproduces the same range. `GET /ledger/{id}/explain` recomputes that exact run.
- `GET /loss` draws 10,000 Dirichlet samples from the stored alpha `[22, 8, 10]` using stdlib
  `random.gammavariate(alpha, 1)` normalized per draw. It reports sampled component means/σ and
  the 5/50/95th percentile values `mean ± 1.645σ`. The sample is seeded by the loss ID, so `/loss`
  and `/truth/daily` agree. The seed record itself is never mutated.
- `GET /summary` computes `profit_mean = revenue − cogs − loss` and
  `profit_std = sqrt(σ_revenue² + σ_cogs² + σ_loss²)` from the seed components: ₹1,200 ± ₹179.51.
- No numpy or other new dependency; all sampling is Python's standard library.

## Trust Receipt and Daily Truth (Phase 4.5)

`GET /ledger/{transaction_id}/explain` returns an `EntryExplanation`: the stored amount and
confidence, the evidence lines with wall/logical clocks and suspect flags, the price-agreement
verdict, the exact σ multiplier, per-source counterfactual ranges, and a plain-language narrative.
For the canonical entry it sets `canonical_fallback: true` and shows both the pinned seed range and
the real simulated range.

`GET /truth/daily` returns a `DailyTruth` computed live from the seed events, ledger and recipes:

- Purchased 3.0 kg tomatoes; 7 poha plates consume 0.105 kg by the Poha/Tomatoes recipe.
- Expected on hand 2.895 kg; counted 2.1 kg ⇒ **0.795 kg missing ≈ ₹47.7** at ₹60/kg.
- The loss model expects 0.9 ± 0.25 kg / ₹54 ± ₹15, so the physical gap is inside 1σ.
- Live Dirichlet loss components, and a profit waterfall:
  +₹2,400 revenue − ₹1,146 COGS − ₹54 hidden loss = **₹1,200 ± ₹179.51 true profit**.
- A SHA-256 `ledger_fingerprint` over the logically sorted ledger, plus source-mix/confidence
  evidence counts and two or three plain-language checks.

The ghost-inventory flow is deliberately scoped to tomatoes: they are the ingredient with a
purchase, a recipe consumption, and a physical stock count in the seed. The endpoint states its
method rather than implying a full balance sheet.

## CRDT sync and hostile clock (Phase 5)

`backend/crdt_sim.py` implements a deterministic, dependency-free merge:

- `DeviceLedger(device_id, entries, next_clock)`.
- Merge unions entries by `transaction_id`; the winner is the highest
  `(logical_clock, device_id, transaction_id)`. `next_clock` becomes
  `max(a.next_clock, b.next_clock) + 1`.
- `POST /sync` merges device-a + device-b, then the result + device-c. Fresh state resolves
  3 conflicts (two then one) with 0 lost transactions and returns a `MergeResult`. The merge log
  is derived from the actual report, not hardcoded. All devices become online and adopt the
  merged ledger/clock. `device_ids` is accepted for compatibility but the full network is merged.
- `POST /simulate-clock` appends a probe to the target replica with `created_at` set to the
  hostile `1970-01-01T00:00:00+05:30` value but `logical_clock = next_clock`, plus a matching
  synthetic transaction event so provenance resolves. It then merges the device into the network
  and returns a `ClockResetResult` with the detected wall clock, the logical clock actually used,
  `history_preserved`, a step-by-step merge log, and the sorted ledger.
- `GET /ledger` is sorted by `(logical_clock, device_id, transaction_id)`. The 1970 probe keeps a
  valid logical clock and lands at the position that clock dictates, never at the top just because
  its wall clock is old — the proof that wall clocks did not reorder history.
- The three replica states (including demo-only stale versions that create the initial conflicts)
  live in memory. `POST /demo/reset` wipes them back to the seeded state. Run one worker.

## Contracts

`schemas.json` is the single source of truth (JSON Schema Draft 2020-12), shared with the
Flutter side. Every definition uses `additionalProperties: false` and carries examples that the
test suite validates.

Defined types: `TransactionEvent`, `ExtractedEntity`, `LedgerEntry`, `Posting`,
`LossDistribution`, `LossComponent`, `Account`, `ProfitSummary`, `RecipeBurnRate`,
`CustomerCredit`, `LexiconEntry`, `DeviceSyncState`, `MergeResult`, `ClockResetResult`,
`EntryExplanation`, `DailyTruth`.

Rules the mock enforces:

- Debit mean/σ must equal credit mean/σ; accounts must differ.
- A `fused` entry needs at least two `event_ids`; `event_ids` are the anti-double-count key.
- Missing prices stay `null` — never silently become zero.
- Loss shares sum to 1 across exactly three causes; `alpha` has three positive values.
- Wall clocks are untrusted data; `logical_clock` is authoritative.

## Storage

SQLite, via `backend/store.py`. Path defaults to `data/invisible_worker.db`; override with the
`INVISIBLE_WORKER_DB` environment variable (the test suite points it at a temp directory).

| Table                | Primary key                       | Payload |
|----------------------|-----------------------------------|---------|
| `raw_events`         | `event_id`                        | `TransactionEvent` |
| `ledger_entries`     | `transaction_id`                  | `LedgerEntry` |
| `loss_distributions` | `loss_distribution_id`            | `LossDistribution` |
| `lexicon_entries`    | `(local_term, version)`           | `LexiconEntry` |
| `devices`            | `device_id`                       | `DeviceSyncState` |

Each row stores the contract payload as JSON under the schema's UUID. No fields are invented;
lexicon uses a composite key because that schema has no UUID. Writes go to both the cache and
the database, and state is reloaded from SQLite on startup, so a restart keeps accepted events,
fused entries, device state, and taught words. CRDT replica divergence is intentionally in-memory
and reset-only.

`/demo/reset` wipes the five tables back to seed data and re-arms the CRDT replicas — run it
between rehearsals, or delete `data/invisible_worker.db` and restart.

## Mock limitations and honest assumptions

- `/fuse` pins the canonical audio+OCR pair. Other combinations use the real Monte Carlo path;
  only entities matching the primary item contribute to the amount, and corroborating evidence is
  pooled (demo-scale fusion, not a full hierarchical Bayesian model).
- Monte Carlo / Dirichlet sample sizes are 10,000 for demo speed. The seeded RNG makes results
  reproducible; it does not make them non-probabilistic.
- `/summary` is computed from the seeded revenue/COGS/loss components. `/credits` and `/recipes`
  remain fixed seed data because the assignment defines no live math for them yet.
- Entity extraction is regex-based and covers the demo vocabulary only (tomato, onion, poha,
  chai, kilo, `do`/`chalis`, etc.). Whisper/Tesseract run outside this service.
- The stale device replicas and the hostile-clock probe are synthetic demo fixtures, clearly
  labelled; they are not persisted as real ledger history beyond the probe entry.
- The ghost-inventory reconciliation covers tomatoes only and assumes the sale unit maps to the
  recipe's per-plate unit.
- No authentication, no rate limiting, no schema migrations, no multi-worker CRDT.
