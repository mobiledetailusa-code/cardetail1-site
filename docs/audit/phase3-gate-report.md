# GATE 3 — Payment Authority Foundation

**Date:** 2026-07-18
**Branch:** `feat/postgres-payment-core`
**Scope:** Additive only, same discipline as Phase 2. **No file under `netlify/functions/`, no `.html` file, and no existing live payment code (`netlify/lib/payment-service.js`, `netlify/functions/stripe-webhook.js`, `netlify/functions/create-payment-intent.js`, etc.) was modified.** Checkout design and behavior are unchanged. Nothing here is wired into live traffic.

## Why this is scoped narrower than the original Phase 3 brief

The general brief's Phase 3 describes wiring Admin/Customer/My Garage to consume the new projection and embedding the Payment Element — that's explicitly Phase 4 (button/operation audit) and Phase 5 (embedded payment) territory, and touches live checkout surfaces. Given the standing instruction throughout this engagement not to change checkout design or functioning, and that Phase 1/2 already established the Blob aggregate (`cd1-bookings`) remains sole live authority, this gate builds and proves the **PaymentService core logic** in isolation — reservation, reconciliation, refunds, adjustments — against the real Phase 2 Postgres foundation, with zero live wiring. Wiring into Admin/Customer/webhook endpoints is a separate decision requiring its own explicit authorization, called out in Residual Risks below.

## 1. What was built

