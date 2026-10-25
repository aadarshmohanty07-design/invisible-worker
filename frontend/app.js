(() => {
  "use strict";

  const SEED = {
    audio: "3f1b9c2e-5a4d-4f7a-8b6e-1c2d3e4f5a6b",
    ocr: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
    stock: "7c6b5a4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
    sale: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    credit: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    pendingAudio: "4c5d6e7f-8a9b-4c1d-9e2f-3a4b5c6d7e8f",
    pendingSms: "5d6e7f8a-9b0c-4d2e-8f3a-4b5c6d7e8f9a",
    canonicalTx: "b7e6d5c4-3a2f-4e1d-9c8b-7a6f5e4d3c2b",
  };

  const TAB_SUBTITLES = {
    today: "Today's numbers",
    ledger: "All entries",
    sync: "Devices and merge log",
    more: "Scenarios, evidence, settings",
  };

  const SOURCE_CLASSES = new Set(["audio", "ocr", "sms", "manual"]);
  const DEVICE_STATUSES = new Set(["online", "offline", "syncing"]);
  const LOSS_COLORS = {
    spoilage: "var(--amber-ink)",
    theft: "var(--red)",
    personal_consumption: "var(--blue)",
  };
  const LOSS_FALLBACK = "var(--faint)";

  const state = {
    apiBase: initialApiBase(),
    tab: "today",
    ledgerFilter: "all",
    health: null,
    ledger: [],
    events: [],
    devices: [],
    summary: null,
    loss: [],
    credits: [],
    recipes: [],
    truth: null,
    lastMerge: null,
    lastClock: null,
    lastScenario: null,
    pendingOnly: false,
    actionBusy: false,
    firstRefreshDone: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function initialApiBase() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("api");
    const stored = window.localStorage.getItem("iw-api-base");
    const fallback = window.location.protocol === "http:" || window.location.protocol === "https:"
      ? window.location.origin
      : "http://127.0.0.1:8000";
    return String(fromQuery || stored || fallback).replace(/\/+$/, "");
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]));
  }

  const moneyFormatter = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  });

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number) ? moneyFormatter.format(number) : "—";
  }

  function signedMoney(value) {
    const number = Number(value) || 0;
    return `${number < 0 ? "−" : "+"}${money(Math.abs(number))}`;
  }

  function num(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "—";
  }

  function pct(value, digits = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : "—";
  }

  function pctPoints(value, digits = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(digits)}%` : "—";
  }

  function confidenceDelta(value) {
    const number = Number(value) || 0;
    const points = number * 100;
    return `${points > 0 ? "+" : ""}${points.toFixed(0)} pts`;
  }

  function fmtDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function isSuspectWallClock(value) {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return false;
    return timestamp < Date.parse("2000-01-01T00:00:00Z") || timestamp > Date.now() + 86400000;
  }

  function is1970(entry) {
    return String(entry.created_at || "").startsWith("1970");
  }

  function shortDevice(deviceId) {
    const suffix = String(deviceId || "").split("-").pop();
    return suffix.length <= 2 ? suffix.toUpperCase() : String(deviceId);
  }

  function sourceClass(source) {
    const value = String(source);
    return SOURCE_CLASSES.has(value) ? value : "manual";
  }

  function statusTag(status) {
    const classes = { fused: "green", posted: "blue", pending: "amber", voided: "red" };
    return `<span class="tag tag--${classes[status] || "quiet"}">${esc(status)}</span>`;
  }

  function verdictTag(verdict) {
    const classes = { agree: "green", disagree: "red", single_source: "quiet" };
    const label = String(verdict || "").replace(/_/g, " ");
    return `<span class="tag tag--${classes[verdict] || "quiet"}">${esc(label)}</span>`;
  }

  function deviceStatusClass(status) {
    const value = String(status);
    return DEVICE_STATUSES.has(value) ? value : "offline";
  }

  function truncate(value, max = 88) {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function findLedger(transactionId) {
    return state.ledger.find((entry) => entry.transaction_id === transactionId) || null;
  }

  function findEvent(eventId) {
    return state.events.find((event) => event.event_id === eventId) || null;
  }

  function emptyState(message) {
    return `<div class="empty-state">${esc(message)}</div>`;
  }

  const CHEVRON = '<span class="entry__chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span>';

  async function api(path, options = {}) {
    const { method = "GET", body, headers = {} } = options;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${state.apiBase}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (!response.ok) {
        const detail = payload && typeof payload === "object" ? payload.detail : payload;
        throw new Error(`${response.status} ${detail || response.statusText}`);
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The request timed out.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function setStatus(mode, text) {
    const status = $("#api-status");
    if (!status) return;
    status.className = `status status--${mode}`;
    $("#api-status-text").textContent = text;
  }

  function showBanner(message) {
    const banner = $("#error-banner");
    banner.hidden = false;
    $("#error-text").textContent = message;
  }

  function hideBanner() {
    $("#error-banner").hidden = true;
  }

  function toast(message, type = "info") {
    const container = $("#toasts");
    const item = document.createElement("div");
    item.className = `toast${type === "error" ? " toast--error" : ""}`;
    item.textContent = message;
    container.appendChild(item);
    while (container.children.length > 2) container.firstChild.remove();
    window.setTimeout(() => item.remove(), 4200);
  }

  function setButtonBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle("is-busy", busy);
    button.setAttribute("aria-busy", String(busy));
  }

  async function runAction(button, action) {
    if (state.actionBusy) {
      toast("Another demo action is still running.", "error");
      return;
    }
    state.actionBusy = true;
    setButtonBusy(button, true);
    try {
      await action();
    } catch (error) {
      toast(error.message || "Action failed.", "error");
    } finally {
      state.actionBusy = false;
      setButtonBusy(button, false);
    }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      toast("Copied to clipboard.");
    } catch {
      toast("Could not copy. Select the text manually.", "error");
    }
  }

  /* ---------- Tabs & sheets ---------- */

  function switchTab(tab) {
    if (!TAB_SUBTITLES[tab]) return;
    state.tab = tab;
    $$(".page").forEach((page) => {
      page.hidden = page.dataset.page !== tab;
    });
    $$(".bottomnav__item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.tab === tab);
    });
    $("#appbar-sub").textContent = TAB_SUBTITLES[tab];
    $("#main").scrollTop = 0;
  }

  function openSheet(id) {
    const sheet = $(id);
    if (!sheet || !sheet.hidden) return;
    sheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeSheet(id) {
    const sheet = $(id);
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    if ($("#receipt-sheet").hidden && $("#actions-sheet").hidden) {
      document.body.style.overflow = "";
    }
  }

  function closeAllSheets() {
    closeSheet("#receipt-sheet");
    closeSheet("#actions-sheet");
  }

  function hideSplash() {
    const splash = $("#splash");
    if (!splash || splash.classList.contains("is-hide")) return;
    splash.classList.add("is-hide");
    splash.setAttribute("aria-hidden", "true");
    window.setTimeout(() => splash.remove(), 600);
  }

  async function refreshAll({ quiet = false } = {}) {
    if (!quiet) setStatus("busy", "Refreshing");
    const requests = [
      api("/health"),
      api("/ledger"),
      api("/events"),
      api("/devices"),
      api("/summary"),
      api("/loss"),
      api("/truth/daily"),
      api("/credits"),
      api("/recipes"),
    ];
    const keys = ["health", "ledger", "events", "devices", "summary", "loss", "truth", "credits", "recipes"];
    const results = await Promise.allSettled(requests);
    const failures = [];

    results.forEach((result, index) => {
      const key = keys[index];
      if (result.status === "fulfilled") {
        state[key] = result.value;
      } else {
        failures.push({ key, error: result.reason });
        if (key === "health") state.health = null;
      }
    });

    const healthOk = Boolean(state.health);
    if (!healthOk) {
      setStatus("error", "Offline");
      const first = failures.find((failure) => failure.key === "health") || failures[0];
      showBanner(first?.error?.message || "The API could not be reached.");
    } else if (failures.length) {
      setStatus("ok", "Live");
      showBanner(`Some data could not load: ${failures[0].error.message}`);
    } else {
      setStatus("ok", "Live");
      hideBanner();
    }

    renderAll();

    if (!state.firstRefreshDone) {
      state.firstRefreshDone = true;
      window.setTimeout(hideSplash, 450);
    }
  }

  /* ---------- Renderers ---------- */

  function renderAll() {
    renderStatus();
    renderProfit();
    renderMoneyShot();
    renderGhost();
    renderWaterfall();
    renderLoss();
    renderEvidence();
    renderLedger();
    renderDevices();
    renderMergeLog();
    renderClockResult();
    renderOrder();
    renderEvents();
    renderExtras();
    renderScenario();
    renderApiLinks();
  }

  function renderStatus() {
    const version = $("#health-version");
    const businessDate = $("#business-date");
    version.textContent = state.health ? `API v${state.health.version}` : "API —";
    businessDate.textContent = state.truth?.business_date || state.summary?.time_period || "No day loaded";
  }

  function renderProfit() {
    const card = $("#profit-card");
    const summary = state.summary;
    if (!summary) {
      card.innerHTML = emptyState("No profit summary loaded. Check the API connection in More → Settings.");
      return;
    }
    const evidence = state.truth?.evidence_summary || {};
    const low = summary.profit_mean - summary.profit_std_dev;
    const high = summary.profit_mean + summary.profit_std_dev;
    const avgConf = Number(evidence.average_confidence);
    const circumference = 2 * Math.PI * 20;
    const offset = Number.isFinite(avgConf)
      ? circumference * (1 - Math.max(0, Math.min(1, avgConf)))
      : circumference;
    const fused = evidence.fused_entries ?? "—";
    const suspect = evidence.suspect_clock_events ?? "—";
    card.innerHTML = `
      <div class="hero-top">
        <div>
          <p class="eyebrow">True profit · ${esc(summary.time_period)}</p>
          <p class="hero-amount">${money(summary.profit_mean)}</p>
          <p class="hero-sub">± ${money(summary.profit_std_dev)} one-sigma band</p>
        </div>
        <div class="conf-ring">
          <svg width="56" height="56" viewBox="0 0 48 48" aria-hidden="true">
            <circle class="conf-ring__track" cx="24" cy="24" r="20" fill="none" stroke-width="5"></circle>
            <circle class="conf-ring__fill" cx="24" cy="24" r="20" fill="none" stroke-width="5" stroke-linecap="round"
              stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
              transform="rotate(-90 24 24)"></circle>
          </svg>
          <div class="conf-ring__label">${Number.isFinite(avgConf) ? pct(avgConf, 0) : "—"} sure</div>
        </div>
      </div>
      <div class="range-bar" aria-hidden="true"><span class="range-bar__fill" style="left:15%;width:70%"></span></div>
      <div class="range-labels"><span>${money(low)}</span><span>${money(high)}</span></div>
      <dl class="mini-grid">
        <div><dt>Revenue</dt><dd>${money(summary.revenue_mean)} <span>± ${money(summary.revenue_std_dev)}</span></dd></div>
        <div><dt>COGS</dt><dd>${money(summary.cogs_mean)} <span>± ${money(summary.cogs_std_dev)}</span></dd></div>
        <div><dt>Hidden loss</dt><dd>${money(summary.loss_mean)} <span>± ${money(summary.loss_std_dev)}</span></dd></div>
        <div><dt>Evidence</dt><dd>${esc(fused)} fused <span>· ${esc(suspect)} suspect</span></dd></div>
      </dl>
      <p class="hero-foot">Profit = revenue − COGS − hidden loss. Each term carries its own uncertainty.</p>
    `;
  }

  function renderMoneyShot() {
    const card = $("#money-shot-card");
    const entry = findLedger(SEED.canonicalTx);
    if (!entry) {
      card.innerHTML = `${emptyState("The canonical tomato entry is missing. Reset the demo to restore it.")}
        <div class="button-row"><button class="btn btn--primary" type="button" data-action="reset">Reset demo</button></div>`;
      return;
    }
    const sourceEvents = entry.event_ids.map(findEvent).filter(Boolean);
    const chips = sourceEvents.map((event) => `
      <span class="chip chip--${sourceClass(event.source)}">${esc(event.source)} · ${esc(shortDevice(event.device_id))}</span>
    `).join("");
    card.innerHTML = `
      <div class="card__head">
        <div><p class="eyebrow">Money shot</p><h3>Fused tomato purchase</h3></div>
        ${entry.clock_suspect ? '<span class="tag tag--red">1970 clock</span>' : ""}
      </div>
      <p class="shot-amount">${money(entry.debit.amount_mean)}</p>
      <div class="sub-number">± ${money(entry.debit.amount_std_dev)} <span>1σ</span></div>
      <p class="shot-account">${esc(entry.debit.account)} → ${esc(entry.credit.account)}</p>
      <div class="evidence-chips">${chips || '<span class="chip">Evidence attached</span>'}</div>
      <div class="entry__meter">
        <span class="muted">${pct(entry.confidence, 0)} confident</span>
        <div class="confidence-bar"><span style="width:${Math.round(entry.confidence * 100)}%"></span></div>
        <span class="muted">${entry.event_ids.length} lines</span>
      </div>
      <div class="button-row">
        <button class="btn btn--primary" type="button" data-explain="${esc(entry.transaction_id)}">Open Trust Receipt</button>
        <button class="btn btn--ghost" type="button" data-action="money-shot">Re-run fusion</button>
      </div>
    `;
  }

  function renderGhost() {
    const card = $("#ghost-card");
    const reconciliation = state.truth?.reconciliation;
    if (!reconciliation) {
      card.innerHTML = emptyState("Ghost inventory is unavailable. Check /truth/daily.");
      return;
    }
    const expected = Number(reconciliation.expected_on_hand_qty) || 0;
    const counted = Number(reconciliation.counted_qty) || 0;
    const countedPct = expected > 0 ? Math.max(0, Math.min(100, (counted / expected) * 100)) : 0;
    const missingPct = Math.max(0, 100 - countedPct);
    const consistent = Boolean(reconciliation.consistent_within_1_sigma);
    card.innerHTML = `
      <div class="card__head">
        <div><p class="eyebrow">Ghost inventory</p><h3>Counted vs expected stock</h3></div>
        <span class="tag tag--amber">${esc(reconciliation.item)}</span>
      </div>
      <div class="ghost-number">${num(reconciliation.missing_qty, 3)} kg <small>≈ ${money(reconciliation.missing_value)}</small></div>
      <div class="stock-bar" aria-hidden="true">
        <span class="stock-bar__expected"></span>
        <span class="stock-bar__counted" style="width:${countedPct}%"></span>
        <span class="stock-bar__missing" style="width:${missingPct}%"></span>
      </div>
      <div class="stock-legend"><span>Counted ${num(counted, 3)} kg</span><span>Expected ${num(expected, 3)} kg</span></div>
      <div class="consistency${consistent ? "" : " consistency--warn"}">
        <span aria-hidden="true">●</span>
        <span>${consistent ? "Inside the loss model's 1σ band" : "Outside the loss model's 1σ band"}<br>
          <span class="muted">Model ${num(reconciliation.modeled_loss_qty_mean)} ± ${num(reconciliation.modeled_loss_qty_std_dev)} kg · ${money(reconciliation.modeled_loss_value_mean)} ± ${money(reconciliation.modeled_loss_value_std_dev)}</span>
        </span>
      </div>
    `;
  }

  function renderWaterfall() {
    const card = $("#waterfall-card");
    const summary = state.summary;
    const steps = state.truth?.waterfall || (summary ? [
      { label: "Revenue", amount_mean: summary.revenue_mean, amount_std_dev: summary.revenue_std_dev },
      { label: "Less: COGS", amount_mean: -summary.cogs_mean, amount_std_dev: summary.cogs_std_dev },
      { label: "Less: hidden loss", amount_mean: -summary.loss_mean, amount_std_dev: summary.loss_std_dev },
      { label: "True profit", amount_mean: summary.profit_mean, amount_std_dev: summary.profit_std_dev },
    ] : []);
    if (!steps.length) {
      card.innerHTML = emptyState("The profit waterfall is unavailable.");
      return;
    }
    const maxAbs = Math.max(1, ...steps.map((step) => Math.abs(Number(step.amount_mean) || 0)));
    const rows = steps.map((step) => {
      const isTotal = step.label === "True profit";
      const isNegative = Number(step.amount_mean) < 0;
      const width = Math.max(2, (Math.abs(Number(step.amount_mean) || 0) / maxAbs) * 100);
      return `
        <div class="waterfall__row${isTotal ? " waterfall__row--total" : ""}">
          <span class="waterfall__label">${esc(step.label)}</span>
          <div class="waterfall__track" aria-hidden="true"><span class="waterfall__bar${isNegative ? " waterfall__bar--negative" : ""}${isTotal ? " waterfall__bar--total" : ""}" style="width:${width}%"></span></div>
          <span class="waterfall__value">${signedMoney(step.amount_mean)} <span class="faint">± ${money(step.amount_std_dev)}</span></span>
        </div>`;
    }).join("");
    card.innerHTML = `
      <div class="card__head"><div><h3>Profit breakdown</h3></div><span class="muted">1σ bands</span></div>
      <div class="waterfall">${rows}</div>
    `;
  }

  function renderLoss() {
    const card = $("#loss-card");
    const loss = state.loss?.[0];
    const components = state.truth?.loss_components || loss?.components || [];
    if (!components.length) {
      card.innerHTML = emptyState("Loss attribution is unavailable.");
      return;
    }
    const stack = components.map((component) => {
      const width = Math.max(0, Math.min(100, Number(component.share_mean) * 100));
      const color = LOSS_COLORS[component.cause] || LOSS_FALLBACK;
      return `<span style="width:${width}%;background:${color}" title="${esc(component.cause)}"></span>`;
    }).join("");
    const rows = components.map((component) => {
      const color = LOSS_COLORS[component.cause] || LOSS_FALLBACK;
      return `
        <div>
          <div class="loss-legend__row">
            <span class="loss-legend__name"><span class="swatch" style="background:${color}"></span>${esc(String(component.cause).replace(/_/g, " "))}</span>
            <span class="loss-legend__value">${pct(component.share_mean, 1)} <span class="faint">± ${pct(component.share_std_dev, 1)}</span></span>
          </div>
          <p class="loss-driver">${esc(component.driver)}</p>
        </div>`;
    }).join("");
    const value = loss?.value_lost;
    const quantiles = value
      ? `<div class="loss-quantiles">
          <span>q05 ${money(value.q05)}</span>
          <span>q50 ${money(value.q50)}</span>
          <span>q95 ${money(value.q95)}</span>
          <span>α ${esc((loss.allocation?.alpha || []).join(" / "))}</span>
        </div>`
      : "";
    card.innerHTML = `
      <div class="card__head">
        <div><p class="eyebrow">Hidden loss</p><h3>Spoilage, theft, household</h3></div>
        <span class="muted">Dirichlet</span>
      </div>
      <div class="loss-stack" aria-hidden="true">${stack}</div>
      <div class="loss-legend">${rows}</div>
      ${quantiles}
    `;
  }

  function renderEvidence() {
    const card = $("#evidence-card");
    const truth = state.truth;
    if (!truth) {
      card.innerHTML = emptyState("Daily evidence is unavailable.");
      return;
    }
    const evidence = truth.evidence_summary;
    const stats = [
      ["Events", evidence.total_events],
      ["Fused", evidence.fused_entries],
      ["Confidence", pct(evidence.average_confidence, 0)],
      ["Rescued", evidence.hostile_clock_recoveries],
    ];
    const sourceMix = Object.entries(evidence.source_mix)
      .map(([source, count]) => `<span class="chip chip--${sourceClass(source)}">${esc(source)} ${esc(count)}</span>`)
      .join("");
    const actions = (truth.actions || []).map((action) => `<li>${esc(action)}</li>`).join("");
    card.innerHTML = `
      <div class="card__head">
        <div><h3>Evidence summary</h3></div>
      </div>
      <div class="evidence-grid">
        ${stats.map(([label, value]) => `<div class="stat"><div class="stat__label">${esc(label)}</div><div class="stat__value">${esc(value)}</div></div>`).join("")}
      </div>
      <div class="evidence-chips">${sourceMix}</div>
      <p class="muted" style="margin:10px 0 0">${esc(truth.narrative)}</p>
      <ul class="action-list">${actions}</ul>
      <div class="fingerprint">
        <span class="faint">SHA-256 ledger fingerprint</span>
        <code>${esc(truth.ledger_fingerprint)}</code>
      </div>
      <div class="button-row">
        <button class="btn btn--small btn--outline" type="button" data-copy="${esc(truth.ledger_fingerprint)}">Copy fingerprint</button>
      </div>
    `;
  }

  function ledgerMatchesFilter(entry) {
    if (state.ledgerFilter === "all") return true;
    if (state.ledgerFilter === "fused") return entry.status === "fused";
    if (state.ledgerFilter === "pending") return entry.status === "pending";
    if (state.ledgerFilter === "suspect") return is1970(entry) || entry.clock_suspect;
    return true;
  }

  function renderLedger() {
    const list = $("#ledger-list");
    const entries = state.ledger.filter(ledgerMatchesFilter);
    if (!state.ledger.length) {
      list.innerHTML = emptyState("No ledger entries. Reset the demo from More.");
      return;
    }
    if (!entries.length) {
      list.innerHTML = emptyState("No entries match this filter.");
      return;
    }
    list.innerHTML = entries.map((entry) => {
      const canonical = entry.transaction_id === SEED.canonicalTx;
      const probe = is1970(entry);
      const qty = entry.debit.qty_mean != null ? ` · ${num(entry.debit.qty_mean, 3)} ${esc(entry.debit.unit || "")}` : "";
      const sourceChips = entry.event_ids.map(findEvent).filter(Boolean)
        .slice(0, 3)
        .map((event) => `<span class="chip chip--${sourceClass(event.source)}">${esc(event.source)}</span>`)
        .join("");
      return `
        <button class="entry${canonical ? " is-canonical" : ""}${probe ? " is-probe" : ""}" type="button" data-explain="${esc(entry.transaction_id)}">
          <span class="entry__top">
            <span class="entry__clock">${esc(entry.logical_clock)}</span>
            ${statusTag(entry.status)}
            ${probe ? '<span class="tag tag--red">1970</span>' : (entry.clock_suspect ? '<span class="tag tag--red">clock</span>' : "")}
            <span class="entry__device">${esc(shortDevice(entry.device_id))}</span>
          </span>
          <span class="entry__accounts">${esc(entry.debit.account)} → ${esc(entry.credit.account)}</span>
          <span class="entry__amount"><strong>${money(entry.debit.amount_mean)}</strong><span>± ${money(entry.debit.amount_std_dev)}${qty}</span></span>
          <span class="entry__meter">
            <span class="muted">${pct(entry.confidence, 0)}</span>
            <span class="confidence-bar"><span style="width:${Math.round(entry.confidence * 100)}%"></span></span>
          </span>
          <span class="entry__foot">
            <span class="entry__evidence">${entry.event_ids.length} evidence line${entry.event_ids.length === 1 ? "" : "s"} ${sourceChips}</span>
            ${CHEVRON}
          </span>
        </button>`;
    }).join("");
  }

  function renderDevices() {
    const grid = $("#device-grid");
    if (!state.devices.length) {
      grid.innerHTML = emptyState("Device state is unavailable.");
      return;
    }
    grid.innerHTML = state.devices.map((device) => `
      <article class="device">
        <div class="device__top">
          <span class="device__name">${esc(device.device_id)}</span>
          <span class="device__status"><span class="dot ${deviceStatusClass(device.status)}"></span>${esc(device.status)}</span>
        </div>
        <div class="device__meta">
          <span>Last merged<strong>${esc(device.last_merged_logical_clock)}</strong></span>
          <span>Conflicts<strong>${esc(device.conflicts_resolved)}</strong></span>
        </div>
      </article>
    `).join("");
  }

  function renderMergeLog() {
    const card = $("#merge-log-card");
    if (!state.lastMerge) {
      card.innerHTML = `
        <div class="card__head"><h3>Merge log</h3><span class="muted">Last sync</span></div>
        <p class="log__empty">Run Sync devices. Reset first to replay the seeded three-conflict merge.</p>
      `;
      return;
    }
    const result = state.lastMerge;
    card.innerHTML = `
      <div class="card__head"><h3>Merge log</h3><span class="tag tag--green">${esc(result.conflicts_resolved)} conflicts</span></div>
      <div class="log">${esc((result.merge_log || []).join("\n"))}</div>
    `;
  }

  function renderClockResult() {
    const card = $("#clock-result-card");
    if (!state.lastClock) {
      card.innerHTML = `
        <div class="card__head"><h3>Hostile clock</h3><span class="muted">Last simulation</span></div>
        <p class="log__empty">Run “1970 clock” to append a hostile-clock probe and prove the ledger order survives.</p>
      `;
      return;
    }
    const result = state.lastClock;
    card.innerHTML = `
      <div class="card__head">
        <h3>Hostile clock</h3>
        ${result.history_preserved ? '<span class="tag tag--green">history preserved</span>' : '<span class="tag tag--red">history at risk</span>'}
      </div>
      <div class="clock-result">
        <div class="clock-result__message">${esc(result.message)}</div>
        <div class="kv"><span>Detected wall clock</span><span>${esc(fmtDate(result.detected_wall_clock))}</span></div>
        <div class="kv"><span>Logical clock used</span><span>${esc(result.logical_clock_used)}</span></div>
        <div class="log">${esc((result.merge_log || []).join("\n"))}</div>
      </div>
    `;
  }

  function renderOrder() {
    const order = $("#ledger-order");
    const proof = $("#probe-proof");
    if (!state.ledger.length) {
      order.innerHTML = "";
      proof.textContent = "No ledger entries.";
      return;
    }
    order.innerHTML = state.ledger.map((entry) => {
      const probe = is1970(entry);
      const canonical = entry.transaction_id === SEED.canonicalTx;
      const classes = ["order-pill"];
      if (probe) classes.push("order-pill--probe");
      if (canonical) classes.push("order-pill--canonical");
      return `<span class="${classes.join(" ")}" title="${esc(entry.transaction_id)}"><strong>${esc(entry.logical_clock)}</strong> ${esc(shortDevice(entry.device_id))}</span>`;
    }).join("");
    const probeEntry = state.ledger.find(is1970);
    if (!probeEntry) {
      proof.textContent = "No hostile-clock probe yet. Run “1970 clock” to append one.";
      return;
    }
    const index = state.ledger.indexOf(probeEntry);
    const first = state.ledger[0];
    proof.innerHTML = `1970 probe at position <strong>${index + 1} of ${state.ledger.length}</strong>; first entry is <strong>${esc(first.device_id)} at clock ${esc(first.logical_clock)}</strong>. ${index > 0 ? "<strong>History preserved.</strong>" : "<strong>Unexpected: probe is first.</strong>"}`;
  }

  function renderEvents() {
    const list = $("#events-body");
    const used = new Set(state.ledger.flatMap((entry) => entry.event_ids));
    const events = state.events.filter((event) => !state.pendingOnly || !used.has(event.event_id));
    if (!events.length) {
      list.innerHTML = emptyState("No events match the current filter.");
      return;
    }
    list.innerHTML = events.map((event) => {
      const entity = event.extracted_entities?.[0];
      const entityText = entity
        ? `${entity.item} · ${num(entity.qty, 2)} ${esc(entity.unit)}${entity.price != null ? ` · ${money(entity.price)}` : ""}`
        : "No parsed line";
      const suspect = isSuspectWallClock(event.wall_clock) ? '<span class="tag tag--red">suspect</span>' : "";
      const usedState = used.has(event.event_id)
        ? '<span class="tag tag--quiet">in ledger</span>'
        : '<span class="tag tag--amber">pending</span>';
      return `
        <div class="event">
          <div class="event__top">
            <span class="chip chip--${sourceClass(event.source)}">${esc(event.source)}</span>
            ${usedState}
            ${suspect}
            <span class="event__device">${esc(shortDevice(event.device_id))} · ${esc(event.logical_clock)}</span>
          </div>
          <div class="event__text">${esc(truncate(event.raw_text, 110) || "—")}</div>
          <div class="event__meta">
            <span>${esc(entityText)}</span>
            <span class="mono">${esc(fmtDate(event.wall_clock))}</span>
          </div>
        </div>`;
    }).join("");
  }

  function renderSeedIds() {
    const seeds = [
      ["Audio evidence", SEED.audio],
      ["OCR receipt", SEED.ocr],
      ["Stock count", SEED.stock],
      ["Poha sale", SEED.sale],
      ["Credit SMS", SEED.credit],
      ["Pending audio", SEED.pendingAudio],
      ["Pending SMS", SEED.pendingSms],
      ["Canonical transaction", SEED.canonicalTx],
    ];
    $("#seed-list").innerHTML = seeds.map(([label, id]) => `
      <div class="seed-item">
        <div><span class="seed-item__label">${esc(label)}</span><code class="seed-item__id">${esc(id)}</code></div>
        <button class="btn btn--small btn--ghost" type="button" data-copy="${esc(id)}">Copy</button>
      </div>
    `).join("");
  }

  function renderExtras() {
    const credits = $("#credits-card");
    if (!state.credits.length) {
      credits.innerHTML = emptyState("No customer credit loaded.");
    } else {
      credits.innerHTML = `
        <div class="card__head"><div><p class="eyebrow">Udhaar</p><h3>Customer credit</h3></div><span class="muted">${state.credits.length} aliases</span></div>
        <div class="extra-list">
          ${state.credits.map((credit) => `
            <div class="extra-row">
              <div>${esc(credit.customer_alias)}<span class="cell-sub">${pct(credit.confidence, 0)} confidence</span></div>
              <div class="extra-row__value">${money(credit.balance_mean)}<span class="cell-sub">± ${money(credit.balance_std_dev)}</span></div>
            </div>`).join("")}
        </div>`;
    }

    const recipes = $("#recipes-card");
    if (!state.recipes.length) {
      recipes.innerHTML = emptyState("No recipe burn rates loaded.");
    } else {
      recipes.innerHTML = `
        <div class="card__head"><div><p class="eyebrow">Recipes</p><h3>Ingredient burn rates</h3></div><span class="muted">${state.recipes.length} lines</span></div>
        <div class="extra-list">
          ${state.recipes.map((recipe) => `
            <div class="extra-row">
              <div>${esc(recipe.dish_name)} · ${esc(recipe.ingredient_name)}<span class="cell-sub">${pct(recipe.confidence, 0)} confidence</span></div>
              <div class="extra-row__value">${num(recipe.qty_per_plate_mean, 4)} ${esc(recipe.unit)}<span class="cell-sub">± ${num(recipe.qty_per_plate_std_dev, 4)} per plate</span></div>
            </div>`).join("")}
        </div>`;
    }
  }

  function renderScenario() {
    const container = $("#scenario-result");
    if (!state.lastScenario) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }
    container.hidden = false;
    if (state.lastScenario.type === "noisy") {
      const { tight, noisy } = state.lastScenario;
      const tightStd = Number(tight.debit.amount_std_dev) || 0;
      const noisyStd = Number(noisy.debit.amount_std_dev) || 0;
      const ratio = tightStd > 0 ? noisyStd / tightStd : 0;
      container.innerHTML = `
        <h3>Live range comparison</h3>
        <p>Same item and quantity; only the quoted-price disagreement differs.</p>
        <div class="receipt-compare">
          <div><span>Tight quotes</span><strong>${money(tight.debit.amount_mean)} ± ${money(tightStd)}</strong></div>
          <div><span>Noisy quotes</span><strong>${money(noisy.debit.amount_mean)} ± ${money(noisyStd)}</strong></div>
          <div><span>Range ratio</span><strong>${ratio.toFixed(2)}×</strong></div>
        </div>
        <div class="button-row">
          <button class="btn btn--small btn--primary" type="button" data-explain="${esc(noisy.transaction_id)}">Open noisy Trust Receipt</button>
        </div>
      `;
      return;
    }
    if (state.lastScenario.type === "pending") {
      const entry = state.lastScenario.entry;
      container.innerHTML = `
        <h3>Pending pair fused</h3>
        <p>Monte Carlo fused the pending audio and SMS events into a balanced entry.</p>
        <div class="receipt-compare">
          <div><span>Amount</span><strong>${money(entry.debit.amount_mean)} ± ${money(entry.debit.amount_std_dev)}</strong></div>
          <div><span>Confidence</span><strong>${pct(entry.confidence, 0)}</strong></div>
          <div><span>Status</span><strong>${esc(entry.status)}</strong></div>
        </div>
        <div class="button-row">
          <button class="btn btn--small btn--primary" type="button" data-explain="${esc(entry.transaction_id)}">Open Trust Receipt</button>
        </div>
      `;
    }
  }

  function renderApiLinks() {
    const base = state.apiBase.replace(/\/+$/, "");
    const docs = document.getElementById("docs-link");
    const openapi = document.getElementById("openapi-link");
    if (docs) docs.href = `${base}/docs`;
    if (openapi) openapi.href = `${base}/openapi.json`;
  }

  function renderReceipt(explanation) {
    const entry = findLedger(explanation.transaction_id);
    const rangeMap = new Map(explanation.per_source_ranges.map((range) => [range.event_id, range]));
    const sourceCards = explanation.sources.length
      ? explanation.sources.map((source) => {
          const range = rangeMap.get(source.event_id);
          return `
            <article class="source-card">
              <div class="source-card__top">
                <span class="chip chip--${sourceClass(source.source)}">${esc(source.source)} · ${esc(source.device_id)}</span>
                <span class="muted">${pct(source.confidence, 0)} confidence</span>
              </div>
              <div class="source-card__meta">
                <div><span>Item</span><strong>${esc(source.item)}</strong></div>
                <div><span>Quantity</span><strong>${num(source.qty, 2)} ${esc(source.unit)}</strong></div>
                <div><span>Extended price</span><strong>${source.price == null ? "missing → default" : money(source.price)}</strong></div>
                <div><span>Unit price</span><strong>${money(source.unit_price)}</strong></div>
                <div><span>Logical clock</span><strong>${esc(source.logical_clock)}</strong></div>
                <div><span>Wall clock</span><strong>${esc(fmtDate(source.wall_clock))}</strong></div>
              </div>
              <div class="badge-stack" style="margin-top:.55rem">
                ${source.clock_suspect ? '<span class="tag tag--red">suspect wall clock</span>' : '<span class="tag tag--green">trusted clock</span>'}
                ${range ? `<span class="tag tag--quiet">single-source ${money(range.amount_mean)} ± ${money(range.amount_std_dev)}</span>` : ""}
              </div>
            </article>`;
        }).join("")
      : emptyState("No priced entity was found for this entry.");

    const ranges = explanation.per_source_ranges.map((range) => {
      const source = explanation.sources.find((item) => item.event_id === range.event_id);
      return { ...range, source };
    });
    const maxRangeMean = Math.max(1, ...ranges.map((range) => Number(range.amount_mean) || 0), Number(explanation.simulated_amount_mean) || 0);
    const counterfactuals = ranges.map((range) => `
      <div class="counterfactual">
        <span>${esc(range.source?.source || "source")} · ${esc(shortDevice(range.source?.device_id || ""))}</span>
        <div class="counterfactual__track" aria-hidden="true"><span class="counterfactual__fill" style="width:${Math.max(2, (Number(range.amount_mean) / maxRangeMean) * 100)}%"></span></div>
        <span class="counterfactual__value">${money(range.amount_mean)} ± ${money(range.amount_std_dev)}</span>
      </div>`).join("");
    const fusedCounterfactual = `
      <div class="counterfactual">
        <span><strong>Fused</strong></span>
        <div class="counterfactual__track" aria-hidden="true"><span class="counterfactual__fill" style="width:${Math.max(2, (Number(explanation.simulated_amount_mean) / maxRangeMean) * 100)}%"></span></div>
        <span class="counterfactual__value">${money(explanation.simulated_amount_mean)} ± ${money(explanation.simulated_amount_std_dev)}</span>
      </div>`;

    const agreement = explanation.agreement;
    $("#receipt-title").textContent = entry
      ? `${entry.debit.account} → ${entry.credit.account}`
      : "Evidence explanation";
    $("#receipt-body").innerHTML = `
      <div class="receipt-hero">
        <div>
          <p class="eyebrow">Stored entry ${esc(explanation.status)}</p>
          <div class="receipt-amount">${money(explanation.amount_mean)}</div>
          <p class="receipt-sub">± ${money(explanation.amount_std_dev)} · confidence ${pct(explanation.confidence, 0)}</p>
        </div>
        <div class="badge-stack">
          ${explanation.canonical_fallback ? '<span class="tag tag--amber">pinned demo seed</span>' : '<span class="tag tag--green">live simulation</span>'}
          ${explanation.sources.some((source) => source.clock_suspect) ? '<span class="tag tag--red">suspect clock</span>' : ""}
          <span class="tag">${explanation.sources.length} source${explanation.sources.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div class="receipt-compare">
        <div><span>Stored value</span><strong>${money(explanation.amount_mean)} ± ${money(explanation.amount_std_dev)}</strong></div>
        <div><span>Live Monte Carlo</span><strong>${money(explanation.simulated_amount_mean)} ± ${money(explanation.simulated_amount_std_dev)}</strong></div>
        <div><span>Confidence</span><strong>${pct(explanation.confidence, 0)} / ${pct(explanation.simulated_confidence, 0)}</strong></div>
      </div>

      ${explanation.canonical_fallback ? '<div class="receipt-callout">This is the canonical demo seed, pinned for rehearsal. The live Monte Carlo above is what the same evidence actually produces.</div>' : ""}

      <section class="receipt-section">
        <h3>Evidence</h3>
        <div class="source-grid">${sourceCards}</div>
      </section>

      <section class="receipt-section">
        <h3>Agreement</h3>
        <div class="agreement-grid">
          <div><span>Verdict</span><strong>${verdictTag(agreement.verdict)}</strong></div>
          <div><span>Price spread</span><strong>${pctPoints(agreement.price_spread_pct, 1)}</strong></div>
          <div><span>Range multiplier</span><strong>${num(agreement.std_multiplier, 2)}×</strong></div>
          <div><span>Confidence delta</span><strong>${confidenceDelta(agreement.confidence_adjustment)}</strong></div>
        </div>
        <p class="muted" style="margin:.55rem 0 0">Mean source confidence ${pct(agreement.mean_source_confidence, 1)}. Method: ${esc(agreement.method)}.</p>
      </section>

      ${ranges.length ? `
      <section class="receipt-section">
        <h3>Counterfactual ranges</h3>
        <div class="counterfactual-grid">
          ${counterfactuals}
          ${ranges.length > 1 ? fusedCounterfactual : ""}
        </div>
      </section>` : ""}

      <section class="receipt-section">
        <h3>Why</h3>
        <p class="narrative">${esc(explanation.narrative)}</p>
      </section>

      ${(explanation.evidence_event_ids || []).length ? `
      <section class="receipt-section">
        <h3>Evidence IDs</h3>
        <div class="evidence-id-list">
          ${(explanation.evidence_event_ids || []).map((id) => `<span class="evidence-id">${esc(id)}</span>`).join("")}
        </div>
      </section>` : ""}
    `;
  }

  async function openReceipt(transactionId, button) {
    setButtonBusy(button, true);
    try {
      const explanation = await api(`/ledger/${encodeURIComponent(transactionId)}/explain`);
      renderReceipt(explanation);
      openSheet("#receipt-sheet");
    } catch (error) {
      toast(error.message || "Could not load the Trust Receipt.", "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  /* ---------- Scenario runners ---------- */

  async function runMoneyShot(button) {
    await runAction(button, async () => {
      const entry = await api("/fuse", { method: "POST", body: { event_ids: [SEED.audio, SEED.ocr] } });
      await refreshAll({ quiet: true });
      toast(`Canonical fusion: ${money(entry.debit.amount_mean)} ± ${money(entry.debit.amount_std_dev)}.`);
      await openReceipt(entry.transaction_id);
    });
  }

  async function runNoisyScenario(button) {
    await runAction(button, async () => {
      await api("/demo/reset", { method: "POST" });
      state.lastMerge = null;
      state.lastClock = null;
      state.lastScenario = null;

      const createEvent = (price, label) => api("/events", {
        method: "POST",
        body: {
          source: "manual",
          raw_text: `Synthetic ${label} supplier quote`,
          device_id: label.endsWith("A") ? "device-a" : "device-b",
          extracted_entities: [{ item: "onion", qty: 2, unit: "kg", price }],
        },
      });

      const tightA = await createEvent(100, "tight A");
      const tightB = await createEvent(100, "tight B");
      const noisyA = await createEvent(100, "noisy A");
      const noisyB = await createEvent(140, "noisy B");
      const tight = await api("/fuse", { method: "POST", body: { event_ids: [tightA.event_id, tightB.event_id] } });
      const noisy = await api("/fuse", { method: "POST", body: { event_ids: [noisyA.event_id, noisyB.event_id] } });

      state.lastScenario = { type: "noisy", tight, noisy };
      await refreshAll({ quiet: true });
      switchTab("more");
      const ratio = Number(tight.debit.amount_std_dev) > 0
        ? (Number(noisy.debit.amount_std_dev) / Number(tight.debit.amount_std_dev)).toFixed(2)
        : "—";
      toast(`Noisy quotes: ${money(noisy.debit.amount_std_dev)} vs ${money(tight.debit.amount_std_dev)} (${ratio}×).`);
    });
  }

  async function runPendingPair(button) {
    await runAction(button, async () => {
      await api("/demo/reset", { method: "POST" });
      state.lastMerge = null;
      state.lastClock = null;
      const entry = await api("/fuse", { method: "POST", body: { event_ids: [SEED.pendingAudio, SEED.pendingSms] } });
      state.lastScenario = { type: "pending", entry };
      await refreshAll({ quiet: true });
      switchTab("more");
      toast(`Pending pair fused: ${money(entry.debit.amount_mean)} ± ${money(entry.debit.amount_std_dev)}.`);
    });
  }

  async function runSync(button) {
    await runAction(button, async () => {
      const result = await api("/sync", { method: "POST", body: {} });
      state.lastMerge = result;
      await refreshAll({ quiet: true });
      switchTab("sync");
      toast(`Sync complete: ${result.conflicts_resolved} conflicts resolved, 0 transactions lost.`);
    });
  }

  async function runClock(button) {
    await runAction(button, async () => {
      const result = await api("/simulate-clock", { method: "POST", body: { device_id: "device-b" } });
      state.lastClock = result;
      await refreshAll({ quiet: true });
      switchTab("sync");
      toast(`1970 clock detected; entry placed at logical clock ${result.logical_clock_used}.`);
    });
  }

  async function runReset(button) {
    await runAction(button, async () => {
      await api("/demo/reset", { method: "POST" });
      state.lastMerge = null;
      state.lastClock = null;
      state.lastScenario = null;
      closeAllSheets();
      await refreshAll({ quiet: true });
      toast("Demo restored to the seed state.");
    });
  }

  const ACTIONS = {
    "money-shot": runMoneyShot,
    noisy: runNoisyScenario,
    "pending-pair": runPendingPair,
    sync: runSync,
    clock: runClock,
    reset: runReset,
  };

  /* ---------- Events ---------- */

  function bindEvents() {
    $("#refresh-btn").addEventListener("click", () => refreshAll());
    $("#retry-btn").addEventListener("click", () => refreshAll());
    $("#fab").addEventListener("click", () => openSheet("#actions-sheet"));

    $$(".bottomnav__item").forEach((item) => {
      item.addEventListener("click", () => switchTab(item.dataset.tab));
    });

    $$("#ledger-filters .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.ledgerFilter = chip.dataset.filter;
        $$("#ledger-filters .chip").forEach((item) => item.classList.toggle("is-active", item === chip));
        renderLedger();
      });
    });

    $("#pending-toggle").addEventListener("change", (event) => {
      state.pendingOnly = event.target.checked;
      renderEvents();
    });

    $("#api-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("#api-base");
      const raw = input.value.trim();
      let base = raw;
      try {
        const url = new URL(base || state.apiBase);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
        base = url.origin;
      } catch {
        toast("Enter a valid http(s) API base.", "error");
        return;
      }
      state.apiBase = base.replace(/\/+$/, "");
      window.localStorage.setItem("iw-api-base", state.apiBase);
      input.value = state.apiBase;
      refreshAll();
    });

    const themeToggle = $("#theme-toggle");
    themeToggle.checked = document.documentElement.dataset.theme === "dark";
    themeToggle.addEventListener("change", () => {
      const theme = themeToggle.checked ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
      window.localStorage.setItem("iw-theme", theme);
    });

    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-modal]")) {
        closeSheet("#receipt-sheet");
        return;
      }
      if (event.target.closest("[data-close-sheet]")) {
        closeSheet("#actions-sheet");
        return;
      }
      const action = event.target.closest("[data-action]");
      if (action) {
        closeSheet("#actions-sheet");
        const runner = ACTIONS[action.dataset.action];
        if (runner) runner(action);
        return;
      }
      const explain = event.target.closest("[data-explain]");
      if (explain) {
        openReceipt(explain.dataset.explain, explain);
        return;
      }
      const copy = event.target.closest("[data-copy]");
      if (copy) copyText(copy.dataset.copy);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllSheets();
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (!window.location.protocol.startsWith("http")) return;
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  function boot() {
    bindEvents();
    renderSeedIds();
    $("#api-base").value = state.apiBase;
    switchTab("today");
    window.setTimeout(hideSplash, 2600);
    refreshAll();
    registerServiceWorker();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
