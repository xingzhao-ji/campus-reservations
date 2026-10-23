# Commonspace · Campus Reservations

A working reservation system for a single campus: browse sessions, hold one place, confirm it, cancel it, or join a FIFO waitlist. React and TypeScript sit above an Express API and PostgreSQL. This is a **v0.1.0 portfolio MVP**, with synthetic demo identities and explicit production credential configuration.

The interesting part is the failure behavior: 100 contenders compete for five places; retried requests produce one reservation and one event; an abandoned outbox lease can be reclaimed without accepting an old worker's acknowledgement.

## Run with PostgreSQL

Requires Docker Compose:

```sh
docker compose up --build
```

Open **http://localhost:3101**. Choose Alex, Sam, or Admin in the identity selector. Reserve the one-place photography session with Alex, switch to Sam and join its waitlist, then cancel as Alex. Sam receives a two-minute hold and can confirm it. Admin can create sessions and inspect delivery activity. The worker prints event IDs/types and acknowledges them; it does not send email.

Compose binds both ports to loopback. Its password and identities are **local demo fixtures**. Persisted data lives in the `campus_data` volume; `docker compose down` retains it. Sessions are seeded only when the database has no slots, so use the Admin form to add future sessions after the original demo dates pass.

## Run locally

Node 24 and PostgreSQL 16+:

```sh
npm ci
export DATABASE_URL=postgres://campus:local_demo_only@localhost:5432/campus
export DEMO_MODE=true
npm run build
npm run dev
# In a second shell with DATABASE_URL set:
npm run worker
```

`npm start` runs compiled code. The API serves the built React app on the same origin. Set `PORT=4173` when using a preview supervisor on that port. No separate Vite process is required. For frontend hot reload, run `npx vite --host 0.0.0.0` alongside the API on its default port 3101.

If native PostgreSQL cannot run in a restricted development environment:

```sh
npm ci
npm run build
PORT=4173 npm run demo:embedded
```

This **explicit local-only fallback** uses PGlite's PostgreSQL/WASM engine, persists under `.demo-db`, and serializes entire transactions because PGlite has one session. The banner identifies it as an embedded demo. It exercises the real SQL and HTTP paths, but it does **not** demonstrate PostgreSQL multi-session locking or contention. The normal server never selects this fallback automatically. Embedded mode refuses `NODE_ENV=production`.

## Tests

Use a dedicated, disposable test database: the suite truncates its application tables.

```sh
TEST_DATABASE_URL=postgres://campus:local_demo_only@localhost:5432/campus_test npm test
```

The GitHub Actions workflow runs against a real PostgreSQL 16 service. If `CI` is set without `TEST_DATABASE_URL`, tests fail rather than fall back. Local `npm test` without that variable explicitly runs serialized PGlite SQL tests. The output prints the engine mode. Passing embedded tests is not a concurrency claim.

Coverage includes:

- 100 simultaneous callers: exactly 5 holds and 95 waitlist entries; real concurrent database sessions when configured with PostgreSQL.
- 30 concurrent same-key retries, principal-scoped keys, payload mismatch rejection and concurrent distinct-key duplicate bookings.
- FIFO promotion after cancellation, hold expiry, expiry/confirm conflict and repeated sweeps.
- Injected pre-commit failure rolling back reservation, response record and outbox together.
- Closing/reopening database connections and replaying the committed response. This is connection restart/persistence testing, not a power-loss test.
- Abandoned leases, redelivery, stale acknowledgement fencing, and disjoint parallel worker claims.
- HTTP auth, member/admin boundaries, cross-member privacy, payload bounds and the complete hold/confirm flow.
- Booking closure at start, restart catch-up without late offers, capped hold deadlines, and closed-session UI decisions.
- Real pg-pool idle-client removal/replacement and credential-free logging; readiness outage/recovery. A live `pg_terminate_backend` reconnection test runs only with TEST_DATABASE_URL and is explicitly skipped in embedded mode.

## Transaction model

Every capacity transition locks the slot with `SELECT ... FOR UPDATE`. Expiration runs under that same lock, then promotes the oldest waitlist entries into fresh holds while booking remains open. `held + confirmed <= capacity` holds across all service mutations. A partial unique index allows only one active reservation per principal per slot. Capacity is immutable after slot creation. Booking closes at `starts_at` according to the database clock: no new holds/waitlists, offers or confirmations are allowed at or after that boundary. Holds are capped at the session start; closure expires outstanding holds and waitlist entries, preserving confirmed history and its cancellation path. The UI marks started sessions closed.

