import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ProductionStore } from "./production-store.js";
import { actorFromClaims, hasPermission } from "./authorization.js";
import { extname, join, normalize, relative } from "node:path";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Pharmacy
 * @property {string} name - Display name of the pharmacy.
 * @property {string} phone - Phone number in international E.164 format (e.g. "+12025550123").
 * @property {number} distanceKm - Approximate distance from the operator in kilometres.
 */

/**
 * @typedef {Object} SanitizedResult
 * @property {"in_stock"|"limited"|"out_of_stock"|"unknown"} stock_status - Whether the medicine is available.
 * @property {string} price_range - Approximate price range reported by the pharmacy.
 * @property {"ready_today"|"not_confirmed_today"|"unknown"} pickup_readiness - Same-day pickup availability.
 * @property {string} hours - Pharmacy operating hours.
 * @property {string} substitution_available - Whether a substitute formulation was mentioned.
 * @property {string} notes - Free-text notes from the call.
 * @property {"high"|"medium"|"low"} confidence - How confident the agent was in its answers.
 */

/**
 * @typedef {Object} CallResult
 * @property {string} pharmacy - Pharmacy display name.
 * @property {string} phone - Masked phone number for display.
 * @property {string} recipientKey - HMAC-hashed phone key (server-only).
 * @property {number} distanceKm - Distance in kilometres.
 * @property {SanitizedResult} result - Sanitized structured call result.
 * @property {string} callId - CALL-E call identifier.
 * @property {string} summary - Redacted call summary.
 * @property {Array<{speaker: string, text: string, offsetSeconds: number|null}>} transcript - Cleaned transcript turns.
 * @property {"live"|"demo"} mode - Whether this was a real call or demo.
 * @property {string} [error] - Error message if the call failed.
 */

/**
 * @typedef {Object} CheckRecord
 * @property {string} id - Unique run identifier (e.g. "run_1234567890_abc123").
 * @property {string} createdAt - ISO 8601 timestamp.
 * @property {"live"|"demo"} mode - Execution mode.
 * @property {string} medicine - Medicine name.
 * @property {string} strength - Strength and dosage form string.
 * @property {CallResult[]} results - Per-pharmacy results.
 * @property {string} [idempotencyKey] - Stored idempotency key (live mode only).
 * @property {string} [requestFingerprint] - Request fingerprint for idempotency (live mode only).
 */

/**
 * @typedef {Object} Actor
 * @property {string} subject - Pseudonymous subject identifier (hashed).
 * @property {Set<string>} permissions - Set of permission strings the actor holds.
 */

/**
 * @typedef {Object} ValidationError
 * @property {string} error - Human-readable error message.
 */

/**
 * @typedef {Object} ValidationSuccess
 * @property {string} medicine - Sanitized medicine name.
 * @property {string} strength - Sanitized strength string.
 * @property {Pharmacy[]} pharmacies - Cleaned pharmacy list.
 * @property {boolean} liveRequested - Whether live calling was requested.
 */

/**
 * @typedef {Object} AnalyticsResult
 * @property {number} totalRuns - Total number of saved check runs.
 * @property {number} totalCalls - Total pharmacy calls across all runs.
 * @property {number} liveRuns - Number of runs that used live calling.
 * @property {number} inStockRate - Percentage of calls that reported in-stock.
 * @property {Array<{medicine: string, count: number}>} topMedicines - Most-checked medicines.
 * @property {Object[]} recent - Most recent public records.
 */

/**
 * @typedef {Object} IdempotentRun
 * @property {string} fingerprint - Request fingerprint for validation.
 * @property {Promise<CheckRecord>} promise - In-flight promise for the result.
 * @property {boolean} uncertain - Whether the outcome is unknown (needs reconciliation).
 */

/**
 * @typedef {Object} TranscriptTurn
 * @property {"bot"|"user"|"unknown"} speaker - Who is speaking.
 * @property {string} text - Normalized and redacted turn text.
 * @property {number|null} offsetSeconds - Seconds from call start, or null if unavailable.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** @type {number} Server listening port. */
const port = Number(process.env.PORT || 3000);

/** @type {string} Absolute path to the public/static files directory. */
const publicDir = join(process.cwd(), "public");

/** @type {string} Directory for local data persistence (history JSON). */
const dataDir = process.env.MEDROUTE_DATA_DIR || join(process.cwd(), "data");

/** @type {string} Path to the local history JSON file. */
const historyFile = join(dataDir, "medroute-history.json");

/** @type {string} Path to the Python transcript PDF generator script. */
const transcriptPdfScript = join(process.cwd(), "scripts", "generate-transcript-pdf.py");

/** @type {boolean} Whether the server is running in production mode (requires PostgreSQL + OIDC). */
const productionMode = process.env.MEDROUTE_ENV === "production";

/**
 * Operator access token for non-production mode.
 * Falls back to "medroute-demo" when neither CALLE_API_KEY nor MEDROUTE_ACCESS_TOKEN is set.
 * @type {string|undefined}
 */
const accessToken =
  process.env.MEDROUTE_ACCESS_TOKEN ||
  (!productionMode && !process.env.CALLE_API_KEY ? "medroute-demo" : undefined);

