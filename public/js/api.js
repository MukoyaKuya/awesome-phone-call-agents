// ============================================================================
// MedRoute — API Client Module
// All server communication: check submission, history, analytics, transcripts.
// ============================================================================

/**
 * @typedef {Object} Pharmacy
 * @property {string} name
 * @property {string} phone
 * @property {string} distanceKm
 */

/**
 * @typedef {Object} CheckRequestBody
 * @property {string} medicine
 * @property {string} strength
 * @property {Pharmacy[]} pharmacies
 * @property {boolean} confirmLive
 * @property {boolean} consentAcknowledged
 * @property {boolean} liveCallAcknowledged
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

/**
 * @typedef {Object} AnalyticsData
 * @property {number} totalRuns
 * @property {number} totalCalls
 * @property {number} liveRuns
 * @property {number} inStockRate
 * @property {Array<{medicine: string, count: number}>} topMedicines
 * @property {CheckRecord[]} recent
 */

/** @type {string} SessionStorage key for tracking in-flight live requests. */
const pendingLiveRequestKey = "medroute-pending-live-request";

/**
 * Build Authorization headers using the provided token.
 * @param {string} token - Bearer token value.
 * @returns {{Authorization: string}} Headers object.
 */
function authHeaders(token) {
  return { Authorization: `Bearer ${token.trim()}` };
}

/**
 * Submit a medicine availability check to the server.
 * Manages idempotency keys for live requests via sessionStorage.
 * @param {string} token - Current access token.
 * @param {CheckRequestBody} requestBody - Check request parameters.
 * @returns {Promise<CheckRecord>} The completed check record with results.
 * @throws {Error} If the server returns an error response.
 */
export async function apiCheck(token, requestBody) {
  const requestFingerprint = JSON.stringify(requestBody);
  const isLive = requestBody.confirmLive;
  const savedRequest = isLive ? JSON.parse(sessionStorage.getItem(pendingLiveRequestKey) || "null") : null;
  const idempotencyKey = isLive
    ? (savedRequest?.fingerprint === requestFingerprint ? savedRequest.idempotencyKey : crypto.randomUUID())
    : null;

  if (isLive) {
    sessionStorage.setItem(pendingLiveRequestKey, JSON.stringify({ fingerprint: requestFingerprint, idempotencyKey }));
  }

  const response = await fetch("/api/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = response.status === 401
      ? "The operator access token is missing or does not match this server. Copy MEDROUTE_ACCESS_TOKEN from your local .env.local file and try again."
      : data.error;
    throw new Error(message);
  }

  if (isLive) sessionStorage.removeItem(pendingLiveRequestKey);
  return /** @type {CheckRecord} */ (data);
}

/**
 * Fetch the actor's check history from the server.
 * @param {string} token - Current access token.
 * @returns {Promise<CheckRecord[]>} Array of historical records, or empty array on failure.
 */
export async function apiFetchHistory(token) {
  const response = await fetch("/api/history", { headers: authHeaders(token) });
  if (!response.ok) return [];
  const data = await response.json();
  return /** @type {CheckRecord[]} */ (data.history || []);
}

/**
 * Fetch aggregate analytics from the server.
 * @param {string} token - Current access token.
 * @returns {Promise<AnalyticsData|null>} Analytics data, or null on failure.
 */
export async function apiFetchAnalytics(token) {
  const response = await fetch("/api/analytics", { headers: authHeaders(token) });
  if (!response.ok) return null;
  return /** @type {Promise<AnalyticsData>} */ (response.json());
}

/**
 * Download a transcript PDF and trigger a browser download.
 * @param {string} token - Current access token.
 * @param {string} url - API URL for the transcript PDF endpoint.
 * @returns {Promise<void>}
 * @throws {Error} If the download fails.
 */
export async function apiDownloadTranscript(token, url) {
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Could not download transcript.");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = "medroute-call-transcript.pdf";
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
