export function bookingClosed(
  slot: { booking_open: boolean; starts_at: string },
  now = Date.now(),
): boolean {
  return !slot.booking_open || Date.parse(slot.starts_at) <= now;
}
export function reservationNotice(result: { state: string }): string {
  return result.state === "held"
    ? "Your place is held until the countdown ends. Confirm to keep it."
    : "You’re on the waitlist. We’ll offer a hold here if a place opens before the session starts.";
}
