import { resolve } from "node:path";
import { embeddedDatabase } from "./embedded.js";
import { Reservations } from "./service.js";
import { migrate } from "./migrate.js";
import { app } from "./app.js";
if (process.env.NODE_ENV === "production")
  throw new Error("Embedded synthetic demo is forbidden in production");
const db = embeddedDatabase(resolve(".demo-db"));
await migrate(db, true);
const service = new Reservations(db);
let sweeping = false;
const timer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await service.sweep();
  } catch {
    console.error("Embedded demo sweep failed");
  } finally {
    sweeping = false;
  }
}, 1000);
const server = app(service, {
  ...process.env,
  DEMO_MODE: "true",
  EMBEDDED_DEMO: "true",
}).listen(Number(process.env.PORT ?? 3101), "0.0.0.0", () =>
  console.log(
    `Serialized embedded LOCAL DEMO on ${process.env.PORT ?? 3101}; synthetic identities, not multi-session PostgreSQL`,
  ),
);
function stop() {
  clearInterval(timer);
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
