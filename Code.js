/**
 * ====================================================================
 * RAVii INVENTORY ENGINE v2.1 — ledger-driven, J/N/O model
 * --------------------------------------------------------------------
 * Stock math lives HERE, not in sheet formulas. Three Inventory columns,
 * resolved BY HEADER NAME (never hardcoded):
 *   HQ Inventory  (J)  = "In Store"  — materialized total; add/deduct/counts write here
 *   On Display    (N)  = show units  — mark-show writes here
 *   In Sales      (O)  = max(0, HQ - On Display) — sellable; code-derived, written on every mutation
 * Inflow HQ / Outflow HQ / Static Initial Stock Count (G/H/I) are RETIRED
 * (ignored by code; the columns are left physically intact).
 * Every stock change also appends a signed delta to "Stock Change History".
 *
 * The browser app (hosted on Netlify) reaches these via a Netlify Function
 * proxy that adds CORS. Reads: doGet(?action=...). Writes: doPost({action,...}).
 * ====================================================================
 */

const CONFIG = {
  // Sheet/tab names
  TAB_INV: "Inventory",                 // Master inventory (source of truth)
  TAB_ADJ: "Stock Change History",      // The ledger (append-only)
  TAB_SC: "Stock Count",                // Legacy on-sheet count input (checkbox path)
  TAB_INCOMING: "Incoming inventory",   // Legacy transaction sheet (demoted)
  TAB_OUTGOING: "Outgoing Inventory",   // Legacy transaction sheet (demoted)
  TAB_IMG: "Img",                       // productName -> Drive image
  TAB_LIVE: "Live Inventory",           // Query mirror used by the matrix builder

  // Inventory header NAMES (resolved by name; never hardcode columns)
  H_SKU: "SKU",
  H_CODE: "Code",
  H_BRAND: "Brand",
  H_COLOR: "color",
  H_SIZE: "size",
  H_NAME: "Name",
  H_HQ: "HQ Inventory",                 // In Store
  H_ONDISPLAY: "On Display",
  H_INSALES: "In Sales",                // = max(0, HQ - On Display)

  // Stock Count sheet columns (legacy checkbox path)
  SC_COL_SKU: 2,                        // Column B
  SC_COL_QTY: 3,                        // Column C

  ADJ_REASON: "Full Stock Count (Global Reset)",
  LOCK_WAIT_MS: 30000
};

/* ====================================================================
 * WEB ENDPOINTS  (reads via GET, writes via POST; both return JSON)
 * ==================================================================== */

function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action;
    if (!action) return jsonOut_({ ok: true, data: { status: "RAVii inventory API v2.1" } });
    return jsonOut_({ ok: true, data: routeAction_(action, e.parameter) });
  } catch (err) {
    return jsonOut_(errorOut_(err));
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body && body.action) {
      return jsonOut_({ ok: true, data: routeAction_(body.action, body) });
    }
    return legacyDoPost_(e); // old cached app build doing {target, items}
  } catch (err) {
    return jsonOut_(errorOut_(err));
  }
}

function routeAction_(action, payload) {
  switch (action) {
    case "ping":                   return { pong: true, at: new Date().toISOString() };
    case "getInventory":           return getInventory();
    case "recomputeAll":           return recomputeAll();
    case "applyAddDeduct":         return applyAddDeduct(payload);
    case "applyStockCountFull":    return applyStockCountFull(payload);
    case "applyStockCountPartial": return applyStockCountPartial(payload);
    case "applyShowMarks":         return applyShowMarks(payload);
    case "setShowFlag":            return setShowFlag(payload);
    case "dumpLedger":             return dumpLedger();          // read-only ledger export (recovery)
    case "auditRecovery":          return auditRecovery(payload); // read-only dry-run report (recovery)
    default: throw mkError_("Unknown action: " + action, "BAD_INPUT");
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}
function errorOut_(err) {
  return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || "ERROR" };
}
function mkError_(msg, code) {
  var e = new Error(msg);
  e.code = code || "ERROR";
  return e;
}

/* ====================================================================
 * SHARED INFRASTRUCTURE
 * ==================================================================== */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) throw mkError_("System busy, please retry.", "BUSY");
  try { return fn(); } finally { lock.releaseLock(); }
}

/**
 * Read the Inventory header row once; resolve columns by NAME.
 * onDisplay / inSales / code are optional (null if the column is absent).
 */
function getInventoryIndex_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.TAB_INV);
  if (!sheet) throw mkError_("Missing '" + CONFIG.TAB_INV + "' sheet", "NOT_FOUND");

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });

  function find(name) { return headers.findIndex(function (h) { return h.toLowerCase() === name.toLowerCase(); }); }
  function req(name) { var i = find(name); if (i === -1) throw mkError_("Inventory column not found: " + name, "BAD_INPUT"); return i + 1; }
  function opt(name) { var i = find(name); return i === -1 ? null : i + 1; }

  return {
    sheet: sheet, lastRow: lastRow, lastCol: lastCol,
    cols: {
      sku: req(CONFIG.H_SKU),
      code: opt(CONFIG.H_CODE),
      brand: req(CONFIG.H_BRAND),
      color: req(CONFIG.H_COLOR),
      size: req(CONFIG.H_SIZE),
      name: req(CONFIG.H_NAME),
      hq: req(CONFIG.H_HQ),
      onDisplay: opt(CONFIG.H_ONDISPLAY),
      inSales: opt(CONFIG.H_INSALES)
    }
  };
}

function readCol_(sheet, col, n) { return sheet.getRange(2, col, n, 1).getValues(); }

/** Recompute & write "In Sales" = max(0, HQ - On Display) for all rows (no-op if column absent). */
function writeInSales_(idx, hqVals, onDisplayVals) {
  if (!idx.cols.inSales) return;
  var n = hqVals.length, out = [];
  for (var i = 0; i < n; i++) {
    var hq = Number(hqVals[i][0]) || 0;
    var od = onDisplayVals ? (Number(onDisplayVals[i][0]) || 0) : 0;
    out.push([Math.max(0, hq - od)]);
  }
  idx.sheet.getRange(2, idx.cols.inSales, n, 1).setValues(out);
}

function appendLedger_(rows) {
  if (!rows || !rows.length) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.TAB_ADJ);
  if (!sheet) throw mkError_("Missing '" + CONFIG.TAB_ADJ + "' sheet", "NOT_FOUND");
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** items:[{sku,count}] -> Map(sku -> summed count), ignoring blanks/zeros. */
function aggregateItems_(items) {
  var m = new Map();
  (items || []).forEach(function (it) {
    var sku = String(it.sku).trim();
    var c = Number(it.count) || 0;
    if (sku && c) m.set(sku, (m.get(sku) || 0) + c);
  });
  return m;
}

