// ============================================================================
// MedRoute — Rendering Module
// All DOM rendering: pharmacy form, results, history, analytics, call overlay.
// ============================================================================

import { dom, esc } from "./dom.js";
import { apiFetchAnalytics } from "./api.js";

/**
 * @typedef {Object} Pharmacy
 * @property {string} name
 * @property {string} phone
 * @property {string} distanceKm
 */

/**
 * @typedef {Object} SanitizedResult
 * @property {"in_stock"|"limited"|"out_of_stock"|"unknown"} stock_status
 * @property {string} price_range
 * @property {"ready_today"|"not_confirmed_today"|"unknown"} pickup_readiness
 * @property {string} hours
 * @property {string} substitution_available
 * @property {string} notes
 * @property {"high"|"medium"|"low"} confidence
 */

/**
 * @typedef {Object} CallResult
 * @property {string} pharmacy
 * @property {string} phone
 * @property {number} distanceKm
 * @property {SanitizedResult} result
 * @property {"live"|"demo"} mode
 * @property {string} [error]
 * @property {Array<{speaker: string, text: string, offsetSeconds: number|null}>} [transcript]
 */

/**
 * @typedef {Object} CheckRecord
 * @property {string} id
 * @property {string} createdAt
 * @property {"live"|"demo"} mode
 * @property {string} medicine
 * @property {string} strength
 * @property {CallResult[]} results
 */

// ---------------------------------------------------------------------------
// Call overlay
// ---------------------------------------------------------------------------

/**
 * Show or hide the full-screen live call overlay with animation.
 * @param {boolean} active - Whether to show (true) or hide (false) the overlay.
 * @param {Pharmacy[]} [pharmacyList=[]] - Pharmacies being called (for display).
 * @param {string} [medicine=""] - Medicine name being checked (for display).
 * @returns {void}
 */
export function setLiveCallOverlay(active, pharmacyList = [], medicine = "") {
  if (!active) {
    document.body.classList.remove("call-in-progress");
    dom.callOverlay.hidden = true;
    dom.callOverlay.querySelector("video").pause();
    return;
  }

  const names = pharmacyList.map((p) => p.name).filter(Boolean);
  const destination = names.length === 1 ? names[0] : `${names.length} authorized pharmacies`;
  dom.callOverlay.querySelector("#call-overlay-title").textContent = `CALL-E is checking ${medicine || "medicine"}`;
  dom.callOverlay.querySelector("#call-overlay-detail").textContent = `Speaking with ${destination}. This may take a few minutes.`;
  dom.callOverlay.hidden = false;
  document.body.classList.add("call-in-progress");

  const animation = dom.callOverlay.querySelector("video");
  animation.currentTime = 0;
  animation.play().catch(() => {});
  dom.callOverlay.focus();
}

// ---------------------------------------------------------------------------
// Pharmacy form
// ---------------------------------------------------------------------------

/**
 * Render the pharmacy form rows from the current pharmacy list.
 * Shows an empty state message when no pharmacies are configured.
 * @param {Pharmacy[]} pharmacies - Current pharmacy list.
 * @returns {void}
 */