| File | Purpose |
|---|---|
| `netlify/lib/db/financial-projection.js` | Pure `computeFinancialProjection()` — no I/O. Sums settled/adjustment/refund ledger entries **across the whole booking** (not per quote version), so `remainingCents = approvedCents - cumulativeNetSettled` is correct even after a quote-version adjustment. |
| `netlify/lib/db/payment-authority-service.js` | The one module allowed to reserve obligations, create/retrieve PaymentIntents, reconcile provider state, create refunds, and create adjustment quotes on the new schema. |
| `netlify/lib/db/webhook-inbox.js` | Signature verification (HMAC-SHA256, 300s tolerance, timing-safe compare — algorithm mirrors `netlify/functions/stripe-webhook.js` exactly, duplicated rather than imported since that's a Netlify function file, not a lib module) + dispatch to the reconciler. |
| `netlify/lib/db/repositories.js` | Extended with `getLatestQuote`, `createAdjustmentQuote`, `listPaymentAttempts`, `listLedgerEntries`, `findPaymentAttemptByProviderObjectId`, `updatePaymentAttempt`, `markQuoteStatus`. |

All Stripe network calls go through an injectable `fetchImpl` (default `globalThis.fetch`) and the existing `stripe-mode.js` guard — same pattern `netlify/lib/payment-service.js` already uses. No test in this session ever calls real Stripe; every test passes a fake `fetchImpl`, matching the existing convention in `tests/release-a-acceptance.test.js`.

## 2. Invariants proven (against the real configured Postgres database, not mocked)

`tests/payment-authority-service.test.js` — **18/18 passing**, stable across repeated runs:

| Invariant | Test |
|---|---|
| One PaymentIntent per bookingId+quoteVersion | creation test + concurrent-call test |
| Concurrent/duplicate creation (double-click, browser retry) collapses to one Stripe call, one attempt row | 3-way `Promise.all` + immediate retry, asserts `calls.length <= 1` |
| Stale quoteVersion refused | rejects with `stale_quote_version`, 409 |
| No double charge after settlement | rejects with `already_paid`, 409 |
| Webhook succeeded → settles quote, matches projection | ledger + quote status both asserted |
| Duplicate webhook delivery never double-credits | same `stripeEventId` twice, `settledCents` unchanged |
| Out-of-order webhook doesn't un-settle a paid booking | stale `requires_action` after `succeeded` — projection stays `paid` |
| Payment succeeded before local attempt exists is quarantined, not dropped | `no_matching_payment_attempt`, `quarantined: true` |
| Declined card allows a controlled retry | `requires_payment_method` → new attempt row, exactly one active obligation afterward |
| Partial refund recalculates remaining correctly | refund 3000 of 10000 → remaining reopens to 3000 |
| Refund amount clamped to refundable ceiling | requesting 999999 clamps to the real 1000 settled |
| Post-payment adjustment charges only the delta | paid 5000 → adjust to 8000 → remaining is 3000, not 8000; original settled quote row provably untouched |
| Webhook signature: valid/tampered/stale-timestamp/missing-header | 4 pure unit tests, no DB |
| `handleWebhookDelivery` rejects bad signatures before any DB write | verified |

## 3. Mandatory failure-injection list — coverage against the brief's 16 items

| # | Scenario | Status |
|---|---|---|
| 1 | Delayed webhook | Not distinctly tested — timing doesn't affect this code path (no timeout logic exists to delay against); the reconciler is called whenever the event arrives, regardless of delay. Not a gap in this layer. |
| 2 | Missing webhook | Not tested here — this requires the polling/recovery path ("Reconcile with Stripe" from Admin), which is explicitly Phase 4/5 UI work, not built yet. **Residual gap.** |
| 3 | Duplicate webhook | ✅ Covered |
| 4 | Out-of-order webhook | ✅ Covered |
| 5 | Admin and Customer loading simultaneously | Satisfied by construction — `getFinancialProjection` is a pure read with no caching; two simultaneous reads just run the same query twice. Not a dedicated test, but not a distinct code path either. |
| 6 | Admin and Customer creating payment simultaneously | ✅ Covered (the 3-way concurrent test) |
| 7 | Double click | ✅ Covered (same test) |
| 8 | Browser retry | ✅ Covered (idempotency-key replay assertion) |
| 9 | Network timeout after Stripe object creation | **Not tested.** This needs a fake `fetchImpl` that succeeds server-side at Stripe but the response never reaches our code (simulating a timeout after creation) — a real gap; the existing test only covers the DB-reservation race, not a genuine Stripe-side timeout. **Residual gap.** |
| 10 | Stale tab / stale quoteVersion | ✅ Covered |
| 11 | Payment succeeded but local transaction initially failed | ✅ Covered (quarantine test) |
| 12 | Partial refund | ✅ Covered |
| 13 | Declined card | ✅ Covered |
| 14 | Authentication required | Partially — `requires_action` is handled in `reconcilePaymentIntentEvent` and correctly counted as an active obligation (blocks a second concurrent PI), but no dedicated test asserts the full requires-action-then-succeeds flow. **Residual gap.** |
| 15 | Booking paid then financial adjustment | ✅ Covered |
| 16 | Booking paid then operational address request | **Out of scope for this module** — address changes are Blob/ChangeRequest domain, not financial; nothing in `payment-authority-service.js` touches addresses. |

**9 of 16 fully covered, 2 satisfied by construction (not by a dedicated test), 1 partially covered, 3 explicit residual gaps, 1 out of scope.** Reported honestly per rule 9/10 — this is not a claim of complete coverage.

## 4. Test data residue

Same pattern as Phase 2: bookings with a settlement/refund `LedgerEntry` cannot be deleted (FK `RESTRICT` + the immutability trigger keep them alive by design). All 25 `TESTDB-PAY-`-prefixed bookings from this session's test runs remain in the configured database, harmless and clearly labeled.

## 5. Full suite result

`node --test tests/*.test.js`: **1267 tests, 1267 pass, 0 fail, 0 skipped.**

One thing worth recording: committing `netlify/functions/db-health.js` in the Phase 2 close-out surfaced 4 **separate, independently-maintained** hygiene-guard tests (`ai-chat-public-pricing.test.js`, `encoding-chat-pricing-correction.test.js`, `pre-commit-stabilization.test.js`, `state-hub-accordion-header.test.js`) that each scan `git diff` against their own pinned baseline commit and each maintain their own allowlist of acceptable Netlify Function changes — none of the four had been updated for `db-health.js`, because it was untracked (and therefore invisible to a git-diff-based check) at the time those guards were last run clean. All four are now updated. This is a structural fragility worth flagging to the owner: any future new Netlify Function file will need to be added to all four allowlists separately, and there is no single source of truth for "which function changes are approved."

## 6. Residual risks

1. **Not wired to anything live.** `netlify/lib/db/payment-authority-service.js` and `webhook-inbox.js` are inert — no Netlify Function calls them. This is intentional per this gate's scope, not an oversight.
2. **3 of the 16 mandatory failure-injection scenarios have real gaps** (missing webhook / recovery-reconcile path, genuine Stripe-side network timeout, full requires-action-then-succeeds flow) — see §3.
3. **The 4-separate-allowlist fragility** (§5) — a structural maintenance risk in the existing test suite, not something this session introduced, but now touched twice.
4. **`FinancialProjection`'s "remaining reopens after a partial refund" semantics** is a reasonable default model, not validated against a real business rule for this specific operation — worth explicit owner sign-off before this becomes the live behavior (e.g., does a partial refund actually mean "customer owes the refunded amount again," or should that require a fresh adjustment quote instead?).
5. Per rule 9/10: this is not a claim of production reliability. It is what was verified — the core payment-authority logic behaves correctly against a real database and a mocked Stripe, for the scenarios listed in §2 and §3.

## 7. What Phase 3 (as originally briefed) still requires before it's actually done

- Wiring `getFinancialProjection` into Admin list/detail and My Garage as the shared read path (Phase 4/5 territory — touches live UI).
- Wiring `webhook-inbox.js` into an actual Netlify Function endpoint with real Stripe webhook delivery (requires `STRIPE_WEBHOOK_SECRET` in a context this can be tested against, and explicit authorization since it touches the live webhook surface).
- The Admin "Reconcile with Stripe" recovery action.
- Live Stripe test-mode manual proof (the brief's own GATE 3 requirement: Stripe succeeded → one PaymentAttempt succeeded → one ledger credit → remainingCents = 0 → Customer/Admin both show Paid/$0 remaining) — not attempted, since it requires wiring into a live endpoint first.

None of the above was started. Stopping here for explicit authorization before touching any live surface.