/**
 * CORE INCREMENT ENGINE — add/deduct. Updates HQ, recomputes In Sales.
 */
function applyDeltas_(deltaMap, reason, note) {
  return withLock_(function () {
    var idx = getInventoryIndex_();
    var sheet = idx.sheet, cols = idx.cols, lastRow = idx.lastRow;
    var missing = [];
    if (lastRow < 2) { deltaMap.forEach(function (_v, sku) { missing.push(sku); }); return { updated: 0, missing: missing }; }

    var n = lastRow - 1;
    var skuVals = readCol_(sheet, cols.sku, n);
    var hqVals = readCol_(sheet, cols.hq, n);
    var onDisplayVals = cols.onDisplay ? readCol_(sheet, cols.onDisplay, n) : null;

    var rowBySku = new Map();
    for (var i = 0; i < n; i++) { var s = String(skuVals[i][0]).trim(); if (s) rowBySku.set(s, i); }

    var ledger = [], ts = new Date(), updated = 0;
    deltaMap.forEach(function (delta, sku) {
      var d = Number(delta) || 0;
      var ri = rowBySku.get(String(sku).trim());
      if (ri === undefined) { missing.push(sku); return; }
      hqVals[ri][0] = (Number(hqVals[ri][0]) || 0) + d;
      if (d !== 0) ledger.push([ts, sku, d, reason, note || ""]);
      updated++;
    });

    sheet.getRange(2, cols.hq, n, 1).setValues(hqVals);
    writeInSales_(idx, hqVals, onDisplayVals);
    appendLedger_(ledger);
    return { updated: updated, missing: missing };
  });
}

/**
 * CORE COUNT ENGINE — full & partial counts.
 * In-scope SKU: counted = scanned ?? 0 (unscanned-in-scope -> 0). Sets HQ = counted,
 * logs delta, recomputes In Sales. Out-of-scope untouched. Returns variance.
 */
function applyCount_(scannedMap, inScope, reason, note) {
  return withLock_(function () {
    var idx = getInventoryIndex_();
    var sheet = idx.sheet, cols = idx.cols, lastRow = idx.lastRow, lastCol = idx.lastCol;
    var variance = { inScope: 0, counted: 0, zeroed: [], increased: [], decreased: [], unchanged: 0, totalDelta: 0 };
    if (lastRow < 2) return variance;

    var n = lastRow - 1;
    var block = sheet.getRange(2, 1, n, lastCol).getValues();
    var hqVals = [], onDisplayVals = [];
    for (var i = 0; i < n; i++) {
      hqVals.push([block[i][cols.hq - 1]]);
      onDisplayVals.push([cols.onDisplay ? block[i][cols.onDisplay - 1] : 0]);
    }

    var ledger = [], ts = new Date();
    for (var r = 0; r < n; r++) {
      var sku = String(block[r][cols.sku - 1]).trim();
      if (!sku) continue;
      var item = {
        sku: sku,
        name: String(block[r][cols.name - 1]).trim(),
        color: String(block[r][cols.color - 1]).trim(),
        size: String(block[r][cols.size - 1]).trim()
      };
      if (!inScope(item)) continue;

      variance.inScope++;
      var wasScanned = scannedMap.has(sku);
      var counted = wasScanned ? (Number(scannedMap.get(sku)) || 0) : 0;
      if (wasScanned) variance.counted++;

      var old = Number(hqVals[r][0]) || 0;
      var delta = counted - old;
      hqVals[r][0] = counted;

      if (delta !== 0) {
        ledger.push([ts, sku, delta, reason, note || ""]);
        variance.totalDelta += delta;
        if (counted === 0 && old > 0) variance.zeroed.push({ sku: sku, was: old });
        else if (delta > 0) variance.increased.push({ sku: sku, was: old, now: counted });
        else variance.decreased.push({ sku: sku, was: old, now: counted });
      } else variance.unchanged++;
    }

    sheet.getRange(2, cols.hq, n, 1).setValues(hqVals);
    writeInSales_(idx, hqVals, onDisplayVals);
    appendLedger_(ledger);
    return variance;
  });
}

function makeScopePredicate_(selectors) {
  var norm = function (s) { return String(s == null ? "" : s).trim().toLowerCase(); };
  var sel = (selectors || []).map(function (x) {
    return { name: norm(x.name), color: norm(x.color), size: norm(x.size), sku: String(x.sku || "").trim() };
  });
  return function (item) {
    for (var i = 0; i < sel.length; i++) {
      var s = sel[i];
      if (s.sku) { if (s.sku === item.sku) return true; continue; }
      if (s.name && s.name !== norm(item.name)) continue;
      if (s.color && s.color !== norm(item.color)) continue;
      if (s.size && s.size !== norm(item.size)) continue;
      if (s.name || s.color || s.size) return true;
    }
    return false;
  };
}

function describeScope_(selectors) {
  if (!selectors || !selectors.length) return "Partial";
  return selectors.map(function (s) {
    if (s.sku) return s.sku;
    return [s.name, s.color, s.size].filter(Boolean).join("/");
  }).join("; ").slice(0, 240);
}

/* ====================================================================
 * WRITE ACTIONS
 * ==================================================================== */

function applyAddDeduct(payload) {
  var dir = (payload.direction === "deduct") ? -1 : 1;
  var agg = aggregateItems_(payload.items);
  var deltaMap = new Map();
  agg.forEach(function (cnt, sku) { deltaMap.set(sku, dir * cnt); });
  return applyDeltas_(deltaMap, dir > 0 ? "Add (App)" : "Deduct (App)", "");
}

function applyStockCountFull(payload) {
  var scanned = aggregateItems_(payload.items);
  // Backstop: an empty full count would zero EVERY SKU in the store. Stale cached
  // clients can still POST here, so guard server-side too. `force` is the deliberate escape.
  if (scanned.size === 0 && !payload.force) {
    throw mkError_("Refusing empty full count: it would set EVERY SKU to 0. Pass force:true only if the whole store is genuinely empty.", "EMPTY_COUNT");
  }
  return { variance: applyCount_(scanned, function () { return true; }, "Full Stock Count (Global Reset)", "") };
}

function applyStockCountPartial(payload) {
  var scanned = aggregateItems_(payload.items);
  var selectors = (payload.scope && payload.scope.selectors) || payload.selectors || [];
  if (!selectors.length) throw mkError_("Partial count needs a scope.", "BAD_INPUT");
  // Backstop: an empty partial count sets every in-scope SKU to 0 (unscanned -> 0). This is the
  // bug that produced mirrored +N/-N ledger rows. Reject empty scans unless explicitly forced.
  if (scanned.size === 0 && !payload.force) {
    throw mkError_("Refusing empty partial count: it would set every in-scope SKU to 0. Pass force:true only if the whole scope is genuinely sold out.", "EMPTY_COUNT");
  }
  var variance = applyCount_(scanned, makeScopePredicate_(selectors), "Partial Stock Count", describeScope_(selectors));
  return { variance: variance };
}

