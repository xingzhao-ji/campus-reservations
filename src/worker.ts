// Example consumer: printing an event is the side effect. A crash before ACK repeats it.
// Real consumers MUST deduplicate by event.id within their own durable side-effect transaction.
import { database } from "./db.js";
import { Reservations } from "./service.js";
const db = database();
const service = new Reservations(db);
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});
process.on("SIGTERM", () => {
  stop = true;
});
try {
  while (!stop) {
    const events = await service.claim();
    for (const event of events) {
      console.log(
        JSON.stringify({
          eventId: event.id,
          type: event.type,
          attempt: event.attempts,
        }),
      );
      await service.ack(event.id, event.lease_token);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await db.end();
}
