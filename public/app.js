// ============================================================================
// MedRoute — Client Application Entry Point
// Imports storage, API, and rendering modules. Manages state and event wiring.
// ============================================================================

import { dom } from "./js/dom.js";
import { loadSavedPharmacies, savePharmacies, loadAccessToken, saveAccessToken } from "./js/storage.js";
import { apiCheck, apiFetchHistory, apiDownloadTranscript } from "./js/api.js";
import {
  setLiveCallOverlay,
  renderPharmacies,
  showResults,
  renderHistoryList,
  changeView as renderingChangeView,
  updateCtaMode,
} from "./js/rendering.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import("./js/api.js").Pharmacy[]} Current pharmacy list. */
let pharmacies = loadSavedPharmacies();

/** @type {import("./js/api.js").CheckRecord[]} Saved check history loaded from the server. */
let history = [];

/** @type {string} Current operator access token. */
let accessToken = loadAccessToken();

// ---------------------------------------------------------------------------
// Access token persistence
// ---------------------------------------------------------------------------

dom.accessToken.value = accessToken;
dom.accessToken.addEventListener("input", () => {
  accessToken = dom.accessToken.value.trim();
  saveAccessToken(accessToken);
});

// ---------------------------------------------------------------------------
// View switching (delegates to rendering, passes token)
// ---------------------------------------------------------------------------

/**
 * Switch between workspace and analytics views.
 * @param {"workspace"|"analytics"} view - Target view.
 * @returns {Promise<void>}
 */
async function changeView(view) {
  await renderingChangeView(view, accessToken);
}

// ---------------------------------------------------------------------------
// Event handlers — Pharmacy form
// ---------------------------------------------------------------------------

/**
 * Sync a pharmacy row's input values back into the pharmacies array.
 * @param {number} index - Index of the pharmacy in the array.
 * @param {HTMLElement} row - The .pharmacy DOM row element.
 * @returns {void}
 */
function syncPharmacyFromRow(index, row) {
  const inputs = row.querySelectorAll("input");
  pharmacies[index] = {
    name: inputs[0].value,
    phone: inputs[1].value,
    distanceKm: inputs[2].value,
  };
  savePharmacies(pharmacies);
}

dom.pharmacies.addEventListener("input", (e) => {
  const row = /** @type {HTMLElement} */ (e.target).closest(".pharmacy");
  if (!row) return;
  const index = [...dom.pharmacies.children].indexOf(row);
  syncPharmacyFromRow(index, row);
});

dom.pharmacies.addEventListener("click", (e) => {
  if (/** @type {HTMLElement} */ (e.target).dataset.remove === undefined) return;
  pharmacies.splice(Number(/** @type {HTMLElement} */ (e.target).dataset.remove), 1);
  savePharmacies(pharmacies);
  renderPharmacies(pharmacies);
});

document.querySelector("#add").onclick = () => {
  pharmacies.push({ name: "", phone: "", distanceKm: "" });
  savePharmacies(pharmacies);
  renderPharmacies(pharmacies);
};

// ---------------------------------------------------------------------------
// Event handlers — Run check
// ---------------------------------------------------------------------------

dom.run.onclick = async () => {
  if (!dom.consent.checked) return alert("Please confirm authorization before preparing checks.");
  if (!dom.accessToken.value.trim()) return alert("Enter the operator access token.");

  const isLive = dom.live.checked;
  const medicine = dom.medicine.value;
  const strength = [dom.strengthValue.value, dom.strengthUnit.value, dom.dosageForm.value]
    .filter(Boolean)
    .join(" ");

  dom.run.disabled = true;
  dom.run.textContent = isLive ? "Live calls in progress…" : "Preparing checks…";
  if (isLive) setLiveCallOverlay(true, pharmacies, medicine);

  try {
    /** @type {import("./js/api.js").CheckRequestBody} */
    const requestBody = {
      medicine,
      strength,
      pharmacies,
      confirmLive: isLive,
      consentAcknowledged: dom.consent.checked,
      liveCallAcknowledged: isLive,
    };
    const data = await apiCheck(accessToken, requestBody);
    showResults(data);
    history = await apiFetchHistory(accessToken);
    renderHistoryList(history);
  } catch (error) {
    alert(/** @type {Error} */ (error).message);
  } finally {
    if (isLive) setLiveCallOverlay(false);
    dom.run.disabled = false;
    updateCtaMode();
  }
};

// ---------------------------------------------------------------------------
// Event handlers — Navigation
// ---------------------------------------------------------------------------

dom.live.onchange = updateCtaMode;

document.querySelectorAll(".nav-tab").forEach((button) => {
  button.onclick = () => changeView(/** @type {string} */ (/** @type {HTMLElement} */ (button).dataset.view));
});

dom.home.onclick = () => changeView("workspace");

// ---------------------------------------------------------------------------
// Event handlers — History clicks
// ---------------------------------------------------------------------------

dom.historyList.onclick = (event) => {
  const id = /** @type {HTMLElement} */ (event.target.closest("[data-history-id]"))?.dataset.historyId;
  const record = history.find((item) => item.id === id);
  if (record) showResults(record, true);
};

dom.analyticsContent.onclick = async (event) => {
  const id = /** @type {HTMLElement} */ (event.target.closest("[data-history-id]"))?.dataset.historyId;
  if (!id) return;
  const record = history.find((item) => item.id === id);
  if (!record) return;
  await changeView("workspace");
  showResults(record, true);
};

// ---------------------------------------------------------------------------
// Event handlers — Transcript downloads
// ---------------------------------------------------------------------------

document.addEventListener("click", async (event) => {
  const button = /** @type {HTMLElement} */ (event.target.closest("[data-transcript-url]"));
  if (!button) return;
  button.disabled = true;
  try {
    await apiDownloadTranscript(accessToken, /** @type {string} */ (button.dataset.transcriptUrl));
  } catch (error) {
    alert(/** @type {Error} */ (error).message);
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Event handlers — Example value placeholders
// ---------------------------------------------------------------------------

document.querySelectorAll(".example-value").forEach((input) =>
  input.addEventListener(
    "focus",
    () => {
      if (input.classList.contains("example-value")) {
        input.value = "";
        input.classList.remove("example-value");
      }
    },
    { once: true }
  )
);

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

renderPharmacies(pharmacies);
apiFetchHistory(accessToken).then((data) => {
  history = data;
  renderHistoryList(history);
});