/**
 * Adjust On Display (Inventory col N) by +count (show) or -count (unshow), clamped at 0.
 * In Store unchanged; In Sales recomputed. `missing` = scanned SKUs not present in Inventory.
 */
function applyShowMarks(payload) {
  var dir = (payload.direction === "unshow") ? -1 : 1;
  var agg = aggregateItems_(payload.items);
  return withLock_(function () {
    var idx = getInventoryIndex_();
    var sheet = idx.sheet, cols = idx.cols, lastRow = idx.lastRow;
    if (!cols.onDisplay) throw mkError_("Inventory has no 'On Display' column", "NOT_FOUND");
    var missing = [];
    if (lastRow < 2) { agg.forEach(function (_v, sku) { missing.push(sku); }); return { updated: 0, missing: missing }; }

    var n = lastRow - 1;
    var skuVals = readCol_(sheet, cols.sku, n);
    var hqVals = readCol_(sheet, cols.hq, n);
    var onDisplayVals = readCol_(sheet, cols.onDisplay, n);

    var rowBySku = new Map();
    for (var i = 0; i < n; i++) { var s = String(skuVals[i][0]).trim(); if (s) rowBySku.set(s, i); }

    var updated = 0, ledger = [], ts = new Date();
    var reason = dir > 0 ? "Show (App)" : "Unshow (App)";
    agg.forEach(function (cnt, sku) {
      var ri = rowBySku.get(sku);
      if (ri === undefined) { missing.push(sku); return; }
      var cur = Number(onDisplayVals[ri][0]) || 0;
      onDisplayVals[ri][0] = Math.max(0, cur + dir * cnt);
      var delta = onDisplayVals[ri][0] - cur;
      if (delta !== 0) ledger.push([ts, sku, delta, reason, ""]);
      updated++;
    });

    sheet.getRange(2, cols.onDisplay, n, 1).setValues(onDisplayVals);
    writeInSales_(idx, hqVals, onDisplayVals);
    appendLedger_(ledger);
    return { updated: updated, missing: missing };
  });
}

/** Absolute set of On Display for one SKU (matrix tap). Targeted single-row write. */
function setShowFlag(payload) {
  var sku = String(payload.sku).trim();
  var qty = Math.max(0, Number(payload.onDisplay) || 0);
  if (!sku) throw mkError_("Missing sku", "BAD_INPUT");
  return withLock_(function () {
    var idx = getInventoryIndex_();
    var sheet = idx.sheet, cols = idx.cols, lastRow = idx.lastRow;
    if (!cols.onDisplay) throw mkError_("Inventory has no 'On Display' column", "NOT_FOUND");
    if (lastRow < 2) throw mkError_("Inventory is empty", "NOT_FOUND");

    var n = lastRow - 1;
    var skuVals = readCol_(sheet, cols.sku, n);
    var ri = -1;
    for (var i = 0; i < n; i++) { if (String(skuVals[i][0]).trim() === sku) { ri = i; break; } }
    if (ri === -1) throw mkError_("SKU not found: " + sku, "NOT_FOUND");

    var row = ri + 2;
    var prevQty = Number(sheet.getRange(row, cols.onDisplay).getValue()) || 0;
    sheet.getRange(row, cols.onDisplay).setValue(qty);
    var hq = Number(sheet.getRange(row, cols.hq).getValue()) || 0;
    if (cols.inSales) {
      sheet.getRange(row, cols.inSales).setValue(Math.max(0, hq - qty));
    }
    var delta = qty - prevQty;
    if (delta !== 0) {
      var reason = delta > 0 ? "Show (App)" : "Unshow (App)";
      appendLedger_([[new Date(), sku, delta, reason, ""]]);
    }
    return { sku: sku, onDisplay: qty };
  });
}

/* ====================================================================
 * READ ACTIONS
 * ==================================================================== */

function getInventory() {
  var idx = getInventoryIndex_();
  var sheet = idx.sheet, cols = idx.cols, lastRow = idx.lastRow, lastCol = idx.lastCol;
  var items = [];

  if (lastRow >= 2) {
    var n = lastRow - 1;
    var block = sheet.getRange(2, 1, n, lastCol).getValues();

    // Self-heal: On Display is bounded by In Store (HQ). You can't display more than you
    // physically have, and if HQ is 0 there's nothing to display. Clamp every row to
    // min(onDisplay, max(0, HQ)); if anything drifted, persist the fix (On Display + In Sales)
    // so the sheet is corrected on load. No write happens when everything already agrees.
    if (cols.onDisplay) {
      var drift = false;
      for (var r = 0; r < n; r++) {
        var hq = Number(block[r][cols.hq - 1]) || 0;
        var od = Number(block[r][cols.onDisplay - 1]) || 0;
        var clamped = Math.min(od, Math.max(0, hq));
        if (clamped !== od) { block[r][cols.onDisplay - 1] = clamped; drift = true; }
      }
      if (drift) {
        withLock_(function () {
          var odOut = [], hqVals = [];
          for (var w = 0; w < n; w++) {
            odOut.push([Number(block[w][cols.onDisplay - 1]) || 0]);
            hqVals.push([Number(block[w][cols.hq - 1]) || 0]);
          }
          sheet.getRange(2, cols.onDisplay, n, 1).setValues(odOut);
          writeInSales_(idx, hqVals, odOut);
        });
      }
    }

    for (var i = 0; i < n; i++) {
      var sku = String(block[i][cols.sku - 1]).trim();
      if (!sku) continue;
      items.push({
        s: sku,
        n: String(block[i][cols.name - 1]).trim(),
        b: String(block[i][cols.brand - 1]).trim(),
        c: String(block[i][cols.color - 1]).trim(),
        z: String(block[i][cols.size - 1]).trim(),
        inStore: Number(block[i][cols.hq - 1]) || 0,
        onDisplay: cols.onDisplay ? (Number(block[i][cols.onDisplay - 1]) || 0) : 0
      });
    }
  }
  return { updated: new Date().toISOString(), items: items, images: getImageMap_() };
}

/** One-time backfill / re-sync: In Sales = max(0, HQ - On Display) for every row. */
function recomputeAll() {
  return withLock_(function () {
    var idx = getInventoryIndex_();
    var sheet = idx.sheet, cols = idx.cols, lastRow = idx.lastRow;
    if (!cols.inSales) return { rows: 0, note: "No 'In Sales' column found" };
    if (lastRow < 2) return { rows: 0 };
    var n = lastRow - 1;
    var hqVals = readCol_(sheet, cols.hq, n);
    var onDisplayVals = cols.onDisplay ? readCol_(sheet, cols.onDisplay, n) : null;
    writeInSales_(idx, hqVals, onDisplayVals);
    return { rows: n };
  });
}

