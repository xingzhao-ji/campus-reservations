import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import pg from "pg";
import { database, tx, type Database } from "../src/db.js";
import { randomBytes } from "node:crypto";
import { app } from "../src/app.js";
import { Reservations } from "../src/service.js";

test("real pg-pool idle handler removes failed client, logs no secrets, and replaces it", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  const pool: any = database(
    "postgres://synthetic:secret-sentinel@invalid/synthetic",
  );
  let connections = 0;
  class FakeClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    connect(callback: any) {
      connections++;
      queueMicrotask(() => callback(null));
    }
    query(_sql: any, _values: any, callback: any) {
      queueMicrotask(() => callback(null, { rows: [{ ok: 1 }] }));
    }
    end(callback?: () => void) {
      this._ending = true;
      callback?.();
    }
  }
  pool.Client = FakeClient;
  try {
    await pool.query("SELECT 1");
    const failed = pool._idle[0].client;
    assert.doesNotThrow(() =>
      failed.emit("error", new Error("secret-sentinel connection terminated")),
    );
    assert.equal(failed._ending, true);
    assert.equal(pool.idleCount, 0);
    await pool.query("SELECT 1");
    assert.equal(connections, 2);
    assert.equal(logs.length, 1);
    assert(!JSON.stringify(logs).includes("secret-sentinel"));
  } finally {
    await pool.end();
  }
});

test("readiness returns bounded 503 during database failure and recovers without restarting HTTP", async () => {
  let offline = true;
  const db: Database = {
    connect: async () => {
      throw new Error("unused");
    },
    query: async () => {
      if (offline) throw new Error("secret-sentinel");
      return { rows: [{ ok: 1 }] };
    },
    end: async () => {},
  };
  const server = app(new Reservations(db), { DEMO_MODE: "true" }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const outage = await fetch(base + "/health");
    assert.equal(outage.status, 503);
    assert.deepEqual(await outage.json(), {
      ok: false,
      error: "Database unavailable",
    });
    offline = false;
    const recovered = await fetch(base + "/health");
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test(
  "real PostgreSQL idle backend termination reconnects and preserves HTTP readiness",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async () => {
    const pool = database(process.env.TEST_DATABASE_URL) as pg.Pool;
    const control = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const server = app(new Reservations(pool as Database), {
      DEMO_MODE: "true",
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const before = (await pool.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const disconnected = new Promise<void>((resolve) =>
        pool.once("error", () => resolve()),
      );
      assert.equal(
        (
          await control.query("SELECT pg_terminate_backend($1) AS killed", [
            before,
          ])
        ).rows[0].killed,
        true,
      );
      await disconnected;
      const health = await fetch(base + "/health");
      assert.equal(health.status, 200);
      const after = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      assert.notEqual(after, before);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await Promise.all([pool.end(), control.end()]);
    }
  },
);

for (const failureAt of ["BEGIN", "WORK", "COMMIT"]) {
  test(`failed rollback discards connection and preserves original ${failureAt} error`, async () => {
    const original = new Error(`original ${failureAt} timeout`),
      rollbackFailure = new Error("rollback timeout");
    const statements: string[] = [],
      released: unknown[] = [];
    const connection = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql === failureAt) throw original;
        if (sql === "ROLLBACK") throw rollbackFailure;
        return { rows: [] };
      },
      release: (discard?: Error | boolean) => {
        released.push(discard);
      },
    };
    const db: Database = {
      connect: async () => connection,
      query: async () => ({ rows: [] }),
      end: async () => {},
    };
    await assert.rejects(
      () => tx(db, (c) => c.query("WORK")),
      (error) => error === original,
    );
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.deepEqual(released, [true]);
  });
}

test("successful rollback safely releases once and preserves original failure", async () => {
  const original = new Error("application failure"),
    released: unknown[] = [];
  const connection = {
    query: async () => ({ rows: [] }),
    release: (discard?: Error | boolean) => {
      released.push(discard);
    },
  };
  const db: Database = {
    connect: async () => connection,
    query: async () => ({ rows: [] }),
    end: async () => {},
  };
  await assert.rejects(
    () =>
      tx(db, async () => {
        throw original;
      }),
    (error) => error === original,
  );
  assert.deepEqual(released, [undefined]);
});

test(
  "real PostgreSQL timed-out rollback cannot leak prior writes into the next transaction",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async () => {
    const pool = database(process.env.TEST_DATABASE_URL) as pg.Pool;
    // Use the production pool/helper, shortening only timeouts to reproduce the
    // driver's queued-ROLLBACK timeout deterministically without a five-second wait.
    pool.options.max = 1;
    pool.options.query_timeout = 100;
    const control = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const table = `test_timeout_markers_${randomBytes(8).toString("hex")}`;
    let firstPid: number | undefined,
      inserted = false;
    try {
      await control.query(`CREATE TABLE ${table} (marker text NOT NULL)`);
      await assert.rejects(
        () =>
          tx(pool as Database, async (c) => {
            firstPid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0]
              .pid;
            await c.query(`INSERT INTO ${table} VALUES ('failed')`);
            inserted = true;
            await c.query("SELECT pg_sleep(0.6)");
          }),
        /timeout/i,
      );
      assert.equal(inserted, true);
      assert.equal(typeof firstPid, "number");
      assert.equal(pool.idleCount, 0);
      // Let the old backend's slow statement finish before attempting another tx.
      // Without discard, that tx would reuse the still-open transaction and commit
      // its earlier 'failed' write together with the new 'healthy' write.
      await control.query("SELECT pg_sleep(0.8)");
      const secondPid = await tx(pool as Database, async (c) => {
        const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        await c.query(`INSERT INTO ${table} VALUES ('healthy')`);
        return pid;
      });
      assert.notEqual(secondPid, firstPid);
      assert.deepEqual(
        (await control.query(`SELECT marker FROM ${table} ORDER BY marker`))
          .rows,
        [{ marker: "healthy" }],
      );
    } finally {
      await pool.end();
      await control.query(`DROP TABLE IF EXISTS ${table}`);
      await control.end();
    }
  },
);
