import { database } from "./db.js";
import { app } from "./app.js";
import { Reservations } from "./service.js";
import { migrate } from "./migrate.js";
const db = database();
const service = new Reservations(db);
const application = app(service);
await migrate(db, process.env.DEMO_MODE === "true");
let sweeping = false;
const timer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await service.sweep();
  } catch {
    console.error("Expiry sweep failed; will retry");
  } finally {
    sweeping = false;
  }
}, 1000);
timer.unref();
const server = application.listen(
  Number(process.env.PORT ?? 3101),
  "0.0.0.0",
  () =>
    console.log(
      `Campus Reservations listening on ${process.env.PORT ?? 3101}; demo=${process.env.DEMO_MODE === "true"}`,
    ),
);
async function stop() {
  clearInterval(timer);
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
