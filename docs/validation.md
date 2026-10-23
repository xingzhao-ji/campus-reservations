# Validation record — 2026-10-23

Environment: Node 24.19.0, npm 11.9.0, restricted development container. Native PostgreSQL was initially unavailable. `apt-get update` failed setuid/setgroups restrictions; `apt-get -o APT::Sandbox::User=root update` succeeded, but installation failed archive-directory permissions and fetch errors. No local native PostgreSQL result is claimed here.

- `npm run build`: TypeScript backend and frontend checking, Vite production bundle.
- `npm test`: uses explicitly labeled serialized PGlite unless TEST_DATABASE_URL is supplied.
- CI configuration requires a real PostgreSQL 16 service and TEST_DATABASE_URL; it must be observed separately after publishing.
- Docker Compose configuration supplied; Docker runtime is unavailable locally, so no local container-run claim.

The embedded test suite exercises the same SQL but serializes complete transactions. It does not validate multi-session database locking, SQL deadlocks, or production throughput. A database connection reopen validates persisted state; it is not an OS crash or power-failure experiment. Outbox crash recovery is modeled by abandoning and expiring a claim, then reclaiming it with a new lease token.

Baseline local result at `d69ef476`: `npm run build` passed backend/frontend TypeScript checks and Vite bundle. `npm test` passed **14/14** tests, **0 skipped**, in approximately 3.4 seconds in serialized embedded mode. HTTP tests bind an ephemeral loopback port and exercise the real Express application. Browser visual verification and native PostgreSQL/CI execution were not performed by this implementer.

Root browser QA identified secure-context-only `crypto.randomUUID` as incompatible with HTTP preview origins. The client now uses `crypto.getRandomValues` to format UUIDv4 keys when randomUUID is absent. Three explicit tests cover native selection, fallback formatting, and 1,000 distinct cryptographic fallback keys. Final full build and 14-test suite passed after this fix.

## Independent review follow-up

Root observed the original 14-test baseline pass against real PostgreSQL 16 in [GitHub Actions run 39996251958](https://github.com/xingzhao-ji/campus-reservations/actions/runs/39996251958), job 120560425288, remote commit `873ae119` corresponding to local `d69ef476`. Dependency install, build and tests all passed there. This is baseline evidence; the follow-up head requires a new CI run.

The independent review reproduced post-start waitlist promotion/confirmation and an unhandled idle PostgreSQL pool error. Both were first captured by failing regression tests. Booking is now closed by database-clock predicates at session start; initial/promoted hold deadlines are capped there; closure expires outstanding holds/waitlists without new offers; confirmed history/cancellation remains available. UI closed state and server-result-derived notices are covered. The admin expiry endpoint now rejects unexpected fields.

Idle pool errors are handled without driver/client details, failed idle clients are replaced on demand, and health probes return 503 during database failure and 200 after recovery. Connection acquisition/query timeouts bound outage waits. Compose adds application/database restart policies. A regression exercises the installed pg-pool's actual idle handler with a synthetic client and verifies removal, replacement and credential-free logs. A separate live PostgreSQL backend-termination test is explicitly skipped locally and must run in real PostgreSQL CI.

Follow-up local result: `npm run build` passed backend/frontend TypeScript checks and Vite production build. `npm test` reported **22 tests: 21 passed, 0 failed, 1 explicitly skipped** in approximately 3.8 seconds. The sole skip is the live PostgreSQL backend-termination test because TEST_DATABASE_URL is absent locally. All booking-boundary, restart catch-up, hold-deadline, pg-pool idle-handler, readiness-recovery, UI-boundary and existing integration regressions passed. `git diff --check` passed. Native CI on the follow-up commit remains to be observed by root.
