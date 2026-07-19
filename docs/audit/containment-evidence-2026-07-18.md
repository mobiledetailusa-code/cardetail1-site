# Containment & Evidence Report — Phase 2 Verification

**Date:** 2026-07-18
**Trigger:** owner STOP instruction — halt before Phase 3, contain and verify Phase 0–2 work under a dedicated branch, produce evidence without further behavior changes.
**Scope discipline:** every change in this report is either (a) a new, isolated file, or (b) a test-only fix to a pre-existing false failure. **No file under `netlify/functions/`, no `.html` file, and no existing `netlify/lib/*.js` file was modified.** Checkout design and behavior are unchanged.

---

## 1. Containment status

| Item | Status |
|---|---|
| New branch `feat/postgres-payment-core` | Created from `d4ad054`, working tree preserved (uncommitted changes carried over, nothing lost) |
| `fix/final-production-readiness` | Unmodified. Still at `d4ad054`, identical to `origin/fix/final-production-readiness`. **No commit was ever made to it with the Postgres foundation work** — confirmed by `git status`/`git log` before branching showing only uncommitted working-tree changes, and the branch ref is unchanged after branching. |
| PR #118 / existing deploy preview | Untouched — nothing was pushed, nothing was deployed |
| Production | Not configured in this environment (no Production DB/Stripe credentials present); not touched |
| Netlify Blobs | Not written, updated, or deleted at any point this session (confirmed in §5 below) |
| Commit made this session | **None.** Everything below is in the working tree only, pending your review. |

## 2. Working-tree inventory

```
Branch:      feat/postgres-payment-core
HEAD SHA:    d4ad05470da1f905439b5aa144b909f6c2083f44
Parent SHA:  99fb0a48a225b1732e7ce01405365ddc9c69c5f3
```

`git status --short`:
```
 M prisma/schema.prisma
 M tests/booking-flow.test.js
 M tests/pre-commit-stabilization.test.js
 M tests/specialty-images-booking-garageplan.test.js
?? docs/audit/payment-platform-baseline.md
?? docs/audit/phase1-delta-audit-2026-07-18.md
?? docs/audit/phase2-gate-report.md
?? netlify/lib/db/
?? prisma/migrations/20260718181514_phase2_transactional_foundation/
?? scripts/db-import-dry-run.mjs
?? tests/db-transactional-foundation.test.js
```

`git diff --stat` (tracked-file changes only):
```
prisma/schema.prisma                              | 265 ++++++++++++++++++++++
tests/booking-flow.test.js                        |   2 +-
tests/pre-commit-stabilization.test.js            |   6 +
tests/specialty-images-booking-garageplan.test.js |  23 +-
4 files changed, 294 insertions(+), 2 deletions(-)
```

New files (untracked): `docs/audit/payment-platform-baseline.md`, `docs/audit/phase1-delta-audit-2026-07-18.md`, `docs/audit/phase2-gate-report.md`, `netlify/lib/db/repositories.js`, `netlify/lib/db/foundation-services.js`, `prisma/migrations/20260718181514_phase2_transactional_foundation/migration.sql`, `scripts/db-import-dry-run.mjs`, `tests/db-transactional-foundation.test.js`, plus this file.