if (!productionMode && process.env.CALLE_API_KEY && !process.env.MEDROUTE_ACCESS_TOKEN) {
  throw new Error("Live CALL-E configuration requires MEDROUTE_ACCESS_TOKEN.");
}

/** @type {number} Maximum API requests per minute per operator+IP. */
const maxChecksPerMinute = Number(process.env.MEDROUTE_MAX_CHECKS_PER_MINUTE || 30);

/** @type {number} Minimum milliseconds between live calls to the same pharmacy. */
const liveCooldownMs = Number(process.env.MEDROUTE_LIVE_COOLDOWN_SECONDS || 900) * 1_000;

/** @type {number} Milliseconds before a pending idempotency reservation can be retried. */
const idempotencyPendingMs = Number(process.env.MEDROUTE_IDEMPOTENCY_PENDING_SECONDS || 900) * 1_000;

/** @type {number} Maximum number of transcript turns to retain from a call. */
const maxTranscriptTurns = Number(process.env.MEDROUTE_MAX_TRANSCRIPT_TURNS || 200);

/** @type {string} OIDC permission required to read history and transcripts. */
const readPermission = process.env.MEDROUTE_OIDC_READ_PERMISSION || "medroute.read";

/** @type {string} OIDC permission required to place live calls. */
const livePermission = process.env.MEDROUTE_OIDC_LIVE_PERMISSION || "medroute.live";

if (productionMode && (!process.env.DATABASE_URL || !process.env.MEDROUTE_OIDC_ISSUER || !process.env.MEDROUTE_OIDC_AUDIENCE || !process.env.MEDROUTE_OIDC_JWKS_URL)) {
  throw new Error("Production mode requires DATABASE_URL and MEDROUTE_OIDC_ISSUER, MEDROUTE_OIDC_AUDIENCE, and MEDROUTE_OIDC_JWKS_URL.");
}

// ---------------------------------------------------------------------------
// Production store + OIDC
// ---------------------------------------------------------------------------

const ProductionStoreClass =
  productionMode && process.env.MEDROUTE_PRODUCTION_STORE_MODULE
    ? (await import(process.env.MEDROUTE_PRODUCTION_STORE_MODULE)).ProductionStore
    : ProductionStore;

/** @type {ProductionStore|null} Database-backed store, null in development mode. */
const productionStore = productionMode ? new ProductionStoreClass(process.env.DATABASE_URL) : null;
if (productionStore) await productionStore.init();

/** @type {import("jose").RemoteJWKSet|null} JWKS endpoint for OIDC token verification, null in dev. */
const oidcJwks = productionMode ? createRemoteJWKSet(new URL(process.env.MEDROUTE_OIDC_JWKS_URL)) : null;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/**
 * In-flight idempotent live runs, keyed by `${actorSubject}:${idempotencyKey}`.
 * @type {Map<string, IdempotentRun>}
 */
const idempotentRuns = new Map();

/**
 * Sliding-window rate limiter timestamps, keyed by `${ip}:${actorSubject}`.
 * @type {Map<string, number[]>}
 */
const requestWindows = new Map();

/**
 * Local cooldown reservations for pharmacies recently called live (dev mode only).
 * @type {Map<string, number>}
 */
const localCooldownReservations = new Map();

/** Serialised save queue for atomic local history writes. */
let saveQueue = Promise.resolve();

// ---------------------------------------------------------------------------
// CALL-E result schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema for the structured result expected from CALL-E pharmacy calls.
 * @type {Object}
 */
