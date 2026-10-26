(() => {
  "use strict";

  const SOURCE_CLASSES = new Set(["audio", "ocr", "video", "sms", "manual"]);

  const TAB_SUBTITLES = {
    today: "Your money",
    ledger: "All notes",
    sync: "Saved here. Syncs later.",
    more: "Stock and settings",
  };

  const SOURCE_NAMES = { audio: "Voice note", ocr: "Bill photo", video: "Video", sms: "SMS", manual: "Typed note" };
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
      mode: null,
      attachments: [],
      contextIds: [],
    },
    assistant: {
      lang: (() => {
        const supported = ["en", "hi", "mr", "or", "ta", "te"];
        const stored = window.localStorage.getItem("iw-lang");
        if (supported.includes(stored)) return stored;
        const prefix = String(navigator.language || "").toLowerCase().split("-")[0];
        return supported.includes(prefix) ? prefix : "en";
      })(),
      state: null,
      draft: null,
      recognition: null,
      listening: false,
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

  /* ---------- Tabs, sheets and device motion ---------- */

  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const desktopFrame = () => window.matchMedia("(min-width: 700px) and (hover: hover) and (pointer: fine)").matches;
  const deviceMotion = { x: 0, y: 0, s: 1, tx: 0, ty: 0, ts: 1, frame: 0 };
  let pageEnterTimer = 0;

  function applyDeviceMotion() {
    const app = $("#app");
    if (!app) return;
    app.style.setProperty("--tilt-x", `${deviceMotion.x.toFixed(2)}deg`);
    app.style.setProperty("--tilt-y", `${deviceMotion.y.toFixed(2)}deg`);
    app.style.setProperty("--tilt-scale", deviceMotion.s.toFixed(4));
  }

  function stepDeviceMotion() {
    const motion = deviceMotion;
    motion.x += (motion.tx - motion.x) * 0.11;
    motion.y += (motion.ty - motion.y) * 0.11;
    motion.s += (motion.ts - motion.s) * 0.11;
    applyDeviceMotion();
    const settled = Math.abs(motion.tx - motion.x) < 0.02
      && Math.abs(motion.ty - motion.y) < 0.02
      && Math.abs(motion.ts - motion.s) < 0.001;
    motion.frame = settled ? 0 : window.requestAnimationFrame(stepDeviceMotion);
  }

  function startDeviceMotion() {
    if (!deviceMotion.frame) deviceMotion.frame = window.requestAnimationFrame(stepDeviceMotion);
  }

  function wakeDevice() {
    if (reduceMotion() || !desktopFrame()) return;
    const motion = deviceMotion;
    motion.x = 6.5;
    motion.y = -9;
    motion.s = 0.972;
    motion.tx = 0;
    motion.ty = 0;
    motion.ts = 1;
    applyDeviceMotion();
    startDeviceMotion();
  }

  function flattenDevice() {
    if (reduceMotion() || !desktopFrame()) return;
    deviceMotion.tx = 0;
    deviceMotion.ty = 0;
    deviceMotion.ts = 1;
    startDeviceMotion();
  }

  function setupDeviceMotion() {
    if (reduceMotion()) return;
    window.addEventListener("pointermove", (event) => {
      if (!desktopFrame()) return;
      if (document.body.style.overflow === "hidden") {
        flattenDevice();
        return;
      }
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) {
        flattenDevice();
        return;
      }
      const nx = (event.clientX / window.innerWidth - 0.5) * 2;
      const ny = (event.clientY / window.innerHeight - 0.5) * 2;
      deviceMotion.tx = -ny * 1.5;
      deviceMotion.ty = nx * 1.9;
      deviceMotion.ts = 1;
      startDeviceMotion();
    }, { passive: true });
    document.addEventListener("pointerleave", flattenDevice);
    window.addEventListener("blur", flattenDevice);
  }

  function switchTab(tab) {
    if (!TAB_SUBTITLES[tab]) return;
    const current = $(".page:not([hidden])");
    const next = $(`#page-${tab}`);
    if (!next) return;
    state.tab = tab;
    $$(".bottomnav__item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.tab === tab);
    });
    $("#appbar-sub").textContent = TAB_SUBTITLES[tab];
    $("#main").scrollTop = 0;
    if (current === next) return;
    $$(".page").forEach((page) => {
      if (page === next) return;
      page.hidden = true;
      page.classList.remove("page--enter");
      [...page.children].forEach((child) => child.style.removeProperty("--stagger"));
    });
    next.hidden = false;
    next.classList.remove("page--enter");
    if (pageEnterTimer) window.clearTimeout(pageEnterTimer);
    if (reduceMotion()) {
      [...next.children].forEach((child) => child.style.removeProperty("--stagger"));
      return;
    }
    void next.offsetWidth;
    [...next.children].forEach((child, index) => {
      child.style.setProperty("--stagger", Math.min(index, 6));
    });
    next.classList.add("page--enter");
    pageEnterTimer = window.setTimeout(() => {
      next.classList.remove("page--enter");
      [...next.children].forEach((child) => child.style.removeProperty("--stagger"));
    }, 1100);
  }

  function openSheet(id) {
    const sheet = $(id);
    if (!sheet || !sheet.hidden) return;
    flattenDevice();
    sheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeSheet(id) {
    const sheet = $(id);
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    const anyOpen = ["#receipt-sheet", "#add-sheet", "#stock-sheet", "#assistant-sheet"].some((selector) => {
      const element = $(selector);
      return element && !element.hidden;
    });
    if (!anyOpen) document.body.style.overflow = "";
  }

  function closeAllSheets() {
    closeSheet("#receipt-sheet");
    closeAddSheet();
    closeSheet("#stock-sheet");
    closeAssistant();
  }

  function hideSplash() {
    const splash = $("#splash");
    if (!splash || splash.classList.contains("is-hide")) return;
    splash.classList.add("is-hide");
    splash.setAttribute("aria-hidden", "true");
    window.setTimeout(wakeDevice, 160);
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
              ${(source.attachments || []).map((attachment) => `
                <div class="attach-media">
                  <span class="faint">Bill photo</span>
                  <div class="source-media" data-media="${esc(attachment.id)}" hidden></div>
                </div>`).join("")}
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
    const hasMedia = sources.some((source) => source.media || (source.attachments || []).length);

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
        ${hasMedia ? '<p class="faint" style="margin:8px 0 0">Photos and video stay on this phone.</p>' : ""}
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

      ${(explanation.contexts || []).length ? `
      <section class="receipt-section">
        <h3>Linked notes</h3>
        <div class="context-list">
          ${explanation.contexts.map((context) => `
            <button class="context-row" type="button" data-explain="${esc(context.transaction_id)}">
              <span>${esc(context.title)}</span><strong>${money(context.amount)}</strong>
            </button>`).join("")}
        </div>
      </section>` : ""}

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
      } else if (String(blob.type).startsWith("video/")) {
        const video = document.createElement("video");
        video.controls = true;
        video.playsInline = true;
        video.src = url;
        holder.appendChild(video);
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
    add.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url));
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
      mode: null,
      attachments: [],
      contextIds: [],
    };
    $("#capture-row").hidden = false;
    $("#add-draft").hidden = true;
    $("#add-draft").innerHTML = "";
    $("#add-form").hidden = true;
    $("#add-form").reset();
    $$(".seg__btn").forEach((button) => button.classList.toggle("is-active", button.dataset.direction === "out"));
    $("#photo-input").value = "";
    $("#bill-input").value = "";
    renderAttachments();
    renderContextList();
    $("#context-picker").hidden = true;
    $("#context-picker").innerHTML = "";
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
        <div class="recording"><span class="recording__dot"></span>${add.mode === "video" ? "Recording video" : "Recording"}… <span id="rec-time">0:00</span></div>
        ${add.mode === "video" ? '<video id="video-preview" autoplay muted playsinline></video>' : ""}
        <div class="draft__actions"><button class="btn btn--danger-outline" type="button" id="stop-rec">Stop</button></div>`;
      if (add.mode === "video") {
        const preview = $("#video-preview");
        if (preview) preview.srcObject = add.stream;
      }
      return;
    }
    if (!add.mediaBlob) {
      draft.hidden = true;
      draft.innerHTML = "";
      return;
    }
    const type = String(add.mediaBlob.type);
    const isImage = type.startsWith("image/");
    const isVideo = type.startsWith("video/");
    $("#capture-row").hidden = true;
    draft.hidden = false;
    draft.innerHTML = `
      <div class="draft__row">
        <span class="draft__label">${isImage ? "Photo attached" : isVideo ? "Video ready" : "Voice note ready"}</span>
        <button class="btn btn--small btn--ghost" type="button" id="redo-media">Change</button>
      </div>
      ${isImage ? `<img src="${add.mediaUrl}" alt="The photo you took">` : isVideo ? `<video controls playsinline src="${add.mediaUrl}"></video>` : `<audio controls src="${add.mediaUrl}"></audio>`}
    `;
  }

  function clearMediaDraft() {
    const add = state.add;
    if (add.mediaUrl) URL.revokeObjectURL(add.mediaUrl);
    add.mediaBlob = null;
    add.mediaUrl = null;
    add.kind = "typed";
    add.mode = null;
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

  async function onBillsPicked(event) {
    const files = Array.from(event.target.files || []);
    $("#bill-input").value = "";
    if (!files.length) return;
    const room = 3 - state.add.attachments.length;
    if (room <= 0) {
      toast("You can add up to 3 bill photos.", "error");
      return;
    }
    for (const file of files.slice(0, room)) {
      const blob = await shrinkImage(file);
      state.add.attachments.push({ blob, mime: blob.type, url: URL.createObjectURL(blob) });
    }
    renderAttachments();
  }

  function renderAttachments() {
    const list = $("#attach-list");
    if (!list) return;
    list.innerHTML = state.add.attachments.map((attachment, index) => `
      <span class="attach-chip">
        <img src="${attachment.url}" alt="Bill photo ${index + 1}">
        <span>Bill ${index + 1}</span>
        <button type="button" data-remove-attach="${index}" aria-label="Remove bill photo">×</button>
      </span>`).join("");
  }

  function renderContextList() {
    const list = $("#context-list");
    if (!list) return;
    list.innerHTML = state.add.contextIds.map((id) => {
      const entry = findLedger(id);
      if (!entry) return "";
      return `<span class="context-chip">${esc(entryInfo(entry).title)} · ${money(entry.debit.amount_mean)}<button type="button" data-remove-context="${esc(id)}" aria-label="Remove linked note">×</button></span>`;
    }).join("");
  }

  function renderContextPicker() {
    const picker = $("#context-picker");
    const entries = state.ledger.slice(-6).reverse();
    if (!entries.length) {
      picker.innerHTML = '<p class="muted" style="margin:4px 6px">No other notes yet.</p>';
      return;
    }
    picker.innerHTML = entries.map((entry) => {
      const selected = state.add.contextIds.includes(entry.transaction_id);
      return `<button class="context-option${selected ? " is-selected" : ""}" type="button" data-context-id="${esc(entry.transaction_id)}">
        <strong>${esc(entryInfo(entry).title)}</strong><span>${money(entry.debit.amount_mean)}</span>
      </button>`;
    }).join("");
  }

  function toggleContextPicker() {
    const picker = $("#context-picker");
    picker.hidden = !picker.hidden;
    if (!picker.hidden) renderContextPicker();
  }

  function toggleContext(id) {
    const list = state.add.contextIds;
    const index = list.indexOf(id);
    if (index >= 0) {
      list.splice(index, 1);
    } else if (list.length < 3) {
      list.push(id);
    } else {
      toast("You can link up to 3 notes.", "error");
      return;
    }
    renderContextList();
    renderContextPicker();
    $("#context-picker").hidden = true;
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
      add.mode = "voice";
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

  function stopRecording() {
    if (state.add.recorder?.state === "recording") state.add.recorder.stop();
  }

  async function startVideo() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast("Video is not available here. Use a photo.", "error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: true });
      const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType: type });
      const add = state.add;
      add.kind = "video";
      add.mode = "video";
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
        add.mediaBlob = new Blob(add.chunks, { type: recorder.mimeType || "video/webm" });
        add.mediaUrl = URL.createObjectURL(add.mediaBlob);
        renderDraft();
        showAddForm("video");
      };
      recorder.start();
      renderDraft();
      add.timer = window.setInterval(() => {
        add.seconds += 1;
        const label = $("#rec-time");
        if (label) label.textContent = `${Math.floor(add.seconds / 60)}:${String(add.seconds % 60).padStart(2, "0")}`;
        if (add.seconds >= 15 && recorder.state === "recording") recorder.stop();
      }, 1000);
    } catch {
      toast("Camera not allowed. Use a photo instead.", "error");
    }
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
      }, state.add.mediaBlob, {
        attachments: state.add.attachments.map((attachment) => ({
          blob: attachment.blob,
          kind: "photo",
          mime: attachment.mime,
        })),
        contextIds: state.add.contextIds,
      });
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

  /* ---------- Voice assistant ---------- */

  const ASSISTANT_TEXT = {
    en: {
      title: "Ask me",
      eyebrow: "Voice assistant",
      idle: "Tap the mic and speak",
      statusListening: "Listening…",
      langName: "English",
      otherLang: "हिंदी",
      locationLabel: "Use my location",
      hint: "Voice needs internet. The money book works offline.",
      quickAdd: "Add a note",
      quickToday: "Today's money",
      quickStock: "Count stock",
      quickSync: "Sync",
      greet: "What do you want to do? Say add a note, today's money, count stock, or sync.",
      askDirection: "Did you sell or spend?",
      askItem: "What was it?",
      askAmount: "How many rupees?",
      askQty: "How much? Say a number and a unit, like 3 kilos or 7 plates.",
      askStock: (item) => `How many kilos of ${item} are left?`,
      confirm: (draft) => `${money(draft.amount)} ${draft.direction === "in" ? "received for" : "spent on"} ${draft.item}. Say yes to save.`,
      saved: "Saved.",
      cancelled: "Okay, cancelled.",
      today: (summary) => `You made ${money(summary.profit_mean)} today, give or take ${money(summary.profit_std_dev)}. Money in ${money(summary.revenue_mean)}, money out ${money(summary.cogs_mean)}, missing ${money(summary.loss_mean)}.`,
      noData: "No notes yet. Add your first one.",
      whyNone: "There is no note to explain yet.",
      why: (info) => `${info.title}, ${money(info.amount)}, ${info.notes} note${info.notes === 1 ? "" : "s"}, ${info.confidence} percent sure.`,
      stockMissing: (info) => `${info.item} is ${info.missing} kilos short, about ${money(info.value)}.`,
      noStock: "No stock count yet. Say count stock to add one.",
      syncDone: (info) => `Synced. ${info.pushed} sent, ${info.pulled} received.`,
      syncOffline: "No connection. Everything is saved on this phone.",
      stockOk: "Your stock matches what you bought.",
      unknown: "I can add a note, tell today's money, count stock, or sync.",
      noInternet: "Voice needs internet in this browser. The money book still works offline.",
      micDenied: "Microphone is not allowed. Use the buttons.",
      notHeard: "I didn't hear that. Tap the mic and try again.",
      unsupported: "Voice is not supported in this browser. Use the buttons.",
      locationDenied: "Location not available. Switch language with the button.",
      locationSet: "Language set from your location.",
      langSet: "I will speak in English.",
      languagePrompt: "I can speak English, Hindi, Marathi, Odia, Tamil or Telugu.",
      saveFailed: "Could not save. Try again.",
    },
    hi: {
      title: "पूछिए",
      eyebrow: "आवाज़ सहायक",
      idle: "माइक दबाकर बोलिए",
      statusListening: "सुन रहा हूँ…",
      langName: "हिंदी",
      otherLang: "English",
      locationLabel: "मेरी जगह से भाषा",
      hint: "आवाज़ के लिए इंटरनेट चाहिए। खाता ऑफ़लाइन चलता है।",
      quickAdd: "नोट जोड़ें",
      quickToday: "आज की कमाई",
      quickStock: "स्टॉक गिनें",
      quickSync: "सिंक",
      greet: "बोलिए — नोट जोड़ूँ, आज की कमाई बताऊँ, स्टॉक गिनूँ या सिंक करूँ?",
      askDirection: "आपने बेचा या खर्च किया?",
      askItem: "क्या था?",
      askAmount: "कितने रुपये?",
      askQty: "कितना? जैसे तीन किलो या सात प्लेट।",
      askStock: (item) => `${displayItem(item)} कितने किलो बचे हैं?`,
      confirm: (draft) => `${money(draft.amount)} ${draft.direction === "in" ? "मिले" : "खर्च"}, ${displayItem(draft.item)}। ठीक है? हाँ कहिए।`,
      saved: "सेव हो गया।",
      cancelled: "ठीक है, रद्द किया।",
      today: (summary) => `आज आपने ${money(summary.profit_mean)} कमाए, लगभग ${money(summary.profit_std_dev)} कम या ज़्यादा। आया ${money(summary.revenue_mean)}, खर्च ${money(summary.cogs_mean)}, गायब ${money(summary.loss_mean)}।`,
      noData: "अभी कोई नोट नहीं है। पहला नोट जोड़िए।",
      whyNone: "अभी बताने के लिए कोई नोट नहीं है।",
      why: (info) => `${info.title}, ${money(info.amount)}, ${info.notes} नोट, ${info.confidence} प्रतिशत भरोसा।`,
      stockMissing: (info) => `${displayItem(info.item)} ${info.missing} किलो कम है, लगभग ${money(info.value)}।`,
      noStock: "अभी स्टॉक नहीं गिना है। स्टॉक गिनिए।",
      syncDone: (info) => `सिंक हो गया। ${info.pushed} भेजे, ${info.pulled} मिले।`,
      syncOffline: "कनेक्शन नहीं है। सब कुछ इस फ़ोन में सेव है।",
      stockOk: "आपका स्टॉक खरीद के हिसाब से ठीक है।",
      unknown: "मैं नोट जोड़ने, आज की कमाई, स्टॉक और सिंक में मदद कर सकता हूँ।",
      noInternet: "आवाज़ के लिए इंटरनेट चाहिए। बटन दबाकर काम कर सकते हैं।",
      micDenied: "माइक की इजाज़त नहीं है। बटन दबाइए।",
      notHeard: "सुनाई नहीं दिया। फिर बोलिए।",
      unsupported: "इस ब्राउज़र में आवाज़ नहीं चलती। बटन दबाइए।",
      locationDenied: "लोकेशन नहीं मिली। भाषा बटन से बदलिए।",
      locationSet: "आपकी जगह के हिसाब से भाषा चुनी।",
      langSet: "अब हिंदी में बोलूँगा।",
      languagePrompt: "मैं अंग्रेज़ी, हिंदी, मराठी, ओड़िया, तमिल और तेलुगु बोल सकता हूँ।",
      saveFailed: "सेव नहीं हो सका। फिर कोशिश कीजिए।",
    },
    mr: {
      title: "विचारा",
      eyebrow: "आवाज सहाय्यक",
      idle: "माइक दाबून बोला",
      statusListening: "ऐकत आहे…",
      langName: "मराठी",
      otherLang: "",
      locationLabel: "माझ्या जागेवरून भाषा",
      hint: "आवाजासाठी इंटरनेट लागते. खाते ऑफलाइन चालते.",
      quickAdd: "नोंद जोडा",
      quickToday: "आजची कमाई",
      quickStock: "स्टॉक मोजा",
      quickSync: "सिंक",
      greet: "सांगा — नोंद जोडू, आजची कमाई सांगू, स्टॉक मोजू किंवा सिंक करू?",
      askDirection: "तुम्ही विकले की खर्च केले?",
      askItem: "काय होते?",
      askAmount: "किती रुपये?",
      askQty: "किती? तीन किलो किंवा सात प्लेट असे सांगा.",
      askStock: (item) => `${item} किती किलो शिल्लक आहे?`,
      confirm: (draft) => `${money(draft.amount)} ${draft.direction === "in" ? "मिळाले" : "खर्च"}, ${displayItem(draft.item)}. बरोबर आहे? हो म्हणा.`,
      saved: "जतन झाले.",
      cancelled: "ठीक आहे, रद्द केले.",
      today: (summary) => `आज तुम्ही ${money(summary.profit_mean)} कमावले, सुमारे ${money(summary.profit_std_dev)} कमी-जास्त. आले ${money(summary.revenue_mean)}, खर्च ${money(summary.cogs_mean)}, गायब ${money(summary.loss_mean)}.`,
      noData: "अजून नोंद नाही. पहिली नोंद जोडा.",
      whyNone: "सांगण्यासाठी नोंद नाही.",
      why: (info) => `${info.title}, ${money(info.amount)}, ${info.notes} नोंदी, ${info.confidence} टक्के खात्री.`,
      stockMissing: (info) => `${displayItem(info.item)} ${info.missing} किलो कमी आहे, सुमारे ${money(info.value)}.`,
      noStock: "अजून स्टॉक मोजला नाही. स्टॉक मोजा.",
      syncDone: (info) => `सिंक झाले. ${info.pushed} पाठवले, ${info.pulled} मिळाले.`,
      syncOffline: "कनेक्शन नाही. सर्व काही या फोनमध्ये जतन आहे.",
      stockOk: "तुमचा स्टॉक खरेदीच्या हिशोबाने ठीक आहे.",
      unknown: "मी नोंद जोडणे, आजची कमाई, स्टॉक आणि सिंक यात मदत करू शकतो.",
      noInternet: "आवाजासाठी इंटरनेट लागते. बटणांनी काम करू शकता.",
      micDenied: "माइकची परवानगी नाही. बटणे वापरा.",
      notHeard: "ऐकले नाही. पुन्हा बोला.",
      unsupported: "या ब्राउझरमध्ये आवाज चालत नाही. बटणे वापरा.",
      locationDenied: "लोकेशन मिळाले नाही. भाषा बटणाने बदला.",
      locationSet: "तुमच्या जागेनुसार भाषा निवडली.",
      langSet: "आता मराठीत बोलेन.",
      languagePrompt: "मी इंग्रजी, हिंदी, मराठी, ओडिया, तमिळ आणि तेलुगू बोलू शकतो.",
      saveFailed: "जतन करता आले नाही. पुन्हा प्रयत्न करा.",
    },
    or: {
      title: "ପଚାରନ୍ତୁ",
      eyebrow: "ସ୍ୱର ସହାୟକ",
      idle: "ମାଇକ୍ ଦବାଇ କୁହନ୍ତୁ",
      statusListening: "ଶୁଣୁଛି…",
      langName: "ଓଡ଼ିଆ",
      otherLang: "",
      locationLabel: "ମୋ ସ୍ଥାନରୁ ଭାଷା",
      hint: "ସ୍ୱର ପାଇଁ ଇଣ୍ଟରନେଟ୍ ଦରକାର। ଖାତା ଅଫଲାଇନ୍ ଚାଲେ।",
      quickAdd: "ନୋଟ୍ ଯୋଡ଼ନ୍ତୁ",
      quickToday: "ଆଜିର ଆୟ",
      quickStock: "ଷ୍ଟକ୍ ଗଣନ୍ତୁ",
      quickSync: "ସିଙ୍କ୍",
      greet: "କୁହନ୍ତୁ — ନୋଟ୍ ଯୋଡ଼ିବି, ଆଜିର ଆୟ କହିବି, ଷ୍ଟକ୍ ଗଣିବି କିମ୍ବା ସିଙ୍କ୍ କରିବି?",
      askDirection: "ଆପଣ ବିକ୍ରି କଲେ ନା ଖର୍ଚ୍ଚ କଲେ?",
      askItem: "କଣ ଥିଲା?",
      askAmount: "କେତେ ଟଙ୍କା?",
      askQty: "କେତେ? ତିନି କିଲୋ କିମ୍ବା ସାତ ପ୍ଲେଟ୍ ଭଳି କୁହନ୍ତୁ।",
      askStock: (item) => `${item} କେତେ କିଲୋ ବାକି ଅଛି?`,
      confirm: (draft) => `${money(draft.amount)} ${draft.direction === "in" ? "ମିଳିଲା" : "ଖର୍ଚ୍ଚ"}, ${displayItem(draft.item)}। ଠିକ୍ ଅଛି? ହଁ କୁହନ୍ତୁ।`,
      saved: "ସେଭ୍ ହେଲା।",
      cancelled: "ଠିକ୍, ବାତିଲ୍ କଲି।",
      today: (summary) => `ଆଜି ଆପଣ ${money(summary.profit_mean)} ରୋଜଗାର କରିଛନ୍ତି, ପ୍ରାୟ ${money(summary.profit_std_dev)} କମ୍ କିମ୍ବା ଅଧିକ। ଆୟ ${money(summary.revenue_mean)}, ଖର୍ଚ୍ଚ ${money(summary.cogs_mean)}, ନାହିଁ ${money(summary.loss_mean)}।`,
      noData: "ଏପର୍ଯ୍ୟନ୍ତ ନୋଟ୍ ନାହିଁ। ପ୍ରଥମ ନୋଟ୍ ଯୋଡ଼ନ୍ତୁ।",
      whyNone: "ବୁଝାଇବା ପାଇଁ ନୋଟ୍ ନାହିଁ।",
      why: (info) => `${info.title}, ${money(info.amount)}, ${info.notes} ନୋଟ୍, ${info.confidence} ପ୍ରତିଶତ ଭରସା।`,
      stockMissing: (info) => `${displayItem(info.item)} ${info.missing} କିଲୋ କମ୍ ଅଛି, ପ୍ରାୟ ${money(info.value)}।`,
      noStock: "ଷ୍ଟକ୍ ଗଣା ହୋଇନାହିଁ। ଷ୍ଟକ୍ ଗଣନ୍ତୁ।",
      syncDone: (info) => `ସିଙ୍କ୍ ହେଲା। ${info.pushed} ପଠାଗଲା, ${info.pulled} ମିଳିଲା।`,
      syncOffline: "କନେକ୍ସନ୍ ନାହିଁ। ସବୁ ଏହି ଫୋନରେ ସେଭ୍ ଅଛି।",
      stockOk: "ଆପଣଙ୍କ ଷ୍ଟକ୍ କିଣାହିସାବରେ ଠିକ୍ ଅଛି।",
      unknown: "ମୁଁ ନୋଟ୍ ଯୋଡ଼ିବା, ଆଜିର ଆୟ, ଷ୍ଟକ୍ ଓ ସିଙ୍କ୍‌ରେ ସାହାଯ୍ୟ କରିପାରିବି।",
      noInternet: "ସ୍ୱର ପାଇଁ ଇଣ୍ଟରନେଟ୍ ଦରକାର। ବଟନ୍ ଦ୍ୱାରା କାମ କରିପାରିବେ।",
      micDenied: "ମାଇକ୍ ଅନୁମତି ନାହିଁ। ବଟନ୍ ବ୍ୟବହାର କରନ୍ତୁ।",
      notHeard: "ଶୁଣିଲି ନାହିଁ। ପୁଣି କୁହନ୍ତୁ।",
      unsupported: "ଏହି ବ୍ରାଉଜରରେ ସ୍ୱର ଚାଲେ ନାହିଁ। ବଟନ୍ ବ୍ୟବହାର କରନ୍ତୁ।",
      locationDenied: "ଲୋକେସନ୍ ମିଳିଲା ନାହିଁ। ଭାଷା ବଟନ୍‌ରେ ବଦଳାନ୍ତୁ।",
      locationSet: "ଆପଣଙ୍କ ସ୍ଥାନ ଅନୁସାରେ ଭାଷା ବଛାଗଲା।",
      langSet: "ବର୍ତ୍ତମାନ ଓଡ଼ିଆରେ କହିବି।",
      languagePrompt: "ମୁଁ ଇଂରାଜୀ, ହିନ୍ଦୀ, ମରାଠୀ, ଓଡ଼ିଆ, ତାମିଲ ଓ ତେଲୁଗୁ କହିପାରିବି।",
      saveFailed: "ସେଭ୍ ହେଲା ନାହିଁ। ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।",
    },
    ta: {
      title: "கேளுங்கள்",
      eyebrow: "குரல் உதவியாளர்",
      idle: "மைக்கை அழுத்திப் பேசுங்கள்",
      statusListening: "கேட்கிறேன்…",
      langName: "தமிழ்",
      otherLang: "",
      locationLabel: "என் இருப்பிடத்திலிருந்து மொழி",
      hint: "குரலுக்கு இணையம் தேவை. கணக்கு ஆஃப்லைனில் இயங்கும்.",
      quickAdd: "குறிப்பு சேர்",
      quickToday: "இன்றைய வருமானம்",
      quickStock: "இருப்பு எண்ணு",
      quickSync: "ஒத்திசை",
      greet: "சொல்லுங்கள் — குறிப்பு சேர்க்கலாம், இன்றைய வருமானம் சொல்லலாம், இருப்பு எண்ணலாம் அல்லது ஒத்திசைக்கலாம்?",
      askDirection: "நீங்கள் விற்றீர்களா அல்லது செலவு செய்தீர்களா?",
      askItem: "என்ன?",
      askAmount: "எத்தனை ரூபாய்?",
      askQty: "எவ்வளவு? மூன்று கிலோ அல்லது ஏழு தட்டு என்று சொல்லுங்கள்.",
      askStock: (item) => `${item} எத்தனை கிலோ மீதம் உள்ளது?`,
      confirm: (draft) => `${money(draft.amount)} ${draft.direction === "in" ? "கிடைத்தது" : "செலவு"}, ${displayItem(draft.item)}. சரியா? ஆம் என்று சொல்லுங்கள்.`,
      saved: "சேமிக்கப்பட்டது.",
      cancelled: "சரி, ரத்து செய்துவிட்டேன்.",
      today: (summary) => `இன்று நீங்கள் ${money(summary.profit_mean)} சம்பாதித்தீர்கள், தோராயமாக ${money(summary.profit_std_dev)} கூடுதலாக அல்லது குறைவாக. வருமானம் ${money(summary.revenue_mean)}, செலவு ${money(summary.cogs_mean)}, காணாமல் ${money(summary.loss_mean)}.`,
      noData: "இன்னும் குறிப்பு இல்லை. முதல் குறிப்பைச் சேருங்கள்.",
      whyNone: "விளக்க குறிப்பு இல்லை.",
      why: (info) => `${info.title}, ${money(info.amount)}, ${info.notes} குறிப்புகள், ${info.confidence} சதவீதம் உறுதி.`,
      stockMissing: (info) => `${displayItem(info.item)} ${info.missing} கிலோ குறைவு, சுமார் ${money(info.value)}.`,
      noStock: "இருப்பு எண்ணப்படவில்லை. இருப்பை எண்ணுங்கள்.",
      syncDone: (info) => `ஒத்திசைந்தது. ${info.pushed} அனுப்பப்பட்டது, ${info.pulled} பெறப்பட்டது.`,
      syncOffline: "இணைப்பு இல்லை. எல்லாம் இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளது.",
      stockOk: "உங்கள் இருப்பு வாங்கியதற்கு சரியாக உள்ளது.",
      unknown: "குறிப்பு சேர்ப்பது, இன்றைய வருமானம், இருப்பு மற்றும் ஒத்திசைவில் உதவ முடியும்.",
      noInternet: "குரலுக்கு இணையம் தேவை. பொத்தான்களைப் பயன்படுத்தலாம்.",
      micDenied: "மைக் அனுமதி இல்லை. பொத்தான்களைப் பயன்படுத்துங்கள்.",
      notHeard: "கேட்கவில்லை. மீண்டும் பேசுங்கள்.",
      unsupported: "இந்த உலாவியில் குரல் இல்லை. பொத்தான்களைப் பயன்படுத்துங்கள்.",
      locationDenied: "இருப்பிடம் கிடைக்கவில்லை. மொழி பொத்தானில் மாற்றுங்கள்.",
      locationSet: "உங்கள் இருப்பிடத்திற்கேற்ப மொழி தேர்ந்தெடுக்கப்பட்டது.",
      langSet: "இப்போது தமிழில் பேசுவேன்.",
      languagePrompt: "ஆங்கிலம், இந்தி, மராத்தி, ஒடியா, தமிழ், தெலுங்கு பேச முடியும்.",
      saveFailed: "சேமிக்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்.",
    },
    te: {
      title: "అడగండి",
      eyebrow: "వాయిస్ సహాయకుడు",
      idle: "మైక్ నొక్కి మాట్లాడండి",
      statusListening: "వినిపిస్తోంది…",
      langName: "తెలుగు",
      otherLang: "",
      locationLabel: "నా స్థానం నుంచి భాష",
      hint: "వాయిస్‌కు ఇంటర్నెట్ కావాలి. ఖాతా ఆఫ్‌లైన్‌లో పనిచేస్తుంది.",
      quickAdd: "నోట్ జోడించు",
      quickToday: "ఈరోజు ఆదాయం",
      quickStock: "స్టాక్ లెక్కించు",
      quickSync: "సింక్",
      greet: "చెప్పండి — నోట్ జోడించాలా, ఈరోజు ఆదాయం చెప్పాలా, స్టాక్ లెక్కించాలా లేదా సింక్ చేయాలా?",
      askDirection: "మీరు అమ్మారా లేదా ఖర్చు చేశారా?",
      askItem: "ఏమిటి?",
      askAmount: "ఎన్ని రూపాయలు?",
      askQty: "ఎంత? మూడు కిలోలు లేదా ఏడు ప్లేట్లు అని చెప్పండి.",
      askStock: (item) => `${item} ఎన్ని కిలోలు మిగిలాయి?`,
      confirm: (draft) => `${money(draft.amount)} ${draft.direction === "in" ? "వచ్చింది" : "ఖర్చు"}, ${displayItem(draft.item)}. సరేనా? అవును అనండి.`,
      saved: "సేవ్ అయింది.",
      cancelled: "సరే, రద్దు చేశాను.",
      today: (summary) => `ఈరోజు మీరు ${money(summary.profit_mean)} సంపాదించారు, సుమారు ${money(summary.profit_std_dev)} తక్కువ లేదా ఎక్కువ. ఆదాయం ${money(summary.revenue_mean)}, ఖర్చు ${money(summary.cogs_mean)}, మిస్ ${money(summary.loss_mean)}.`,
      noData: "ఇంకా నోట్‌లు లేవు. మొదటి నోట్ జోడించండి.",
      whyNone: "వివరించడానికి నోట్ లేదు.",
      why: (info) => `${info.title}, ${money(info.amount)}, ${info.notes} నోట్‌లు, ${info.confidence} శాతం నమ్మకం.`,
      stockMissing: (info) => `${displayItem(info.item)} ${info.missing} కిలోలు తక్కువ, సుమారు ${money(info.value)}.`,
      noStock: "స్టాక్ లెక్కించలేదు. స్టాక్ లెక్కించండి.",
      syncDone: (info) => `సింక్ అయింది. ${info.pushed} పంపారు, ${info.pulled} వచ్చాయి.`,
      syncOffline: "కనెక్షన్ లేదు. అంతా ఈ ఫోన్‌లో సేవ్ అయింది.",
      stockOk: "మీ స్టాక్ కొన్న దానితో సరిపోతోంది.",
      unknown: "నోట్ జోడించడం, ఈరోజు ఆదాయం, స్టాక్, సింక్‌లో సహాయం చేయగలను.",
      noInternet: "వాయిస్‌కు ఇంటర్నెట్ కావాలి. బటన్లతో పని చేయవచ్చు.",
      micDenied: "మైక్ అనుమతి లేదు. బటన్లు వాడండి.",
      notHeard: "వినిపించలేదు. మళ్లీ చెప్పండి.",
      unsupported: "ఈ బ్రౌజర్‌లో వాయిస్ లేదు. బటన్లు వాడండి.",
      locationDenied: "లొకేషన్ దొరకలేదు. భాష బటన్‌తో మార్చండి.",
      locationSet: "మీ ప్రాంతం ప్రకారం భాష ఎంచుకున్నాను.",
      langSet: "ఇప్పుడు తెలుగులో మాట్లాడతాను.",
      languagePrompt: "ఆంగ్లం, హిందీ, మరాఠీ, ఒడియా, తమిళం, తెలుగు మాట్లాడగలను.",
      saveFailed: "సేవ్ కాలేదు. మళ్లీ ప్రయత్నించండి.",
    },
  };

  const LANGUAGES = {
    en: { native: "English", code: "en-IN", currency: "rupees" },
    hi: { native: "हिंदी", code: "hi-IN", currency: "रुपये" },
    mr: { native: "मराठी", code: "mr-IN", currency: "रुपये" },
    or: { native: "ଓଡ଼ିଆ", code: "or-IN", currency: "ଟଙ୍କା" },
    ta: { native: "தமிழ்", code: "ta-IN", currency: "ரூபாய்" },
    te: { native: "తెలుగు", code: "te-IN", currency: "రూపాయలు" },
  };

  const LANGUAGE_WORDS = {
    en: ["english", "अंग्रेज़ी", "इंग्रजी", "ଇଂରାଜୀ", "ஆங்கிலம்", "ఆంగ్లం"],
    hi: ["hindi", "हिंदी", "हिन्दी", "हिंदीत", "ହିନ୍ଦୀ", "ஹிந்தி", "హిందీ"],
    mr: ["marathi", "मराठी"],
    or: ["odia", "oriya", "ଓଡ଼ିଆ"],
    ta: ["tamil", "தமிழ்"],
    te: ["telugu", "తెలుగు"],
  };

  const ASSISTANT_WORDS = {
    cancel: ["cancel", "stop", "रद्द", "बंद", "थांबा", "ବାତିଲ୍", "ରଦ୍ଦ", "ரத்து", "நிறுத்து", "రద్దు", "ఆపు"],
    yes: ["yes", "ok", "okay", "correct", "हाँ", "हां", "ठीक", "सही", "हो", "होय", "ହଁ", "ஆம்", "சரி", "అవును", "సరే"],
    no: ["no", "नहीं", "नही", "नको", "ନା", "ନାହିଁ", "இல்லை", "வேண்டாம்", "కాదు", "వద్దు"],
    sold: ["sold", "sale", "received", "got", "earned", "बेचा", "बेच", "मिला", "कमाया", "विकले", "विकला", "बेचले", "मिळाले", "कमावले", "ବିକ୍ରି", "ବିକିଲି", "ମିଳିଲା", "விற்றேன்", "விற்பனை", "கிடைத்தது", "అమ్మాను", "అమ్మకం", "వచ్చింది"],
    spent: ["spent", "spend", "bought", "buy", "paid", "खर्च", "खरीदा", "खरीद", "दिया", "विकत", "घेतले", "दिले", "ଖର୍ଚ୍ଚ", "କିଣିଲି", "ଦେଲି", "செலவு", "வாங்கினேன்", "கொடுத்தேன்", "ఖర్చు", "కొన్నాను", "ఇచ్చాను"],
    add: ["add", "note", "नोट", "जोड़", "नोंद", "जोडा", "टाका", "ନୋଟ୍", "ଯୋଡ଼", "குறிப்பு", "சேர்", "నోట్", "జోడించు"],
    today: ["today", "profit", "made", "make", "money", "earned", "कमाई", "कमाया", "मुनाफा", "आज", "नफा", "ଆଜି", "ରୋଜଗାର", "ଲାଭ", "இன்று", "வருமானம்", "லாபம்", "ఇవాళ", "ఆదాయం", "లాభం"],
    stock: ["stock", "count stock", "स्टॉक", "गिन", "माल", "मोजणी", "ଷ୍ଟକ୍", "ଗଣନା", "ஸ்டாக்", "கணக்கு", "స్టాక్", "లెక్క"],
    sync: ["sync", "सिंक", "ସିଙ୍କ୍", "ஒத்திசை", "ஒத்திசைவு", "సింక్"],
    why: ["why", "explain", "क्यों", "कैसे", "का", "କାହିଁକି", "ஏன்", "ఎందుకు"],
    language: ["language", "भाषा", "ଭାଷା", "மொழி", "భాష"],
  };

  const STATE_LANGUAGES = [
    { name: "Delhi", lat: 28.61, lon: 77.21, lang: "hi" },
    { name: "Lucknow", lat: 26.85, lon: 80.95, lang: "hi" },
    { name: "Patna", lat: 25.59, lon: 85.14, lang: "hi" },
    { name: "Bhopal", lat: 23.26, lon: 77.41, lang: "hi" },
    { name: "Jaipur", lat: 26.91, lon: 75.79, lang: "hi" },
    { name: "Chandigarh", lat: 30.73, lon: 76.78, lang: "hi" },
    { name: "Dehradun", lat: 30.32, lon: 78.03, lang: "hi" },
    { name: "Raipur", lat: 21.25, lon: 81.63, lang: "hi" },
    { name: "Ranchi", lat: 23.34, lon: 85.31, lang: "hi" },
    { name: "Shimla", lat: 31.10, lon: 77.17, lang: "hi" },
    { name: "Mumbai", lat: 19.08, lon: 72.88, lang: "mr" },
    { name: "Pune", lat: 18.52, lon: 73.86, lang: "mr" },
    { name: "Nagpur", lat: 21.15, lon: 79.09, lang: "mr" },
    { name: "Bhubaneswar", lat: 20.30, lon: 85.82, lang: "or" },
    { name: "Cuttack", lat: 20.46, lon: 85.88, lang: "or" },
    { name: "Chennai", lat: 13.08, lon: 80.27, lang: "ta" },
    { name: "Coimbatore", lat: 11.02, lon: 76.96, lang: "ta" },
    { name: "Madurai", lat: 9.93, lon: 78.12, lang: "ta" },
    { name: "Hyderabad", lat: 17.39, lon: 78.49, lang: "te" },
    { name: "Amaravati", lat: 16.51, lon: 80.52, lang: "te" },
    { name: "Visakhapatnam", lat: 17.69, lon: 83.22, lang: "te" },
    { name: "Ahmedabad", lat: 23.03, lon: 72.58, lang: "en" },
    { name: "Bengaluru", lat: 12.97, lon: 77.59, lang: "en" },
    { name: "Kolkata", lat: 22.57, lon: 88.36, lang: "en" },
    { name: "Guwahati", lat: 26.14, lon: 91.74, lang: "en" },
    { name: "Thiruvananthapuram", lat: 8.52, lon: 76.94, lang: "en" },
    { name: "Panaji", lat: 15.49, lon: 73.83, lang: "en" },
    { name: "Srinagar", lat: 34.08, lon: 74.80, lang: "en" },
  ];

  const ITEM_NAMES = {
    hi: {
      tomatoes: "टमाटर", tomato: "टमाटर", onion: "प्याज़", potato: "आलू",
      poha: "पोहा", tea: "चाय", snacks: "स्नैक्स", oil: "तेल", "gas cylinder": "गैस सिलेंडर",
    },
    mr: {
      tomatoes: "टोमॅटो", tomato: "टोमॅटो", onion: "कांदा", potato: "बटाटा",
      poha: "पोहे", tea: "चहा", snacks: "स्नॅक्स", oil: "तेल", "gas cylinder": "गॅस सिलिंडर",
    },
    or: {
      tomatoes: "ଟମାଟୋ", tomato: "ଟମାଟୋ", onion: "ପିଆଜ", potato: "ଆଳୁ",
      poha: "ପୋହା", tea: "ଚା", snacks: "ସ୍ନାକ୍ସ", oil: "ତେଲ", "gas cylinder": "ଗ୍ୟାସ୍ ସିଲିଣ୍ଡର",
    },
    ta: {
      tomatoes: "தக்காளி", tomato: "தக்காளி", onion: "வெங்காயம்", potato: "உருளைக்கிழங்கு",
      poha: "அவல்", tea: "தேநீர்", snacks: "சிற்றுண்டி", oil: "எண்ணெய்", "gas cylinder": "எரிவாயு சிலிண்டர்",
    },
    te: {
      tomatoes: "టమాటాలు", tomato: "టమాటా", onion: "ఉల్లిపాయ", potato: "బంగాళదుంప",
      poha: "పొహా", tea: "టీ", snacks: "స్నాక్స్", oil: "నూనె", "gas cylinder": "గ్యాస్ సిలిండర్",
    },
  };

  function assistantText() {
    return ASSISTANT_TEXT[state.assistant.lang];
  }

  function hasWord(text, words) {
    return words.some((word) => (
      /^[a-z ]+$/i.test(word)
        ? new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`, "i").test(text)
        : String(text).includes(word)
    ));
  }

  function cleanItem(text) {
    return String(text)
      .replace(/^(it was|i bought|i sold|i spent on|bought|sold|spent on)\s+/i, "")
      .replace(/[.?!।]+$/g, "")
      .trim()
      .slice(0, 60);
  }

  function parseNumber(text) {
    const devanagari = "०१२३४५६७८९";
    const normalized = String(text)
      .replace(/[०-९]/g, (character) => String(devanagari.indexOf(character)))
      .replace(/,/g, "");
    const match = normalized.match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function parseQty(text, direction) {
    const normalized = String(text).toLowerCase();
    let unit = direction === "in" ? "piece" : "kg";
    if (/kg|kilo|किलो|கிலோ|కిలో|କିଲୋ/.test(normalized)) unit = "kg";
    else if (/plate|प्लेट|தட்டு|ప్లేట్|ପ୍ଲେଟ୍/.test(normalized)) unit = "plate";
    else if (/cup|कप|கப்|కప్పు|କପ୍/.test(normalized)) unit = "cup";
    else if (/litre|liter|लीटर|லிட்டர்|లీటర్|ଲିଟର/.test(normalized)) unit = "litre";
    else if (/piece|नग|पीस|துண்டு|ముక్క|ପିସ୍/.test(normalized)) unit = "piece";
    return { qty: parseNumber(text) || 1, unit };
  }

  function displayItem(item) {
    const names = ITEM_NAMES[state.assistant.lang];
    return names ? names[String(item).toLowerCase()] || item : item;
  }

  function spoken(text) {
    const currency = LANGUAGES[state.assistant.lang]?.currency || "rupees";
    return String(text).replace(/₹\s?([\d,.]+)/g, (_, amount) => `${amount} ${currency}`);
  }

  function nearestLanguage(lat, lon) {
    let best = STATE_LANGUAGES[0];
    let bestDistance = Infinity;
    STATE_LANGUAGES.forEach((statePoint) => {
      const distance = ((statePoint.lat - lat) ** 2) + ((statePoint.lon - lon) ** 2);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = statePoint;
      }
    });
    return best.lang;
  }

  function voiceFor(lang) {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    const prefix = (LANGUAGES[lang]?.code || "en-IN").split("-")[0].toLowerCase();
    return voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix) && voice.lang.toLowerCase().includes("-in"))
      || voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix))
      || null;
  }

  function setListening(on) {
    state.assistant.listening = on;
    $("#assistant-orb")?.classList.toggle("is-listening", on);
    $("#assistant-btn")?.classList.toggle("is-listening", on);
    const status = $("#assistant-status");
    if (status) status.textContent = on ? assistantText().statusListening : assistantText().idle;
  }

  function speak(text, { listenAfter = false } = {}) {
    const reply = $("#assistant-reply");
    if (reply) reply.textContent = text;
    if (state.assistant.recognition) {
      try { state.assistant.recognition.abort(); } catch { /* already stopped */ }
    }
    setListening(false);
    if (!("speechSynthesis" in window)) {
      if (listenAfter) window.setTimeout(startListening, 250);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken(text));
    utterance.lang = LANGUAGES[state.assistant.lang]?.code || "en-IN";
    const voice = voiceFor(state.assistant.lang);
    if (voice) utterance.voice = voice;
    utterance.rate = 0.95;
    utterance.onend = () => {
      if (listenAfter && !$("#assistant-sheet").hidden) window.setTimeout(startListening, 300);
    };
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      if (listenAfter) window.setTimeout(startListening, 250);
    }
  }

  function updateAssistantUI() {
    const text = assistantText();
    $("#assistant-title").textContent = text.title;
    $("#assistant-eyebrow").textContent = text.eyebrow;
    $("#assistant-lang-label").textContent = text.langName;
    $("#assistant-status").textContent = state.assistant.listening ? text.statusListening : text.idle;
    const select = $("#assistant-lang-select");
    if (select) select.value = state.assistant.lang;
    $("#assistant-location-btn").textContent = text.locationLabel;
    $("#assistant-hint").textContent = text.hint;
    const labels = { add: text.quickAdd, today: text.quickToday, stock: text.quickStock, sync: text.quickSync };
    $$("#assistant-sheet [data-assistant-action]").forEach((button) => {
      const label = labels[button.dataset.assistantAction];
      if (label) button.textContent = label;
    });
  }

  function setAssistantLanguage(lang, announce = true) {
    if (!LANGUAGES[lang]) return;
    state.assistant.lang = lang;
    window.localStorage.setItem("iw-lang", lang);
    updateAssistantUI();
    if (announce) speak(assistantText().langSet);
  }

  function useLocationLanguage() {
    const text = assistantText();
    if (!navigator.geolocation) {
      speak(text.locationDenied);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lang = nearestLanguage(position.coords.latitude, position.coords.longitude);
        state.assistant.lang = lang;
        window.localStorage.setItem("iw-lang", lang);
        updateAssistantUI();
        speak(`${assistantText().locationSet} ${assistantText().langSet}`);
      },
      () => speak(text.locationDenied),
      { timeout: 8000, maximumAge: 86400000 },
    );
  }

  function openAssistant() {
    openSheet("#assistant-sheet");
    state.assistant.state = null;
    state.assistant.draft = null;
    $("#assistant-reply").textContent = "";
    updateAssistantUI();
    speak(assistantText().greet, { listenAfter: true });
  }

  function closeAssistant() {
    if (state.assistant.recognition) {
      try { state.assistant.recognition.abort(); } catch { /* already stopped */ }
      state.assistant.recognition = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setListening(false);
    closeSheet("#assistant-sheet");
  }

  function startListening() {
    const text = assistantText();
    if (!navigator.onLine) {
      speak(text.noInternet);
      return;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      speak(text.unsupported);
      return;
    }
    if (state.assistant.recognition) {
      try { state.assistant.recognition.abort(); } catch { /* already stopped */ }
    }
    const recognition = new Recognition();
    state.assistant.recognition = recognition;
    recognition.lang = LANGUAGES[state.assistant.lang]?.code || "en-IN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";
      for (const result of event.results) {
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      const status = $("#assistant-status");
      if (interim && status) status.textContent = interim;
      if (finalText) {
        setListening(false);
        handleUtterance(finalText);
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") speak(text.micDenied);
      else if (event.error === "network") speak(text.noInternet);
      else if (event.error === "no-speech") speak(text.notHeard);
    };
    recognition.onend = () => setListening(false);
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  }

  function handleUtterance(raw) {
    const text = String(raw || "").trim().toLowerCase();
    if (!text) return;
    const copy = assistantText();
    const assistant = state.assistant;
    if (hasWord(text, ASSISTANT_WORDS.cancel)) {
      assistant.state = null;
      assistant.draft = null;
      speak(copy.cancelled);
      return;
    }
    if (assistant.state === "confirm") {
      if (hasWord(text, ASSISTANT_WORDS.yes)) {
        saveAssistantNote();
      } else if (hasWord(text, ASSISTANT_WORDS.no)) {
        assistant.state = null;
        assistant.draft = null;
        speak(copy.cancelled);
      } else {
        speak(copy.confirm(assistant.draft), { listenAfter: true });
      }
      return;
    }
    if (assistant.state === "direction") {
      if (hasWord(text, ASSISTANT_WORDS.sold)) assistant.draft.direction = "in";
      else if (hasWord(text, ASSISTANT_WORDS.spent)) assistant.draft.direction = "out";
      else {
        speak(copy.askDirection, { listenAfter: true });
        return;
      }
      assistant.state = "item";
      speak(copy.askItem, { listenAfter: true });
      return;
    }
    if (assistant.state === "item") {
      const item = cleanItem(raw);
      if (!item || hasWord(text, ASSISTANT_WORDS.yes)) {
        speak(copy.askItem, { listenAfter: true });
        return;
      }
      assistant.draft.item = item;
      assistant.state = "amount";
      speak(copy.askAmount, { listenAfter: true });
      return;
    }
    if (assistant.state === "amount") {
      const amount = parseNumber(text);
      if (!amount || amount <= 0) {
        speak(copy.askAmount, { listenAfter: true });
        return;
      }
      assistant.draft.amount = amount;
      assistant.state = "qty";
      speak(copy.askQty, { listenAfter: true });
      return;
    }
    if (assistant.state === "qty") {
      const parsed = parseQty(text, assistant.draft.direction);
      assistant.draft.qty = parsed.qty;
      assistant.draft.unit = parsed.unit;
      assistant.state = "confirm";
      speak(copy.confirm(assistant.draft), { listenAfter: true });
      return;
    }
    if (assistant.state === "stockqty") {
      const counted = parseNumber(text);
      if (counted == null) {
        speak(copy.askStock(displayItem(assistant.draft.item)), { listenAfter: true });
        return;
      }
      saveAssistantStock(assistant.draft.item, counted);
      return;
    }
    const requestedLanguage = Object.entries(LANGUAGE_WORDS)
      .find(([, words]) => hasWord(text, words));
    if (requestedLanguage) {
      setAssistantLanguage(requestedLanguage[0]);
      return;
    }
    if (hasWord(text, ASSISTANT_WORDS.language)) {
      speak(assistantText().languagePrompt);
      return;
    }
    if (hasWord(text, ASSISTANT_WORDS.today)) { speakToday(); return; }
    if (hasWord(text, ASSISTANT_WORDS.stock)) { startStockFlow(); return; }
    if (hasWord(text, ASSISTANT_WORDS.sync)) { runAssistantSync(); return; }
    if (hasWord(text, ASSISTANT_WORDS.why)) { speakWhy(); return; }
    if (hasWord(text, ASSISTANT_WORDS.add) || hasWord(text, ASSISTANT_WORDS.sold) || hasWord(text, ASSISTANT_WORDS.spent)) {
      startAddFlow(text);
      return;
    }
    speak(copy.unknown);
  }

  function startAddFlow(seed = "") {
    const copy = assistantText();
    const assistant = state.assistant;
    assistant.draft = { direction: null, item: null, amount: null, qty: null, unit: null };
    if (hasWord(seed, ASSISTANT_WORDS.spent)) assistant.draft.direction = "out";
    else if (hasWord(seed, ASSISTANT_WORDS.sold)) assistant.draft.direction = "in";
    if (assistant.draft.direction) {
      assistant.state = "item";
      speak(copy.askItem, { listenAfter: true });
    } else {
      assistant.state = "direction";
      speak(copy.askDirection, { listenAfter: true });
    }
  }

  async function saveAssistantNote() {
    const assistant = state.assistant;
    const copy = assistantText();
    const draft = assistant.draft;
    assistant.state = null;
    assistant.draft = null;
    try {
      await IWLocal.addNote({
        kind: "typed",
        direction: draft.direction,
        item: draft.item,
        qty: draft.qty,
        unit: draft.unit,
        amount: draft.amount,
        text: "Added by voice",
      });
      await refreshLocal();
      speak(copy.saved);
    } catch (error) {
      console.error(error);
      speak(copy.saveFailed);
    }
  }

  function stockItem() {
    if (state.stock?.itemKey) return state.stock.itemKey;
    const entry = [...state.ledger].reverse().find((item) => item.debit.unit === "kg");
    return entry ? entry.debit.account.split(":")[1] : "tomatoes";
  }

  function startStockFlow() {
    const assistant = state.assistant;
    assistant.draft = { item: stockItem() };
    assistant.state = "stockqty";
    speak(assistantText().askStock(displayItem(assistant.draft.item)), { listenAfter: true });
  }

  async function saveAssistantStock(item, counted) {
    const assistant = state.assistant;
    const copy = assistantText();
    assistant.state = null;
    assistant.draft = null;
    try {
      const stock = await IWLocal.countStock({ item, countedQty: counted });
      await refreshLocal();
      if (stock.missingQty > 0) {
        speak(copy.stockMissing({
          item: stock.item,
          missing: num(stock.missingQty, 1),
          value: stock.missingValue,
        }));
      } else {
        speak(copy.stockOk);
      }
    } catch (error) {
      console.error(error);
      speak(copy.saveFailed);
    }
  }

  function speakToday() {
    const copy = assistantText();
    if (state.empty || !state.summary || !state.notes.length) {
      speak(copy.noData);
      return;
    }
    speak(copy.today(state.summary));
  }

  function speakWhy() {
    const copy = assistantText();
    const entry = [...state.ledger].sort((a, b) => b.logical_clock - a.logical_clock)[0];
    if (!entry) {
      speak(copy.whyNone);
      return;
    }
    speak(copy.why({
      title: entryInfo(entry).title,
      amount: entry.debit.amount_mean,
      notes: entry.event_ids.length,
      confidence: Number(pct(entry.confidence, 0).replace("%", "")) || 0,
    }));
  }

  async function runAssistantSync() {
    const copy = assistantText();
    try {
      const info = await IWLocal.sync(state.apiBase);
      await refreshLocal();
      speak(copy.syncDone(info));
    } catch {
      speak(copy.syncOffline);
    }
  }

  function assistantAction(action) {
    if (action === "add") startAddFlow();
    else if (action === "today") speakToday();
    else if (action === "stock") startStockFlow();
    else if (action === "sync") runAssistantSync();
  }

  window.addEventListener("iw-assistant-say", (event) => {
    const text = event?.detail?.text;
    if (text) handleUtterance(String(text));
  });

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

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("iw-theme", theme);
    const meta = document.getElementById("theme-color");
    if (meta) meta.setAttribute("content", theme === "dark" ? "#100d07" : "#d9cdac");
  }

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
    $("#video-btn").addEventListener("click", startVideo);
    $("#type-btn").addEventListener("click", () => showAddForm("typed"));
    $("#bill-btn").addEventListener("click", () => $("#bill-input").click());
    $("#bill-input").addEventListener("change", onBillsPicked);
    $("#context-btn").addEventListener("click", toggleContextPicker);
    $("#add-form").addEventListener("submit", onAddSubmit);
    $("#stock-form").addEventListener("submit", onStockSubmit);
    $("#assistant-btn").addEventListener("click", openAssistant);
    $("#assistant-orb").addEventListener("click", startListening);
    $("#assistant-lang-select").addEventListener("change", (event) => setAssistantLanguage(event.target.value));
    $("#assistant-location-btn").addEventListener("click", useLocationLanguage);
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
      setTheme(themeToggle.checked ? "dark" : "light");
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
      if (event.target.closest("[data-close-assistant]")) {
        closeAssistant();
        return;
      }
      if (event.target.closest("#stop-rec")) {
        stopRecording();
        return;
      }
      if (event.target.closest("#redo-media")) {
        clearMediaDraft();
        return;
      }
      const removeAttachment = event.target.closest("[data-remove-attach]");
      if (removeAttachment) {
        const index = Number(removeAttachment.dataset.removeAttach);
        const [removed] = state.add.attachments.splice(index, 1);
        if (removed) URL.revokeObjectURL(removed.url);
        renderAttachments();
        return;
      }
      const removeContext = event.target.closest("[data-remove-context]");
      if (removeContext) {
        toggleContext(removeContext.dataset.removeContext);
        return;
      }
      const contextOption = event.target.closest("[data-context-id]");
      if (contextOption) {
        toggleContext(contextOption.dataset.contextId);
        return;
      }
      const assistantButton = event.target.closest("[data-assistant-action]");
      if (assistantButton) {
        assistantAction(assistantButton.dataset.assistantAction);
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
    setupDeviceMotion();
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
