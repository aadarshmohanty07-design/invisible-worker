(() => {
  "use strict";

  const SOURCE_CLASSES = new Set(["audio", "ocr", "sms", "manual"]);

  const TAB_SUBTITLES = {
    today: "Your money",
    ledger: "All notes",
    sync: "Saved here. Syncs later.",
    more: "Stock and settings",
  };

  const SOURCE_NAMES = { audio: "Voice note", ocr: "Bill photo", sms: "SMS", manual: "Typed note" };
  const STATUS_LABELS = { fused: "Checked", posted: "Saved", pending: "To check", voided: "Cancelled" };
  const STATUS_TONES = { fused: "green", posted: "quiet", pending: "amber", voided: "red" };
  const CAUSE_NAMES = { spoilage: "Rotted", theft: "Stolen", personal_consumption: "Taken home" };

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
    snapshot: null,
    summary: null,
    ledger: [],
    events: [],
    devices: [],
    truth: null,
    notes: [],
    stock: null,
    syncInfo: null,
    empty: true,
    seed: false,
    actionBusy: false,
    firstRefreshDone: false,
    add: {
      kind: "typed",
      direction: "out",
      mediaBlob: null,
      mediaUrl: null,
      recording: false,
      recorder: null,
      stream: null,
      chunks: [],
      timer: null,
      seconds: 0,
    },
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
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number) ? moneyFormatter.format(number) : "—";
  }

  function num(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "—";
  }

  function qtyLabel(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
  }

  function pct(value, digits = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : "—";
  }

  function pctPoints(value, digits = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(digits)}%` : "—";
  }

  const COUNT_FORMATS = {
    money: (value) => money(value),
    int: (value) => String(Math.round(value)),
    pct: (value) => pct(value, 0),
  };
  const countValues = new Map();

  function countUp(root = document) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    root.querySelectorAll("[data-count]").forEach((element) => {
      const target = Number(element.dataset.count);
      if (!Number.isFinite(target)) return;
      const key = element.dataset.countKey || element.className;
      const format = COUNT_FORMATS[element.dataset.countFormat] || COUNT_FORMATS.int;
      const previous = countValues.has(key) ? countValues.get(key) : 0;
      countValues.set(key, target);
      if (previous === target) return;
      const started = performance.now();
      const duration = 820;
      element.textContent = format(previous);
      const tick = (now) => {
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = format(previous + (target - previous) * eased);
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
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

  function phoneName(deviceId) {
    const suffix = String(deviceId || "").split("-").pop();
    return suffix && suffix.length <= 2 ? `Phone ${suffix.toUpperCase()}` : "This phone";
  }

  function sourceName(source) {
    return SOURCE_NAMES[String(source)] || "Note";
  }

  function dayLabel(value) {
    if (!value) return "Today";
    const text = String(value);
    const date = new Date(text.length === 10 ? `${text}T00:00:00` : text);
    if (Number.isNaN(date.getTime())) return text;
    return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" }).format(date);
  }

  function timeLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(date);
  }

  function entryInfo(entry) {
    const debit = String(entry.debit?.account || "");
    const credit = String(entry.credit?.account || "");
    const name = (account) => account.split(":").slice(1).join(":").trim();
    if (debit.startsWith("Inventory:")) return { title: `Bought ${name(debit).toLowerCase()}`, direction: "out" };
    if (credit.startsWith("Sales:")) return { title: `Sold ${name(credit).toLowerCase()}`, direction: "in" };
    if (credit.startsWith("Udhaar:")) return { title: `${name(credit)} paid back`, direction: "in" };
    if (debit.startsWith("Udhaar:")) return { title: `Gave ${name(debit)} credit`, direction: "out" };
    const incoming = debit === "Cash" && credit !== "Cash";
    return { title: incoming ? "Money in" : "Money out", direction: incoming ? "in" : "out" };
  }

  function sourceClass(source) {
    const value = String(source);
    return SOURCE_CLASSES.has(value) ? value : "manual";
  }

  function statusTag(status) {
    return `<span class="tag tag--${STATUS_TONES[status] || "quiet"}">${STATUS_LABELS[status] || esc(status)}</span>`;
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
      toast("Wait for the other step to finish.", "error");
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
      toast("Copied.");
    } catch {
      toast("Could not copy. Press and hold the text.", "error");
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
    const anyOpen = ["#receipt-sheet", "#add-sheet", "#stock-sheet"].some((selector) => {
      const element = $(selector);
      return element && !element.hidden;
    });
    if (!anyOpen) document.body.style.overflow = "";
  }

  function closeAllSheets() {
    closeSheet("#receipt-sheet");
    closeAddSheet();
    closeSheet("#stock-sheet");
  }

  function hideSplash() {
    const splash = $("#splash");
    if (!splash || splash.classList.contains("is-hide")) return;
    splash.classList.add("is-hide");
    splash.setAttribute("aria-hidden", "true");
    window.setTimeout(() => splash.remove(), 600);
  }

  async function refreshLocal() {
    try {
      const snapshot = await IWLocal.snapshot();
      state.snapshot = snapshot;
      state.summary = snapshot.summary;
      state.ledger = snapshot.ledger;
      state.events = snapshot.events;
      state.devices = snapshot.devices;
      state.truth = snapshot.truth;
      state.notes = snapshot.notes;
      state.syncInfo = snapshot.syncInfo;
      state.stock = snapshot.stock;
      state.empty = snapshot.empty;
      state.seed = snapshot.seed;
      setStatus("ok", "Saved");
      hideBanner();
      renderAll();
      if (!state.firstRefreshDone) {
        state.firstRefreshDone = true;
        window.setTimeout(hideSplash, 260);
        window.setTimeout(() => countUp(), 340);
      } else {
        countUp();
      }
    } catch (error) {
      console.error(error);
      setStatus("error", "Problem");
      showBanner("Could not read the notes on this phone. Reload the app.");
    }
  }

  /* ---------- Renderers ---------- */

  function renderAll() {
    const numbersFold = $("#numbers-fold");
    if (numbersFold) numbersFold.hidden = state.notes.length === 0;
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
    renderOrder();
    renderEvents();
  }

  function renderStatus() {
    const businessDate = $("#business-date");
    const dayNote = $("#day-note");
    const seedPill = $("#seed-pill");
    const total = state.notes.length;
    businessDate.textContent = dayLabel(state.snapshot?.day || new Date());
    dayNote.textContent = total > 0 ? `${total} notes` : "No notes";
    if (seedPill) seedPill.hidden = !state.seed;
    const deviceLine = $("#device-line");
    if (deviceLine) {
      deviceLine.textContent = total > 0
        ? `${total} note${total === 1 ? "" : "s"} saved on this phone. It works without internet.`
        : "Notes are saved here, even without internet.";
    }
  }

  function renderProfit() {
    const card = $("#profit-card");
    const summary = state.summary;
    if (state.empty || !summary) {
      card.innerHTML = `
        <p class="eyebrow">Today</p>
        <p class="hero-amount">₹0</p>
        <p class="hero-sub">No notes yet. Add what you spent or got.</p>
        <div class="button-row">
          <button class="btn btn--light" type="button" data-action="add-note">Add a note</button>
          <button class="btn btn--hero-line" type="button" data-action="load-example">See an example day</button>
        </div>
      `;
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
    card.innerHTML = `
      <div class="hero-top">
        <div>
          <p class="eyebrow">You made today</p>
          <p class="hero-amount" data-count="${Number(summary.profit_mean)}" data-count-format="money" data-count-key="profit">${money(summary.profit_mean)}</p>
          <p class="hero-sub">Give or take ${money(summary.profit_std_dev)}</p>
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
      <div class="money-rows">
        <div class="money-row"><span>Money in</span><strong>${money(summary.revenue_mean)}</strong></div>
        <div class="money-row"><span>Money out</span><strong>${money(summary.cogs_mean)}</strong></div>
        <div class="money-row"><span>Missing</span><strong>${money(summary.loss_mean)}</strong></div>
      </div>
    `;
  }

  function renderMoneyShot() {
    const card = $("#money-shot-card");
    const seedEntry = findLedger("seed-tomato");
    const entry = seedEntry || [...state.ledger].sort((a, b) => b.logical_clock - a.logical_clock)[0];
    if (!entry) {
      card.hidden = true;
      card.innerHTML = "";
      return;
    }
    card.hidden = false;
    const sourceEvents = entry.event_ids.map(findEvent).filter(Boolean);
    const sourceKinds = [...new Set(sourceEvents.map((event) => event.source))];
    const suspect = sourceEvents.some((event) => isSuspectWallClock(event.wall_clock));
    const qty = entry.debit.qty_mean != null ? `${num(entry.debit.qty_mean, 0)} ${entry.debit.unit || ""}`.trim() : "";
    const count = entry.event_ids.length;
    const headline = seedEntry ? "Tomato bill" : "Latest note";
    card.innerHTML = `
      <div class="card__head">
        <div><h3>${headline}</h3></div>
        ${statusTag(entry.status)}
      </div>
      <p class="shot-amount" data-count="${Number(entry.debit.amount_mean)}" data-count-format="money" data-count-key="shot:${esc(entry.transaction_id)}">${money(entry.debit.amount_mean)}</p>
      <p class="sub-number">Give or take ${money(entry.debit.amount_std_dev)}</p>
      <p class="shot-line">${count > 1 ? `${count} notes agree` : "One note"}: ${money(entry.debit.amount_mean)}${qty ? ` for ${esc(qty)}` : ""}.</p>
      <div class="evidence-chips">${sourceKinds.map((source) => `<span class="chip chip--${sourceClass(source)}">${sourceName(source)}</span>`).join("")}</div>
      ${suspect ? '<p class="faint" style="margin:8px 0 0">One note had a wrong date. We still used it.</p>' : ""}
      <div class="button-row">
        <button class="btn btn--primary" type="button" data-explain="${esc(entry.transaction_id)}">Why ${money(entry.debit.amount_mean)}?</button>
      </div>
    `;
  }

  function renderGhost() {
    const card = $("#ghost-card");
    card.hidden = false;
    const reconciliation = state.truth?.reconciliation;
    if (!reconciliation) {
      card.innerHTML = `
        <div class="card__head"><div><h3>Stock check</h3></div></div>
        <p class="stock-line">No count yet. Count what is left to see what is missing.</p>
        <div class="button-row"><button class="btn btn--outline" type="button" data-action="open-stock">Count stock</button></div>
      `;
      return;
    }
    const expected = Number(reconciliation.expected_on_hand_qty) || 0;
    const counted = Number(reconciliation.counted_qty) || 0;
    const countedPct = expected > 0 ? Math.max(0, Math.min(100, (counted / expected) * 100)) : 0;
    const missingPct = Math.max(0, 100 - countedPct);
    const consistent = Boolean(reconciliation.consistent_within_1_sigma);
    const usual = Number(reconciliation.modeled_loss_qty_mean);
    card.innerHTML = `
      <div class="card__head">
        <div><h3>Stock check</h3></div>
        <span class="tag tag--amber">${esc(reconciliation.item)}</span>
      </div>
      <p class="ghost-number">${num(reconciliation.missing_qty, 1)} kg short <small>about ${money(reconciliation.missing_value)}</small></p>
      <p class="stock-line">You counted ${num(counted, 1)} kg. The book expected ${num(expected, 1)} kg.</p>
      <div class="stock-bar" aria-hidden="true">
        <span class="stock-bar__expected"></span>
        <span class="stock-bar__counted" style="width:${countedPct}%"></span>
        <span class="stock-bar__missing" style="width:${missingPct}%"></span>
      </div>
      <div class="stock-legend"><span>Counted ${num(counted, 1)} kg</span><span>Expected ${num(expected, 1)} kg</span></div>
      <p class="consistency${consistent ? "" : " consistency--warn"}">${consistent ? "Within the usual loss." : "More than usual."} About ${num(usual, 1)} kg goes missing on a normal day.</p>
    `;
  }

  function stepName(label) {
    const text = String(label);
    if (/revenue/i.test(text)) return "Money in";
    if (/cogs|cost/i.test(text)) return "Money out";
    if (/loss/i.test(text)) return "Missing";
    if (/profit/i.test(text)) return "You made";
    return text;
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
      card.innerHTML = emptyState("The breakdown is unavailable.");
      return;
    }
    const maxAbs = Math.max(1, ...steps.map((step) => Math.abs(Number(step.amount_mean) || 0)));
    const rows = steps.map((step) => {
      const isTotal = /profit/i.test(step.label);
      const isNegative = Number(step.amount_mean) < 0;
      const width = Math.max(2, (Math.abs(Number(step.amount_mean) || 0) / maxAbs) * 100);
      return `
        <div class="waterfall__row${isTotal ? " waterfall__row--total" : ""}">
          <span class="waterfall__label">${esc(stepName(step.label))}</span>
          <div class="waterfall__track" aria-hidden="true"><span class="waterfall__bar${isNegative ? " waterfall__bar--negative" : ""}${isTotal ? " waterfall__bar--total" : ""}" style="width:${width}%"></span></div>
          <span class="waterfall__value">${money(Math.abs(Number(step.amount_mean) || 0))} <span class="faint">give or take ${money(step.amount_std_dev)}</span></span>
        </div>`;
    }).join("");
    card.innerHTML = `
      <div class="card__head"><div><h3>Money in and out</h3></div></div>
      <div class="waterfall">${rows}</div>
    `;
  }

  function renderLoss() {
    const card = $("#loss-card");
    const components = state.truth?.loss_components || [];
    if (!components.length) {
      card.hidden = true;
      card.innerHTML = "";
      return;
    }
    card.hidden = false;
    const stack = components.map((component) => {
      const width = Math.max(0, Math.min(100, Number(component.share_mean) * 100));
      const color = LOSS_COLORS[component.cause] || LOSS_FALLBACK;
      return `<span style="width:${width}%;background:${color}" title="${esc(CAUSE_NAMES[component.cause] || component.cause)}"></span>`;
    }).join("");
    const rows = components.map((component) => {
      const color = LOSS_COLORS[component.cause] || LOSS_FALLBACK;
      return `
        <div class="loss-legend__row">
          <span class="loss-legend__name"><span class="swatch" style="background:${color}"></span>${esc(CAUSE_NAMES[component.cause] || String(component.cause).replace(/_/g, " "))}</span>
          <span class="loss-legend__value">${pct(component.share_mean, 0)}</span>
        </div>`;
    }).join("");
    const total = Number(state.summary?.loss_mean);
    card.innerHTML = `
      <div class="card__head"><div><h3>${Number.isFinite(total) ? `Where the missing ${money(total)} went` : "Where the missing money went"}</h3></div></div>
      <div class="loss-stack" aria-hidden="true">${stack}</div>
      <div class="loss-legend">${rows}</div>
    `;
  }

  function renderEvidence() {
    const card = $("#evidence-card");
    const truth = state.truth;
    if (!truth) {
      card.innerHTML = emptyState("No notes yet.");
      return;
    }
    const evidence = truth.evidence_summary;
    const mix = Object.entries(evidence.source_mix || {})
      .map(([source, count]) => `<span class="chip chip--${sourceClass(source)}">${sourceName(source)} ${esc(count)}</span>`)
      .join("");
    card.innerHTML = `
      <div class="card__head"><div><h3>Today's notes</h3></div></div>
      <div class="receipt-compare">
        <div><span>Notes that came in</span><strong>${esc(evidence.total_events)}</strong></div>
        <div><span>Two notes, one record</span><strong>${esc(evidence.fused_entries)}</strong></div>
        <div><span>Wrong date</span><strong>${esc(evidence.suspect_clock_events)}</strong></div>
        <div><span>How sure on average</span><strong>${pct(evidence.average_confidence, 0)}</strong></div>
      </div>
      <div class="evidence-chips">${mix}</div>
      <div class="fingerprint">
        <span class="faint">Proof code</span>
        <code>${esc(truth.ledger_fingerprint)}</code>
      </div>
      <div class="button-row">
        <button class="btn btn--small btn--outline" type="button" data-copy="${esc(truth.ledger_fingerprint)}">Copy proof code</button>
      </div>
    `;
  }

  function ledgerMatchesFilter(entry) {
    if (state.ledgerFilter === "all") return true;
    if (state.ledgerFilter === "in" || state.ledgerFilter === "out") {
      return entryInfo(entry).direction === state.ledgerFilter;
    }
    if (state.ledgerFilter === "pending") return entry.status === "pending";
    return true;
  }

  function renderLedger() {
    const list = $("#ledger-list");
    const entries = state.ledger.filter(ledgerMatchesFilter);
    if (!state.ledger.length) {
      list.innerHTML = emptyState("No records yet. Start over from More.");
      return;
    }
    if (!entries.length) {
      list.innerHTML = emptyState("Nothing here.");
      return;
    }
    list.innerHTML = entries.map((entry) => {
      const info = entryInfo(entry);
      const probe = is1970(entry) || entry.clock_suspect;
      const sources = [...new Set(entry.event_ids.map(findEvent).filter(Boolean).map((event) => sourceName(event.source)))];
      const qty = entry.debit.qty_mean != null ? `${qtyLabel(entry.debit.qty_mean)} ${entry.debit.unit || ""}`.trim() : "";
      const range = Number(entry.debit.amount_std_dev) > 0 ? `give or take ${money(entry.debit.amount_std_dev)}` : "";
      return `
        <button class="entry" type="button" data-explain="${esc(entry.transaction_id)}">
          <span class="entry__top">
            <span class="entry__title">${esc(info.title)}</span>
            ${statusTag(entry.status)}
            ${probe ? '<span class="tag tag--red">Wrong date</span>' : ""}
          </span>
          <span class="entry__amount">
            <strong>${info.direction === "out" ? "− " : "+ "}<span data-count="${Number(entry.debit.amount_mean)}" data-count-format="money" data-count-key="entry:${esc(entry.transaction_id)}">${money(entry.debit.amount_mean)}</span></strong>
            ${range ? `<span>${range}</span>` : ""}
          </span>
          <span class="entry__sub">${esc([qty, sources.join(" + ")].filter(Boolean).join(" · "))}</span>
          <span class="entry__foot">
            <span class="entry__sure">${pct(entry.confidence, 0)} sure</span>
            ${CHEVRON}
          </span>
        </button>`;
    }).join("");
  }

  function renderDevices() {
    const grid = $("#device-grid");
    if (!state.devices.length) {
      grid.innerHTML = emptyState("This phone is not set up yet.");
      return;
    }
    grid.innerHTML = state.devices.map((device) => `
      <article class="device">
        <div class="device__top">
          <span class="device__name">${esc(device.label || phoneName(device.device_id))}</span>
          <span class="device__status"><span class="dot online"></span>${device.status === "saved" ? "Saved here" : "Synced"}</span>
        </div>
        <p class="device__line">${Number(device.notes) || 0} note${device.notes === 1 ? "" : "s"}</p>
      </article>`).join("");
  }

  function renderMergeLog() {
    const card = $("#merge-log-card");
    if (!state.syncInfo) {
      card.innerHTML = `
        <div class="card__head"><div><h3>Sync</h3></div></div>
        <p class="log__empty">Tap “Sync with shop” to look for notes from another phone.</p>
      `;
      return;
    }
    const info = state.syncInfo;
    const parts = [];
    if (info.pulled) parts.push(`${info.pulled} note${info.pulled === 1 ? "" : "s"} came from another phone.`);
    if (info.pushed) parts.push(`${info.pushed} note${info.pushed === 1 ? "" : "s"} sent.`);
    if (!parts.length) parts.push("Everything was already on this phone.");
    card.innerHTML = `
      <div class="card__head"><div><h3>Sync</h3></div><span class="tag tag--green">Done</span></div>
      <p class="result-line">${parts.join(" ")}</p>
      <p class="faint" style="margin:8px 0 0">Checked ${esc(fmtDate(info.at))}</p>
    `;
  }

  function renderOrder() {
    const order = $("#ledger-order");
    const proof = $("#probe-proof");
    if (!state.notes.length) {
      order.innerHTML = "";
      proof.textContent = "No notes yet.";
      return;
    }
    order.innerHTML = state.notes.map((note) => {
      const wrong = IWLocal.isWrongClock(note.createdAt);
      const label = note.deviceId === IWLocal.deviceId() ? "This phone" : phoneName(note.deviceId);
      return `<span class="order-pill${wrong ? " order-pill--probe" : ""}"><strong>${esc(note.order)}</strong> ${esc(label)}</span>`;
    }).join("");
    const wrongIndex = state.notes.findIndex((note) => IWLocal.isWrongClock(note.createdAt));
    if (wrongIndex < 0) {
      proof.textContent = "No note with a wrong date yet.";
      return;
    }
    proof.innerHTML = `The wrong-date note is number <strong>${wrongIndex + 1}</strong> of ${state.notes.length}, not number 1.`;
  }

  function renderEvents() {
    const list = $("#events-body");
    if (!state.events.length) {
      list.innerHTML = emptyState("No notes on this phone yet.");
      return;
    }
    list.innerHTML = state.events.map((event) => {
      const entity = event.extracted_entities?.[0];
      const entityText = entity
        ? `${esc(entity.item)} · ${qtyLabel(entity.qty)} ${esc(entity.unit)}${entity.price != null ? ` · ${money(entity.price)}` : ""}`
        : "No item was read";
      const wrong = isSuspectWallClock(event.wall_clock);
      return `
        <div class="event">
          <div class="event__top">
            <span class="chip chip--${sourceClass(event.source)}">${esc(sourceName(event.source))}</span>
            ${wrong ? '<span class="tag tag--red">Wrong date</span>' : ""}
            <span class="event__device">${esc(event.device_label || phoneName(event.device_id))}${wrong ? "" : ` · ${esc(timeLabel(event.wall_clock))}`}</span>
          </div>
          <div class="event__text">${esc(truncate(event.raw_text, 110) || "—")}</div>
          <div class="event__meta">
            <span>${entityText}</span>
          </div>
        </div>`;
    }).join("");
  }

  function renderReceipt(explanation) {
    const entry = findLedger(explanation.transaction_id);
    const title = entry ? entryInfo(entry).title : "This record";
    const rangeMap = new Map(explanation.per_source_ranges.map((range) => [range.event_id, range]));
    const sources = explanation.sources || [];
    const evidenceEvents = (explanation.evidence_event_ids || []).map(findEvent).filter(Boolean);
    const sourceCards = sources.length
      ? sources.map((source) => {
          const range = rangeMap.get(source.event_id);
          const event = findEvent(source.event_id);
          const text = event?.raw_text ? truncate(event.raw_text, 120) : "";
          const time = source.clock_suspect ? "" : timeLabel(source.wall_clock);
          const facts = [
            `${qtyLabel(source.qty)} ${esc(source.unit)} ${esc(source.item)}`,
            source.price == null ? "price not read" : money(source.price),
            time,
          ].filter(Boolean).map((fact) => `<span>${fact}</span>`).join("");
          const label = source.device_label || phoneName(source.device_id);
          return `
            <article class="source-card">
              <div class="source-card__top">
                <span class="chip chip--${sourceClass(source.source)}">${esc(sourceName(source.source))} · ${esc(label)}</span>
                <span class="muted">${pct(source.confidence, 0)} sure</span>
              </div>
              ${text ? `<p class="source-note">“${esc(text)}”</p>` : ""}
              <div class="source-media" data-media="${esc(source.event_id)}" hidden></div>
              <div class="source-facts">${facts}</div>
              ${range ? `<div class="source-facts"><span>On its own: ${money(range.amount_mean)}</span></div>` : ""}
              ${source.clock_suspect ? '<span class="tag tag--red" style="margin-top:8px">Wrong date on this note</span>' : ""}
            </article>`;
        }).join("")
      : evidenceEvents.length
        ? evidenceEvents.map((event) => `
            <article class="source-card">
              <div class="source-card__top">
                <span class="chip chip--${sourceClass(event.source)}">${esc(sourceName(event.source))} · ${esc(event.device_label || phoneName(event.device_id))}</span>
                <span class="muted">${isSuspectWallClock(event.wall_clock) ? "" : esc(timeLabel(event.wall_clock))}</span>
              </div>
              ${event.raw_text ? `<p class="source-note">“${esc(truncate(event.raw_text, 120))}”</p>` : ""}
              <div class="source-media" data-media="${esc(event.event_id)}" hidden></div>
              <div class="source-facts"><span>The amount was written in this note.</span></div>
              ${isSuspectWallClock(event.wall_clock) ? '<span class="tag tag--red" style="margin-top:8px">Wrong date on this note</span>' : ""}
            </article>`).join("")
        : emptyState("No note could be read for this record.");

    const ranges = explanation.per_source_ranges.map((range) => ({
      ...range,
      source: sources.find((item) => item.event_id === range.event_id),
    }));
    const maxRangeMean = Math.max(1, ...ranges.map((range) => Number(range.amount_mean) || 0), Number(explanation.simulated_amount_mean) || 0);
    const counterfactuals = ranges.map((range) => `
      <div class="counterfactual">
        <span>${esc(sourceName(range.source?.source))} only</span>
        <div class="counterfactual__track" aria-hidden="true"><span class="counterfactual__fill" style="width:${Math.max(2, (Number(range.amount_mean) / maxRangeMean) * 100)}%"></span></div>
        <span class="counterfactual__value">${money(range.amount_mean)}</span>
      </div>`).join("");
    const fusedRow = ranges.length > 1
      ? `<div class="counterfactual">
          <span><strong>Both notes</strong></span>
          <div class="counterfactual__track" aria-hidden="true"><span class="counterfactual__fill" style="width:${Math.max(2, (Number(explanation.simulated_amount_mean) / maxRangeMean) * 100)}%"></span></div>
          <span class="counterfactual__value">${money(explanation.simulated_amount_mean)}</span>
        </div>`
      : "";

    const agreement = explanation.agreement;
    const agreeText = agreement.verdict === "agree"
      ? "Yes. The notes say the same amount."
      : agreement.verdict === "disagree"
        ? `No. The prices are ${pctPoints(agreement.price_spread_pct, 0)} apart.`
        : "Only one note, so there is nothing to compare.";
    const whyText = sources.length === 0
      ? "The amount was written directly in one note. There is no second note to compare."
      : agreement.verdict === "agree"
        ? "Two separate notes give the same amount, so the number is strong."
        : agreement.verdict === "disagree"
          ? "The notes disagree, so the number is less certain and the range is wider."
          : "Only one note mentions this, so the number is less certain.";
    const wrongDate = sources.some((source) => source.clock_suspect)
      || evidenceEvents.some((event) => isSuspectWallClock(event.wall_clock));
    const spread = Number(explanation.amount_std_dev) || 0;

    $("#receipt-title").textContent = `Why ${money(explanation.amount_mean)}?`;
    $("#receipt-body").innerHTML = `
      <div class="receipt-hero">
        <div>
          <p class="eyebrow">${esc(title)}</p>
          <div class="receipt-amount" data-count="${Number(explanation.amount_mean)}" data-count-format="money" data-count-key="receipt">${money(explanation.amount_mean)}</div>
          <p class="receipt-sub">${spread > 0 ? `Give or take ${money(spread)} · ` : ""}${pct(explanation.confidence, 0)} sure</p>
        </div>
        <div class="badge-stack">
          ${statusTag(explanation.status)}
          ${wrongDate ? '<span class="tag tag--red">Wrong date</span>' : ""}
        </div>
      </div>

      <section class="receipt-section">
        <h3>What we used</h3>
        <div class="source-grid">${sourceCards}</div>
      </section>

      <section class="receipt-section">
        <h3>Do the notes agree?</h3>
        <p class="result-line">${agreeText}</p>
      </section>

      ${ranges.length ? `
      <section class="receipt-section">
        <h3>If we had only one note</h3>
        <div class="counterfactual-grid">${counterfactuals}${fusedRow}</div>
      </section>` : ""}

      <section class="receipt-section">
        <h3>What this means</h3>
        <p class="result-line">${whyText}${wrongDate ? " The bill photo had a wrong date, but we still used the amount." : ""}</p>
      </section>

      <details class="fold fold--inner">
        <summary>More detail</summary>
        <div class="fold__body">
          <div class="receipt-compare">
            <div><span>Amount</span><strong>${money(explanation.amount_mean)}</strong></div>
            <div><span>How sure</span><strong>${pct(explanation.confidence, 0)}</strong></div>
            <div><span>Notes</span><strong>${sources.length || evidenceEvents.length}</strong></div>
          </div>
          ${explanation.canonical_fallback ? '<p class="faint">This is the fixed example bill used for the demo.</p>' : ""}
          ${(explanation.evidence_event_ids || []).length ? `
            <div class="evidence-id-list">
              ${(explanation.evidence_event_ids || []).map((id) => `<span class="evidence-id">${esc(id)}</span>`).join("")}
            </div>` : ""}
        </div>
      </details>
    `;
  }

  async function openReceipt(transactionId, button) {
    setButtonBusy(button, true);
    try {
      const explanation = await IWLocal.explain(transactionId);
      renderReceipt(explanation);
      openSheet("#receipt-sheet");
      countUp(document.querySelector("#receipt-body") || document);
      hydrateMedia();
    } catch (error) {
      console.error(error);
      toast("Could not open this note. Try again.", "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function hydrateMedia() {
    const holders = document.querySelectorAll("#receipt-body [data-media]");
    for (const holder of holders) {
      if (holder.dataset.loaded) continue;
      const blob = await IWLocal.getMedia(holder.dataset.media);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      if (String(blob.type).startsWith("image/")) {
        const image = document.createElement("img");
        image.src = url;
        image.alt = "Photo attached to this note";
        holder.appendChild(image);
      } else if (String(blob.type).startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = url;
        audio.className = "source-audio";
        holder.appendChild(audio);
      } else {
        continue;
      }
      holder.hidden = false;
      holder.dataset.loaded = "1";
    }
  }

  /* ---------- Scenario runners ---------- */

  /* ---------- Add a note ---------- */

  function resetAddDraft() {
    const add = state.add;
    if (add.timer) window.clearInterval(add.timer);
    if (add.recorder && add.recorder.state !== "inactive") {
      try { add.recorder.stop(); } catch { /* already stopped */ }
    }
    if (add.stream) add.stream.getTracks().forEach((track) => track.stop());
    if (add.mediaUrl) URL.revokeObjectURL(add.mediaUrl);
    state.add = {
      kind: "typed",
      direction: "out",
      mediaBlob: null,
      mediaUrl: null,
      recording: false,
      recorder: null,
      stream: null,
      chunks: [],
      timer: null,
      seconds: 0,
    };
    $("#capture-row").hidden = false;
    $("#add-draft").hidden = true;
    $("#add-draft").innerHTML = "";
    $("#add-form").hidden = true;
    $("#add-form").reset();
    $$(".seg__btn").forEach((button) => button.classList.toggle("is-active", button.dataset.direction === "out"));
    $("#photo-input").value = "";
  }

  function openAddSheet() {
    resetAddDraft();
    openSheet("#add-sheet");
  }

  function closeAddSheet() {
    resetAddDraft();
    closeSheet("#add-sheet");
  }

  function showAddForm(kind) {
    state.add.kind = kind;
    $("#add-form").hidden = false;
    window.setTimeout(() => $("#add-item").focus(), 260);
  }

  function renderDraft() {
    const draft = $("#add-draft");
    const add = state.add;
    if (add.recording) {
      $("#capture-row").hidden = true;
      draft.hidden = false;
      draft.innerHTML = `
        <div class="recording"><span class="recording__dot"></span>Recording… <span id="rec-time">0:00</span></div>
        <div class="draft__actions"><button class="btn btn--danger-outline" type="button" id="stop-rec">Stop</button></div>`;
      return;
    }
    if (!add.mediaBlob) {
      draft.hidden = true;
      draft.innerHTML = "";
      return;
    }
    const isImage = String(add.mediaBlob.type).startsWith("image/");
    $("#capture-row").hidden = true;
    draft.hidden = false;
    draft.innerHTML = `
      <div class="draft__row">
        <span class="draft__label">${isImage ? "Photo attached" : "Voice note ready"}</span>
        <button class="btn btn--small btn--ghost" type="button" id="redo-media">Change</button>
      </div>
      ${isImage ? `<img src="${add.mediaUrl}" alt="The photo you took">` : `<audio controls src="${add.mediaUrl}"></audio>`}
    `;
  }

  function clearMediaDraft() {
    const add = state.add;
    if (add.mediaUrl) URL.revokeObjectURL(add.mediaUrl);
    add.mediaBlob = null;
    add.mediaUrl = null;
    add.kind = "typed";
    $("#capture-row").hidden = false;
    $("#add-draft").hidden = true;
    $("#add-draft").innerHTML = "";
    $("#photo-input").value = "";
  }

  async function shrinkImage(file) {
    if (!String(file.type).startsWith("image/")) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      return blob || file;
    } catch {
      return file;
    }
  }

  async function onPhotoPicked(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const blob = await shrinkImage(file);
    if (state.add.mediaUrl) URL.revokeObjectURL(state.add.mediaUrl);
    state.add.mediaBlob = blob;
    state.add.mediaUrl = URL.createObjectURL(blob);
    renderDraft();
    showAddForm("photo");
  }

  async function startVoice() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast("Voice is not available here. Type it instead.", "error");
      showAddForm("typed");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const add = state.add;
      add.kind = "voice";
      add.stream = stream;
      add.recorder = recorder;
      add.chunks = [];
      add.seconds = 0;
      add.recording = true;
      recorder.ondataavailable = (eventData) => {
        if (eventData.data.size) add.chunks.push(eventData.data);
      };
      recorder.onstop = () => {
        if (state.add !== add) return;
        add.recording = false;
        if (add.timer) window.clearInterval(add.timer);
        stream.getTracks().forEach((track) => track.stop());
        add.mediaBlob = new Blob(add.chunks, { type: recorder.mimeType || "audio/webm" });
        add.mediaUrl = URL.createObjectURL(add.mediaBlob);
        renderDraft();
        showAddForm("voice");
      };
      recorder.start();
      renderDraft();
      add.timer = window.setInterval(() => {
        add.seconds += 1;
        const label = $("#rec-time");
        if (label) label.textContent = `${Math.floor(add.seconds / 60)}:${String(add.seconds % 60).padStart(2, "0")}`;
        if (add.seconds >= 45 && recorder.state === "recording") recorder.stop();
      }, 1000);
    } catch {
      toast("Mic not allowed. Type it instead.", "error");
      showAddForm("typed");
    }
  }

  function stopVoice() {
    if (state.add.recorder?.state === "recording") state.add.recorder.stop();
  }

  async function onAddSubmit(event) {
    event.preventDefault();
    const item = $("#add-item").value.trim();
    const qty = Number($("#add-qty").value);
    const amount = Number($("#add-amount").value);
    const unit = $("#add-unit").value;
    const text = $("#add-text").value.trim();
    if (!item || !(qty > 0) || !(amount > 0)) {
      toast("Add the item, quantity and amount.", "error");
      return;
    }
    const button = event.submitter || $("#add-form button[type=submit]");
    setButtonBusy(button, true);
    try {
      const result = await IWLocal.addNote({
        kind: state.add.kind,
        direction: state.add.direction,
        item,
        qty,
        unit,
        amount,
        text,
      }, state.add.mediaBlob);
      closeAddSheet();
      switchTab("today");
      await refreshLocal();
      if (result.count > 1) {
        toast(result.agree
          ? `${result.count} notes agree on ${money(result.amount)}.`
          : "The notes differ, so the range is wider.");
      } else {
        toast(`Saved: ${money(amount)}.`);
      }
    } catch (error) {
      console.error(error);
      toast("Could not save the note.", "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  function openStockSheet() {
    $("#stock-form").reset();
    $("#stock-item").value = "tomatoes";
    openSheet("#stock-sheet");
    window.setTimeout(() => $("#stock-qty").focus(), 260);
  }

  async function onStockSubmit(event) {
    event.preventDefault();
    const item = $("#stock-item").value.trim();
    const counted = Number($("#stock-qty").value);
    if (!item || !(counted >= 0)) {
      toast("Add the item and how much is left.", "error");
      return;
    }
    const button = event.submitter || $("#stock-form button[type=submit]");
    setButtonBusy(button, true);
    try {
      const stock = await IWLocal.countStock({ item, countedQty: counted });
      closeSheet("#stock-sheet");
      switchTab("today");
      await refreshLocal();
      toast(stock.missingQty > 0
        ? `${num(stock.missingQty, 1)} kg short, about ${money(stock.missingValue)}.`
        : "Your stock matches what you bought.");
    } catch (error) {
      console.error(error);
      toast("Could not save the count.", "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function runSync(button) {
    await runAction(button, async () => {
      const info = await IWLocal.sync(state.apiBase);
      await refreshLocal();
      const parts = [];
      if (info.pushed) parts.push(`${info.pushed} sent`);
      if (info.pulled) parts.push(`${info.pulled} received`);
      toast(parts.length ? `Synced: ${parts.join(", ")}.` : "Everything was already on this phone.");
    });
  }

  async function runReset(button) {
    if (!window.confirm("Erase every note on this phone?")) return;
    await runAction(button, async () => {
      await IWLocal.reset();
      closeAllSheets();
      switchTab("today");
      await refreshLocal();
      toast("All notes erased.");
    });
  }

  async function runExample(button) {
    if (!window.confirm("Replace the notes on this phone with an example day?")) return;
    await runAction(button, async () => {
      await IWLocal.loadExample();
      closeAllSheets();
      switchTab("today");
      await refreshLocal();
      toast("Example day loaded.");
    });
  }

  const ACTIONS = {
    "add-note": openAddSheet,
    "open-stock": openStockSheet,
    sync: runSync,
    reset: runReset,
    "load-example": runExample,
  };

  /* ---------- Events ---------- */

  function bindEvents() {
    $("#refresh-btn").addEventListener("click", () => refreshLocal());
    $("#retry-btn").addEventListener("click", () => refreshLocal());
    $("#fab").addEventListener("click", openAddSheet);

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

    $("#photo-btn").addEventListener("click", () => $("#photo-input").click());
    $("#photo-input").addEventListener("change", onPhotoPicked);
    $("#voice-btn").addEventListener("click", startVoice);
    $("#type-btn").addEventListener("click", () => showAddForm("typed"));
    $("#add-form").addEventListener("submit", onAddSubmit);
    $("#stock-form").addEventListener("submit", onStockSubmit);
    $$("#add-form .seg__btn").forEach((button) => {
      button.addEventListener("click", () => {
        state.add.direction = button.dataset.direction;
        $$("#add-form .seg__btn").forEach((item) => item.classList.toggle("is-active", item === button));
      });
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
        toast("Enter a valid server address.", "error");
        return;
      }
      state.apiBase = base.replace(/\/+$/, "");
      window.localStorage.setItem("iw-api-base", state.apiBase);
      input.value = state.apiBase;
      toast("Server saved.");
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
      if (event.target.closest("[data-close-add]")) {
        closeAddSheet();
        return;
      }
      if (event.target.closest("[data-close-stock]")) {
        closeSheet("#stock-sheet");
        return;
      }
      if (event.target.closest("#stop-rec")) {
        stopVoice();
        return;
      }
      if (event.target.closest("#redo-media")) {
        clearMediaDraft();
        return;
      }
      const action = event.target.closest("[data-action]");
      if (action) {
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
    $("#api-base").value = state.apiBase;
    switchTab("today");
    window.setTimeout(hideSplash, 2600);
    refreshLocal();
    registerServiceWorker();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