function getImageMap_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.TAB_IMG);
  var map = {};
  if (!sheet) return map;
  var data = sheet.getDataRange().getValues();
  data.forEach(function (r) { if (r[0]) map[String(r[0]).trim().toLowerCase()] = extractId(r[1]); });
  return map;
}

/* ====================================================================
 * LEGACY: old app builds posting {target, items} (kept during cutover)
 * ==================================================================== */

function legacyDoPost_(e) {
  var JSONData = JSON.parse(e.postData.contents);
  var targetTabName = JSONData.target;
  var items = JSONData.items || [];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(targetTabName);
  if (targetTabName === "-" || !sheet) sheet = ss.getSheetByName("Transfer") || ss.insertSheet("Transfer");

  var timestamp = new Date();
  for (var i = items.length - 1; i >= 0; i--) {
    var item = items[i];
    sheet.insertRowBefore(2);
    sheet.getRange(2, 1, 1, 5).setValues([[timestamp, item.sku, item.count, "", "App Sync"]]);
  }
  return jsonOut_({ status: "success" });
}

/* ====================================================================
 * ON-SHEET TRIGGERS & MATRIX BUILDER (existing UX preserved)
 * ==================================================================== */

function onEdit(e) {
  if (!e) return;
  var range = e.range;
  var sheet = range.getSheet();
  var sheetName = sheet.getName();
  var row = range.getRow();
  var col = range.getColumn();
  var value = e.value;

  if (row === 1 && col === 2 && value === "TRUE") {
    if (sheetName === "RAVii" || sheetName === "RAVii essentials") {
      range.setValue(false);
      createSplitMatrixView();
      return;
    }
  }

  if (sheetName === CONFIG.TAB_SC && row === 1 && col === 7 && value === "TRUE") {
    range.setValue(false);
    processGlobalStockReset();
    return;
  }
}

function runFullCount() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt(
    '⚠️ CRITICAL ACTION: FULL STOCK RESET ⚠️',
    'This recounts every SKU from the "Stock Count" tab, logs +/- variances to history, sets In Store, and wipes transaction logs.\nType "confirm" to proceed:',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() == ui.Button.OK) {
    if (result.getResponseText().toLowerCase().trim() === 'confirm') {
      try { ui.alert('Success', processGlobalStockReset(), ui.ButtonSet.OK); }
      catch (error) { ui.alert('❌ Execution Error', error.toString(), ui.ButtonSet.OK); }
    } else {
      ui.alert('❌ Cancelled', 'Incorrect confirmation text entered.', ui.ButtonSet.OK);
    }
  }
}

/** Reads the "Stock Count" sheet, runs a full count via the ledger engine, clears logs. */
function processGlobalStockReset() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var scSheet = ss.getSheetByName(CONFIG.TAB_SC);
  if (!scSheet) throw mkError_("Missing '" + CONFIG.TAB_SC + "' sheet", "NOT_FOUND");

  var last = scSheet.getLastRow();
  var scanned = new Map();
  if (last >= 2) {
    var data = scSheet.getRange(2, 1, last - 1, Math.max(CONFIG.SC_COL_QTY, scSheet.getLastColumn())).getValues();
    data.forEach(function (r) {
      var sku = String(r[CONFIG.SC_COL_SKU - 1]).trim();
      var qty = Number(r[CONFIG.SC_COL_QTY - 1]);
      if (sku) scanned.set(sku, (scanned.get(sku) || 0) + (isNaN(qty) ? 0 : qty));
    });
  }

  var variance = applyCount_(scanned, function () { return true; }, CONFIG.ADJ_REASON, "Global Reset (sheet)");

  clearSheetBody_(scSheet);
  clearSheetBody_(ss.getSheetByName(CONFIG.TAB_INCOMING));
  clearSheetBody_(ss.getSheetByName(CONFIG.TAB_OUTGOING));

  return "Counted " + variance.inScope + " SKUs · " + variance.zeroed.length +
         " zeroed · total delta " + variance.totalDelta + ".";
}

function clearSheetBody_(sheet) {
  if (!sheet) return;
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
}

function createSplitMatrixView() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const itemSheet = ss.getSheetByName(CONFIG.TAB_LIVE);
  const imgSheet = ss.getSheetByName(CONFIG.TAB_IMG);
  if (!itemSheet || !imgSheet) return;

  const BRAND_CONFIG = [
    { brand: "RAVii", sheetName: "RAVii" },
    { brand: "RAVii Essentials", sheetName: "RAVii essentials" }
  ];

  const imgData = imgSheet.getDataRange().getValues();
  const imageMap = new Map();
  imgData.forEach(row => { if (row[0]) imageMap.set(row[0].toString().trim().toLowerCase(), extractId(row[1])); });

  const rawData = itemSheet.getDataRange().getValues();
  const idx = { brand: 2, color: 3, size: 4, name: 5, amount: 9 };
  const timestamp = "Last Updated: " + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM HH:mm");

  BRAND_CONFIG.forEach(conf => {
    let targetSheet = ss.getSheetByName(conf.sheetName);
    if (!targetSheet) targetSheet = ss.insertSheet(conf.sheetName);

    targetSheet.clear();
    targetSheet.getRange("C1").setValue(timestamp).setFontSize(8).setFontColor("#7f8c8d").setFontStyle("italic");
    targetSheet.getRange("B1").insertCheckboxes().setValue(false);

    const brandData = rawData.filter((row, i) => {
      if (i === 0) return false;
      const rowBrand = (row[idx.brand] || "").toString().trim().toLowerCase();
      const hasStock = Number(row[idx.amount]) > 0;
      return rowBrand === conf.brand.toLowerCase() && hasStock;
    });
    if (brandData.length === 0) return;

    const products = {};
    brandData.forEach(row => {
      const cleanName = row[idx.name].toString().trim();
      if (!products[cleanName]) products[cleanName] = { data: [], colors: new Set() };
      products[cleanName].data.push(row);
      products[cleanName].colors.add(row[idx.color]);
    });

    renderUniformUI(targetSheet, products, imageMap, idx);
  });
}

