# Invisible Worker (CASCADE '26, Theme 1, Problem 2)

**Real profit, not just cash in hand.**

A street vendor can take ₹2,400 in a day and still end up with less: stock spoils, a few plates go
missing, a customer pays tomorrow. Invisible Worker turns the notes a vendor already makes — a photo
of a bill, a voice note, a short video of the exchange, a few taps — into one honest daily number
with a range and a confidence, and it does that **entirely on the phone, with no internet**.

Two cooperating pieces live in this repo:

- `frontend/` — the product: an offline-first PWA. Notes, media and the daily model live in
  IndexedDB; Today, Records and Why need no server. The server is optional and only used to sync
  notes from another phone.
- `backend/` — the reference API: shared JSON contracts, SQLite persistence, Monte Carlo and
  Dirichlet math, a three-device CRDT simulation, and the contract tests. It also backs the
  optional sync endpoint (`/events`).

**Why this is different from a khata app:** a khata records what was said. Invisible Worker checks
it. Notes about the same purchase are fused into one record; if they disagree, the range gets wider
and the record is marked "To check"; a phone with a wrong date cannot reorder history; missing stock
is priced and subtracted. Instead of a fake exact number it reports, for example, "₹1,200, give or
take ₹177, 93% sure", and every number opens to the notes behind it.

The AI extraction layer (speech / OCR) is still replaceable. Today the app attaches the photo or
voice note as evidence and the vendor confirms the values; the uncertainty and reconciliation
machinery underneath is real.

## Architecture

```
Phone (PWA installed from Chrome)
  frontend/index.html + styles.css + app.js
  frontend/local.js   <- IndexedDB notes/media, fusion, daily summary, stock, sync
        |
        |  optional HTTPS sync of notes (/events)
        v
FastAPI on the laptop (0.0.0.0:8000) — contracts, reference engine, SQLite, CRDT demo, /ui
```

Everything the vendor sees runs on the phone. The laptop API is a shared shop server for sync and
the reference engine, not a dependency for the money book.

## Quickstart

```bash
py -3 -m pip install -r backend/requirements.txt

# 1. start the shop server (needed for sync and the reference API)
py -3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# 2. open the app (works offline after the first load)
#    http://127.0.0.1:8000/ui/

# 3. install it on an Android phone, with a public HTTPS link and no phone setup
py -3 serve_android.py --tunnel

# contract + persistence + CRDT tests
py -3 -m pytest backend -v
```

Interactive API docs: <http://127.0.0.1:8000/docs>

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

The same base URL with `/ui/` opens the app on the phone:
`http://<laptop-lan-ip>:8000/ui/`.

## The app (`/ui/`)

A no-build PWA in `frontend/`. It starts empty: you add a photo, a voice note, a short video or a
few typed values, and every screen is computed on the phone from those notes. No API is needed to
use it.

**Adding a note** (+ button, or "Add a note"):

1. Choose **Photo**, **Voice**, **Video** or **Type**. Photos use the camera and are compressed on
   the phone; voice and video are recorded with the mic and camera. All of it is stored with the
   note in IndexedDB.
2. Say whether it was money spent or money received, then enter the item, quantity, unit and amount.
   Optionally attach up to **3 bill photos** and link up to **3 past notes** as context. Speech-to-
   text and OCR are not required: the evidence is attached and you confirm the values.
3. Save. A note joins a matching note about the same item and quantity within 30 minutes; two
   agreeing notes are marked **Checked** and get a tighter range, a disagreement is marked
   **To check** and widens the range. **Why ₹X?** then plays the video or voice note, shows the
   bill photos, and links the context notes. Photos and video stay on this phone.

**Voice assistant (6 languages)**

The mic button beside **+** opens a guided assistant in **English, हिंदी, मराठी, ଓଡ଼ିଆ, தமிழ் and
తెలుగు**. Pick a language in the assistant, or start from the phone's language. **Use my location**
maps the GPS position to the nearest Indian state and picks one of the six languages offline (no
map API): Maharashtra → Marathi, Odisha → Odia, Tamil Nadu → Tamil, Telangana/Andhra → Telugu, the
Hindi belt → Hindi, elsewhere English. It speaks the question, waits for the answer, and walks
through sold/spent → item → rupees → quantity → spoken confirmation → save; it also answers "how
much did I make?", "why this number?", "count stock" and "sync" aloud. Every button stays
available. Browser speech recognition needs internet; speech output and the entire money book keep
working offline. Voice output needs a matching language voice installed on the phone.

**Screens**

- **Today** — "You made today" with a range and how sure, money in / money out / missing, the stock
  check, and the latest checked note. The breakdown, note summary and proof code are under "See all
  the numbers". In a fresh install it offers **Add a note** and **See an example day**.
- **Records** — every record with a plain title, money in or out, how sure, and a
  Checked / Saved / To check / Wrong date tag; filters by direction. Tap for **Why ₹X?**: the
  video/photo/voice evidence, the bill photos, the linked notes, what each note alone would give,
  and the model detail.
