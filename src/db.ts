import pg from "pg";
export type QueryResult = { rows: any[]; rowCount?: number | null };
export interface Connection {
  query(sql: string, params?: any[]): Promise<QueryResult>;
  release(discard?: Error | boolean): void;
}
export interface Database {
  connect(): Promise<Connection>;
  query(sql: string, params?: any[]): Promise<QueryResult>;
  end(): Promise<void>;
}
export function database(url = process.env.DATABASE_URL): Database {
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString: url,
    max: 30,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  // pg-pool removes failed idle clients before emitting this event. Keep the
  // process alive so its next query can obtain a replacement connection.
  // Never log the error/client: driver messages can contain connection secrets.
  pool.on("error", () => {
    console.error("Database idle connection lost; will reconnect on demand");
  });
  return pool as Database;
}
export async function tx<T>(
  db: Database,
  fn: (c: Connection) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  let discard = false;
  try {
    await c.query("BEGIN");
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // A timed-out ROLLBACK may never reach PostgreSQL. Its transaction may
      // still be open; destroy this client rather than let another request
      // reuse it and accidentally commit the failed transaction's writes.
      discard = true;
    }
    throw e;
  } finally {
    c.release(discard ? true : undefined);
  }
}