function renderUniformUI(sheet, products, imageMap, idx) {
  let currentRow = 2;
  const STANDARD_HEIGHT = 21;
  const IMAGE_HEIGHT = 9;
  const standardSizeOrder = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL"];
  const COLOR_MAP = {
    "pink": { bg: "#e91e63", text: "#ffffff" }, "black": { bg: "#212529", text: "#ffffff" },
    "navy": { bg: "#1d3557", text: "#ffffff" }, "blue": { bg: "#4a90e2", text: "#ffffff" },
    "cream": { bg: "#f8f9fa", text: "#000000" }, "white": { bg: "#ffffff", text: "#000000" }
  };

  for (let name in products) {
    const p = products[name];
    const colorArray = Array.from(p.colors);

    sheet.getRange(currentRow, 1, 1, colorArray.length + 2)
          .merge().setValue(name).setFontWeight("bold").setBackground("#2c3e50").setFontColor("white").setFontSize(10);

    const imageCell = sheet.getRange(currentRow + 1, 1, IMAGE_HEIGHT, 1).merge();
    const imageId = imageMap.get(name.trim().toLowerCase());
    if (imageId) imageCell.setFormula(`=IMAGE("https://drive.google.com/uc?export=view&id=${imageId}")`);
    else imageCell.setValue("No Img").setFontSize(8).setFontColor("#bdc3c7").setHorizontalAlignment("center");

    const gridValues = [], gridColors = [], gridTextColors = [], gridFontWeights = [];
    const headerRow = ["Size"], headerBacks = ["#f8f9fa"], headerTexts = ["#000000"], headerWeights = ["bold"];

    colorArray.forEach(color => {
      headerRow.push(color);
      const normColor = color.toString().toLowerCase().trim();
      if (COLOR_MAP[normColor]) { headerBacks.push(COLOR_MAP[normColor].bg); headerTexts.push(COLOR_MAP[normColor].text); }
      else { headerBacks.push("#f8f9fa"); headerTexts.push("#000000"); }
      headerWeights.push("bold");
    });
    gridValues.push(headerRow); gridColors.push(headerBacks); gridTextColors.push(headerTexts); gridFontWeights.push(headerWeights);

    standardSizeOrder.forEach(size => {
      const rowVals = [size], rowBacks = ["#ffffff"], rowTexts = ["#000000"], rowWeights = ["bold"];
      colorArray.forEach(color => {
        const item = p.data.find(r => r[idx.color] === color && r[idx.size] === size);
        const amt = item ? item[idx.amount] : 0;
        rowVals.push(amt); rowBacks.push("#ffffff");
        if (amt === 0) { rowTexts.push("#d1d1d1"); rowWeights.push("normal"); }
        else { rowTexts.push("#000000"); rowWeights.push("bold"); }
      });
      gridValues.push(rowVals); gridColors.push(rowBacks); gridTextColors.push(rowTexts); gridFontWeights.push(rowWeights);
    });

    const range = sheet.getRange(currentRow + 1, 2, gridValues.length, gridValues[0].length);
    range.setValues(gridValues).setBackgrounds(gridColors).setFontColors(gridTextColors).setFontWeights(gridFontWeights)
          .setBorder(true, true, true, true, true, true).setFontSize(9).setHorizontalAlignment("center");

    sheet.setRowHeights(currentRow + 1, IMAGE_HEIGHT, STANDARD_HEIGHT);
    currentRow += 1 + IMAGE_HEIGHT + 1;
  }

  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 50);
  sheet.getRange("A:Z").setVerticalAlignment("middle");
}

function extractId(urlOrId) {
  if (!urlOrId) return null;
  const match = urlOrId.toString().match(/[-\w]{25,}/);
  return match ? match[0] : urlOrId;
}

/* ====================================================================
 * RECOVERY TOOLING — repair damage from the empty-scan partial-count bug
 * --------------------------------------------------------------------
 * An empty-scan partial/full count set every in-scope SKU to 0, producing
 * mirrored +N/-N ledger rows that net to zero and silently wiped real stock.
 * These functions reconstruct each SKU's correct "In Store" from the ledger
 * via an absolute-counted SET replay that SKIPS the erroneous re-zero batches.
 *
 * Run from the Apps Script editor:
 *   1. auditRecovery()                         -> read-only dry run (skips ALL suspects)
 *   2. review the returned .suspectBatches      -> pick the truly-erroneous tsMs values
 *   3. auditRecovery({skipBatches:[ts,...]})    -> preview corrections for that subset
 *   4. applyRecoveryCorrections({skipBatches:[ts,...], confirm:true})  -> writes
 * ==================================================================== */

// Reasons that mutate "In Store" (HQ). Show/Unshow are EXCLUDED (they move On Display).
var HQ_REASONS_ = {
  "Add (App)": true,
  "Deduct (App)": true,
  "Full Stock Count (Global Reset)": true,
  "Partial Stock Count": true
};
// Count reasons SET an absolute value; everything else in HQ_REASONS_ is an increment.
var COUNT_REASONS_ = {
  "Full Stock Count (Global Reset)": true,
  "Partial Stock Count": true
};

/** Read-only dump of the whole ledger with full millisecond timestamps. */
function dumpLedger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.TAB_ADJ);
  if (!sheet) throw mkError_("Missing '" + CONFIG.TAB_ADJ + "' sheet", "NOT_FOUND");
  var last = sheet.getLastRow();
  if (last < 2) return { rows: [] };
  var vals = sheet.getRange(2, 1, last - 1, 5).getValues(); // [ts, sku, delta, reason, note]
  var rows = vals.map(function (r, i) {
    var ts = r[0];
    var ms = (ts instanceof Date) ? ts.getTime() : new Date(ts).getTime();
    return {
      rowNum: i + 2,                 // physical sheet row, for audit traceability
      tsMs: ms,                      // batch key: all rows of one engine call share this
      ts: new Date(ms).toISOString(),
      sku: String(r[1]).trim(),
      delta: Number(r[2]) || 0,
      reason: String(r[3]).trim(),
      note: String(r[4])
    };
  });
  return { rows: rows };
}

/**
 * Core reconstruction (read-only). Groups the ledger into batches, classifies
 * empty-scan re-zero batches, and replays HQ chronologically to reconstruct each
 * SKU's correct "In Store".
 *
 * skipBatchesArr:
 *   - an Array of tsMs  -> skip exactly those batches (explicit, reviewed list)
 *   - null/undefined    -> AUTO: skip every classified suspect-zero batch (max proposal)
 *
 * Returns { ledger, order(batches), recon{sku:value}, current{sku:value} }.
 */