- **Phones** — this phone and any phones that synced, with "Sync with shop". Notes are already
  saved here; sync only moves unsynced notes to the shop server and pulls notes from other phones.
- **More** — count stock, start over, dark screen, and **Advanced** (shop server, all notes on this
  phone, load the example day).

**Motion** — the app takes its cues from a 3D device reel: on a laptop the phone frame wakes from a
slight tilt and follows the pointer; tabs fly in with depth; cards stagger; sheets lift in 3D; the
hero catches a soft sheen; numbers count up. Everything is transform/opacity based and every
animation is disabled under `prefers-reduced-motion`.

**Offline model** (`frontend/local.js`)

- Notes and media live in IndexedDB. Photos are compressed to max 1400 px; video is capped at 15 s;
  audio stays as recorded.
- A record is one or more notes about the same purchase or sale. Fusion uses an inverse-variance
  mean, combined confidence, and a wider range when the notes disagree by more than 15% in price.
- Money in/out are sums of records; missing is the priced stock gap; the daily range is the
  combined uncertainty plus a 5% cushion for cash that was never noted.
- Stock: expected = everything bought for that item in this book; missing = expected − counted;
  value = missing × the latest unit cost. Counting uses records, not evidence notes, so a purchase
  photographed twice is not counted twice.
- Ordering uses the order notes were added, not the phone clock. A note with a 1970 timestamp is
  still evidence but is pinned at the end, so it cannot jump the queue.
- Sync: every note has a UUID and is posted to `/events` idempotently; `media_ref` carries the
  direction, kind and account. Syncing twice never duplicates a note, and notes from another phone
  about the same item, quantity and time are fused into the same record. Media, bill photos and
  linked notes stay on the phone that recorded them.

Suggested rehearsal (five minutes, on the phone, in airplane mode after the first load):

1. **Start over** (More) → Today shows ₹0 and an **Add a note** button.
2. Take a photo of a bill, add a bill photo, link an earlier note, and save → open **Why ₹X?** to
   show the bill and the linked context.
3. Record a 10-second **video** of a handover, enter the amount and save; open **Why** to play it.
4. Tap the **mic**, ask "how much did I make?", then switch to हिंदी, தமிழ் or తెలుగు and ask
   "आज की कमाई" — the answer is spoken in the selected language. **Use my location** picks the
   language from the nearest state.
5. **Count stock** → the missing kilos and rupees appear on Today and are subtracted from profit.
6. Toggle airplane mode: the app keeps working. **Phones → Sync with shop** sends the notes and
   pulls notes from another phone.
7. **See an example day** loads the full 9-note demo day (₹2,400 in, ₹1,146 out, ₹54 missing →
   ₹1,200 give or take ₹177, 93% sure).

## Install on a real Android phone

The demo installs on a physical Android phone as a standalone PWA. Chrome only installs from a
trusted HTTPS origin, so there are two routes, both driven by `serve_android.py`.

**A. Temporary public HTTPS link (no setup on the phone)**

```bash
py -3 serve_android.py --tunnel
```

Downloads Cloudflare's `cloudflared` once into `data/bin/` (~55 MB), starts the app if it is not
already running, then prints a scannable QR code and a `https://<random>.trycloudflare.com/ui/`
URL. On the phone, open the URL in Chrome → three-dot menu → **Install app**. No certificate is
involved, and the phone can be on mobile data. The link is public and temporary: it dies when the
process exits, and a new URL is issued each run.

**B. Same Wi-Fi, no internet**

```bash
py -3 serve_android.py          # OR: py -3 serve_android.py --ip 192.168.1.23
```

Mints a local certificate authority with OpenSSL, serves the app over HTTPS on port 8443, and puts
a phone-facing install page on port 8080 with a certificate download and a live trust check.

1. Scan the QR code → the install page opens over plain HTTP.
2. **Download certificate** → install it as a **CA certificate** (Settings → Security & privacy →
   More security settings → Encryption & credentials → Install a certificate → CA certificate).
   Android warns that your network may be monitored; that warning is expected for a certificate
   you installed yourself.
3. **Open Invisible Worker** over HTTPS, then Chrome's three-dot menu → **Install app**.

The certificate lives in `data/certs/` (gitignored) and is re-issued when the laptop's IP changes;
the CA itself is kept so the phone does not need to reinstall anything. Allow Python through
Windows Defender Firewall for **Private** networks on ports 8080 and 8443. Without the
certificate, the app still runs in a Chrome tab at `http://<laptop-lan-ip>:8000/ui/`, but Chrome
will not install it from there.

In both cases the icon lands on the home screen and opens full-screen without an address bar.

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
`/ui/` and `/` rows are served by the PWA; every other row is a JSON API endpoint
validated against `schemas.json`.

## The tomato fusion example (API)

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