export function renderPharmacies(pharmacies) {
  if (!pharmacies.length) {
    dom.pharmacies.innerHTML = `<p class="empty-state">No pharmacies added yet.</p>`;
    return;
  }

  dom.pharmacies.innerHTML = pharmacies
    .map(
      (p, i) => `
    <div class="pharmacy">
      <input aria-label="Pharmacy name" placeholder="Pharmacy name" value="${esc(p.name)}">
      <input aria-label="E.164 phone" placeholder="+12025550123" value="${esc(p.phone)}">
      <input aria-label="Distance km" type="number" min="0" step="0.1" placeholder="km" value="${esc(p.distanceKm)}">
      <button aria-label="Remove pharmacy" data-remove="${i}">×</button>
    </div>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} Human-readable labels for pickup_readiness values. */
const pickupLabels = {
  can_hold: "ready for pickup today",
  cannot_hold: "not confirmed today",
  ready_today: "ready for pickup today",
  not_confirmed_today: "not confirmed today",
  unknown: "unknown",
};

/**
 * Generate the transcript download button or status message for a result.
 * @param {CheckRecord} record - The parent check record.
 * @param {number} resultIndex - Index of this result in the record's results array.
 * @param {CallResult} result - The call result to check for transcript data.
 * @returns {string} HTML string for the download button or status message.
 */
function transcriptLink(record, resultIndex, result) {
  if (Array.isArray(result.transcript) && result.transcript.length) {
    return `<button type="button" class="transcript-download" data-transcript-url="/api/transcripts/${encodeURIComponent(record.id)}/${resultIndex}.pdf">Download call transcript PDF <span aria-hidden="true">↓</span></button>`;
  }
  return result.mode === "live" ? `<p class="transcript-status">No transcript was returned for this call.</p>` : "";
}

/**
 * Render a single pharmacy result card as HTML.
 * @param {CallResult} result - Call result data.
 * @param {number} index - Zero-based rank index.
 * @param {CheckRecord} record - Parent check record (for transcript links).
 * @returns {string} HTML string for the result card.
 */
function resultCard(result, index, record) {
  const r = result.result || {};
  const pickup = pickupLabels[r.pickup_readiness] || String(r.pickup_readiness || "unknown").replaceAll("_", " ");

  return `
    <article class="result ${esc(r.stock_status || "unknown")}">
      <div class="rank">${String(index + 1).padStart(2, "0")}</div>
      <div>
        <h3>${esc(result.pharmacy)}</h3>
        <p>${esc(result.distanceKm)} km away · ${esc(result.phone)}</p>
      </div>
      <strong>${esc((r.stock_status || "unavailable").replaceAll("_", " "))}</strong>
      <dl>
        <div><dt>Price</dt><dd>${esc(r.price_range || "Unknown")}</dd></div>
        <div><dt>Pickup today</dt><dd>${esc(pickup)}</dd></div>
        <div><dt>Hours</dt><dd>${esc(r.hours || "Unknown")}</dd></div>
      </dl>
      <p class="note">${esc(r.notes || result.error || "No details returned.")}</p>
      ${transcriptLink(record, index, result)}
    </article>`;
}

/**
 * Show a check record's results in the output section.
 * @param {CheckRecord} record - Check record to display.
 * @param {boolean} [scroll=true] - Whether to smooth-scroll to the results.
 * @returns {void}
 */
export function showResults(record, scroll = true) {
  dom.output.hidden = false;
  dom.badge.textContent = record.mode === "demo" ? "DEMO RESULTS" : "LIVE RESULTS";
  dom.results.innerHTML = record.results.map((r, i) => resultCard(r, i, record)).join("");
  if (scroll) dom.output.scrollIntoView({ behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Render the saved checks history list.
 * @param {CheckRecord[]} history - History records to render.
 * @returns {void}
 */
export function renderHistoryList(history) {
  dom.historyCount.textContent = `${history.length} saved`;

  if (!history.length) {
    dom.historyList.innerHTML = `<p class="history-empty">Your completed availability checks will appear here after the first run.</p>`;
    return;
  }

  dom.historyList.innerHTML = history
    .map(
      (item) => `
    <button class="history-item" data-history-id="${esc(item.id)}">
      <span>
        <b>${esc(item.medicine)}</b>
        <small>${new Date(item.createdAt).toLocaleString()} · ${esc(item.mode)}</small>
      </span>
      <strong>${item.results.length} call${item.results.length === 1 ? "" : "s"} →</strong>
    </button>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** @type {number} Maximum items to show before collapsing into "See N more". */
const analyticsPreviewLimit = 7;

/**
 * Render a single medicine demand bar row for the analytics chart.
 * @param {{medicine: string, count: number}} item - Medicine and its check count.
 * @param {number} maximum - Maximum count across all medicines (for bar width scaling).
 * @returns {string} HTML string for the bar row.
 */
function medicineDemandRow(item, maximum) {
  const width = Math.max(12, (item.count / maximum) * 100);
  return `<div class="bar-row"><span>${esc(item.medicine)}</span><div><i style="width:${width}%"></i></div><b>${item.count}</b></div>`;
}

/**
 * Generate the transcript download button for a recent activity row.
 * @param {CheckRecord} item - Check record to check for transcripts.
 * @returns {string} HTML string for the PDF button, "View PDFs" button, or empty string.
 */
function recentTranscriptAction(item) {
  const transcripts = (item.results || [])
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => Array.isArray(result.transcript) && result.transcript.length);

  if (transcripts.length === 1) {
    return `<button type="button" class="activity-pdf" data-transcript-url="/api/transcripts/${encodeURIComponent(item.id)}/${transcripts[0].index}.pdf">PDF <span aria-hidden="true">↓</span></button>`;
  }
  if (transcripts.length > 1) {
    return `<button class="activity-view-pdfs" type="button" data-history-id="${esc(item.id)}">View PDFs</button>`;
  }
  return "";
}

/**
 * Render a single recent activity row for the analytics panel.
 * @param {CheckRecord} item - Check record to render.
 * @returns {string} HTML string for the activity row.
 */
function recentActivityRow(item) {
  return `
    <div class="activity">
      <span class="activity-dot ${esc(item.mode)}"></span>
      <div>
        <b>${esc(item.medicine)}</b>
        <small>${new Date(item.createdAt).toLocaleString()}</small>
      </div>
      <em>${item.results.length} call${item.results.length === 1 ? "" : "s"}</em>
      ${recentTranscriptAction(item)}
    </div>`;
}

/**
 * Render a "See N more" collapsible overflow section when items exceed the preview limit.
 * @param {Array<*>} items - Full list of items.
 * @param {string} label - Plural label for the items (e.g. "medicines", "checks").
 * @param {(item: *) => string} renderItem - Function to render a single item as HTML.
 * @returns {string} HTML string for the overflow details element, or empty string if none needed.
 */
function analyticsOverflow(items, label, renderItem) {
  const more = items.slice(analyticsPreviewLimit);
  if (!more.length) return "";
  return `
    <details class="analytics-overflow">
      <summary>See ${more.length} more ${label}<span aria-hidden="true">⌄</span></summary>
      <div class="analytics-overflow-list">${more.map(renderItem).join("")}</div>
    </details>`;
}

/**
 * Fetch and render the full analytics dashboard.
 * @param {string} token - Current access token.
 * @returns {Promise<void>}
 */
export async function renderAnalytics(token) {
  const data = await apiFetchAnalytics(token);
  if (!data) return;

  const maximum = Math.max(...data.topMedicines.map((m) => m.count), 1);
  const medicineRows = data.topMedicines
    .slice(0, analyticsPreviewLimit)
    .map((item) => medicineDemandRow(item, maximum))
    .join("");
  const recentRows = data.recent
    .slice(0, analyticsPreviewLimit)
    .map(recentActivityRow)
    .join("");

  dom.analyticsContent.innerHTML = `
    <div class="metrics">
      <article><small>Saved checks</small><b>${data.totalRuns}</b><span>On this device</span></article>
      <article><small>Pharmacies reached</small><b>${data.totalCalls}</b><span>Across all checks</span></article>
      <article><small>In-stock rate</small><b>${data.inStockRate}%</b><span>Reported availability</span></article>
      <article><small>Live runs</small><b>${data.liveRuns}</b><span>CALL-E completed</span></article>
    </div>
    <div class="analytics-grid">
      <section class="chart-card">
        <div><p class="eyebrow">MOST REQUESTED</p><h2>Medicine demand</h2></div>
        ${
          data.topMedicines.length
            ? `${medicineRows}${analyticsOverflow(data.topMedicines, "medicines", (item) => medicineDemandRow(item, maximum))}`
            : `<p class="analytics-empty">No saved checks yet. Complete an availability check to start seeing trends.</p>`
        }
      </section>
      <section class="chart-card">
        <div><p class="eyebrow">RECENT ACTIVITY</p><h2>Latest checks</h2></div>
        ${
          data.recent.length
            ? `${recentRows}${analyticsOverflow(data.recent, "checks", recentActivityRow)}`
            : `<p class="analytics-empty">No activity to show yet.</p>`
        }
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

/**
 * Switch between the workspace and analytics views.
 * @param {"workspace"|"analytics"} view - Target view to activate.
 * @param {string} token - Current access token (for analytics fetch).
 * @returns {Promise<void>}
 */
export async function changeView(view, token) {
  dom.workspace.hidden = view !== "workspace";
  dom.analytics.hidden = view !== "analytics";
  document.querySelectorAll(".nav-tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.view === view)
  );
  if (view === "analytics") await renderAnalytics(token);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// CTA mode (demo vs live)
// ---------------------------------------------------------------------------

/**
 * Update the submit button text and hint text based on the live/demo toggle state.
 * @returns {void}
 */
export function updateCtaMode() {
  const isLive = dom.live.checked;
  if (!dom.run.disabled) {
    dom.run.innerHTML = isLive
      ? "<span>Start pharmacy calls</span><b>→</b>"
      : "<span>Preview pharmacy checks</span><b>→</b>";
  }
  if (dom.hint) {
    dom.hint.textContent = isLive
      ? "Live calling is enabled. Structured inquiries will be placed to authorized numbers."
      : "Safe demo mode is active. Calls are verifiable, and no orders or patient info will be shared.";
  }
}