function computeRecovery_(skipBatchesArr) {
  var explicit = Array.isArray(skipBatchesArr);
  var skipSet = {};
  if (explicit) skipBatchesArr.forEach(function (ms) { skipSet[Number(ms)] = true; });

  var ledger = dumpLedger().rows;
  ledger.sort(function (a, b) { return (a.tsMs - b.tsMs) || (a.rowNum - b.rowNum); }); // chronological

  // --- group rows into submission batches keyed by (tsMs|reason) ---
  var order = [], map = {};
  ledger.forEach(function (row) {
    var key = row.tsMs + "|" + row.reason;
    var b = map[key];
    if (!b) { b = { tsMs: row.tsMs, ts: row.ts, reason: row.reason, note: row.note, rows: [] }; map[key] = b; order.push(b); }
    b.rows.push(row);
  });

  // --- classify: suspect-zero = a count batch whose rows are ALL negative (no positive) ---
  order.forEach(function (b) {
    b.isCount = !!COUNT_REASONS_[b.reason];
    var allNeg = b.rows.length > 0, anyPos = false;
    b.rows.forEach(function (r) { if (r.delta >= 0) allNeg = false; if (r.delta > 0) anyPos = true; });
    b.suspectZero = b.isCount && allNeg && !anyPos;
    b.skip = explicit ? !!skipSet[b.tsMs] : b.suspectZero; // auto-mode skips all suspects
  });

  // --- PASS 1: raw replay (nothing skipped) to recover each count row's ABSOLUTE target ---
  // For a count row, logged delta = counted - old, so counted = running_before + delta.
  var running = {};
  ledger.forEach(function (r) {
    if (!HQ_REASONS_[r.reason]) return; // Show/Unshow do not affect HQ
    var before = running[r.sku] || 0;
    r._countedTarget = before + r.delta;
    running[r.sku] = before + r.delta;
  });

  // --- PASS 2: corrected replay. Skip flagged batches. Counts SET; add/deduct increment. ---
  var recon = {};
  order.forEach(function (b) {
    if (b.skip || !HQ_REASONS_[b.reason]) return;
    if (b.isCount) b.rows.forEach(function (r) { recon[r.sku] = r._countedTarget; });
    else b.rows.forEach(function (r) { recon[r.sku] = (recon[r.sku] || 0) + r.delta; });
  });

  // --- current authoritative In Store ---
  var current = {};
  getInventory().items.forEach(function (it) { current[it.s] = it.inStore; });

  return { ledger: ledger, order: order, recon: recon, current: current };
}

/**
 * Read-only recovery audit / dry run. Writes NOTHING.
 * opts.skipBatches (optional): explicit Array of tsMs to back out. Omit to preview
 * the maximal proposal (all suspect-zero batches skipped) for review.
 */
function auditRecovery(opts) {
  opts = opts || {};
  var R = computeRecovery_(opts.skipBatches ? opts.skipBatches.map(Number) : null);

  var skippedBySku = {};
  R.order.forEach(function (b) {
    if (!b.skip) return;
    b.rows.forEach(function (r) {
      (skippedBySku[r.sku] = skippedBySku[r.sku] || []).push({ ts: b.ts, reason: b.reason });
    });
  });

  var all = {};
  Object.keys(R.recon).forEach(function (s) { all[s] = true; });
  Object.keys(R.current).forEach(function (s) { all[s] = true; });

  var skus = [], changed = 0, net = 0;
  Object.keys(all).sort().forEach(function (s) {
    var cur = R.current[s] != null ? R.current[s] : 0;
    var rec = R.recon[s] != null ? R.recon[s] : cur; // no HQ signal -> keep current (never invent)
    var diff = rec - cur;
    if (diff !== 0 || (skippedBySku[s] && skippedBySku[s].length)) {
      skus.push({ sku: s, currentInStore: cur, reconstructedInStore: rec, difference: diff, skippedBatches: skippedBySku[s] || [] });
    }
    if (diff !== 0) { changed++; net += diff; }
  });

  var suspectBatches = R.order.filter(function (b) { return b.suspectZero; }).map(function (b) {
    return {
      tsMs: b.tsMs, ts: b.ts, reason: b.reason, note: b.note, rowCount: b.rows.length,
      skus: b.rows.map(function (r) { return r.sku; }),
      treatedAs: b.skip ? "SKIPPED (backed out)" : "KEPT"
    };
  });

  // Every count batch with neg/pos stats. Auto-detection only flags PURE re-zeros
  // (all rows negative); mixed batches (mostly negative + a few stray scans) are NOT
  // auto-skipped — list them so a human can judge and add their tsMs to skipBatches.
  var countBatches = R.order.filter(function (b) { return b.isCount; }).map(function (b) {
    var neg = 0, pos = 0;
    b.rows.forEach(function (r) { if (r.delta < 0) neg++; else if (r.delta > 0) pos++; });
    return {
      tsMs: b.tsMs, ts: b.ts, reason: b.reason, note: b.note,
      rowCount: b.rows.length, negRows: neg, posRows: pos,
      suspectZero: b.suspectZero, skipped: b.skip,
      flag: b.suspectZero ? "PURE_REZERO" : (neg > pos ? "MOSTLY_ZEROING_review" : "")
    };
  });

  return {
    summary: {
      ledgerRows: R.ledger.length,
      batches: R.order.length,
      suspectZeroBatches: suspectBatches.length,
      skusWithCorrection: changed,
      netDelta: net,
      mode: opts.skipBatches ? "explicit skip list" : "AUTO: skipping ALL suspect-zero batches — REVIEW suspectBatches/countBatches before applying"
    },
    suspectBatches: suspectBatches,
    countBatches: countBatches,
    skus: skus
  };
}

/**
 * Apply recovery corrections (WRITES). Deliberately requires an explicit, reviewed
 * skip list and confirm:true so it never invents stock on its own. Corrections are
 * themselves logged via applyDeltas_ under the reason "Recovery Correction".
 *   applyRecoveryCorrections({ skipBatches:[ts,...], confirm:true })
 */
function applyRecoveryCorrections(opts) {
  opts = opts || {};
  if (!Array.isArray(opts.skipBatches) || !opts.skipBatches.length) {
    throw mkError_("Pass skipBatches:[tsMs,...] — the batches you confirmed erroneous in auditRecovery().", "BAD_INPUT");
  }
  if (opts.confirm !== true) {
    throw mkError_("Refusing to write. Review auditRecovery() first, then pass confirm:true.", "NEED_CONFIRM");
  }
  var R = computeRecovery_(opts.skipBatches.map(Number));
  var deltaMap = new Map(), preview = [];
  Object.keys(R.recon).forEach(function (sku) {
    var rec = R.recon[sku];
    var cur = R.current[sku] != null ? R.current[sku] : 0;
    var diff = rec - cur;
    if (diff !== 0) { deltaMap.set(sku, diff); preview.push({ sku: sku, from: cur, to: rec, delta: diff }); }
  });
  if (!deltaMap.size) return { applied: 0, note: "No corrections needed.", preview: [] };
  // Safety: a reconstruction that lands below zero means the ledger is missing that
  // SKU's opening balance (it was never counted into history). Writing it would set
  // impossible negative stock. Refuse and steer to the forward-restore path instead.
  var negatives = preview.filter(function (p) { return p.to < 0; });
  if (negatives.length) {
    throw mkError_("Refusing to write: reconstruction produced NEGATIVE stock for " + negatives.length +
      " SKU(s) (e.g. " + negatives.slice(0, 5).map(function (p) { return p.sku + "=" + p.to; }).join(", ") +
      "). Their opening balance was never logged, so a from-zero replay underflows. Use reconcilePreview()/reconcileApply() instead.", "NEGATIVE_RECON");
  }
  var res = applyDeltas_(deltaMap, "Recovery Correction", "empty-scan zeroing recovery");
  return { applied: deltaMap.size, updated: res.updated, missing: res.missing, preview: preview };
}

