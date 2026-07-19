# Phase 0 — Baseline and Repository Freeze

**Date:** 2026-07-18
**Posture:** Read-only. No application code was modified to produce this document.

## 1. Repository state

| Item | Value |
|---|---|
| Requested starting branch (per task brief) | `feat/operational-payment-platform` — **does not exist locally**; not checked out |
| Actual current branch | `fix/final-production-readiness` |
| HEAD SHA | `d4ad05470da1f905439b5aa144b909f6c2083f44` |
| Parent SHA | `99fb0a48a225b1732e7ce01405365ddc9c69c5f3` |
| `git status` | clean, up to date with `origin/fix/final-production-readiness` |
| Referenced PR | #118 (`deploy-preview-118--cardetail1.netlify.app` per prior audit doc) |

## 2. Toolchain versions

| Tool | Version |
|---|---|
| Node.js | v24.18.0 |
| npm | 11.16.0 |
| Netlify CLI | not installed in this environment (`netlify` not found on PATH) |
| Prisma | 7.8.0 (`prisma` + `@prisma/client`) |
| Stripe SDK | **no `stripe` npm package in `package.json`** — Stripe is called via raw REST (`fetch` to `api.stripe.com`) from `netlify/lib/*` and `netlify/functions/*`, gated by `netlify/lib/stripe-mode.js` |

## 3. Test commands and current result

Command: `node --test tests/*.test.js` (also `npm test`)

```
tests    1234
suites   63
pass     1231
fail     3
cancelled 0
skipped  0
```

Failing tests (pre-existing, not introduced by this session):

1. `tests/booking-flow.test.js:65` — regex assertion `/jobStatus:\s+'not_started'/` against `submit-booking.js` source text no longer matches (stale text-scan assertion, not a runtime failure).
2. `tests/pre-commit-stabilization.test.js:254` — "Netlify Function changes vs production master are limited to approved RevOps additions" fails because `netlify/lib/booking-prisma-mirror.js` is an unapproved diff per that guard's allowlist. This is a **repo-hygiene guard test**, not a functional test; it will need its allowlist updated once Prisma-mirror work is intentionally accepted.
3. `tests/specialty-images-booking-garageplan.test.js:156` — "no Communication Core / credential / QA screenshot artifacts introduced" fails because a `.env` file exists in the working tree. `.env` is listed in `.gitignore` (confirmed) so it is not committed, but the test scans the working tree, not git, so it flags local-only `.env`.

No test was modified or skipped to produce this count.

## 4. Deploy preview URL

Not independently verified this session (Netlify CLI unavailable locally). Prior audit doc (`docs/audit/final-production-readiness-report.md`, dated 2026-07-17) records `https://deploy-preview-118--cardetail1.netlify.app`, deploy SHA `32f63b36e915682981d88360ce7708b031fba846` — **older than current HEAD** (5 commits behind); treat as stale until reconfirmed.

## 5. Storage inventory

### Netlify Blobs (primary/authoritative store today)
- `cd1-bookings` — the canonical booking/quote/service aggregate (per `netlify/lib/booking-repository.js`, `booking-commands.js`, `canonical-quote.js`). CAS (`onlyIfMatch`) + monotonic `bookingVersion` enforced by `commitBooking`.
- `cd1-customer-change-requests` — secondary, rebuildable index of change requests (explicitly documented as best-effort/non-authoritative; aggregate is authoritative).
- Additional Blob stores referenced across `netlify/lib/*`: recent-work media, job-photo storage, revenue/recovery stores, tech accounts, auction data, site-access — not yet fully enumerated; flagged as Phase 1 work.

### PostgreSQL (Prisma) — **mirror only, not authoritative**
- One migration: `20260718054119_cardetail1_foundation`.
- Two models only:
  - `PrismaHealth` — connectivity smoke check.
  - `BookingRecord` — a **JSON payload mirror** of the Blob booking aggregate (`payload: Json`) plus a handful of indexed scalar fields (`phone`, `email`, `paymentWorkflowStatus`, `preferredDate`, etc.). No `Quote`, `QuoteItem`, `PaymentAttempt`, `LedgerEntry`, `StripeEvent`, `AuditEvent`, or `ChangeRequest` relational models exist yet.
- Dual-write is controlled by `PRISMA_BOOKING_MIRROR` (default on when `DATABASE_URL` set) and `PRISMA_BOOKING_READ` (fallback read after Blob miss). Per `.env.example` comment and `netlify/lib/booking-prisma-mirror.js`: **"Blobs stay authoritative."**

### Browser storage
- `sessionStorage`/`localStorage` used for My Garage booking-ID/phone continuity; three recent commits on this branch (`3c8d2af`, `0d5f3cd`) specifically fixed session-storage lock/unlock bugs in this area — flagged for Phase 1 concurrency review regardless.

## 6. Stripe objects in use (by grep, not yet behaviorally traced)

Found references to: Customer, SetupIntent (`create-setup-intent.js`, `card-on-file.js`), PaymentIntent (`create-payment-intent.js`, `capture-payment.js`), Checkout Session / Payment Link (`create-payment-link.js`, `create-payment.js`, `customer-portal-pay.js`), Refund (referenced in admin ops as manual/logged, not automated), webhook Event (`stripe-webhook.js`, HMAC/signature-verified per `admin-security.js` conventions). Full object-by-object trace (creation endpoint, metadata, idempotency key, webhook mapping) is **Phase 1 scope**, not yet done.

