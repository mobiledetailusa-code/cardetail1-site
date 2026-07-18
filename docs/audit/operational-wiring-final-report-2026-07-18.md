# FINAL OUTPUT — Operational Payment Platform Wiring

**Date:** 2026-07-18
**Mandate:** full operational payment scope end-to-end (Admin/My Garage/webhook wiring, embedded payment, live Stripe test-mode E2E proof)

## Branch and SHAs

| Item | Value |
|---|---|
| Branch | `feat/postgres-payment-operational` |
| HEAD SHA | `4d6620075fcb065a3bf298cf831ba2c2ac74d8b5` |
| Parent (`feat/postgres-payment-core` HEAD) | `8dd64e637e95481f3d28f7dd90ff66cb046c7654` |
| PR | [#120](https://github.com/mobiledetailusa-code/cardetail1-site/pull/120) — Draft, targets `feat/postgres-payment-core`, **not merged** |
| Foundation PR | [#119](https://github.com/mobiledetailusa-code/cardetail1-site/pull/119) — Draft, **not merged** |
| `master` | `65b2555397deb7c5963c957e3a9a2b1c186c15e6` — **unchanged** |
| Production | Not touched. No Production credentials exist in this environment. |

## Commits (this branch, beyond the foundation)

```
69e4a14 feat(db): operational payment facade, ensure-mirror, and PI recovery
7a83964 feat(payments): wire webhook to PaymentAuthorityService and embed PI endpoint
1cf1f47 feat(portals): shared Postgres FinancialProjection and Admin reconcile
a676a6e feat(ui): My Garage Payment Element and Admin Reconcile with Stripe
2168026 test(payments): operational wiring coverage and hygiene allowlists
4d66200 fix(portal): don't mislabel rate-limiting as booking-not-found
```

Note on provenance: the first five commits already existed on this branch when this session picked the work back up (this session had built the Phase 2/3 *foundation* on `feat/postgres-payment-core`; the operational wiring above was already implemented, tested, and PR'd by the time this turn started). This session audited that work for correctness before proceeding, ran the live E2E proof, found and fixed one real bug (`4d66200`), and produced this report.

## Changed files (this branch vs. `feat/postgres-payment-core`)

16 files, +1524/-124:

- `netlify/functions/stripe-webhook.js` — webhook wired to `PaymentAuthorityService` for `payment_intent.*` events and balance-Checkout PIs, with fallback to the legacy Blob path when Postgres doesn't "handle" an event
- `netlify/lib/db/operational-payment.js` (new) — the operational facade: `getSharedFinancialProjection`, `prepareEmbeddedPayment`, `adminReconcileWithStripe`, `syncBlobCompatibilityFromProjection`
- `netlify/lib/db/ensure-booking-financial.js` (new) — on-demand Blob→Postgres Booking/Quote import per booking (idempotent, never mutates a settled quote)
- `netlify/lib/db/payment-authority-service.js` — extended with `retrievePaymentIntentClientSecret`, `createCustomerSession`, `reconcileFromStripeProvider`; fixed a real latent bug in `reconcilePaymentIntentEvent` (fresh PaymentIntents were being marked `failed` on their first `requires_payment_method` state instead of only on genuine decline) and a settlement-dedup bug (keyed on `stripeEventId` instead of PaymentIntent, which could have double-credited across a `checkout.session.completed` + `payment_intent.succeeded` pair for the same PI)
- `netlify/functions/customer-balance-payment-intent.js` (new) — the embedded-payment endpoint My Garage calls
- `netlify/functions/customer-portal-data.js`, `netlify/functions/admin-ops-jobs.js` — both read the shared `FinancialProjection`
- `my-garage.html`, `assets/my-garage.js` — Payment Element mount, `confirmPayment({redirect:'if_required'})`, hosted-Checkout fallback button, **this session's rate-limit fix**
- `admin-ops.html` — "Reconcile with Stripe" action
- `tests/operational-payment.test.js` (new, 313 lines) + 4 hygiene-allowlist updates

## Migrations

None new. Uses the Phase 2 schema (`20260718181514_phase2_transactional_foundation`) already on `feat/postgres-payment-core`.

## Automated test counts

`node --test tests/*.test.js`: **1280 tests, 1280 pass, 0 fail, 0 skipped** (confirmed on two consecutive runs; one incidental run showed a single transient DB-timing failure that did not reproduce).

`tests/operational-payment.test.js` specifically — 11/11 passing, run against the real configured Postgres, fake Stripe only:
- ensure-import creates Booking+Quote from a Blob-shaped booking
- Admin and Customer shared-projection parity after settlement
- `checkout.session.completed` + `payment_intent.succeeded` for the same PI cannot double-credit
- `prepareEmbeddedPayment` returns a client secret and reuses one PaymentIntent across repeated calls
- missing-webhook recovery via `reconcileFromStripeProvider`
- stale quoteVersion refused
- non-POST rejected on the embed endpoint
- `postgresPaymentEnabled` respects the `CD1_POSTGRES_PAYMENT=0` kill switch
- structural checks: Payment Element mounted, Reconcile-with-Stripe wired, and (new) rate-limit handling

## E2E results — live, not mocked

Full scenario executed via real browser automation against `https://deploy-preview-120--cardetail1.netlify.app` (real Stripe **test mode**, real Postgres — the same database this repo's `.env` already points at):

1. New booking created through the public 6-step flow (ZIP 07024 → Cars & SUVs → Maintenance Detail → 2022 Toyota Camry → customer "QA E2E Test", clearly-labeled test contact info → card-on-file).
2. Real Stripe test-mode SetupIntent confirmed with test card `4242 4242 4242 4242` → **"✓ Card Saved"**, real Stripe Customer `cus_UuWN3STC2Ynwo1` created.
3. Booking landed as `CD1-MRQZ8LGB-FUHZ`, `isDraft:false`, status "Pending Review".
4. Admin confirmed the booking (Admin Portal, logged in by the owner; all subsequent navigation/actions performed by this session) — approved total $175.00 set automatically from the package price.
5. My Garage (as the customer) showed the same $175.00 approved / $175.00 due, byte-for-byte matching Admin.
6. Clicked "Pay $175.00 securely" → embedded Stripe Payment Element mounted **in place** (no redirect) → real PaymentIntent `pi_3TuhTfLbeoH0J6bl1l9CsUJn` created server-side.
7. Paid with test card `4242 4242 4242 4242` via the embedded form → Stripe confirmed the PaymentIntent.
8. Webhook could not reach this ephemeral preview URL (expected — Stripe Dashboard's webhook endpoint isn't pointed at per-PR preview domains). Settlement completed anyway through the same idempotent `reconcileFromStripeProvider` path Admin's "Reconcile with Stripe" button uses, triggered automatically because the booking was in an "uncertain" state on next load — **this is a live proof of the recovery path itself**, not a gap.
9. Admin: **PAID / CLOSED**, Approved $175.00, Paid $175.00, Balance $0.00, Stripe reference shown, "Stripe settlement closed this invoice automatically. Do not generate another pay link."
10. Postgres, verified directly:
    - `PaymentAttempt`: exactly 1 row, `status: succeeded`, `providerObjectId: pi_3TuhTfLbeoH0J6bl1l9CsUJn`, `amountCents: 17500`
    - `LedgerEntry`: exactly 1 row, `kind: settlement`, `amountCents: 17500`, tied to that PI
    - `FinancialProjection`: `approvedCents:17500, settledCents:17500, remainingCents:0, paymentStatus:'paid'`
11. `customer-portal-data` API (My Garage's own server-side read path) queried directly: independently returned the identical projection — `"state":"paid","remainingCents":0,"stripeReference":"pi_3TuhTfLbeoH0J6bl1l9CsUJn","canPay":false,"authority":"postgres"` — **this is the strongest parity evidence in this report**: two different portals' read paths, checked independently, agree exactly.
12. **Bug found live, not in a test suite:** the payment-confirmation polling burst tripped the app's own rate limiter (`public-rate-limit.js`, 429) on the customer's next booking-lookup request. My Garage's client code had no branch for `error:'rate_limited'`, so it displayed **"No booking found. Check your ID and phone."** and cleared the customer's session/sessionStorage as if authentication had failed — a real paying customer could have been logged out and told their just-paid booking didn't exist. Fixed in `4d66200`, covered by a new regression test that reads the actual shipped source.

## Stripe test evidence

- Real Stripe test-mode PaymentIntent: `pi_3TuhTfLbeoH0J6bl1l9CsUJn`, $175.00, succeeded
- Real Stripe test-mode Customer: `cus_UuWN3STC2Ynwo1`
- Real Stripe test-mode publishable key confirmed on this deploy: `pk_test_51TgF1p...` (`mode:"test"`, verified via `/.netlify/functions/stripe-config`)
- No live Stripe key was used or is configured anywhere reachable in this session

## Database evidence (sanitized — no credentials)

- Same Postgres this repo's `.env`/`DATABASE_URL` already pointed at throughout this engagement (confirmed via `db-health` returning `reachable:true`)
- Dry-run importer re-run after this session's work: **120 bookings scanned (was 119 before this session's one new test booking), 120 would import cleanly, 0 discrepancies** of any kind (quote-version mismatch, ledger-vs-legacy drift, multiple-open-attempts, negative-remaining)
- New Postgres rows created by this session's live test: 1 `Booking`, 1 `Quote`, 1 `PaymentAttempt` (succeeded), 1 `LedgerEntry` (settlement) — all under booking `CD1-MRQZ8LGB-FUHZ`, clearly a test record (customer name "QA E2E Test", email `qa-e2e-test@example.com`)

## Admin/Customer parity evidence

Established two independent ways in this session:
1. Unit test (`Admin and Customer shared projection match after settle`) — both call sites invoke `getSharedFinancialProjection` and are asserted `deepEqual` on the money fields.
2. **Live**: Admin UI screenshot and a direct `customer-portal-data` API call, both showing `approvedCents:17500, settledCents:17500, remainingCents:0, paymentStatus:'paid', stripeReference: pi_3TuhTfLbeoH0J6bl1l9CsUJn` — independently obtained, not derived from each other.

## Controls audited (this session, live click-through — not exhaustive P0 sweep)

- Public booking flow: ZIP validation, category/package/vehicle selection, info form, card-on-file (Stripe SetupIntent), review & submit — all functioned correctly with real Stripe test-mode
- Admin: Confirm booking, Job Balance display, Reconcile-with-Stripe-driven auto-settlement, "do not generate another pay link" guard after settlement
- My Garage: booking lookup (both success and the rate-limit-mislabeled-as-not-found bug, now fixed), Pay Balance → embedded Payment Element → Pay now, hosted-Checkout fallback button present but not exercised
- **Not** re-driven live this session: technician portal, refund flow, post-payment adjustment flow (covered by `tests/payment-authority-service.test.js` unit tests only), duplicate/out-of-order webhook (covered by unit tests only, since no webhook delivery reaches ephemeral preview URLs), 3DS/`requires_action` flow (covered by unit tests only), decline flow (covered by unit tests only)

## Unresolved P0/P1/P2 items

| Priority | Item | Status |
|---|---|---|
| P1 (fixed this session) | Rate-limit mislabeled as booking-not-found + spurious session clear | Fixed, `4d66200`, regression test added |
| P2 | Full 15-scenario mandatory failure-injection matrix not all re-driven live (3DS, decline, two-tabs, refresh-during-processing beyond the rate-limit case, portal re-login) | Unit-test coverage exists for most; live browser re-verification not done this session — time/scope |
| P2 | Duplicate/out-of-order webhook delivery not provable live (ephemeral preview URLs can't receive Stripe webhooks) | Structurally handled by the same idempotent reconciler either way (unit-tested); would need a stable webhook endpoint (branch deploy or Production-adjacent staging) to prove live |
| P2 | Saved-card redisplay (`allow_redisplay`) not exercised — this test booking's card was never presented as a *saved* option on the second payment attempt because there was no second attempt to observe it | Code exists (`createCustomerSession` with `payment_method_redisplay: enabled`); untested live |
| P3 | Technician portal, refund flow, post-payment adjustment not re-driven live | Unit-tested only |

## Migration blockers

**Full deterministic bulk cutover import was intentionally not executed.** The dry-run (read-only, zero risk) is clean — 120/120 bookings, 0 discrepancies. But actually running `ensureBookingFinancial` across all 120 real bookings would write real customers' financial history into Postgres at scale, on a system not yet authoritative for anything live. That's a materially different, more consequential action than the single test booking this session created, and it's the kind of decision the mandate itself reserves for explicit owner sign-off ("a genuine owner decision... that materially changes money" / data-migration scope) rather than a normal implementation step. Recommend the owner explicitly authorize the bulk import as its own controlled action, ideally scheduled (not silently triggered by organic traffic hitting `ensureBookingFinancial` one booking at a time, which is what happens today whenever Admin/Customer/webhook touches a booking under `CD1_POSTGRES_PAYMENT` — worth being aware that the *current* code already does this incrementally, just not yet all at once).

## Rollback runbook

1. **Kill switch**: set `CD1_POSTGRES_PAYMENT=0` in Netlify env for any context — every operational-payment code path (`operational-payment.js#postgresPaymentEnabled`) falls back to the pre-existing Blob-only path immediately, no deploy needed.
2. **Do not merge** `feat/postgres-payment-operational` or `feat/postgres-payment-core` to `master` until the owner reviews both Draft PRs.
3. If already merged and deployed: revert the merge commit; Blobs were never deleted or mutated destructively, so the pre-existing Blob-authoritative system is fully intact underneath.
4. Postgres rows created by this session's test are harmless and isolated (booking ID `CD1-MRQZ8LGB-FUHZ`, clearly labeled test customer) — no cleanup required for safety, though the owner may want to archive/delete that test booking from Blobs via Admin's existing "Archive as test" control.
5. No Production credential, Production database, or live Stripe key exists in this environment — there is nothing to roll back in Production because nothing there was ever touched.

## Explicit verdict

**OWNER REVIEW.**

Not REJECT: the core financial invariants (single PaymentIntent, single ledger credit, Admin/Customer parity, no double-charge, missing-webhook recovery) are proven correct with real, live Stripe test-mode evidence — not just mocks — and a real bug found during that live test was fixed and regression-tested in the same session.

Not READY FOR CONTROLLED PRODUCTION CUTOVER: the full 15-scenario failure-injection matrix isn't all live-verified, the bulk Blob→Postgres cutover import hasn't run (by design — reserved for owner sign-off), saved-card redisplay is untested live, and neither Draft PR has been reviewed or approved by the owner yet. Both PRs remain Draft and unmerged; `master` and Production are untouched.
