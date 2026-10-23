import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { once } from "node:events";
import { openTestDatabase, embedded } from "./database.js";
import { migrate } from "../src/migrate.js";
import { Reservations, type Principal } from "../src/service.js";
import { authentication } from "../src/auth.js";
import { app } from "../src/app.js";
import type { Database } from "../src/db.js";
let db: Database, service: Reservations;
const member = (id: string): Principal => ({ id, role: "member" });
const a = member("alice"),
  b = member("bob"),
  admin: Principal = { id: "administrator", role: "admin" };
async function slot(capacity = 1) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO slots VALUES($1,'Test studio','North campus',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 1 hour',$2)`,
    [id, capacity],
  );
  return id;
}
async function hold(p: Principal, id: string, key = randomUUID()) {
  return service.command(p, key, `hold:${id}`, (c) => service.hold(c, p, id));
}
async function transition(
  p: Principal,
  id: string,
  action: "confirm" | "cancel",
  key = randomUUID(),
) {
  return service.command(p, key, `${action}:${id}`, (c) =>
    service.transition(c, p, id, action),
  );
}
async function count(table: string) {
  return Number(
    (await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,
  );
}
before(async () => {
  if (process.env.CI && !process.env.TEST_DATABASE_URL)
    throw new Error(
      "CI MUST run against real PostgreSQL: set TEST_DATABASE_URL",
    );
  console.log(
    embedded
      ? "MODE: PGlite serialized embedded SQL; NOT a multi-session concurrency test"
      : "MODE: real PostgreSQL multi-session contention",
  );
  if (embedded) await rm(".test-db", { recursive: true, force: true });
  db = openTestDatabase();
  await migrate(db);
  service = new Reservations(db);
});
beforeEach(async () => {
  await db.query(
    "TRUNCATE outbox,idempotency,reservations,slots RESTART IDENTITY CASCADE",
  );
});
after(async () => {
  await db?.end();
  if (embedded) await rm(".test-db", { recursive: true, force: true });
});

test("100 contenders preserve capacity; exactly 5 holds and 95 waitlist entries", async () => {
  const id = await slot(5);
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => hold(member(`person-${i}`), id)),
  );
  assert.equal(results.filter((r) => r.body.state === "held").length, 5);
  assert.equal(results.filter((r) => r.body.state === "waitlisted").length, 95);
  assert(results.every((r) => r.status === 201));
  assert.equal(await count("idempotency"), 100);
  assert.equal(await count("outbox"), 100);
  const s = (await service.list(a))[0];
  assert.equal(s.occupied, 5);
  assert.equal(s.waiting, 95);
});
test("30 simultaneous retries share one response and one event; keys are principal scoped", async () => {
  const id = await slot(2),
    key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 30 }, () => hold(a, id, key)),
  );
  assert(results.every((r) => r.body.id === results[0].body.id));
  assert.equal(await count("reservations"), 1);
  assert.equal(await count("outbox"), 1);
  assert.equal(await count("idempotency"), 1);
  assert.equal((await hold(b, id, key)).status, 201);
  assert.equal(await count("reservations"), 2);
  await assert.rejects(
    () =>
      service.command(a, key, "different-payload", async () => ({
        status: 200,
        body: {},
      })),
    /different request/,
  );
});
test("one active reservation per member, concurrent distinct keys do not bypass uniqueness", async () => {
  const id = await slot(10),
    results = await Promise.all(Array.from({ length: 20 }, () => hold(a, id)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 19);
  assert.equal(await count("outbox"), 1);
});
test("cancel promotes FIFO waiter into a new hold; confirm and cancellation retries are stable", async () => {
  const id = await slot(),
    r1 = await hold(a, id),
    r2 = await hold(b, id),
    r3 = await hold(member("carol"), id);
  assert.equal(
    (await transition(a, r1.body.id, "confirm")).body.state,
    "confirmed",
  );
  const key = randomUUID();
  const cancel = await transition(a, r1.body.id, "cancel", key);
  assert.equal(cancel.body.state, "cancelled");
  assert.deepEqual(await transition(a, r1.body.id, "cancel", key), cancel);
  const rows = (
    await db.query("SELECT * FROM reservations ORDER BY queue_order")
  ).rows;
  assert.equal(rows.find((r) => r.id === r2.body.id).state, "held");
  assert.equal(rows.find((r) => r.id === r3.body.id).state, "waitlisted");
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) n FROM outbox WHERE type='reservation.promoted'",
        )
      ).rows[0].n,
    ),
    1,
  );
});
test("expired holds cannot confirm; expiry promotes once and never overfills", async () => {
  const id = await slot(),
    r1 = await hold(a, id),
    r2 = await hold(b, id);
  await db.query(
    "UPDATE reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [r1.body.id],
  );
  assert.equal((await transition(a, r1.body.id, "confirm")).status, 409);
  await Promise.all([service.sweep(), service.sweep(), service.sweep()]);
  const rows = (
    await db.query("SELECT * FROM reservations ORDER BY queue_order")
  ).rows;
  assert.equal(rows[0].state, "expired");
  assert.equal(rows[1].id, r2.body.id);
  assert.equal(rows[1].state, "held");
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) n FROM outbox WHERE type='reservation.promoted'",
        )
      ).rows[0].n,
    ),
    1,
  );
});
test("reservation, idempotency response and outbox roll back together on failure", async () => {
  const id = await slot();
  const original = service.event;
  service.event = async () => {
    throw new Error("simulated failure before commit");
  };
  try {
    await assert.rejects(() => hold(a, id), /simulated failure/);
  } finally {
    service.event = original;
  }
  assert.equal(await count("reservations"), 0);
  assert.equal(await count("outbox"), 0);
  assert.equal(await count("idempotency"), 0);
});
test("service/database connection restart preserves committed idempotency results", async () => {
  const id = await slot(),
    key = randomUUID(),
    result = await hold(a, id, key);
  await db.end();
  db = openTestDatabase();
  service = new Reservations(db);
  const replay = await hold(a, id, key);
  assert.equal(replay.body.id, result.body.id);
  assert.equal(await count("outbox"), 1);
});
test("abandoned outbox leases redeliver after expiry and stale ACK is fenced", async () => {
  await hold(a, await slot());
  const [first] = await service.claim(1, 30);
  assert.equal(first.attempts, 1);
  assert.equal((await service.claim()).length, 0);
  await db.query(
    "UPDATE outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [first.id],
  );
  await assert.rejects(
    () => service.ack(first.id, first.lease_token),
    /Lease expired/,
  );
  const [second] = await service.claim(1, 30);
  assert.equal(second.id, first.id);
  assert.equal(second.attempts, 2);
  assert.notEqual(second.lease_token, first.lease_token);
  await assert.rejects(
    () => service.ack(first.id, first.lease_token),
    /Lease expired/,
  );
  await service.ack(second.id, second.lease_token);
  assert.equal((await service.claim()).length, 0);
  await assert.rejects(
    () => service.ack(second.id, second.lease_token),
    /already acknowledged/,
  );
});
test("parallel outbox workers receive disjoint event batches", async () => {
  const id = await slot(20);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => hold(member(`u-${i}`), id)),
  );
  const batches = await Promise.all(
    Array.from({ length: 4 }, () => service.claim(5)),
  );
  const ids = batches.flat().map((x) => x.id);
  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20);
});
test("authorization denies cross-member actions and allows admin; no missing-auth fallback", async () => {
  const id = await slot(),
    r = await hold(a, id);
  assert.equal((await transition(b, r.body.id, "cancel")).status, 404);
  assert.equal((await transition(admin, r.body.id, "cancel")).status, 200);
  assert.throws(() => authentication({}), /Configure/);
  assert.throws(
    () =>
      authentication({ DEMO_MODE: "true" }).resolve({
        "x-demo-principal": "constructor",
      }),
    /Choose/,
  );
  assert.throws(
    () => authentication({ NODE_ENV: "production", DEMO_MODE: "true" }),
    /forbidden/,
  );
  assert.throws(
    () => authentication({ AUTH_TOKENS_JSON: "{}" }),
    /At least one/,
  );
  const token = "a".repeat(40),
    auth = authentication({
      NODE_ENV: "production",
      AUTH_TOKENS_JSON: JSON.stringify({ [token]: a }),
    });
  assert.throws(() => auth.resolve({ "x-demo-principal": "admin" }), /bearer/);
  assert.deepEqual(auth.resolve({ authorization: `Bearer ${token}` }), a);
});
test("HTTP end-to-end: auth, validation, roles, hold/confirm/replay and privacy", async () => {
  const server = app(service, { DEMO_MODE: "true" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as any;
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (
    path: string,
    identity?: string,
    body?: any,
    key = randomUUID(),
  ) => {
    const response = await fetch(base + path, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        ...(identity ? { "X-Demo-Principal": identity } : {}),
        ...(body !== undefined
          ? { "Content-Type": "application/json", "Idempotency-Key": key }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await request("/health")).status, 200);
    assert.equal((await request("/api/slots")).status, 401);
    assert.equal((await request("/api/admin/outbox", "alex")).status, 403);
    assert.equal((await request("/api/slots", "alex", {})).status, 403);
    assert.equal(
      (await request("/api/admin/expire", "admin", { unexpected: true }))
        .status,
      400,
    );
    const id = await slot(),
      key = randomUUID();
    const created = await request(`/api/slots/${id}/holds`, "alex", {}, key);
    assert.equal(created.status, 201);
    assert.deepEqual(
      await request(`/api/slots/${id}/holds`, "alex", {}, key),
      created,
    );
    assert.equal(
      (
        await request(`/api/slots/${id}/holds`, "sam", {
          principal: "demo-alex",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(`/api/reservations/${created.body.id}/confirm`, "sam", {}))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          `/api/reservations/${created.body.id}/confirm`,
          "alex",
          {},
        )
      ).body.state,
      "confirmed",
    );
    assert.equal((await request("/api/slots", "sam")).body[0].mine, null);
    assert.equal(
      (await request("/api/slots/not-a-uuid/holds", "alex", {})).status,
      400,
    );
    assert.equal(
      (await request(`/api/slots/${id}/holds`, "sam", {}, "short")).status,
      400,
    );
    const oversized = await fetch(base + "/api/slots", {
      method: "POST",
      headers: {
        "X-Demo-Principal": "admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "x".repeat(20000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("booking closes at database start time: no new hold, waitlist, or confirmation", async () => {
  const id = await slot(2),
    held = await hold(a, id);
  await db.query("UPDATE slots SET starts_at=clock_timestamp() WHERE id=$1", [
    id,
  ]);
  assert.equal((await hold(b, id)).status, 409);
  assert.equal((await transition(a, held.body.id, "confirm")).status, 409);
  assert.equal((await service.list(a))[0].booking_open, false);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) n FROM outbox WHERE type='reservation.confirmed'",
        )
      ).rows[0].n,
    ),
    0,
  );
  const full = await slot();
  await hold(a, full);
  await db.query("UPDATE slots SET starts_at=clock_timestamp() WHERE id=$1", [
    full,
  ]);
  assert.equal((await hold(b, full)).status, 409);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM reservations WHERE state='waitlisted'",
      )
    ).rows[0].n,
    0,
  );
});