## 7. Environment variable names in use (names only, no values read or printed)

```
ADMIN_DASH_PASSWORD, ADMIN_EMAIL, ADMIN_SESSION_SECRET, ADMIN_USERNAME,
ANTHROPIC_API_KEY, BID_SECRET, CHAT_MODEL, CUSTOMER_PORTAL_SMS_OTP_ENABLED,
CUSTOMER_SESSION_SECRET, DATABASE_URL, DIRECT_URL, DRAFT_TOKEN_SECRET,
GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_EXPORT_ENABLED, HOUSEHOLD_DEDUP_SECRET,
HUBSPOT_INTEGRATION_ENABLED, HUBSPOT_PRIVATE_APP_TOKEN,
PRISMA_BOOKING_MIRROR, PRISMA_BOOKING_READ, RECOVERY_AUTOMATION_ENABLED,
RECOVERY_DRY_RUN, RESEND_API_KEY, RESEND_FROM, RESUME_TOKEN_SECRET,
SITE_URL, STRIPE_PUBLISHABLE_KEY, STRIPE_PUBLISHABLE_KEY_LOCAL_TEST,
STRIPE_WEBHOOK_SECRET, TECH_ADJUSTMENT_MAX_CENTS, TECH_ADJUSTMENT_MAX_PERCENT,
TWILIO_FROM, TWILIO_SID, TWILIO_TOKEN
```

Plus Netlify-provided runtime vars (`NETLIFY`, `NETLIFY_DEV`, `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN`, `BRANCH`, `COMMIT_REF`, `CONTEXT`, `DEPLOY_PRIME_URL`, `URL`, `SITE_ID`, `HEAD`).

**Note:** `STRIPE_SECRET_KEY` was not found by static grep under this exact name — Stripe secret-key resolution likely happens inside `stripe-mode.js` under a differently-named or mode-suffixed variable (e.g. test/live variants). This needs confirmation in Phase 1 rather than being asserted here.

## 8. Pre-existing audit trail already in this repository

This is not a greenfield repository. `docs/audit/` already contains a substantial, dated audit and remediation record from prior sessions, using its own defect ID scheme (`PDA-01`…`PDA-19`):

- `portal-executive-summary.md`, `portal-defect-register.md` — original defect audit (dated 2026-07-17, branch `fix/my-garage-operational-portal`).
- `final-production-readiness-report.md` — remediation report claiming **15 of 19 PDA defects RESOLVED**, 2 partially resolved, 3 explicitly deferred (PDA-10, PDA-11, PDA-19). States full suite was `1156/1156` passing at time of writing (2026-07-17); current count is `1231/1234` passing (3 pre-existing failures, see §3) — the suite has grown and shifted since that report, consistent with the 5 commits made after it (`f624d89` … `d4ad054`).
- `authoritative-state-model.md`, `payment-and-invoice-model.md`, `cross-portal-parity-matrix.md`, `implementation-roadmap.md`, `cursor-release-a-command.md`, `release-a-ship-baseline.md`, `portal-ops-smoke-audit.md`.

The claimed architecture in these docs (CAS + monotonic `bookingVersion`/`quoteVersion` on the Blob aggregate, ledger-derived remaining balance, webhook-only payment-status writes, overpayment guard, Paid/Closed hard-lock) substantially overlaps with — but is **not identical to** — the target architecture described in this task's brief (fully PostgreSQL-relational `Quote`/`PaymentAttempt`/`LedgerEntry`/`StripeEvent` tables as the transactional authority). Today Postgres is a JSON mirror, not the source of truth.

## 9. Blockers to a valid Phase 1 audit

1. **Branch mismatch.** The brief names `feat/operational-payment-platform` as the starting branch; it doesn't exist here. I'm treating `fix/final-production-readiness` (current HEAD) as the real baseline unless told otherwise.
2. **Architecture mismatch.** The brief's Phase 2 target ("PostgreSQL is authoritative... after cutover") assumes no authoritative relational layer exists yet. In reality this repo already has a working Blob-CAS-authoritative design with real invariants enforced (version conflict, ledger-derived remaining, webhook-only payment writes) per the prior PDA audit — not the greenfield state the brief's phases assume. Phase 1's read-only audit can proceed against *actual* code either way, but Phase 2/3 planning needs a decision: extend/harden the existing Blob-CAS design, or execute the brief's full cutover to Postgres-as-authority on top of it.
3. **Deploy preview freshness.** The only recorded preview URL is 5 commits stale relative to current HEAD; no live re-verification was done this session (no Netlify CLI, no browser check performed yet under Phase 0's read-only constraint).
4. **Missing credentials in this environment**: no Stripe test-mode keys, no live `DATABASE_URL`/`DIRECT_URL` were read or required for Phase 0. Their presence/absence for Phase 2+ work needs confirmation before any migration or Stripe test-mode proof can run.
5. **Duplicate audit-doc risk.** Because `docs/audit/` already has 10 files covering much of what Phase 1 asks for (state machines, payment authority matrix, etc.), a literal from-scratch Phase 1 would substantially re-derive existing, dated work rather than adding new signal — recommend Phase 1 be scoped as **delta audit against the existing PDA register and the 5 post-report commits**, not a blind restart.
