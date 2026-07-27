import assert from "node:assert/strict";
import test from "node:test";
import { ProductionStore } from "../production-store.js";

test("production history is filtered by owner", async () => {
  const calls = [];
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ payload: { id: "run_1" } }] }; } };
  const store = new ProductionStore("unused", pool);
  assert.deepEqual(await store.readHistory("owner-a"), [{ id: "run_1" }]);
  assert.match(calls[0].sql, /WHERE actor = \$1/);
  assert.deepEqual(calls[0].values, ["owner-a"]);
});

test("unknown idempotency reservations are retained for reconciliation", async () => {
  const calls = [];
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };
  const store = new ProductionStore("unused", pool);
  await store.markIdempotencyUnknown("key-a");
  assert.match(calls[0].sql, /SET status = 'unknown'/);
  assert.match(calls[0].sql, /status = 'pending'/);
  assert.deepEqual(calls[0].values, ["key-a"]);
});

test("an old unknown reservation is not recycled as stale pending work", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("RETURNING key")) return { rowCount: 0, rows: [] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ fingerprint: "fingerprint", status: "unknown", created_at: new Date(0), payload: null }] };
      return { rows: [] };
    },
    release() {}
  };
  const store = new ProductionStore("unused", { async connect() { return client; } });
  const reservation = await store.reserveIdempotency("key-a", "fingerprint", new Date());
  assert.equal(reservation.created, false);
  assert.equal(reservation.status, "unknown");
  assert.equal(queries.some(sql => sql.startsWith("UPDATE medroute_idempotency SET fingerprint")), false);
});