/** Logs a possibly-large array in chunks so nothing is dropped by the log viewer. */
function logChunked_(label, arr, perChunk) {
  arr = arr || []; perChunk = perChunk || 40;
  Logger.log(label + " (" + arr.length + ")");
  for (var i = 0; i < arr.length; i += perChunk) {
    Logger.log(JSON.stringify(arr.slice(i, i + perChunk)));
  }
}

/* ====================================================================
 * RECONCILIATION TOOLING — repair the in-scope zeroing bug
 * --------------------------------------------------------------------
 * No real sales were ever recorded, so every NEGATIVE ledger movement is an
 * artifact. Truth = what was counted in = the POSITIVE entries. These functions
 * rebuild each bug-affected SKU's stock from its positive ledger rows, let you
 * override the gaps (items whose opening was never logged, e.g. Blair_Maxi_Dress),
 * then surgically DELETE the erroneous "Partial Stock Count" zeroing rows.
 *
 * Run from the Apps Script editor:
 *   1. reconcilePreview()             -> writes the editable "Reconciliation" sheet
 *   2. fill the Override column        -> for NO_POSITIVE rows and anything you know differs
 *   3. reconcileApply({confirm:true})  -> backs up history, deletes the zeroing rows,
 *                                         sets stock to the finals, logs adjustments
 *
 * Scope: only "bug-affected" SKUs = any SKU with a "Partial Stock Count" row.
 * ==================================================================== */

var RECON_SHEET_ = "Reconciliation";
var RECON_REASON_ = "Reconciliation Adjustment";   // In-Store delta appended to keep the cleaned log consistent

/**
 * Build the per-SKU reconciliation model from the live ledger + Inventory (read-only).
 * suggested = sum of positive In-Store deltas. Returns one row per affected SKU.
 */
function computeReconcile_() {
  var rows = dumpLedger().rows;

  // current HQ + display name per SKU, straight off the Inventory sheet
  var idx = getInventoryIndex_();
  var info = {};
  var n0 = idx.lastRow - 1;
  if (n0 >= 1) {
    var block0 = idx.sheet.getRange(2, 1, n0, idx.lastCol).getValues();
    for (var i = 0; i < n0; i++) {
      var s0 = String(block0[i][idx.cols.sku - 1]).trim();
      if (!s0) continue;
      info[s0] = { name: String(block0[i][idx.cols.name - 1]).trim(), current: Number(block0[i][idx.cols.hq - 1]) || 0 };
    }
  }

  // aggregate ledger per SKU
  var agg = {};
  rows.forEach(function (r) {
    var a = agg[r.sku] || (agg[r.sku] = { posSum: 0, posPartialRows: 0, bugRowNums: [], bugDelta: 0, otherNeg: 0, hasPartial: false, hqDelta: 0 });
    if (r.reason === "Partial Stock Count") {
      a.hasPartial = true;
      if (r.delta < 0) { a.bugRowNums.push(r.rowNum); a.bugDelta += r.delta; }
      else if (r.delta > 0) a.posPartialRows++;
    }
    if (HQ_REASONS_[r.reason] || r.reason === RECON_REASON_) { // In-Store reasons (Show/Unshow excluded)
      a.hqDelta += r.delta;
      if (r.delta > 0) a.posSum += r.delta;
      else if (r.delta < 0 && r.reason !== "Partial Stock Count") a.otherNeg += r.delta;
    }
  });

  var out = [];
  Object.keys(agg).forEach(function (sku) {
    var a = agg[sku];
    if (!a.hasPartial) return;             // affected = touched by a partial count
    var has = !!info[sku];
    var flags = [];
    if (a.posSum === 0) flags.push("NO_POSITIVE");        // no positive history -> must override
    if (a.posPartialRows > 1) flags.push("MULTI_SCAN");   // scanned more than once -> verify not doubled
    if (a.otherNeg < 0) flags.push("OTHER_NEGATIVE");     // a non-partial negative (e.g. Deduct) kept
    if (!has) flags.push("MISSING_SKU");                  // affected SKU not present in Inventory
    out.push({
      sku: sku,
      name: has ? info[sku].name : "(not in Inventory)",
      current: has ? info[sku].current : 0,
      suggested: a.posSum,
      posPartialRows: a.posPartialRows,
      bugRowCount: a.bugRowNums.length,
      bugRowNums: a.bugRowNums,
      hqDelta: a.hqDelta,
      bugDelta: a.bugDelta,
      flag: flags.join(",")
    });
  });
  out.sort(function (x, y) { return x.sku < y.sku ? -1 : (x.sku > y.sku ? 1 : 0); });
  return out;
}

/**
 * READ-ONLY except it (re)writes the scratch "Reconciliation" sheet. Lists every
 * bug-affected SKU with its current stock, the suggested value (sum of positives),
 * and flags. Fill the Override column before running reconcileApply().
 */
function reconcilePreview() {
  var model = computeReconcile_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECON_SHEET_) || ss.insertSheet(RECON_SHEET_);
  sheet.clear();

  var header = ["SKU", "Name", "Current", "Suggested", "Override", "PosBatches", "BugRows", "Flag"];
  var data = [header];
  model.forEach(function (m) {
    data.push([m.sku, m.name, m.current, m.suggested, "", m.posPartialRows, m.bugRowCount, m.flag]);
  });
  sheet.getRange(1, 1, data.length, header.length).setValues(data);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, header.length).setFontWeight("bold");
  if (model.length) sheet.getRange(2, 5, model.length, 1).setBackground("#fff7e0"); // tint Override col

  var flagged = model.filter(function (m) { return m.flag; });
  Logger.log("Reconciliation: " + model.length + " affected SKUs written to '" + RECON_SHEET_ + "'. " +
             flagged.length + " need review. Fill Override (esp. NO_POSITIVE), then reconcileApply({confirm:true}).");
  logChunked_("Flagged", flagged.map(function (m) {
    return { sku: m.sku, current: m.current, suggested: m.suggested, flag: m.flag };
  }), 30);
  return { affected: model.length, flagged: flagged.length, sheet: RECON_SHEET_ };
}