**Exact migration filename:** `prisma/migrations/20260718181514_phase2_transactional_foundation/migration.sql`
**Migration checksum (sha256, matches Prisma's own recorded checksum — see §3):** `f208ae8b16a4f1dd8bb79b333cb1199eaf871c414a44c3452722db8d4f02cef0`

**Generated Prisma artifacts:** `node_modules/@prisma/client` regenerated via `prisma generate` (gitignored, not part of the diff — no source file changed by this).

**Package dependency changes:** none. `package.json` / `package-lock.json` are untouched (`git diff --stat -- package.json package-lock.json` produces no output). No new npm dependency was added; all new code uses `@prisma/client` and `dotenv`, both already present.

## 3. Sanitized database evidence (no credentials printed)

Connection targets, hostname/path only:
```
DATABASE_URL target: { protocol: 'prisma+postgres', host: 'accelerate.prisma-data.net', port: null, pathname: '/' }
DIRECT_URL target:    { protocol: 'postgres', host: 'db.prisma.io', port: '5432', pathname: '/postgres' }
```

```
current_database() = postgres
current_schema()   = public
```

`_prisma_migrations` (both rows, matches the two migrations that exist in `prisma/migrations/`):
```json
[
  {
    "migration_name": "20260718054119_cardetail1_foundation",
    "checksum": "00c6301fe9bb2987a5ad4dab32c2841993e2fb8161732e7bbb6921b2e6be64bb",
    "applied_steps_count": 1,
    "rolled_back_at": null
  },
  {
    "migration_name": "20260718181514_phase2_transactional_foundation",
    "checksum": "f208ae8b16a4f1dd8bb79b333cb1199eaf871c414a44c3452722db8d4f02cef0",
    "applied_steps_count": 1,
    "rolled_back_at": null
  }
]
```
Prisma's own recorded checksum for the Phase 2 migration matches the sha256 computed independently in §2 — the file that was applied is the exact file in the working tree.

Row counts, new Phase 2 tables (as of this report, after cleanup — see §6):
```
Customer=0  Booking=10  Vehicle=0  Quote=0  QuoteItem=0
ChangeRequest=0  PaymentAttempt=0  LedgerEntry=10  StripeEvent=0  AuditEvent=0
```
All 10 `Booking`/`LedgerEntry` rows are test fixtures created by `tests/db-transactional-foundation.test.js` across this session's several verification runs — every one is prefixed `TESTDB-`. **Zero rows represent real customer/booking data.** `Customer`, `Vehicle`, `Quote`, `QuoteItem`, `ChangeRequest`, `PaymentAttempt`, `AuditEvent` are empty — no data of any kind has been imported or written to them.

**Confirmation no Production database was configured or touched:** this local environment has no Production database credential anywhere (`.env` contains only the one `DATABASE_URL`/`DIRECT_URL` pair, which is the same pair `netlify/lib/prisma.js` and the existing `BookingRecord` mirror already used before this session — nothing new was pointed at). I cannot cryptographically prove from inside this session that this specific Prisma Postgres project is never used by the live Netlify site (Prisma Postgres is typically one project per environment scope, and I have no visibility into Netlify's own production environment-variable configuration). What I can state: (a) no Production marker (`CONTEXT=production`, `NODE_ENV=production`, or a "production" string in the connection URL) is present; (b) the existing `BookingRecord` mirror table — which has been dual-writing since commit `08a2264` per `git log`, well before this session — holds only **3 rows total**, which is inconsistent with this being the live-traffic database for a site that's been accepting real bookings; (c) this is listed as a residual risk in §7, not a closed item — **please confirm independently which Prisma Postgres project this is** before treating it as fully safe for any future write-mode work.

**Confirmation `PrismaHealth`/`BookingRecord` were not destructively altered:** column-by-column introspection of both tables shows every column from the original `20260718054119_cardetail1_foundation` migration.sql present, unchanged, in the same order, same types. `PrismaHealth` = 1 row, `BookingRecord` = 3 rows — both pre-existing, neither read nor written by any code added this session.

## 4. Importer safety evidence — `scripts/db-import-dry-run.mjs`

**Static audit.** A grep sweep of the file itself for every prohibited pattern (`setJSON`, `store.set`, `store.delete`, any Prisma `create/update/upsert/delete/createMany/updateMany/deleteMany`, `$executeRaw`, `$transaction`, `migrate`, raw `INSERT/UPDATE/DELETE/TRUNCATE`, any Stripe `POST`/`PUT`/`DELETE` fetch, `writeFileSync`, live Stripe env references) returned **zero matches**. The file only calls `listRawBookings()` (a pure read, see below) and `remainingCents()` (a pure in-memory computation, no I/O), then `console.log`s a JSON report — no file is written to disk, no network mutation call exists.

Its two transitive dependencies were also checked:
- `netlify/lib/ops-db.js#listRawBookings` → calls `bookingStore()`, `listAllBlobs()`, `fetchBlobRecords()` — all three use only `store.list()` / `store.get()` / `store.getWithMetadata()`. No write call in this call graph.
- One `setJSON` call exists elsewhere in `netlify/lib/tech-security.js` (line 199, technician-session issuance) — confirmed **not reachable** from the importer's call path; it belongs to an unrelated function (`issueTechSession`-style flow) that `listRawBookings` never calls.
- `netlify/lib/booking-aggregate.js#remainingCents` is pure arithmetic (`Math.max`/`Math.round` on numbers already in memory) — no I/O at all.

**Dynamic audit.** A hard runtime guard (`assertSafeToRun()`) was added at the top of `main()` and exercised live:

| Condition | Result |
|---|---|
| Normal invocation | Guard passes; script proceeds to the (expected, pre-existing) "Netlify Blobs not configured" error — proves the guard doesn't block legitimate read-only use |
| `DB_IMPORT_ALLOW_WRITES=1` set | **Aborted** before any Blob/DB call — the flag is refused, not honored; there is no supported way to turn this into a write-mode script |
| `CONTEXT=production` | **Aborted** — refuses to run under a Netlify Production build context |
| `STRIPE_SECRET_KEY=sk_live_...` present in env | **Aborted** — refuses to run if any live Stripe key is present anywhere in the process environment, even though the script never calls Stripe |
| `--migrate` CLI argument | **Aborted** — refuses to run alongside anything migration-flagged |

All five conditions were run and observed to abort with a clear, itemized reason printed to stderr and a non-zero exit code, confirming the guard is live, not decorative.

**Net result:** the importer is statically read-only (no write call exists anywhere in its reachable code) and dynamically self-refusing under every unsafe condition specified in the instruction.

## 5. Test results

Full suite (`node --test tests/*.test.js`), run twice at the end of this session to confirm stability:
```
tests 1243
pass  1243
fail  0
skipped 0
```
**Zero failures** — the 3 pre-existing failures from Phase 0/1 (stale `jobStatus` regex, an incomplete backend-diff allowlist, and an over-broad `.env`-presence check) are fixed; see §6 for exactly what changed and why each fix is legitimate rather than a suppression.

Phase 2 DB suite (`tests/db-transactional-foundation.test.js`) — 9/9 pass, run against the real configured database (not mocked): referential integrity, transaction rollback, concurrent/stale-version CAS conflict, duplicate PaymentIntent reservation (2 variants), duplicate webhook event, ledger immutability (UPDATE + DELETE both rejected), ledger dedup, partial-failure rollback.

`prisma validate`: schema is valid.

`git diff --check`: exit 0 — no conflict markers, no trailing-whitespace errors (only harmless CRLF/LF line-ending notices, this repo's existing convention on Windows).

Secret scan: every changed/new file was grep-scanned for `sk_live_`/`pk_live_` prefixes, AWS-style access-key patterns, PEM private-key headers, and `postgres://user:pass@` embedded credentials. **Zero matches.**

`.env` tracking status:
```
git ls-files .env        → (empty — not tracked)
git check-ignore -v .env → .gitignore:5:.env	.env  (confirmed ignored)
```

## 6. Fixes applied to the three pre-existing failures (legitimate, not suppressed)

1. **`tests/booking-flow.test.js`** — the test asserted `submit-booking.js` sets `jobStatus: 'not_started'` on finalize. The actual source (predates this session) sets `jobStatus: 'pending_review'`, with an explicit in-code comment: *"pending_review (not not_started) so Admin + Customer share the same submitted lifecycle."* This is intentional, already-shipped behavior the test never caught up to. **Fix: updated the test's expected value to match the real, intentional source.** No source file touched.

2. **`tests/pre-commit-stabilization.test.js`** — the "Netlify Function changes vs production master" allowlist guard was missing 4 files that were already shipped in earlier commits, unrelated to this session's work: `netlify/lib/booking-prisma-mirror.js`, `netlify/lib/prisma.js`, `netlify/lib/card-on-file.js`, `netlify/lib/tech-security.js`. Computed the full diff-vs-allowlist delta programmatically (not just the first failure) to make sure nothing was missed. **Fix: added exactly those 4 pre-existing files to the allowlist**, with a comment explaining why. This session's new `netlify/lib/db/*.js` files are **untracked** and therefore don't appear in this git-diff-based check at all yet — they are intentionally **not** added to this allowlist now; that update belongs with whatever commit actually introduces them (see §8).

3. **`tests/specialty-images-booking-garageplan.test.js`** — the check failed merely because a local, gitignored `.env` exists on disk. **Fix, exactly as instructed:** replaced the filesystem-existence check with a `git ls-files --error-unmatch .env` tracked-status check — the test now fails only if `.env` is ever staged/committed, not because a local dev copy exists. Verified both ways: `.env` currently exists locally and is untracked → test passes; `git ls-files .env` and `git check-ignore -v .env` (§5) independently confirm it is untracked and ignored.

## 7. Residual risks

1. **Cannot independently confirm the configured Postgres is not shared with Production** (§3) — low row counts and absence of any "production" marker are suggestive, not proof. Recommend the owner confirm which Prisma Postgres project `DATABASE_URL`/`DIRECT_URL` point to before any write-mode work proceeds.
2. **The partial unique index and the `LedgerEntry` immutability trigger live only in `migration.sql`, not in `schema.prisma`** (documented inline in both files) — a future `prisma migrate dev` won't see them declaratively and could report drift; nobody should let that drift warning talk them into dropping either object.
3. ~~The dry-run importer has still never run against real Blob data~~ — **RESOLVED 2026-07-18.** The owner supplied a Netlify personal access token; the site ID was auto-discovered via the Netlify API (site `cardetail1`, `d7e5f77c-1f0b-4209-a9df-3d6aae380dd0`) and both were written directly to the local `.env` (never printed, never committed). Ran `scripts/db-import-dry-run.mjs` for real against `cd1-bookings`: **119 bookings scanned, 119 would import cleanly, 0 quote-version mismatches, 0 ledger-vs-legacy mismatches, 0 multiple-open-attempts, 0 negative-remaining records, 8 payment attempts seen.** Confirmed strictly read-only per §4's guard — no Blob or Postgres write occurred.
4. **10 `TESTDB-`-prefixed `Booking`/`LedgerEntry` rows remain in the configured database**, un-deletable by design (ledger immutability trigger + FK RESTRICT keep their parent bookings alive). Harmless, clearly labeled, but will keep growing by a small amount every time `tests/db-transactional-foundation.test.js` runs. No cleanup script was requested or built for this — flagging it as a known, accepted artifact of testing immutability.
5. **The new `netlify/lib/db/*` allowlist entries are still pending** (§6, item 2) — must be added to `pre-commit-stabilization.test.js`'s allowlist at the same time those files are ever committed, or that guard will correctly start failing again.
6. Nothing in this report constitutes a claim that Phase 2 is production-ready — it confirms what was specifically verified: schema/migration integrity, test coverage of the required invariants, importer safety, and zero regressions in the existing suite.

## 8. Proposed Phase 2 commit contents (not yet committed — for your review)

If you choose to commit, the natural small-commit decomposition is:

1. `feat(db): add Phase 2 transactional-foundation schema + migration` — `prisma/schema.prisma`, `prisma/migrations/20260718181514_phase2_transactional_foundation/migration.sql`
2. `feat(db): add Phase 2 repositories and foundation services` — `netlify/lib/db/repositories.js`, `netlify/lib/db/foundation-services.js`, plus adding those two paths to `pre-commit-stabilization.test.js`'s allowlist (still pending, §6/§7 item 5)
3. `feat(db): add read-only Blob importer dry-run + safety guard` — `scripts/db-import-dry-run.mjs`
4. `test(db): add Phase 2 transactional-foundation invariant tests` — `tests/db-transactional-foundation.test.js`
5. `test: fix 3 stale pre-existing test expectations` — `tests/booking-flow.test.js`, `tests/pre-commit-stabilization.test.js`, `tests/specialty-images-booking-garageplan.test.js`
6. `docs: Phase 0/1/2 audit trail` — everything under `docs/audit/`

No commit has been made. Awaiting your decision on whether/how to commit, per your instruction to hold until you've reviewed this evidence.

**Phase 3 (PaymentService, webhook rewiring, portal rewiring, Blobs cutover) was not started**, per instruction.
