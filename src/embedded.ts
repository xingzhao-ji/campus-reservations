import { PGlite } from "@electric-sql/pglite";
import { type Database, type QueryResult } from "./db.js";
// LOCAL DEMO / TEST ONLY. PGlite has one session; serialize whole transactions.
// It exercises SQL, but cannot prove PostgreSQL multi-session concurrency behavior.
export function embeddedDatabase(path: string): Database {
  const pg = new PGlite(path);
  let tail = Promise.resolve();
  async function lock() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const previous = tail;
    tail = previous.then(() => gate);
    await previous;
    return release;
  }
  async function query(sql: string, params?: any[]): Promise<QueryResult> {
    if (!params && sql.includes("CREATE TABLE")) {
      await pg.exec(sql);
      return { rows: [] };
    }
    const r = await pg.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows };
  }
  return {
    async connect() {
      const unlock = await lock();
      return { query, release: unlock };
    },
    async query(sql, params) {
      const unlock = await lock();
      try {
        return await query(sql, params);
      } finally {
        unlock();
      }
    },
    async end() {
      await tail;
      await pg.close();
    },
  };
}
