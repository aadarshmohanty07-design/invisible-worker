(() => {
  "use strict";

  const DB_NAME = "iw-local";
  const DB_VERSION = 1;
  const BASE_CONF = { photo: 0.62, voice: 0.85, video: 0.72, typed: 0.93, sms: 0.78 };
  const REL_STD = { photo: 0.18, voice: 0.16, video: 0.15, typed: 0.06, sms: 0.08 };
  const KIND_TO_SOURCE = { photo: "ocr", voice: "audio", video: "manual", typed: "manual", sms: "sms" };
  const DISPLAY_SOURCE = { photo: "ocr", voice: "audio", video: "video", typed: "manual", sms: "sms" };
  const SOURCE_TO_KIND = { ocr: "photo", audio: "voice", manual: "typed", sms: "sms" };
  const DAY_FLOOR = 0.05;
  const USUAL_SHARE = 0.3;
  const GROUP_WINDOW_MS = 30 * 60 * 1000;
  const SYNC_WINDOW_MS = 2 * 60 * 60 * 1000;

  let db;
  let deviceId = "";
  let opened;

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function localDay(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
      const random = (Math.random() * 16) | 0;
      return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
    });
  }

  function norm(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isWrongClock(value) {
    const time = Date.parse(value);
    if (Number.isNaN(time)) return false;
    return new Date(time).getFullYear() < 2020 || time > Date.now() + 86400000;
  }

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("notes")) {
          const notes = database.createObjectStore("notes", { keyPath: "id" });
          notes.createIndex("order", "order");
        }
        if (!database.objectStoreNames.contains("media")) {
          database.createObjectStore("media");
        }
        if (!database.objectStoreNames.contains("meta")) {
          database.createObjectStore("meta", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function read(storeName, action) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = action(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function write(storeName, action) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      try {
        action(transaction.objectStore(storeName));
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  const getAllNotes = () => read("notes", (store) => store.getAll());
  const getMeta = (key) => read("meta", (store) => store.get(key));
  async function setMeta(key, value) {
    await write("meta", (store) => store.put({ key, value }));
  }

  async function init() {
    if (opened) return opened;
    opened = (async () => {
      db = await open();
      const stored = await getMeta("device");
      if (stored?.value) {
        deviceId = stored.value;
      } else {
        deviceId = `phone-${Math.random().toString(16).slice(2, 6)}`;
        await setMeta("device", deviceId);
      }
    })();
    return opened;
  }

  function deviceLabel(id) {
    if (!id) return "This phone";
    if (id === deviceId) return "This phone";
    if (String(id).startsWith("demo-")) return `Phone ${String(id).slice(-1).toUpperCase()}`;
    const suffix = String(id).split("-").pop() || "";
    const readable = /^[a-z]+$/i.test(suffix) && suffix.length > 3
      ? suffix.charAt(0).toUpperCase() + suffix.slice(1)
      : suffix.slice(-4).toUpperCase();
    return `Phone ${readable}`;
  }

  function keyOf(direction, item, qty, unit) {
    return [direction, norm(item), Number(qty).toFixed(2), String(unit).toLowerCase()].join("|");
  }

  function noteStd(note) {
    return Math.max(4, Number(note.amount) * (REL_STD[note.kind] ?? 0.08));
  }

  function fuse(notes) {
    const rows = notes.map((note) => {
      const std = noteStd(note);
      return { note, std, weight: 1 / (std * std) };
    });
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    const mean = rows.reduce((sum, row) => sum + row.weight * row.note.amount, 0) / totalWeight;
    let std = Math.sqrt(1 / totalWeight);
    const amounts = notes.map((note) => note.amount);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    const spread = mean > 0 ? (max - min) / mean : 0;
    if (spread > 0.15) std = Math.sqrt(std * std + Math.pow((max - min) / 2, 2));
    let confidence = 1 - notes.reduce((product, note) => product * (1 - note.confidence), 1);
    if (spread > 0.15) confidence -= 0.25;
    return {
      mean,
      std,
      spread,
      confidence: clamp(confidence, 0.05, 0.97),
      status: notes.length === 1 ? "posted" : spread > 0.15 ? "pending" : "fused",
    };
  }

  function buildGroups(notes) {
    const map = new Map();
    notes.forEach((note) => {
      if (!map.has(note.groupId)) map.set(note.groupId, []);
      map.get(note.groupId).push(note);
    });
    return Array.from(map.entries())
      .map(([id, groupNotes]) => {
        groupNotes.sort((a, b) => a.order - b.order);
        const normal = groupNotes.filter((note) => !note.wrongDate);
        const anchor = normal.length ? Math.min(...normal.map((note) => note.order)) : Math.min(...groupNotes.map((note) => note.order));
        const first = groupNotes[0];
        return {
          id,
          notes: groupNotes,
          direction: first.direction,
          item: first.item,
          qty: first.qty,
          unit: first.unit,
          account: first.account || null,
          day: first.day,
          order: anchor,
          lastTime: Math.max(...normal.map((note) => Date.parse(note.createdAt)).filter(Number.isFinite), 0),
          ...fuse(groupNotes),
        };
      })
      .sort((a, b) => a.order - b.order);
  }

  function ledgerEntry(group) {
    const first = group.notes[0];
    return {
      transaction_id: group.id,
      status: group.status,
      debit: {
        account: group.direction === "out" ? `Inventory:${group.item}` : "Cash",
        amount_mean: group.mean,
        amount_std_dev: group.std,
        qty_mean: group.qty,
        unit: group.unit,
      },
      credit: {
        account: group.direction === "out" ? "Cash" : group.account || `Sales:${group.item}`,
        amount_mean: group.mean,
        amount_std_dev: group.std,
      },
      confidence: group.confidence,
      currency: "INR",
      event_ids: group.notes.map((note) => note.id),
      logical_clock: group.order,
      device_id: first.deviceId,
      device_label: deviceLabel(first.deviceId),
      business_date: group.day,
      created_at: first.createdAt,
      clock_suspect: group.notes.some((note) => note.wrongDate),
    };
  }

  async function fingerprint(notes) {
    const text = notes
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((note) => `${note.id}|${note.item}|${note.qty}|${note.amount}|${note.direction}`)
      .join(";");
    if (crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    let hash = 2166136261;
    for (const character of text) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async function addNote(input, mediaBlob, extras = {}) {
    await init();
    const now = new Date();
    const day = localDay(now);
    const createdAt = input.createdAt || now.toISOString();
    const wrongDate = input.wrongDate ?? isWrongClock(createdAt);
    const notes = (await getAllNotes()).filter((note) => (note.day || localDay(new Date(note.createdAt))) === day);
    const groups = buildGroups(notes);
    const key = keyOf(input.direction, input.item, input.qty, input.unit);
    let target = wrongDate
      ? null
      : groups.find((group) => (
        group.notes.length < 3
        && group.direction === input.direction
        && keyOf(group.direction, group.item, group.qty, group.unit) === key
        && group.lastTime > 0
        && now.getTime() - group.lastTime >= 0
        && now.getTime() - group.lastTime <= GROUP_WINDOW_MS
      )) || null;

    const attachments = [];
    for (const attachment of (extras.attachments || []).slice(0, 3)) {
      if (!attachment?.blob) continue;
      const attachmentId = uuid();
      await write("media", (store) => store.put(attachment.blob, attachmentId));
      attachments.push({
        id: attachmentId,
        kind: attachment.kind || "photo",
        mime: attachment.mime || attachment.blob.type || "image/jpeg",
      });
    }

    const id = uuid();
    const order = Math.max(0, ...notes.map((note) => note.order), ...(target ? target.notes.map((note) => note.order) : [])) + 1;
    const note = {
      id,
      groupId: target ? target.id : uuid(),
      kind: input.kind || "typed",
      text: String(input.text || "").slice(0, 2000),
      item: String(input.item).trim(),
      qty: Number(input.qty),
      unit: String(input.unit || "piece").trim(),
      amount: Number(input.amount),
      direction: input.direction,
      createdAt,
      day,
      deviceId: input.deviceId || deviceId,
      confidence: clamp(Number(input.confidence ?? BASE_CONF[input.kind] ?? 0.85), 0.05, 0.99),
      wrongDate,
      order,
      account: input.account || null,
      demo: Boolean(input.demo),
      synced: Boolean(input.synced),
      media: Boolean(mediaBlob),
      attachments,
      contextIds: [...new Set(extras.contextIds || [])].slice(0, 3),
    };

    await write("notes", (store) => store.put(note));
    if (mediaBlob) await write("media", (store) => store.put(mediaBlob, id));

    const groupNotes = target ? [...target.notes, note] : [note];
    const merged = fuse(groupNotes);
    return {
      groupId: note.groupId,
      count: groupNotes.length,
      agree: merged.spread <= 0.15,
      status: merged.status,
      amount: merged.mean,
      std: merged.std,
    };
  }

  function summarize(groups, notes, stock, lossSplit, day) {
    const incoming = groups.filter((group) => group.direction === "in");
    const outgoing = groups.filter((group) => group.direction === "out");
    const sum = (items) => items.reduce((total, group) => total + group.mean, 0);
    const variance = (items) => items.reduce((total, group) => total + group.std * group.std, 0);
    const revenue = sum(incoming);
    const cogs = sum(outgoing);
    const missing = stock && stock.day === day ? Math.max(0, stock.missingValue) : 0;
    const missingStd = missing * 0.1;
    const profit = revenue - cogs - missing;
    const baseStd = Math.sqrt(variance(incoming) + variance(outgoing) + missingStd * missingStd);
    const std = Math.max(baseStd, DAY_FLOOR * (revenue + cogs));
    const weight = groups.reduce((total, group) => total + group.mean, 0);
    const confidence = weight > 0
      ? groups.reduce((total, group) => total + group.mean * group.confidence, 0) / weight
      : 0;
    return {
      revenue_mean: revenue,
      revenue_std_dev: Math.sqrt(variance(incoming)),
      cogs_mean: cogs,
      cogs_std_dev: Math.sqrt(variance(outgoing)),
      loss_mean: missing,
      loss_std_dev: missingStd,
      profit_mean: profit,
      profit_std_dev: std,
      time_period: day,
      confidence,
    };
  }

  function evidenceSummary(notes, groups) {
    const mix = { audio: 0, ocr: 0, video: 0, sms: 0, manual: 0 };
    notes.forEach((note) => { mix[DISPLAY_SOURCE[note.kind] || "manual"] += 1; });
    const weighted = groups.reduce((total, group) => total + group.mean, 0);
    const confidence = weighted > 0
      ? groups.reduce((total, group) => total + group.mean * group.confidence, 0) / weighted
      : 0;
    return {
      total_events: notes.length,
      fused_entries: groups.filter((group) => group.notes.length > 1 && group.status !== "pending").length,
      single_source_entries: groups.filter((group) => group.notes.length === 1).length,
      average_confidence: confidence,
      suspect_clock_events: notes.filter((note) => note.wrongDate).length,
      hostile_clock_recoveries: 0,
      source_mix: mix,
    };
  }

  async function snapshot() {
    await init();
    const day = localDay();
    const allNotes = await getAllNotes();
    const notes = allNotes
      .filter((note) => (note.day || localDay(new Date(note.createdAt))) === day)
      .sort((a, b) => a.order - b.order);
    const groups = buildGroups(notes);
    const stock = (await getMeta("stock"))?.value || null;
    const lossSplit = (await getMeta("lossSplit"))?.value || null;
    const example = Boolean((await getMeta("example"))?.value);
    const syncInfo = (await getMeta("sync"))?.value || null;
    const summary = summarize(groups, notes, stock, lossSplit, day);
    const evidence = evidenceSummary(notes, groups);
    const hasStock = Boolean(stock);
    const reconciliation = stock ? {
      item: stock.item,
      unit: stock.unit,
      counted_qty: stock.countedQty,
      expected_on_hand_qty: stock.expectedQty,
      missing_qty: stock.missingQty,
      missing_value: stock.missingValue,
      modeled_loss_qty_mean: stock.usualQty,
      modeled_loss_qty_std_dev: 0,
      modeled_loss_value_mean: stock.usualQty * stock.unitCost,
      modeled_loss_value_std_dev: 0,
      consistent_within_1_sigma: stock.missingQty <= stock.usualQty,
    } : null;
    const truth = {
      business_date: day,
      profit: {
        mean: summary.profit_mean,
        std_dev: summary.profit_std_dev,
        confidence: summary.confidence,
      },
      loss_components: hasStock && lossSplit && summary.loss_mean > 0 ? lossSplit : [],
      reconciliation,
      waterfall: [
        { label: "Revenue", amount_mean: summary.revenue_mean, amount_std_dev: summary.revenue_std_dev },
        { label: "Less: COGS", amount_mean: -summary.cogs_mean, amount_std_dev: summary.cogs_std_dev },
        { label: "Less: hidden loss", amount_mean: -summary.loss_mean, amount_std_dev: summary.loss_std_dev },
        { label: "True profit", amount_mean: summary.profit_mean, amount_std_dev: summary.profit_std_dev },
      ],
      evidence_summary: evidence,
      actions: [],
      ledger_fingerprint: await fingerprint(notes),
    };
    const devices = [{ device_id: deviceId, label: "This phone", status: "saved", notes: notes.length }];
    const seen = new Map();
    notes.forEach((note) => {
      if (String(note.deviceId).startsWith("demo-")) return;
      if (note.deviceId === deviceId) return;
      if (!seen.has(note.deviceId)) {
        seen.set(note.deviceId, { device_id: note.deviceId, label: deviceLabel(note.deviceId), status: "synced", notes: 0 });
        devices.push(seen.get(note.deviceId));
      }
      seen.get(note.deviceId).notes += 1;
    });
    return {
      day,
      empty: groups.length === 0 && !hasStock,
      example,
      summary,
      ledger: groups.map(ledgerEntry),
      truth,
      devices,
      notes,
      events: notes.map((note) => ({
        event_id: note.id,
        source: DISPLAY_SOURCE[note.kind] || "manual",
        device_id: note.deviceId,
        device_label: deviceLabel(note.deviceId),
        wall_clock: note.createdAt,
        raw_text: note.text || `${note.item} ${note.qty} ${note.unit}`,
        logical_clock: note.order,
        extracted_entities: [{ item: note.item, qty: note.qty, unit: note.unit, price: note.amount }],
      })),
      stock: stock ? { ...stock } : null,
      syncInfo,
      seed: example,
      fingerprint: truth.ledger_fingerprint,
      deviceLabel: deviceLabel(deviceId),
    };
  }

  async function explain(groupId) {
    await init();
    const notes = (await getAllNotes()).sort((a, b) => a.order - b.order);
    const allGroups = buildGroups(notes);
    const group = allGroups.find((item) => item.id === groupId);
    if (!group) throw new Error("This note is no longer on the phone.");
    const sources = group.notes.map((note) => ({
      event_id: note.id,
      source: DISPLAY_SOURCE[note.kind] || "manual",
      device_id: note.deviceId,
      device_label: deviceLabel(note.deviceId),
      confidence: note.confidence,
      wall_clock: note.createdAt,
      clock_suspect: note.wrongDate,
      item: note.item,
      qty: note.qty,
      unit: note.unit,
      price: note.amount,
      unit_price: note.qty ? note.amount / note.qty : note.amount,
      logical_clock: note.order,
      media: note.media,
      attachments: note.attachments || [],
      context_ids: note.contextIds || [],
      text: note.text,
    }));
    const contexts = [];
    group.notes.forEach((note) => {
      (note.contextIds || []).forEach((contextId) => {
        const linked = allGroups.find((item) => item.id === contextId);
        if (!linked || contexts.some((item) => item.transaction_id === contextId)) return;
        contexts.push({
          transaction_id: linked.id,
          title: groupTitle(linked),
          amount: linked.mean,
          status: linked.status,
        });
      });
    });
    const ranges = group.notes.map((note) => ({
      event_id: note.id,
      source: KIND_TO_SOURCE[note.kind] || "manual",
      amount_mean: note.amount,
      amount_std_dev: noteStd(note),
    }));
    const verdict = group.notes.length === 1 ? "single_source" : group.spread > 0.15 ? "disagree" : "agree";
    const meanSourceConfidence = group.notes.reduce((total, note) => total + note.confidence, 0) / group.notes.length;
    return {
      transaction_id: group.id,
      status: group.status,
      amount_mean: group.mean,
      amount_std_dev: group.std,
      confidence: group.confidence,
      simulated_amount_mean: group.mean,
      simulated_amount_std_dev: group.std,
      simulated_confidence: group.confidence,
      sources,
      per_source_ranges: ranges,
      agreement: {
        verdict,
        price_spread_pct: group.spread * 100,
        std_multiplier: 1,
        confidence_adjustment: 0,
        mean_source_confidence: meanSourceConfidence,
        method: "notes compared on this phone",
      },
      narrative: "",
      evidence_event_ids: group.notes.map((note) => note.id),
      contexts,
      canonical_fallback: false,
    };
  }

  function groupTitle(group) {
    if (String(group.account || "").startsWith("Udhaar:")) {
      return `${String(group.account).split(":").slice(1).join(":")} paid back`;
    }
    const item = String(group.item || "").toLowerCase();
    return group.direction === "in" ? `Sold ${item}` : `Bought ${item}`;
  }

  async function countStock(input) {
    await init();
    const day = localDay();
    const notes = await getAllNotes();
    const itemKey = norm(input.item);
    let purchased = 0;
    let spent = 0;
    buildGroups(notes).forEach((group) => {
      if (group.direction === "out" && group.unit === "kg" && norm(group.item) === itemKey) {
        purchased += group.qty;
        spent += group.mean;
      }
    });
    const unitCost = purchased > 0 ? spent / purchased : 0;
    const counted = Math.max(0, Number(input.countedQty));
    const missingQty = Math.max(0, purchased - counted);
    const stock = {
      item: input.item.charAt(0).toUpperCase() + input.item.slice(1),
      itemKey,
      unit: "kg",
      expectedQty: purchased,
      countedQty: counted,
      missingQty,
      unitCost,
      missingValue: missingQty * unitCost,
      usualQty: purchased * USUAL_SHARE,
      consistent: missingQty <= purchased * USUAL_SHARE,
      countedAt: new Date().toISOString(),
      day,
      seed: false,
    };
    await setMeta("stock", stock);
    return stock;
  }

  async function loadExample() {
    await init();
    await write("notes", (store) => store.clear());
    await write("media", (store) => store.clear());
    await setMeta("stock", null);
    await setMeta("lossSplit", null);
    await setMeta("sync", null);
    const day = localDay();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const at = (hour, minute = 0) => {
      const date = new Date(start);
      date.setHours(hour, minute, 0, 0);
      return date.toISOString();
    };
    const base = (overrides) => ({
      id: overrides.id || uuid(),
      groupId: overrides.groupId,
      kind: overrides.kind,
      text: overrides.text || "",
      item: overrides.item,
      qty: overrides.qty,
      unit: overrides.unit,
      amount: overrides.amount,
      direction: overrides.direction,
      createdAt: overrides.createdAt,
      day,
      deviceId: overrides.deviceId,
      confidence: overrides.confidence ?? BASE_CONF[overrides.kind] ?? 0.85,
      wrongDate: Boolean(overrides.wrongDate),
      order: overrides.order,
      account: overrides.account || null,
      demo: true,
      synced: false,
      media: false,
      attachments: [],
      contextIds: [],
    });
    const notes = [
      base({ id: "demo-photo", groupId: "seed-tomato", kind: "photo", item: "tomatoes", qty: 3, unit: "kg", amount: 180, direction: "out", createdAt: "1970-01-01T00:00:00.000Z", deviceId: "demo-b", wrongDate: true, order: 9, text: "TOMATO 3 KG 180 ONION 2 KG" }),
      base({ id: "demo-onion", groupId: "seed-onion", kind: "sms", item: "onion", qty: 2, unit: "kg", amount: 80, direction: "out", createdAt: at(8, 50), deviceId: "demo-a", order: 2, text: "2 kg onion 80" }),
      base({ id: "demo-oil", groupId: "seed-oil", kind: "typed", item: "oil", qty: 1, unit: "litre", amount: 286, direction: "out", createdAt: at(9, 5), deviceId: "demo-a", order: 3, text: "Oil 1 litre 286" }),
      base({ id: "demo-gas", groupId: "seed-gas", kind: "typed", item: "gas cylinder", qty: 1, unit: "piece", amount: 600, direction: "out", createdAt: at(9, 20), deviceId: "demo-a", order: 4, text: "Gas cylinder 600" }),
      base({ id: "demo-tomato-voice", groupId: "seed-tomato", kind: "voice", item: "tomatoes", qty: 3, unit: "kg", amount: 180, direction: "out", createdAt: at(9, 14), deviceId: "demo-a", order: 1, text: "Bhai 3 kilo tamatar liya 180 mein... Sharma ji ka 40 jama kar, aur 7 plate poha de." }),
      base({ id: "demo-poha", groupId: "seed-poha", kind: "typed", item: "poha", qty: 7, unit: "plate", amount: 560, direction: "in", createdAt: at(10, 5), deviceId: "demo-a", order: 5, text: "7 plate poha at 80 each = 560" }),
      base({ id: "demo-tea", groupId: "seed-tea", kind: "typed", item: "tea", qty: 50, unit: "cup", amount: 1000, direction: "in", createdAt: at(15, 0), deviceId: "demo-a", order: 6, text: "50 cups tea at 20 = 1000" }),
      base({ id: "demo-snacks", groupId: "seed-snacks", kind: "typed", item: "snacks", qty: 40, unit: "piece", amount: 800, direction: "in", createdAt: at(18, 30), deviceId: "demo-a", order: 7, text: "40 snacks at 20 = 800" }),
      base({ id: "demo-credit", groupId: "seed-credit", kind: "sms", item: "sharma ji", qty: 1, unit: "payment", amount: 40, direction: "in", createdAt: at(18, 20), deviceId: "demo-c", order: 8, account: "Udhaar:Sharma ji", text: "Sharma ji ka 40 jama ho gaya" }),
    ];
    await write("notes", (store) => notes.forEach((note) => store.put(note)));
    await setMeta("stock", {
      item: "Tomatoes",
      itemKey: "tomatoes",
      unit: "kg",
      expectedQty: 2.895,
      countedQty: 2,
      missingQty: 0.895,
      unitCost: 60,
      missingValue: 53.7,
      usualQty: 0.9,
      consistent: true,
      countedAt: at(21, 0),
      day,
      seed: true,
    });
    await setMeta("lossSplit", [
      { cause: "spoilage", share_mean: 0.55 },
      { cause: "theft", share_mean: 0.2 },
      { cause: "personal_consumption", share_mean: 0.25 },
    ]);
    await setMeta("example", true);
  }

  async function reset() {
    await init();
    await write("notes", (store) => store.clear());
    await write("media", (store) => store.clear());
    await setMeta("stock", null);
    await setMeta("lossSplit", null);
    await setMeta("sync", null);
    await setMeta("example", false);
  }

  async function sync(apiBase) {
    await init();
    const base = String(apiBase || "").replace(/\/+$/, "");
    if (!base) throw new Error("Set the shop server address first.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const health = await fetch(`${base}/health`, { signal: controller.signal, cache: "no-store" });
      if (!health.ok) throw new Error("offline");
    } catch {
      throw new Error("No connection. Everything is saved on this phone.");
    } finally {
      clearTimeout(timer);
    }

    const notes = await getAllNotes();
    const unsynced = notes.filter((note) => !note.synced && !note.demo && note.amount > 0);
    let pushed = 0;
    for (const note of unsynced) {
      const account = note.account ? `:acc=${encodeURIComponent(note.account)}` : "";
      const body = {
        event_id: note.id,
        source: KIND_TO_SOURCE[note.kind] || "manual",
        raw_text: note.text || `${note.direction === "out" ? "Bought" : "Sold"} ${note.qty} ${note.unit} ${note.item} for ${note.amount}`,
        device_id: note.deviceId,
        wall_clock: note.createdAt,
        confidence: note.confidence,
        media_ref: `iw:${note.direction}:${note.kind}${account}`,
        extracted_entities: [{ item: note.item, qty: note.qty, unit: note.unit, price: note.amount }],
      };
      const response = await fetch(`${base}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("The shop server refused a note.");
      await write("notes", (store) => store.put({ ...note, synced: true }));
      pushed += 1;
    }

    const response = await fetch(`${base}/events`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read notes from the shop server.");
    const events = await response.json();
    const current = await getAllNotes();
    const known = new Set(current.map((note) => note.id));
    let order = Math.max(0, ...current.map((note) => note.order));
    const working = current.slice();
    const pulledNotes = [];
    events.forEach((event) => {
      if (!String(event.device_id || "").startsWith("phone-")) return;
      if (known.has(event.event_id)) return;
      const entity = event.extracted_entities?.[0];
      if (!entity || entity.price == null) return;
      const meta = String(event.media_ref || "");
      const direction = meta.includes("iw:out") ? "out" : meta.includes("iw:in") ? "in" : /^sold/i.test(event.raw_text || "") ? "in" : "out";
      const accountMatch = meta.match(/:acc=([^:]+)/);
      const kindMatch = meta.match(/^iw:[^:]+:([a-z]+)/);
      const kind = kindMatch && ["photo", "voice", "video", "typed", "sms"].includes(kindMatch[1])
        ? kindMatch[1]
        : SOURCE_TO_KIND[event.source] || "typed";
      const day = localDay();
      const wrongDate = isWrongClock(event.wall_clock);
      order += 1;
      const note = {
        id: event.event_id,
        groupId: uuid(),
        kind,
        text: String(event.raw_text || "").slice(0, 2000),
        item: entity.item,
        qty: Number(entity.qty) || 1,
        unit: entity.unit || "piece",
        amount: Number(entity.price),
        direction,
        createdAt: event.wall_clock,
        day,
        deviceId: event.device_id,
        confidence: clamp(Number(event.confidence ?? BASE_CONF[kind] ?? 0.85), 0.05, 0.99),
        wrongDate,
        order,
        account: accountMatch ? decodeURIComponent(accountMatch[1]) : null,
        demo: false,
        synced: true,
        media: false,
        attachments: [],
        contextIds: [],
      };
      if (!wrongDate) {
        const key = keyOf(note.direction, note.item, note.qty, note.unit);
        const target = buildGroups(working).find((group) => (
          group.notes.length < 3
          && group.direction === note.direction
          && keyOf(group.direction, group.item, group.qty, group.unit) === key
          && group.lastTime > 0
          && Math.abs(Date.parse(event.wall_clock) - group.lastTime) <= SYNC_WINDOW_MS
        ));
        if (target) note.groupId = target.id;
      }
      working.push(note);
      pulledNotes.push(note);
    });
    if (pulledNotes.length) {
      await write("notes", (store) => pulledNotes.forEach((note) => store.put(note)));
    }
    const info = { at: new Date().toISOString(), pushed, pulled: pulledNotes.length };
    await setMeta("sync", info);
    return info;
  }

  async function getMedia(id) {
    await init();
    return read("media", (store) => store.get(id));
  }

  window.IWLocal = {
    init,
    snapshot,
    explain,
    addNote,
    countStock,
    loadExample,
    reset,
    sync,
    getMedia,
    isWrongClock,
    deviceId: () => deviceId,
    deviceLabel,
  };
})();
