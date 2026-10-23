# Implementation plan

Build a single-organization reservation service with one seat per member per session. PostgreSQL serializes all capacity changes under the session row lock. Request keys are principal-scoped and commit with responses and events. Expiry frees seats and promotes FIFO waitlist entries into timed holds. A separate leased outbox offers at-least-once delivery with fenced acknowledgements. Demo identities are explicit synthetic data; production requires configured bearer credentials and rejects demo mode.

Ship a responsive React member/admin console, Docker Compose, native setup instructions, real-Postgres CI and failure-mode integration tests. No payment, organization onboarding, email transport, or external identity provider is in scope.