/**
 * WRITES (gated by confirm:true). Backs up the history, deletes the zeroing rows,
 * sets stock to the finals (Override ?? Suggested) for affected SKUs, recomputes
 * In Sales, and appends a "Reconciliation Adjustment" row wherever the cleaned log
 * would not otherwise replay to the final value (covers overrides and gap fills).
 */
function reconcileApply(opts) {
  opts = opts || {};
  if (opts.confirm !== true) {
    throw mkError_("Refusing to write. Review the '" + RECON_SHEET_ + "' sheet, then call reconcileApply({confirm:true}).", "NEED_CONFIRM");
  }
  return withLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 1. read finals from the Reconciliation sheet (Override ?? Suggested)
    var rsheet = ss.getSheetByName(RECON_SHEET_);
    if (!rsheet) throw mkError_("Run reconcilePreview() first — no '" + RECON_SHEET_ + "' sheet.", "NOT_FOUND");
    var rvals = rsheet.getDataRange().getValues();
    var rhead = rvals[0].map(function (h) { return String(h).trim(); });
    var cSku = rhead.indexOf("SKU"), cOver = rhead.indexOf("Override"), cSug = rhead.indexOf("Suggested");
    if (cSku < 0 || cOver < 0 || cSug < 0) throw mkError_("Reconciliation sheet missing SKU/Override/Suggested columns. Re-run reconcilePreview().", "BAD_INPUT");
    var finalBySku = {}, hadOverride = {};
    for (var i = 1; i < rvals.length; i++) {
      var sku = String(rvals[i][cSku]).trim();
      if (!sku) continue;
      var ov = rvals[i][cOver];
      var useOv = (ov !== "" && ov !== null && ov !== undefined && !isNaN(Number(ov)));
      hadOverride[sku] = useOv;
      finalBySku[sku] = useOv ? Number(ov) : (Number(rvals[i][cSug]) || 0);
    }

    // 2. recompute the affected model from the live ledger (bug rowNums, hq deltas)
    var model = computeReconcile_();
    var affected = {};
    model.forEach(function (m) { affected[m.sku] = m; });

    // 2b. SAFETY: a NO_POSITIVE SKU with no Override would be set to 0 — the very zeroing
    // we're repairing. Refuse unless explicitly allowed, so gap items (e.g. Blair_Maxi_Dress)
    // can't be silently wiped by an unfilled sheet.
    var willZero = model.filter(function (m) {
      return m.suggested === 0 && !hadOverride[m.sku];
    }).map(function (m) { return m.sku; });
    if (willZero.length && opts.allowZero !== true) {
      throw mkError_(willZero.length + " affected SKU(s) have no positive history AND no Override, so they would be set to 0 (e.g. " +
        willZero.slice(0, 6).join(", ") + "). Fill their Override in the '" + RECON_SHEET_ +
        "' sheet, or pass {confirm:true, allowZero:true} if they really are sold out.", "WOULD_ZERO");
    }

    // 3. BACK UP the whole history before deleting anything
    var hist = ss.getSheetByName(CONFIG.TAB_ADJ);
    if (!hist) throw mkError_("Missing '" + CONFIG.TAB_ADJ + "' sheet", "NOT_FOUND");
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HHmmss");
    var backupName = CONFIG.TAB_ADJ + " (backup " + stamp + ")";
    hist.copyTo(ss).setName(backupName);

    // 4. delete the zeroing rows: rewrite the body without the flagged rowNums
    var del = {};
    model.forEach(function (m) { m.bugRowNums.forEach(function (rn) { del[rn] = true; }); });
    var deleted = 0, last = hist.getLastRow();
    if (last >= 2) {
      var raw = hist.getRange(2, 1, last - 1, 5).getValues();
      var keep = [];
      for (var k = 0; k < raw.length; k++) {
        if (del[k + 2]) { deleted++; continue; }            // rowNum = sheet row = k + 2
        keep.push(raw[k]);
      }
      clearSheetBody_(hist);
      if (keep.length) hist.getRange(2, 1, keep.length, 5).setValues(keep);
    }

    // 5. set HQ = final for affected SKUs; recompute In Sales; collect consistency adjustments
    var idx = getInventoryIndex_();
    var n = idx.lastRow - 1, setCount = 0, adjustments = [], ts = new Date();
    if (n >= 1) {
      var block = idx.sheet.getRange(2, 1, n, idx.lastCol).getValues();
      var hqVals = [], odVals = [];
      for (var r = 0; r < n; r++) {
        hqVals.push([Number(block[r][idx.cols.hq - 1]) || 0]);
        odVals.push([idx.cols.onDisplay ? (Number(block[r][idx.cols.onDisplay - 1]) || 0) : 0]);
      }
      for (var r2 = 0; r2 < n; r2++) {
        var sku2 = String(block[r2][idx.cols.sku - 1]).trim();
        if (!sku2 || !affected[sku2]) continue;
        var m = affected[sku2];
        var fin = finalBySku[sku2] != null ? finalBySku[sku2] : m.suggested;
        hqVals[r2][0] = fin;
        setCount++;
        var keptHqDelta = m.hqDelta - m.bugDelta;   // remove the deleted (bug) deltas from the replay
        var adj = fin - keptHqDelta;                // make the cleaned log replay to fin
        if (adj !== 0) adjustments.push([ts, sku2, adj, RECON_REASON_, "post-bug reconcile"]);
      }
      idx.sheet.getRange(2, idx.cols.hq, n, 1).setValues(hqVals);
      writeInSales_(idx, hqVals, odVals);
    }

    // 6. append the consistency adjustments (kept-log -> inventory)
    appendLedger_(adjustments);

    var summary = { deletedBugRows: deleted, skusSet: setCount, adjustmentRows: adjustments.length, backupSheet: backupName };
    Logger.log("=== reconcileApply DONE === " + JSON.stringify(summary));
    return summary;
  });
}

/**
 * EDITOR CONVENIENCE: one-click apply. The "Run" button can't pass arguments, so
 * this wraps reconcileApply({confirm:true}). Run reconcilePreview() and fill the
 * Override column FIRST. Still protected by the same guards: it refuses if there's
 * no Reconciliation sheet, and stops (WOULD_ZERO) if any NO_POSITIVE row was left
 * blank — fill those Overrides, then run this again.
 */
function reconcileApplyNow() {
  var res = reconcileApply({ confirm: true });
  Logger.log("APPLIED: " + JSON.stringify(res));
  return res;
}