const resultSchema = {
  type: "object",
  required: ["stock_status", "price_range", "pickup_readiness", "hours", "confidence"],
  properties: {
    stock_status: { type: "string", enum: ["in_stock", "limited", "out_of_stock", "unknown"] },
    price_range: { type: "string" },
    pickup_readiness: { type: "string", enum: ["ready_today", "not_confirmed_today", "unknown"] },
    hours: { type: "string" },
    substitution_available: { type: "string" },
    notes: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON response with security headers.
 * @param {import("node:http").ServerResponse} res - HTTP response object.
 * @param {number} status - HTTP status code.
 * @param {*} value - Value to serialize as JSON body.
 * @returns {void}
 */
function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}

/**
 * Parse a JSON request body with a 100 KB size limit.
 * @param {import("node:http").IncomingMessage} req - HTTP request to read body from.
 * @returns {Promise<Object>} Parsed JSON body.
 * @throws {Error} If body exceeds 100 KB or is not valid JSON.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (!tooLarge) {
        body += chunk;
        tooLarge = body.length > 100_000;
      }
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Request body is too large."));
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

/**
 * Strip newlines and HTML tags, trim whitespace, and cap length.
 * @param {*} value - Input to sanitize (coerced to string).
 * @param {number} [max=120] - Maximum character length.
 * @returns {string} Sanitized text, or empty string for non-string input.
 */
function safeText(value, max = 120) {
  return typeof value === "string" ? value.replace(/[\r\n<>]/g, " ").trim().slice(0, max) : "";
}

/**
 * Mask a phone number for safe display (e.g. "+12•••••0123").
 * @param {string} phone - Raw phone number.
 * @returns {string} Masked phone number, or "Hidden" if too short.
 */
function maskPhone(phone) {
  const value = safeText(phone, 24);
  return value.length > 6
    ? `${value.slice(0, 4)}${"•".repeat(Math.max(0, value.length - 8))}${value.slice(-4)}`
    : "Hidden";
}

/**
 * Redact E.164 phone numbers found in arbitrary text.
 * @param {string} value - Text that may contain phone numbers.
 * @returns {string} Text with phone numbers replaced by masked versions.
 */
function redactPhoneNumbers(value) {
  return safeText(value, 2_000).replace(/\+\d[\d -]{7,}\d/g, (match) =>
    maskPhone(match.replace(/[ -]/g, ""))
  );
}

/**
 * HMAC a phone number to a stable, non-reversible key for internal use.
 * @param {string} phone - Raw phone number in E.164 format.
 * @returns {string} Hex-encoded HMAC-SHA256 digest.
 */
function phoneKey(phone) {
  return createHmac("sha256", process.env.MEDROUTE_RECIPIENT_HASH_KEY || accessToken || "local-development-key")
    .update(phone)
    .digest("hex");
}

/**
 * Compute a deterministic fingerprint of a check request for idempotency.
 * @param {{medicine: string, strength: string, pharmacies: Pharmacy[]}} params - Request parameters.
 * @returns {string} Hex-encoded SHA-256 fingerprint.
 */
function requestFingerprint({ medicine, strength, pharmacies }) {
  return createHash("sha256")
    .update(JSON.stringify({
      medicine,
      strength,
      pharmacies: pharmacies.map((p) => ({ name: p.name, phone: phoneKey(p.phone), distanceKm: p.distanceKm })),
    }))
    .digest("hex");
}

/**
 * Coerce a raw CALL-E result into the sanitized shape we store and serve.
 * Normalizes legacy field names and redacts any embedded phone numbers.
 * @param {Object} result - Raw structured result from CALL-E.
 * @returns {SanitizedResult} Sanitized result with validated enums and redacted text.
 */
function sanitizeResult(result) {
  const source = result && typeof result === "object" ? result : {};
  const pickupMap = { can_hold: "ready_today", cannot_hold: "not_confirmed_today" };
  const pickupReadiness = pickupMap[source.pickup_readiness] || source.pickup_readiness;

  return {
    stock_status: ["in_stock", "limited", "out_of_stock", "unknown"].includes(source.stock_status) ? source.stock_status : "unknown",
    price_range: redactPhoneNumbers(source.price_range),
    pickup_readiness: ["ready_today", "not_confirmed_today", "unknown"].includes(pickupReadiness) ? pickupReadiness : "unknown",
    hours: redactPhoneNumbers(source.hours),
    substitution_available: redactPhoneNumbers(source.substitution_available),
    notes: redactPhoneNumbers(source.notes),
    confidence: ["high", "medium", "low"].includes(source.confidence) ? source.confidence : "low",
  };
}

/**
 * Remove server-only fields before sending a record to the client.
 * Strips idempotencyKey, requestFingerprint, and recipientKey from nested results.
 * @param {CheckRecord} record - Full server-side record.
 * @returns {Object} Public-safe record for client consumption.
 */
function publicRecord(record) {
  const { idempotencyKey, requestFingerprint, results = [], ...rest } = record;
  return { ...rest, results: results.map(({ recipientKey, ...result }) => result) };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming request via Bearer token.
 * In production mode, verifies the JWT against the OIDC JWKS endpoint.
 * In development mode, compares against the shared access token with timing-safe equality.
 * @param {import("node:http").IncomingMessage} req - HTTP request.
 * @returns {Promise<Actor|null>} Authenticated actor, or null if unauthenticated.
 */
async function authenticate(req) {
  const supplied = req.headers.authorization;

  if (productionMode) {
    if (typeof supplied !== "string" || !supplied.startsWith("Bearer ")) return null;
    try {
      const verified = await jwtVerify(supplied.slice(7), oidcJwks, {
        issuer: process.env.MEDROUTE_OIDC_ISSUER,
        audience: process.env.MEDROUTE_OIDC_AUDIENCE,
      });
      return actorFromClaims(verified.payload, process.env.MEDROUTE_OIDC_ISSUER);
    } catch {
      return null;
    }
  }

  const expected = `Bearer ${accessToken || ""}`;
  return Boolean(accessToken) &&
    typeof supplied === "string" &&
    supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ? { subject: createHash("sha256").update("local\0local-operator").digest("hex"), permissions: new Set([readPermission, livePermission]) }
    : null;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Check whether the request is within the per-operator rate limit.
 * Uses a sliding window of 60 seconds.
 * @param {import("node:http").IncomingMessage} req - HTTP request (for IP address).
 * @param {Actor} actor - Authenticated actor.
 * @returns {boolean} True if the request is allowed, false if rate-limited.
 */
function withinRateLimit(req, actor) {
  const key = `${req.socket.remoteAddress || "unknown"}:${actor.subject}`;
  const now = Date.now();
  const window = requestWindows.get(key)?.filter((time) => now - time < 60_000) || [];
  if (window.length >= maxChecksPerMinute) return false;
  window.push(now);
  requestWindows.set(key, window);
  return true;
}

// ---------------------------------------------------------------------------
// Demo mode helpers
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic demo result for a pharmacy without placing a call.
 * Status is derived from the last digit of the phone number for variety.
 * @param {Pharmacy} pharmacy - Pharmacy to generate a demo result for.
 * @param {string} medicine - Medicine name being checked.
 * @returns {CallResult} Demo call result with mode "demo".
 */
function demoResult(pharmacy, medicine) {
  const seeds = ["in_stock", "limited", "out_of_stock"];
  const status = seeds[Number(pharmacy.phone.at(-1)) % seeds.length];
  return {
    pharmacy: pharmacy.name,
    phone: maskPhone(pharmacy.phone),
    distanceKm: pharmacy.distanceKm,
    result: {
      stock_status: status,
      price_range: status === "out_of_stock" ? "Not available" : "KES 2,400–3,100",
      pickup_readiness: status === "in_stock" ? "ready_today" : "not_confirmed_today",
      hours: "Open until 8:00 PM",
      substitution_available: status === "out_of_stock" ? "Ask pharmacist" : "Not needed",
      notes: `Demo response for ${medicine}. Verify with a live authorized call.`,
      confidence: "medium",
    },
    mode: "demo",
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Compute a numeric score for ranking pharmacy results.
 * Higher scores indicate better availability and closer proximity.
 * @param {CallResult} item - Call result to score.
 * @returns {number} Composite score (stock + pickup - distance).
 */
function score(item) {
  const r = item.result || {};
  const stockScore = r.stock_status === "in_stock" ? 100 : r.stock_status === "limited" ? 55 : 0;
  const pickupBonus = ["ready_today", "can_hold"].includes(r.pickup_readiness) ? 20 : 0;
  const distancePenalty = Number(item.distanceKm || 0) * 2;
  return stockScore + pickupBonus - distancePenalty;
}

// ---------------------------------------------------------------------------
// History persistence
// ---------------------------------------------------------------------------

/**
 * Read check history for an actor from the local JSON file or production database.
 * @param {string} actor - Actor subject identifier.
 * @returns {Promise<CheckRecord[]>} Array of historical check records, newest first.
 * @throws {Error} If the history file is malformed or unreadable.
 */
async function readHistory(actor) {
  if (productionStore) return productionStore.readHistory(actor);
  try {
    const history = JSON.parse(await readFile(historyFile, "utf8"));
    if (!Array.isArray(history)) throw new Error("Saved history is not a JSON array.");
    return history;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`Could not read saved history: ${error.message}`);
  }
}

/**
 * Persist a check record atomically (write-to-temp + rename).
 * In production mode, delegates to the PostgreSQL store within a transaction.
 * @param {CheckRecord} record - Check record to save.
 * @param {string} actor - Actor subject identifier.
 * @returns {Promise<void>}
 */
async function saveHistory(record, actor) {
  if (productionStore) return productionStore.saveRun(record, actor);
  const save = async () => {
    const history = await readHistory();
    history.unshift(record);
    await mkdir(dataDir, { recursive: true });
    const temporaryFile = `${historyFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, JSON.stringify(history.slice(0, 100), null, 2), "utf8");
    await rename(temporaryFile, historyFile);
  };
  const pending = saveQueue.then(save, save);
  saveQueue = pending.catch(() => {});
  return pending;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Compute aggregate analytics from check history.
 * @param {CheckRecord[]} history - Array of historical check records.
 * @returns {AnalyticsResult} Computed analytics.
 */
function computeAnalytics(history) {
  const medicineCounts = new Map();
  let calls = 0;
  let inStock = 0;
  let liveRuns = 0;

  for (const run of history) {
    medicineCounts.set(run.medicine, (medicineCounts.get(run.medicine) || 0) + 1);
    calls += run.results.length;
    inStock += run.results.filter((item) => item.result?.stock_status === "in_stock").length;
    if (run.mode === "live") liveRuns += 1;
  }

  return {
    totalRuns: history.length,
    totalCalls: calls,
    liveRuns,
    inStockRate: calls ? Math.round((inStock / calls) * 100) : 0,
    topMedicines: [...medicineCounts.entries()]
      .map(([medicine, count]) => ({ medicine, count }))
      .sort((a, b) => b.count - a.count),
    recent: history.map(publicRecord),
  };
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

/**
 * Normalize transcript text: strip leading numbered prefixes, collapse whitespace.
 * @param {string} value - Raw transcript text.
 * @returns {string} Normalized and trimmed text.
 */
function normalizeTranscriptText(value) {
  return safeText(value, 2_000).replace(/^\s*\d+\.\s+/, "").replace(/\s+/g, " ").trim();
}

/**
 * Check whether a sentence appears to be complete (ends with punctuation).
 * @param {string} value - Text to check.
 * @returns {boolean} True if the text ends with a sentence-ending punctuation mark.
 */
function sentenceComplete(value) {
  return /[.!?]["')\]]?\s*$/.test(value);
}

/**
 * Merge consecutive transcript turns from the same speaker when the previous
 * turn does not end with a complete sentence.
 * @param {TranscriptTurn[]} turns - Array of transcript turns.
 * @returns {TranscriptTurn[]} Merged turns.
 */
function mergeTranscriptTurns(turns) {
  return turns.reduce((merged, turn) => {
    const previous = merged.at(-1);
    if (previous && previous.speaker === turn.speaker && !sentenceComplete(previous.text)) {
      previous.text = `${previous.text} ${turn.text}`.replace(/\s+/g, " ").trim();
      return merged;
    }
    merged.push({ ...turn });
    return merged;
  }, []);
}

/**
 * Extract and clean transcript turns from a CALL-E call object.
 * Limits to maxTranscriptTurns, normalizes text, redacts phone numbers,
 * and merges incomplete consecutive turns from the same speaker.
 * @param {Object} call - CALL-E call response object.
 * @returns {TranscriptTurn[]} Cleaned and merged transcript turns.
 */
function cleanTranscript(call) {
  const attempts = call.recipients[0]?.attempts || [];
  const turns = attempts
    .flatMap((attempt) => attempt.transcriptTurns || [])
    .slice(0, maxTranscriptTurns)
    .map((turn) => ({
      speaker: ["bot", "user"].includes(turn.speaker) ? turn.speaker : "unknown",
      text: redactPhoneNumbers(normalizeTranscriptText(turn.text)),
      offsetSeconds: Number.isFinite(turn.offsetSeconds) ? turn.offsetSeconds : null,
    }))
    .filter((turn) => turn.text);
  return mergeTranscriptTurns(turns);
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

/**
 * Generate a branded PDF transcript by spawning the Python ReportLab script.
 * Sends the transcript payload as JSON via stdin and receives the PDF on stdout.
 * @param {Object} payload - Transcript data to include in the PDF.
 * @param {string} payload.runId - Run identifier.
 * @param {string} payload.createdAt - ISO 8601 creation timestamp.
 * @param {string} payload.medicine - Medicine name.
 * @param {string} payload.strength - Strength/dosage form.
 * @param {string} payload.pharmacy - Pharmacy name.
 * @param {string} payload.phone - Masked phone number.
 * @param {string} payload.callId - CALL-E call reference.
 * @param {string} payload.summary - Call summary.
 * @param {TranscriptTurn[]} payload.transcript - Transcript turns.
 * @returns {Promise<Buffer>} Generated PDF as a Buffer.
 * @throws {Error} If the Python script fails or returns an empty file.
 */
function createTranscriptPdf(payload) {
  return new Promise((resolve, reject) => {
    const python = process.env.MEDROUTE_PYTHON || "python";
    const child = spawn(python, [transcriptPdfScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", (error) => reject(new Error(`Could not create transcript PDF: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Could not create transcript PDF: ${Buffer.concat(errors).toString("utf8").trim() || "PDF generator failed."}`));
      }
      const pdf = Buffer.concat(output);
      if (!pdf.length) return reject(new Error("Could not create transcript PDF: generator returned an empty file."));
      resolve(pdf);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------------------
// Live call execution
// ---------------------------------------------------------------------------

/**
 * Build the task prompt for a CALL-E pharmacy availability call.
 * The prompt instructs the agent to identify itself, confirm the pharmacy,
 * and ask structured questions about stock, price, pickup, and hours.
 * @param {Pharmacy} pharmacy - Target pharmacy.
 * @param {string} medicine - Medicine name.
 * @param {string} strength - Strength and dosage form.
 * @returns {string} Full task prompt for the CALL-E agent.
 */
function buildCallTask(pharmacy, medicine, strength) {
  const medicineRequest = `${medicine}${strength ? `, ${strength}` : ""}`;
  return `You are an automated MedRoute medicine-availability representative calling ${pharmacy.name}.

CRITICAL OPENING: Your first spoken words must be exactly: "Hello, this is an AI representative from Med Route. Is this ${pharmacy.name}?" Speak the full pharmacy name exactly as written. Stop immediately after this question and wait for the response. Do not ask about medicine before the pharmacy is confirmed.

IDENTITY CHECK:
- If they clearly confirm this is ${pharmacy.name}, continue.
- If the answer is unclear, ask exactly once: "May I confirm, is this ${pharmacy.name}?" Then wait.
- If they do not confirm after that, say "Thank you. I may have reached the wrong number. Goodbye." and end the call. Do not ask any availability questions.

AFTER CONFIRMATION: Say exactly: "On behalf of a care coordinator, we're requesting a time-sensitive medicine availability check." Then ask: "Is ${medicineRequest} available today?"

QUESTION RULES:
1. Listen completely to each answer before speaking again.
2. Never ask the same question twice. If an answer is unclear, refused, or unknown, record that item as unknown and move on; do not rephrase it.
3. Extract every fact volunteered in an answer. Do not ask for a fact that the pharmacy has already supplied.
4. Only when still missing, ask each of these once and in this order: approximate price range; whether it is available for pickup today (do not ask the pharmacy to reserve or hold it); today's closing time.
5. Once those four items are answered or marked unknown, say "Thank you for your help. Goodbye." and end the call. Do not restart the conversation or repeat the medicine name.

SAFETY: Identify yourself as an automated assistant. Do not share patient information, request prescriptions, make a purchase, place an order, reserve medicine, give medical advice, or infer facts the pharmacy did not state. Return only facts stated by ${pharmacy.name}.`;
}

/**
 * Execute a live pharmacy availability call via the CALL-E SDK.
 * Places the call, waits for a structured result, sanitizes it, and cleans the transcript.
 * @param {Pharmacy} pharmacy - Pharmacy to call.
 * @param {string} medicine - Medicine name.
 * @param {string} strength - Strength and dosage form.
 * @returns {Promise<CallResult>} Sanitized call result with transcript.
 * @throws {Error} If the call fails or returns no structured result.
 */
async function runLiveCall(pharmacy, medicine, strength) {
  const { CalleClient } = await import(process.env.MEDROUTE_CALLE_CLIENT_MODULE || "@call-e/calle");
  const client = new CalleClient({ apiKey: process.env.CALLE_API_KEY });

  const outboundRecipient = { phone: pharmacy.phone };
  if (process.env.MEDROUTE_CALL_LOCALE) outboundRecipient.locale = process.env.MEDROUTE_CALL_LOCALE;
  if (process.env.MEDROUTE_CALL_REGION) outboundRecipient.region = process.env.MEDROUTE_CALL_REGION;

  const call = await client.calls.createAndWait({
    task: buildCallTask(pharmacy, medicine, strength),
    recipient: outboundRecipient,
    resultSchema,
    recipientResultSchema: resultSchema,
    metadata: { workflow: "medroute-pharmacy-availability" },
  });

  const recipient = call.recipients[0];
  const result = recipient?.structuredResult ?? call.structuredResult;
  if (!result) throw new Error("CALL-E completed without a structured pharmacy result.");

  return {
    pharmacy: pharmacy.name,
    phone: maskPhone(pharmacy.phone),
    recipientKey: phoneKey(pharmacy.phone),
    distanceKm: pharmacy.distanceKm,
    result: sanitizeResult(result),
    callId: safeText(call.id, 120),
    summary: redactPhoneNumbers(recipient?.summary ?? call.summary ?? ""),
    transcript: cleanTranscript(call),
    mode: "live",
  };
}

// ---------------------------------------------------------------------------
// Check request validation
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize a check request body.
 * Returns a validation error or the cleaned parameters.
 * @param {Object} body - Raw parsed request body.
 * @param {string} body.medicine - Medicine name.
 * @param {string} [body.strength] - Strength/dosage form.
 * @param {Array<Object>} body.pharmacies - Array of pharmacy objects.
 * @param {boolean} body.consentAcknowledged - Whether the operator confirmed authorization.
 * @param {boolean} [body.confirmLive] - Whether live calling is requested.
 * @param {boolean} [body.liveCallAcknowledged] - Whether live call consent was given.
 * @returns {ValidationError|ValidationSuccess} Validation result.
 */
function validateCheckRequest(body) {
  const medicine = safeText(body.medicine);
  const strength = safeText(body.strength, 60);
  const pharmacies = Array.isArray(body.pharmacies) ? body.pharmacies.slice(0, 5) : [];

  if (!medicine || pharmacies.length === 0) {
    return { error: "Medicine and at least one pharmacy are required." };
  }

  const clean = pharmacies.map((p) => ({
    name: safeText(p.name),
    phone: safeText(p.phone, 24),
    distanceKm: p.distanceKm === "" || p.distanceKm == null ? 0 : Number(p.distanceKm),
  }));

  if (clean.some((p) => !p.name || !/^\+[1-9]\d{7,14}$/.test(p.phone))) {
    return { error: "Every pharmacy must have a name and an authorized phone number in international E.164 format, such as +12025550123." };
  }
  if (clean.some((p) => !Number.isFinite(p.distanceKm) || p.distanceKm < 0)) {
    return { error: "Pharmacy distance must be a non-negative number." };
  }
  if (body.consentAcknowledged !== true) {
    return { error: "Confirm authorization to contact every pharmacy before running a check." };
  }

  const liveRequested = body.confirmLive === true;
  if (liveRequested && body.liveCallAcknowledged !== true) {
    return { error: "Explicit live-call authorization is required." };
  }

  return { medicine, strength, pharmacies: clean, liveRequested };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/history — return the actor's check history.
 * @param {import("node:http").IncomingMessage} req - HTTP request.
 * @param {import("node:http").ServerResponse} res - HTTP response.
 * @param {Actor} actor - Authenticated actor.
 * @returns {Promise<void>}
 */
async function handleGetHistory(req, res, actor) {
  try {
    json(res, 200, { history: (await readHistory(actor.subject)).map(publicRecord) });
  } catch (error) {
    json(res, 500, { error: error.message || "Could not read saved history." });
  }
}

/**
 * Handle GET /api/analytics — return aggregate analytics for the actor's history.
 * @param {import("node:http").IncomingMessage} req - HTTP request.
 * @param {import("node:http").ServerResponse} res - HTTP response.
 * @param {Actor} actor - Authenticated actor.
 * @returns {Promise<void>}
 */
async function handleGetAnalytics(req, res, actor) {
  try {
    json(res, 200, computeAnalytics(await readHistory(actor.subject)));
  } catch (error) {
    json(res, 500, { error: error.message || "Could not read analytics." });
  }
}

/**
 * Handle GET /api/transcripts/:runId/:index.pdf — generate and serve a transcript PDF.
 * @param {import("node:http").IncomingMessage} req - HTTP request.
 * @param {import("node:http").ServerResponse} res - HTTP response.
 * @param {Actor} actor - Authenticated actor.
 * @param {RegExpMatchArray} match - Regex match with [1]=runId, [2]=result index.
 * @returns {Promise<void>}
 */
async function handleGetTranscript(req, res, actor, match) {
  try {
    const history = await readHistory(actor.subject);
    const record = history.find((item) => item.id === match[1]);
    const item = record?.results?.[Number(match[2])];
    if (!record || !item || !Array.isArray(item.transcript) || item.transcript.length === 0) {
      return json(res, 404, { error: "No transcript is available for this call." });
    }

    const pdf = await createTranscriptPdf({
      runId: record.id,
      createdAt: record.createdAt,
      medicine: record.medicine,
      strength: record.strength,
      pharmacy: item.pharmacy,
      phone: maskPhone(item.phone),
      callId: item.callId,
      summary: item.summary,
      transcript: item.transcript,
    });

    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=medroute-call-transcript.pdf",
      "Content-Length": pdf.length,
      "Cache-Control": "private, no-store",
    });
    res.end(pdf);
  } catch (error) {
    json(res, 500, { error: error.message || "Could not create transcript PDF." });
  }
}

/**
 * Handle POST /api/check — run a medicine availability check (demo or live).
 * Validates input, enforces rate limits and cooldowns, manages idempotency,
 * and returns ranked pharmacy results.
 * @param {import("node:http").IncomingMessage} req - HTTP request.
 * @param {import("node:http").ServerResponse} res - HTTP response.
 * @param {Actor} actor - Authenticated actor.
 * @returns {Promise<void>}
 */
async function handlePostCheck(req, res, actor) {
  if (!withinRateLimit(req, actor)) {
    return json(res, 429, { error: "Too many requests. Please wait before trying again." });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const validation = validateCheckRequest(body);
  if (validation.error) return json(res, 400, { error: validation.error });

  const { medicine, strength, pharmacies: clean, liveRequested } = validation;

  if (productionMode && liveRequested && !hasPermission(actor, livePermission)) {
    return json(res, 403, { error: `The ${livePermission} permission is required for live calls.` });
  }

  const live = Boolean(process.env.CALLE_API_KEY && liveRequested);
  const idempotencyKey = safeText(req.headers["idempotency-key"], 120);

  if (live && !/^[A-Za-z0-9_-]{16,120}$/.test(idempotencyKey)) {
    return json(res, 400, { error: "A stable Idempotency-Key header is required for live calls." });
  }

  const fingerprint = requestFingerprint({ medicine, strength, pharmacies: clean });
  const idempotencyMapKey = `${actor.subject}:${idempotencyKey}`;
  const storedIdempotencyKey = productionStore
    ? createHash("sha256").update(idempotencyMapKey).digest("hex")
    : idempotencyKey;

  // Check for an existing in-flight idempotent run
  if (live) {
    const existing = idempotentRuns.get(idempotencyMapKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return json(res, 409, { error: "This Idempotency-Key belongs to a different request." });
      if (existing.uncertain) return json(res, 409, { error: "This live request has an unknown outcome and requires administrator reconciliation before it can be retried." });
      return json(res, 200, publicRecord(await existing.promise));
    }
  }

  // Build and execute the check
  /** @returns {Promise<CheckRecord>} The completed check record. */
  const execute = async () => {
    if (live) sideEffectsStarted = true;

    const calls = live
      ? await Promise.allSettled(clean.map((p) => runLiveCall(p, medicine, strength)))
      : clean.map((p) => ({ status: "fulfilled", value: demoResult(p, medicine) }));

    const results = calls
      .map((item, index) =>
        item.status === "fulfilled"
          ? item.value
          : { pharmacy: clean[index].name, phone: maskPhone(clean[index].phone), recipientKey: phoneKey(clean[index].phone), distanceKm: clean[index].distanceKm, error: "Call could not be completed.", mode: /** @type {"live"} */ ("live") }
      )
      .sort((a, b) => score(b) - score(a));

    const record = {
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      mode: live ? "live" : "demo",
      medicine,
      strength,
      results,
      ...(live ? { idempotencyKey: storedIdempotencyKey, requestFingerprint: fingerprint } : {}),
    };

    await saveHistory(record, actor.subject);

    if (productionStore) {
      try {
        await productionStore.audit(actor.subject, live ? "live_check_completed" : "demo_check_completed", { runId: record.id, pharmacyCount: clean.length });
      } catch (error) {
        console.error("MedRoute audit write failed after the run was saved:", error.message);
      }
    }

    return record;
  };

  // Demo path: execute synchronously and return
  if (!live) return json(res, 200, await execute());

  // Live path: idempotent, async execution with cooldown protection
  /** @type {boolean} Tracks whether side effects (CALL-E calls) have started. */
  let sideEffectsStarted = false;

  const pending = Promise.resolve().then(async () => {
    // Reserve idempotency
    if (productionStore) {
      const reservation = await productionStore.reserveIdempotency(storedIdempotencyKey, fingerprint, new Date(Date.now() - idempotencyPendingMs));
      if (!reservation.created) {
        if (reservation.fingerprint !== fingerprint) throw Object.assign(new Error("This Idempotency-Key belongs to a different request."), { status: 409 });
        if (reservation.record) return /** @type {CheckRecord} */ (reservation.record);
        if (reservation.status === "unknown") throw Object.assign(new Error("This live request has an unknown outcome and requires administrator reconciliation before it can be retried."), { status: 409 });
        throw Object.assign(new Error("This live request is already in progress. Retry with the same key shortly."), { status: 409 });
      }
    } else {
      const history = await readHistory(actor.subject);
      const previous = history.find((run) => run.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.requestFingerprint !== fingerprint) throw Object.assign(new Error("This Idempotency-Key belongs to a different request."), { status: 409 });
        return /** @type {CheckRecord} */ (previous);
      }
    }

    // Enforce per-pharmacy cooldown
    const cutoff = Date.now() - liveCooldownMs;
    const recipientKeys = clean.map((pharmacy) => phoneKey(pharmacy.phone));
    /** @type {boolean} */
    let cooldownReserved;

    if (productionStore) {
      cooldownReserved = await productionStore.reserveCooldowns(recipientKeys, cutoff, new Date());
    } else {
      const recentlyCalled = new Set(
        (await readHistory(actor.subject))
          .filter((run) => run.mode === "live" && Date.parse(run.createdAt) >= cutoff)
          .flatMap((run) => run.results || [])
          .map((item) => item.recipientKey)
          .filter(Boolean)
      );
      for (const [key, calledAt] of localCooldownReservations) {
        if (calledAt < cutoff) localCooldownReservations.delete(key);
      }
      cooldownReserved = !recipientKeys.some((key) => recentlyCalled.has(key) || localCooldownReservations.has(key));
      if (cooldownReserved) for (const key of recipientKeys) localCooldownReservations.set(key, Date.now());
    }

    if (!cooldownReserved) {
      throw Object.assign(new Error("A selected pharmacy was contacted recently. Wait for the live-call cooldown before trying again."), { status: 429 });
    }

    return execute();
  });

  /** @type {IdempotentRun} */
  const idempotencyEntry = { fingerprint, promise: pending, uncertain: false };
  idempotentRuns.set(idempotencyMapKey, idempotencyEntry);

  try {
    json(res, 200, publicRecord(await pending));
  } catch (error) {
    if (sideEffectsStarted) {
      idempotencyEntry.uncertain = true;
      if (productionStore) {
        try { await productionStore.markIdempotencyUnknown(storedIdempotencyKey); }
        catch (stateError) { console.error("Could not persist unknown idempotency state:", stateError.message); }
        try { await productionStore.audit(actor.subject, "live_check_outcome_unknown", { status: error.status || 500 }); }
        catch (auditError) { console.error("Could not audit unknown live-call outcome:", auditError.message); }
      }
      return json(res, 500, {
        error: "The live call may have completed, but its result could not be persisted. The idempotency key is locked and requires administrator reconciliation; do not retry with a new key.",
      });
    }

    idempotentRuns.delete(idempotencyMapKey);
    if (productionStore) await productionStore.releaseIdempotency(storedIdempotencyKey);
    await productionStore?.audit(actor.subject, "live_check_failed", { status: error.status || 500 });
    return json(res, error.status || 500, { error: error.message || "Unexpected server error" });
  }
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

/**
 * MIME type map for served static files.
 * @type {Record<string, string>}
 */
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

/**
 * Serve a static file from the public directory.
 * Prevents path traversal by validating the resolved path stays within publicDir.
 * @param {import("node:http").IncomingMessage} req - HTTP request.
 * @param {import("node:http").ServerResponse} res - HTTP response.
 * @returns {Promise<void>}
 */
async function serveStaticFile(req, res) {
  const requested = req.url === "/" ? "index.html" : req.url.split("?")[0].replace(/^\//, "");
  const path = normalize(join(publicDir, requested));
  const relativePath = relative(publicDir, path);

  if (relativePath.startsWith("..") || normalize(relativePath) === "") {
    return json(res, 403, { error: "Forbidden" });
  }

  try {
    const content = await readFile(path);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(path)] || "application/octet-stream" });
    res.end(content);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** @type {RegExp} Pattern for matching transcript PDF download routes. */
const transcriptRoutePattern = /^\/api\/transcripts\/(run_[A-Za-z0-9_-]{1,120})\/(\d+)\.pdf$/;

const server = createServer(async (req, res) => {
  // Global security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );

  const url = req.url || "";
  const basePath = url.split("?")[0];

  // API routes require authentication
  if (basePath.startsWith("/api/")) {
    const actor = await authenticate(req);
    if (!actor) return json(res, 401, { error: "Operator authentication is required." });

    // Production-mode permission checks for read/transcript endpoints
    const isReadRequest = req.method === "GET" && ["/api/history", "/api/analytics"].includes(basePath);
    const isTranscriptRequest = basePath.startsWith("/api/transcripts/");
    if (productionMode && (isReadRequest || isTranscriptRequest) && !hasPermission(actor, readPermission)) {
      return json(res, 403, { error: `The ${readPermission} permission is required.` });
    }

    if (req.method === "GET" && basePath === "/api/history") return handleGetHistory(req, res, actor);
    if (req.method === "GET" && basePath === "/api/analytics") return handleGetAnalytics(req, res, actor);

    const transcriptMatch = basePath.match(transcriptRoutePattern);
    if (req.method === "GET" && transcriptMatch) return handleGetTranscript(req, res, actor, transcriptMatch);

    if (req.method === "POST" && basePath === "/api/check") return handlePostCheck(req, res, actor);

    return json(res, 404, { error: "Not found" });
  }

  // Static file serving
  serveStaticFile(req, res);
});

server.listen(port, () => console.log(`MedRoute running at http://localhost:${port}`));
