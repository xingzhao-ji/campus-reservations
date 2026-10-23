import { randomUUID } from "node:crypto";
import { type Database, type Connection, tx } from "./db.js";
export type Principal = { id: string; role: "admin" | "member" };
export type Result = { status: number; body: any };
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Reservations {
  constructor(
    public db: Database,
    public holdSeconds = 120,
  ) {}
  async event(c: Connection, type: string, payload: unknown) {
    await c.query("INSERT INTO outbox(type,payload) VALUES ($1,$2)", [
      type,
      JSON.stringify(payload),
    ]);
  }
  async expireAndPromote(c: Connection, slotId: string, capacity: number) {
    const expired = await c.query(
      `UPDATE reservations r SET state='expired',expires_at=NULL FROM slots s WHERE r.slot_id=$1 AND s.id=r.slot_id AND ((r.state='held' AND r.expires_at<=clock_timestamp()) OR (r.state IN ('held','waitlisted') AND s.starts_at<=clock_timestamp())) RETURNING r.id,r.principal`,
      [slotId],
    );
    for (const r of expired.rows)
      await this.event(c, "reservation.expired", { ...r, slotId });
    if (!(await this.bookingOpen(c, slotId))) return;
    const used = await c.query(
      `SELECT count(*)::int AS n FROM reservations WHERE slot_id=$1 AND state IN ('held','confirmed')`,
      [slotId],
    );
    const free = capacity - used.rows[0].n;
    if (free <= 0) return;
    const waiting = await c.query(
      `SELECT id,principal FROM reservations WHERE slot_id=$1 AND state='waitlisted' ORDER BY queue_order LIMIT $2`,
      [slotId, free],
    );
    for (const r of waiting.rows) {
      const promoted = await c.query(
        `UPDATE reservations r SET state='held',expires_at=LEAST(s.starts_at,clock_timestamp()+($2*interval '1 second')) FROM slots s WHERE r.id=$1 AND s.id=r.slot_id AND s.starts_at>clock_timestamp() RETURNING r.id`,
        [r.id, this.holdSeconds],
      );
      if (promoted.rows.length)
        await this.event(c, "reservation.promoted", { ...r, slotId });
    }
  }
  async bookingOpen(c: Connection, id: string): Promise<boolean> {
    return (
      (
        await c.query(
          "SELECT starts_at>clock_timestamp() AS open FROM slots WHERE id=$1",
          [id],
        )
      ).rows[0]?.open === true
    );
  }
  async lockSlot(c: Connection, id: string) {
    const { rows } = await c.query(
      "SELECT * FROM slots WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!rows[0]) throw new Problem(404, "Session not found");
    await this.expireAndPromote(c, id, rows[0].capacity);
    return rows[0];
  }
  async command(
    p: Principal,
    key: string,
    payload: string,
    run: (c: Connection) => Promise<Result>,
  ): Promise<Result> {
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key))
      throw new Problem(400, "Idempotency-Key must be 8–128 safe characters");
    return tx(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([p.id, key]),
      ]);
      const prior = (
        await c.query(
          "SELECT * FROM idempotency WHERE principal=$1 AND key=$2",
          [p.id, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload !== payload)
          throw new Problem(
            409,
            "Idempotency key was used with a different request",
          );
        return { status: prior.status, body: prior.response };
      }
      // Business failures roll back their side effects before persisting a stable response.
      await c.query("SAVEPOINT action");
      let result: Result;
      try {
        result = await run(c);
      } catch (e) {
        if (!(e instanceof Problem)) throw e;
        await c.query("ROLLBACK TO SAVEPOINT action");
        result = { status: e.status, body: { error: e.message } };
      }
      result = {
        status: result.status,
        body: JSON.parse(JSON.stringify(result.body)),
      };
      await c.query(
        "INSERT INTO idempotency(principal,key,payload,status,response) VALUES($1,$2,$3,$4,$5)",
        [p.id, key, payload, result.status, JSON.stringify(result.body)],
      );
      return result;
    });
  }
  async hold(c: Connection, p: Principal, slotId: string): Promise<Result> {
    const slot = await this.lockSlot(c, slotId);
    if (!(await this.bookingOpen(c, slotId)))
      throw new Problem(409, "This session has started");
    const active = (
      await c.query(
        `SELECT * FROM reservations WHERE slot_id=$1 AND principal=$2 AND state IN ('held','confirmed','waitlisted')`,
        [slotId, p.id],
      )
    ).rows[0];
    if (active)
      throw new Problem(409, "You already have an active reservation");
    const n = (
      await c.query(
        `SELECT count(*)::int AS n FROM reservations WHERE slot_id=$1 AND state IN ('held','confirmed')`,
        [slotId],
      )
    ).rows[0].n;
    const state = n < slot.capacity ? "held" : "waitlisted";
    const r = (
      await c.query(
        `INSERT INTO reservations(id,slot_id,principal,state,expires_at) SELECT $1,$2,$3,$4,CASE WHEN $4='held' THEN LEAST(s.starts_at,clock_timestamp()+($5*interval '1 second')) END FROM slots s WHERE s.id=$2 AND s.starts_at>clock_timestamp() RETURNING *`,
        [randomUUID(), slotId, p.id, state, this.holdSeconds],
      )
    ).rows[0];
    if (!r) throw new Problem(409, "This session has started");
    await this.event(c, `reservation.${state}`, {
      id: r.id,
      slotId,
      principal: p.id,
    });
    return { status: 201, body: r };
  }
  async transition(
    c: Connection,
    p: Principal,
    id: string,
    action: "confirm" | "cancel",
  ): Promise<Result> {
    const initial = (
      await c.query("SELECT slot_id,principal FROM reservations WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (!initial || (initial.principal !== p.id && p.role !== "admin"))
      throw new Problem(404, "Reservation not found");
    const slot = await this.lockSlot(c, initial.slot_id);
    const r = (await c.query("SELECT * FROM reservations WHERE id=$1", [id]))
      .rows[0];
    if (action === "confirm" && !(await this.bookingOpen(c, slot.id)))
      throw new Problem(409, "This session has started");
    if (action === "confirm" && r.state !== "held")
      throw new Problem(409, "Only a live hold can be confirmed");
    if (
      action === "cancel" &&
      !["held", "confirmed", "waitlisted"].includes(r.state)
    )
      throw new Problem(409, "Reservation is no longer active");
    const state = action === "confirm" ? "confirmed" : "cancelled";
    const changed = (
      await c.query(
        `UPDATE reservations r SET state=$2,expires_at=NULL FROM slots s WHERE r.id=$1 AND s.id=r.slot_id AND ($2='cancelled' OR (s.starts_at>clock_timestamp() AND r.state='held' AND r.expires_at>clock_timestamp())) RETURNING r.*`,
        [id, state],
      )
    ).rows[0];
    if (!changed)
      throw new Problem(409, "The hold or booking window has expired");
    await this.event(c, `reservation.${state}`, {
      id,
      slotId: slot.id,
      principal: r.principal,
    });
    await this.expireAndPromote(c, slot.id, slot.capacity);
    return { status: 200, body: changed };
  }
  async sweep() {
    const slots = (
      await this.db.query(
        `SELECT DISTINCT r.slot_id FROM reservations r JOIN slots s ON s.id=r.slot_id WHERE (r.state='held' AND r.expires_at<=clock_timestamp()) OR (r.state IN ('held','waitlisted') AND s.starts_at<=clock_timestamp())`,
      )
    ).rows;
    for (const s of slots)
      await tx(this.db, (c) => this.lockSlot(c, s.slot_id));
    return slots.length;
  }
  async list(p: Principal) {
    return (
      await this.db.query(
        `SELECT s.*,s.starts_at>clock_timestamp() AS booking_open,count(r.id) FILTER(WHERE r.state IN ('held','confirmed'))::int AS occupied,count(r.id) FILTER(WHERE r.state='waitlisted')::int AS waiting, (SELECT row_to_json(m) FROM reservations m WHERE m.slot_id=s.id AND m.principal=$1 AND m.state IN ('held','confirmed','waitlisted') LIMIT 1) AS mine FROM slots s LEFT JOIN reservations r ON r.slot_id=s.id GROUP BY s.id ORDER BY s.starts_at`,
        [p.id],
      )
    ).rows;
  }
  async claim(limit = 10, leaseSeconds = 30) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 300
    )
      throw new Problem(400, "Invalid claim bounds");
    return tx(
      this.db,
      async (c) =>
        (
          await c.query(
            `WITH candidates AS (SELECT id FROM outbox WHERE delivered_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE outbox o SET lease_token=$2,lease_until=clock_timestamp()+($3*interval '1 second'),attempts=attempts+1 FROM candidates c WHERE o.id=c.id RETURNING o.*`,
            [limit, randomUUID(), leaseSeconds],
          )
        ).rows,
    );
  }
  async ack(id: string, token: string) {
    const r = await this.db.query(
      `UPDATE outbox SET delivered_at=clock_timestamp(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND delivered_at IS NULL AND lease_until>clock_timestamp() RETURNING id`,
      [id, token],
    );
    if (!r.rows.length)
      throw new Problem(
        409,
        "Lease expired, replaced, or already acknowledged",
      );
  }
}
