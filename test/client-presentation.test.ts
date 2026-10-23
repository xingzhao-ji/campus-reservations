import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingClosed, reservationNotice } from "../web/presentation.js";
test("booking UI closes exactly at start, honors database closure and excludes past slots", () => {
  const slot = { booking_open: true, starts_at: "2026-10-23T12:00:00Z" },
    start = Date.parse(slot.starts_at);
  assert.equal(bookingClosed(slot, start - 1), false);
  assert.equal(bookingClosed(slot, start), true);
  assert.equal(bookingClosed(slot, start + 1), true);
  assert.equal(
    bookingClosed({ ...slot, booking_open: false }, start - 1000),
    true,
  );
});
test("reservation notices describe server result when observed occupancy is stale", () => {
  assert.match(reservationNotice({ state: "held" }), /held until/);
  assert.match(reservationNotice({ state: "waitlisted" }), /on the waitlist/);
});