test("closed sessions expire outstanding offers without promotion and preserve confirmed history/cancel", async () => {
  const id = await slot(),
    held = await hold(a, id),
    waiting = await hold(b, id);
  await db.query(
    "UPDATE slots SET starts_at=clock_timestamp()-interval '2 hours',ends_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
    [id],
  );
  await db.end();
  db = openTestDatabase();
  service = new Reservations(db);
  await service.sweep();
  const rows = (
    await db.query(
      "SELECT * FROM reservations WHERE slot_id=$1 ORDER BY queue_order",
      [id],
    )
  ).rows;
  assert.equal(rows.find((r) => r.id === held.body.id).state, "expired");
  assert.equal(rows.find((r) => r.id === waiting.body.id).state, "expired");
  assert.equal((await transition(b, waiting.body.id, "confirm")).status, 409);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM outbox WHERE type='reservation.promoted'",
      )
    ).rows[0].n,
    0,
  );
  const confirmedSlot = await slot(),
    confirmed = await hold(a, confirmedSlot);
  await transition(a, confirmed.body.id, "confirm");
  await hold(b, confirmedSlot);
  await db.query("UPDATE slots SET starts_at=clock_timestamp() WHERE id=$1", [
    confirmedSlot,
  ]);
  assert.equal(
    (
      await db.query("SELECT state FROM reservations WHERE id=$1", [
        confirmed.body.id,
      ])
    ).rows[0].state,
    "confirmed",
  );
  assert.equal((await transition(a, confirmed.body.id, "cancel")).status, 200);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM outbox WHERE type='reservation.promoted'",
      )
    ).rows[0].n,
    0,
  );
});

test("initial and promoted hold deadlines never exceed the database session start", async () => {
  const id = await slot();
  await db.query(
    "UPDATE slots SET starts_at=clock_timestamp()+interval '30 seconds' WHERE id=$1",
    [id],
  );
  const first = await hold(a, id),
    second = await hold(b, id);
  const start = (
    await db.query("SELECT starts_at FROM slots WHERE id=$1", [id])
  ).rows[0].starts_at;
  assert.equal(
    new Date(first.body.expires_at).getTime(),
    new Date(start).getTime(),
  );
  await transition(a, first.body.id, "cancel");
  const promoted = (
    await db.query("SELECT * FROM reservations WHERE id=$1", [second.body.id])
  ).rows[0];
  assert.equal(promoted.state, "held");
  assert.equal(
    new Date(promoted.expires_at).getTime(),
    new Date(start).getTime(),
  );
});
