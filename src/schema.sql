CREATE TABLE IF NOT EXISTS slots (
 id uuid PRIMARY KEY, title text NOT NULL, location text NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
 CHECK (ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS reservations (
 id uuid PRIMARY KEY, slot_id uuid NOT NULL REFERENCES slots(id), principal text NOT NULL,
 state text NOT NULL CHECK (state IN ('held','confirmed','waitlisted','expired','cancelled')),
 expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 queue_order bigserial NOT NULL,
 CHECK ((state = 'held') = (expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_reservation ON reservations(slot_id,principal)
 WHERE state IN ('held','confirmed','waitlisted');
CREATE INDEX IF NOT EXISTS reservation_slot_state ON reservations(slot_id,state,queue_order);
CREATE TABLE IF NOT EXISTS idempotency (
 principal text NOT NULL, key text NOT NULL, payload text NOT NULL,
 status integer NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(principal,key)
);
CREATE TABLE IF NOT EXISTS outbox (
 id bigserial PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 delivered_at timestamptz
);
