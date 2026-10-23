# Validation record — 2026-10-23

Environment: Node 24.19.0, npm 11.9.0, restricted development container. Native PostgreSQL was initially unavailable. `apt-get update` failed setuid/setgroups restrictions; `apt-get -o APT::Sandbox::User=root update` succeeded, but installation failed archive-directory permissions and fetch errors. No native PostgreSQL result is claimed here.

- `npm run build`: TypeScript backend and frontend checking, Vite production bundle.
- `npm test`: uses explicitly labeled serialized PGlite unless TEST_DATABASE_URL is supplied.
- CI configuration requires a real PostgreSQL 16 service and TEST_DATABASE_URL; it must be observed separately after publishing.
- Docker Compose configuration supplied; Docker runtime is unavailable locally, so no local container-run claim.

The embedded test suite exercises the same SQL but serializes complete transactions. It does not validate multi-session database locking, SQL deadlocks, or production throughput. A database connection reopen validates persisted state; it is not an OS crash or power-failure experiment. Outbox crash recovery is modeled by abandoning and expiring a claim, then reclaiming it with a new lease token.

Final local result: `npm run build` passed backend/frontend TypeScript checks and Vite bundle. `npm test` passed **14/14** tests, **0 skipped**, in approximately 3.4 seconds in serialized embedded mode. HTTP tests bind an ephemeral loopback port and exercise the real Express application. Browser visual verification and native PostgreSQL/CI execution were not performed by this implementer.

Root browser QA identified secure-context-only `crypto.randomUUID` as incompatible with HTTP preview origins. The client now uses `crypto.getRandomValues` to format UUIDv4 keys when randomUUID is absent. Three explicit tests cover native selection, fallback formatting, and 1,000 distinct cryptographic fallback keys. Final full build and 14-test suite passed after this fix.
