import pg from "pg";
export type QueryResult = { rows: any[]; rowCount?: number | null };
export interface Connection {
  query(sql: string, params?: any[]): Promise<QueryResult>;
  release(): void;
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
  try {
    await c.query("BEGIN");
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