Mutations require `Idempotency-Key` (8–128 safe characters). A transaction-level advisory lock serializes `(principal, key)`, checks the stored request payload, then commits the result, reservation changes and outbox events together. Reusing a key with a different request returns 409. Business errors are stored as stable responses; retry with a new key for a new attempt. Keys are retained indefinitely in this MVP. A replay returns the original response, even if the reservation has since changed; the UI refreshes current state separately.

Expiry sweeps run every second in the server. With the server stopped, expiry waits until restart or the next mutation of that slot. Reads can briefly show a hold that has reached its deadline; confirmation always rechecks under the slot lock. Queue offers are visible in the app; there are no external notifications.

The PostgreSQL pool handles idle connection failures with a generic message and opens replacement connections on demand. Connection acquisition is bounded to two seconds and queries to five seconds. `/health` returns 503 while its database probe fails and returns 200 on recovery; it never includes driver errors or credentials. Compose restarts the database and application unless explicitly stopped. An active failed mutation can be retried with the same idempotency key.

Outbox delivery is **at least once**. Workers claim rows using `FOR UPDATE SKIP LOCKED`, attach a random lease token, and increment attempts. ACK requires the current unexpired token. If a worker crashes after its side effect and before ACK, the event is delivered again. Real consumers must deduplicate by event ID in their own durable side-effect transaction. The example worker only prints event metadata. There is no exactly-once delivery claim, ordering guarantee across workers, retry backoff or dead-letter queue.

## API

| Method | Path                            | Permission                                                             |
| ------ | ------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/config`                   | Public; mode and hold duration                                         |
| GET    | `/api/me`, `/api/slots`         | Authenticated; only caller's own reservation detail                    |
| POST   | `/api/slots/:id/holds`          | Member/admin; `{}` and idempotency key                                 |
| POST   | `/api/reservations/:id/confirm` | Owner/admin; `{}` and idempotency key                                  |
| POST   | `/api/reservations/:id/cancel`  | Owner/admin; `{}` and idempotency key                                  |
| POST   | `/api/slots`                    | Admin; title, location, startsAt, endsAt, capacity and idempotency key |
| POST   | `/api/admin/expire`             | Admin                                                                  |
| GET    | `/api/admin/outbox`             | Admin; latest 100 event summaries                                      |
| POST   | `/api/admin/outbox/claim`       | Admin; optional limit (1–100), leaseSeconds (1–300)                    |
| POST   | `/api/admin/outbox/:id/ack`     | Admin; leaseToken                                                      |
| GET    | `/health`                       | Database readiness                                                     |

Unknown request fields are rejected. JSON is bounded to 16 KiB. Reservation ownership comes from authentication, never a request-body principal. Demo requests require `X-Demo-Principal: alex`, `sam`, or `admin`; there is no default identity.

## Production configuration and limits

`DEMO_MODE=true` is forbidden with `NODE_ENV=production`. Without explicit demo mode, the service requires `AUTH_TOKENS_JSON`, mapping high-entropy bearer credentials of at least 32 characters to principals:

```json
{
  "<random-secret-from-your-secret-manager>": {
    "id": "member-123",
    "role": "member"
  }
}
```

Set `NODE_ENV=production`, configure `DATABASE_URL`, inject real random secrets through your deployment's secret manager, and serve behind HTTPS. Demo identity headers are ignored in this mode. Tokens are compared through SHA-256 digests with timing-safe equality; the UI keeps an entered token in memory only. This is a bounded preconfigured-credential model, not an identity-provider integration. Token rotation currently requires restarting the service. Protect the database from direct untrusted writes; invariants assume mutations pass through this service.

Before exposing a real campus deployment, add institutional SSO, audit retention policy, rate limiting, backup/restore procedures, operational metrics, and consumer-specific delivery handling. This MVP has one organization, one place per reservation, fixed-capacity sessions, no recurring schedule, no payments, no time-zone preference and no institutional calendar integration.

## Source map

- `src/service.ts`: transactions, capacity transitions, idempotency and leased outbox.
- `src/schema.sql`: tables, state checks and unique active booking index.
- `src/app.ts`, `src/auth.ts`: HTTP validation and authentication/authorization.
- `src/server.ts`, `src/migrate.ts`, `src/worker.ts`: runtime, seed/migration and sample consumer.
- `web/`: responsive live member/admin UI.
- `test/`: SQL, persistence and HTTP integration tests.
- `src/embedded.ts`, `src/demo.ts`: explicit local embedded fallback, separate from the PostgreSQL server.

Local validation and known limitations are recorded in `docs/validation.md`.
