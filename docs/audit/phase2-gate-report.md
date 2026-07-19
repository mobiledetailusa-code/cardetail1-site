# GATE 2 — Transactional Foundation

**Date:** 2026-07-18
**Branch:** `fix/final-production-readiness` (HEAD at time of writing: `d4ad054` + this uncommitted work)
**Scope:** Additive only. No existing Netlify function, endpoint, or UI component was modified. Nothing here is wired into live traffic; the Blob aggregate (`cd1-bookings`) remains sole authority for Release A, per `docs/audit/phase1-delta-audit-2026-07-18.md`.

## 1. Schema

Added to `prisma/schema.prisma` (existing `PrismaHealth`/`BookingRecord` untouched): `Customer`, `Booking`, `Vehicle`, `Quote`, `QuoteItem`, `ChangeRequest`, `PaymentAttempt`, `LedgerEntry`, `StripeEvent`, `AuditEvent`, plus 8 enums for state fields (`BookingLifecycleStatus`, `QuoteStatus`, `ChangeRequestKind`, `ChangeRequestStatus`, `ProviderObjectType`, `PaymentAttemptStatus`, `LedgerEntryKind`, `StripeEventStatus`).

Constraints implemented, mapped to the brief's required list:

| Required | Implementation |
|---|---|
| Unique booking ID | `Booking.id` is the primary key |
| Unique bookingId + quoteVersion | `Quote` `@@unique([bookingId, quoteVersion])` |
| Unique **active** obligation per bookingId + quoteVersion | Partial unique index (raw SQL, not expressible in `schema.prisma`): `CREATE UNIQUE INDEX "PaymentAttempt_one_active_obligation" ON "PaymentAttempt" ("bookingId","quoteVersion") WHERE status IN ('creating','open','requires_action')` |
| Unique Stripe PaymentIntent ID | `PaymentAttempt.providerObjectId @unique` (also covers Checkout Session / SetupIntent IDs, disambiguated by `providerObjectType`) |
| Unique Stripe event ID | `StripeEvent.stripeEventId @unique` |
| Valid foreign keys | All child tables FK to `Booking`/`Quote`/`Vehicle`/`PaymentAttempt` as appropriate; `ON DELETE RESTRICT` on the financial chain (Vehicle/Quote/ChangeRequest/PaymentAttempt/LedgerEntry → Booking) so a booking with financial history cannot be deleted out from under it |
| Integer-cent money | Every money field is `Int` (`approvedCents`, `amountCents`, etc.) — no float/decimal money field exists in the new schema |
| Legal enum/state checks | Native Postgres `ENUM` types (not free-text) for every status/kind field |
| Ledger immutability (implied by "settled quote versions are immutable") | Not in the brief's explicit constraint list, but required by rule 15/16 — implemented as a Postgres `BEFORE UPDATE/DELETE` trigger on `LedgerEntry` that raises an exception unconditionally |

