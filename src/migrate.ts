import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { database, tx, type Database } from "./db.js";
import { pathToFileURL } from "node:url";
export async function migrate(db: Database, seed = false) {
  await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(941173)");
    await c.query(
      await readFile(new URL("../src/schema.sql", import.meta.url), "utf8"),
    );
    if (seed && !(await c.query("SELECT id FROM slots LIMIT 1")).rows.length) {
      const base = new Date();
      base.setUTCDate(base.getUTCDate() + 1);
      base.setUTCHours(14, 0, 0, 0);
      for (const [i, title, location, capacity] of [
        [0, "Ceramics open studio", "Arts Building · Studio 04", 6],
        [1, "Quiet focus room", "North Library · Level 02", 2],
        [2, "Photography darkroom", "Media Lab · Room 12", 1],
      ] as const) {
        const start = new Date(base.getTime() + i * 7200000),
          end = new Date(start.getTime() + 5400000);
        await c.query("INSERT INTO slots VALUES($1,$2,$3,$4,$5,$6)", [
          randomUUID(),
          title,
          location,
          start,
          end,
          capacity,
        ]);
      }
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const db = database();
  try {
    await migrate(db, process.env.DEMO_MODE === "true");
    console.log("Schema ready");
  } finally {
    await db.end();
  }
}