**Known limitation:** the partial unique index and the immutability trigger are hand-added to `migration.sql` and are **not** representable in `schema.prisma` itself (Prisma's schema DSL has no partial-index or trigger syntax). A future `prisma migrate dev` will not see them in the declarative schema and could report drift, or a careless `prisma migrate reset` / `db push` could silently drop them. This is called out in-line in both the schema comment and the migration file; anyone touching this schema later needs to know these two objects are migration-only.

## 2. Migration

`prisma/migrations/20260718181514_phase2_transactional_foundation/migration.sql` — applied successfully via `prisma migrate dev` against the database configured by `DIRECT_URL` (the same dev/preview Postgres this repo's `.env` already pointed at for the existing `BookingRecord` mirror; no new credentials were introduced, and no Production database was touched — this environment has no Production credentials configured at all, so a Production migration was not possible even accidentally). `prisma generate` regenerated the client afterward with no errors. `prisma validate` passes.

## 3. Changed / added files

| File | Type |
|---|---|
| `prisma/schema.prisma` | modified (additive) |
| `prisma/migrations/20260718181514_phase2_transactional_foundation/migration.sql` | new |
| `netlify/lib/db/repositories.js` | new — thin Prisma CRUD + `casUpdateBooking` (optimistic concurrency) + `createBookingWithInitialQuote` (transactional) |
| `netlify/lib/db/foundation-services.js` | new — `reservePaymentObligation`, `recordStripeEvent`, `appendLedgerEntry`, `sumLedgerForQuote`, uniqueness-violation → idempotent-response translation |
| `scripts/db-import-dry-run.mjs` | new — read-only Blob scan + comparison report, no writes anywhere |
| `tests/db-transactional-foundation.test.js` | new — 9 tests against the real configured database |
| `docs/audit/payment-platform-baseline.md`, `docs/audit/phase1-delta-audit-2026-07-18.md` | Phase 0/1 documentation (already reviewed with you) |

No file under `netlify/functions/`, no `.html` file, and no existing `netlify/lib/*.js` file was modified. `netlify/lib/db/` is a new, isolated directory.

## 4. Test results

**New Phase 2 suite** (`tests/db-transactional-foundation.test.js`, run directly against the configured Postgres — not mocked): **9/9 pass.**

- Referential integrity (FK rejection on nonexistent booking)
- Transaction rollback (duplicate init fails atomically, no partial rows)
- Concurrent quote update / stale version (CAS rejects a write against a stale `bookingVersion`)
- Duplicate PaymentIntent reservation (two concurrent reservations for the same bookingId+quoteVersion collapse to one row) — 2 variants (different provider IDs; identical idempotency-key replay)
- Duplicate webhook event (same `stripeEventId` recorded once)
- Ledger immutability (UPDATE and DELETE both rejected by the DB trigger; row content verified unchanged afterward)
- Ledger dedup (re-delivered `providerEventId` does not double-credit)
- Partial failure (a ledger insert staged inside a transaction that fails elsewhere does not persist)

**Full existing suite** (`node --test tests/*.test.js`): **1243 tests, 1240 pass, 3 fail** (same 3 pre-existing failures recorded in Phase 0/1 — two stale hygiene-guard assertions and one text-scan assertion, unrelated to this work; see `docs/audit/payment-platform-baseline.md` §3). No regression introduced.

One of those pre-existing failures (`pre-commit-stabilization.test.js`'s "Netlify Function changes vs production master are limited to approved RevOps additions" allowlist guard) will also need its allowlist extended to cover `netlify/lib/db/*` and `scripts/db-import-dry-run.mjs` once this work is intentionally accepted — it currently fails on the first unapproved file it finds (`booking-prisma-mirror.js`, pre-existing) so it hasn't yet even reached these new files in its output, but it will need updating regardless.

## 5. Migration/dry-run importer result

`scripts/db-import-dry-run.mjs` was written, statically/dynamically safety-audited (see `docs/audit/containment-evidence-2026-07-18.md` §4), and **run for real** on 2026-07-18 once the owner supplied Netlify Blobs credentials: **119 real bookings scanned from `cd1-bookings`, all 119 would import cleanly** — 0 quote-version mismatches, 0 ledger-vs-legacy-field mismatches, 0 records with multiple open payment attempts, 0 negative-remaining-balance records, 8 payment attempts seen across those bookings. No Blob or Postgres write occurred (read-only by design, confirmed by the runtime guard). This item is closed.

## 6. Residual risks / open items

1. ~~Dry-run importer unproven against real data~~ — **RESOLVED 2026-07-18** (§5): run for real, 119/119 bookings clean.
2. **Partial index / trigger not in `schema.prisma`** (§1) — anyone running `prisma migrate dev` to add a future model must not let it "fix" perceived drift by dropping these; documented in both files but still a process risk.
3. **Test-data residue in the configured database**: 3 test runs during this session (one from an early, since-fixed test bug) left a small number of `TESTDB-`-prefixed rows that cannot be deleted because they have `LedgerEntry` children (working as designed — that's what proves immutability). Confirmed via direct query: 6 `LedgerEntry` rows / a handful of `Booking`/`Quote` rows under the `TESTDB-` prefix remain in the configured database. They're harmless (clearly prefixed, tiny, and this is a dev/preview instance) but you may want a periodic sweep script if this test suite runs often in CI.
4. **No relational data exists yet for real bookings.** These tables are empty of production-shaped data; nothing has been imported. The Blob aggregate is still the only place real booking/payment state lives.
5. **This foundation is not wired to anything.** `netlify/lib/db/*` is dead code from the running system's point of view until Phase 3 explicitly builds the authoritative `PaymentService` on top of it and something calls it. That is by design per the brief's Phase 2 scope ("without changing the customer payment UX yet"), not an oversight.
6. Per rule 9, this Gate 2 report is not a claim of production reliability — it is what was verified: schema/migration apply cleanly, the 9 targeted invariant tests pass against a real database, and the existing suite has no new regressions.

## 7. Not done in Phase 2 (explicitly out of scope per the brief, deferred to Phase 3+)

- No cutover strategy execution (snapshot/dry-run/comparison/maintenance-window/switch-authority/rollback) — Phase 2 only asked for "an explicit cutover strategy" to be *provided*, which is intentionally deferred to when Phase 3 makes Postgres authoritative for anything real; writing it now, before the importer has been run against real data, would be speculative.
- No `BookingService`/`QuoteService`/`ChangeRequestService` orchestration layer beyond the minimal repository + foundation-service functions needed to prove the required invariants — the brief's Phase 3 explicitly owns "one authoritative PaymentService," and building a second, competing service layer now would create exactly the kind of parallel-implementation risk rule 8/14 warn about.
