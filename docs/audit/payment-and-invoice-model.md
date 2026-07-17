# Payment and Invoice Model — Release A

**Audit baseline:** `fix/my-garage-operational-portal` at `5fa47b99c4d8707dba29b35c6559b3cdba3eb125`  
**Currency assumption in current flows:** USD  
**Audit execution:** no Stripe network charge and no webhook replay; payment conclusions use repository control flow, intercepted clients in existing/synthetic fixtures, and pure money calculations.

## Current-state verdict

Initial public booking pricing is recalculated on the server, and Customer Pay Balance converts a consistent dollar value to cents correctly. That positive behavior is not sufficient to make the payment model authoritative:

- portal changes are quoted from a secondary catalog;
- Admin approves stored proposal totals without a current-version reprice;
- remaining due is persisted in competing fields and can become stale;
- some money-changing paths bypass the money synchronization helper;
- old Checkout Sessions are not expired when a quote changes;
- Customer balance Checkout completion is not reconciled into the ledger;
- the Admin-generated link handler calls undefined `getBooking` and accepts an operator amount;
- historical paid records can remain payable;
- non-production test-mode enforcement is not shared by every money endpoint; and
- no current Pay in Full workflow exists, while the dormant PaymentIntent path can ignore an approved discount.

## Separate commercial concepts

| Concept | Meaning | Authority | Must not be confused with |
|---|---|---|---|
| Quote | Immutable server price for exact structured service inputs and catalog version | Canonical quote service in booking aggregate | Client estimate, top-level label, Checkout Session |
| Approved amount | Quote plus explicitly approved adjustments/offers | Current aggregate `quoteVersion`/ledger | `totalPrice` written by an unrelated mutation |
| Invoice / balance statement | Human-readable projection of approved, settled, credited, and remaining amounts | Versioned projection of quote + ledger | A free-form pay link or Stripe success URL |
| Payment attempt | A version-bound intent/session for an exact remaining amount | Server payment service plus Stripe | An approval or invoice |
| Settlement | Verified, idempotently reconciled Stripe payment | Canonical ledger entry | `?paid=1`, payment status text, return URL |
| SetupIntent | Permission/card setup with no service amount collected | Stripe + stored customer/payment-method references | Pay in Full, Pay Balance, deposit |

## Authoritative calculation

All persisted and transmitted monetary values use integer cents.

```text
approvedCents = current canonical quote approved amount
settledCents = sum(verified settlement ledger entries)
creditedCents = sum(verified refund/credit ledger entries)
remainingCents = max(approvedCents - settledCents - creditedCents, 0)
```

Release A must not use `amountDueApproved`, `balanceDue`, `totalPrice`, operator input, URL parameters, or client JSON as a competing authority. Those values may be compatibility projections only.

Before any payment object is created or reused:

```text
assert aggregate bookingVersion == request expectedBookingVersion
assert aggregate quoteVersion == requested quoteVersion
assert aggregate currency == "usd"
assert aggregate lifecycle is payable
assert no money conflict
derive remainingCents
assert remainingCents > 0
```

## Payment-attempt record

Each Stripe object must have a local record bound to the exact commercial revision:

```text
paymentAttempt = {
  attemptId,
  provider = "stripe",
  providerObjectId,
  type = "customer_balance",
  bookingId,
  bookingVersion,
  quoteVersion,
  currency,
  amountCents,
  status,                 // creating | open | processing | settled | failed | expired | superseded
  idempotencyKey,
  createdAt,
  expiresAt?,
  settledAt?
}
```

Stripe metadata must carry only the identifiers/revisions needed for reconciliation; it is not itself authority. Reconciliation loads the aggregate and verifies exact amount, currency, object identity, and expected quote before crediting.

## Pay Balance

Required Release A flow:

1. Customer uses the normal authorized My Garage workflow; no amount is sent by the browser.
2. Server loads the current aggregate and derives `remainingCents`.
3. If an open attempt exists for the same booking/quote/amount and is still valid, return it; otherwise expire/supersede obsolete attempts.
4. Create a test-mode Checkout Session in local/preview using an idempotency key derived from booking, quote, amount, and attempt.
5. Persist the attempt only if the aggregate revision is still current; otherwise expire the just-created session and return a version conflict.
6. The return page shows “processing” until a verified ledger projection says settled. It never trusts `?paid=1` as proof.
7. The reconciliation service validates the completed object and commits one settlement entry with a conditional aggregate write.
8. Replaying the same provider event/object produces no second credit.

Customer balance success currently fails step 7 because `stripe-webhook` has no `customer_balance` completed-Checkout branch.

## Pay in Full

There is no visible current Pay in Full workflow. Release A must not invent a new Customer UI feature. It must make retained server behavior safe:

- disable/disconnect the dormant `create-payment-intent` handler, or route it through the same authoritative balance service;
- never recalculate a charge from catalog `totalPrice` after an approved offer/discount exists; and
- if a full-balance semantic is retained, “full” means the current `remainingCents`, not the original service total.

Synthetic audit example:

| Value | Amount |
|---|---:|
| Canonical catalog total | `$285.00` |
| Approved discounted total | `$256.50` |
| Correct unpaid full balance | `$256.50` |
| Dormant handler basis | `$285.00` / `28500` cents |

## Admin payment links

The visible generated-link control must use the same authoritative payment service as Customer Pay Balance. It cannot accept a caller/operator `amount` override. Changing an approved amount is a separate quote command with its own reason, actor, version, and Customer-visible result.

A manually supplied URL cannot be represented as an authoritative Stripe payment attempt unless the server verifies its Stripe object, account, currency, amount, booking/quote binding, and status. Until such verification exists, label it an external/manual reference and exclude it from paid/due computation.

The current `generate_stripe_pay_link` path is nonfunctional because `getBooking` is undefined. A minimal import-only repair would still leave the amount-override and revision problems, so the Release A repair must route through the canonical service rather than only fixing the exception.

## Quote changes and open sessions

When approved service or amount changes:

1. Create a new immutable `quoteVersion` and aggregate `bookingVersion`.
2. Mark every open older-version payment attempt `superseded`.
3. Expire/cancel the corresponding Stripe Session/Intent where the provider supports it.
4. Clear compatibility pay-link projections.
5. Do not create the replacement attempt until explicitly requested through a normal workflow.

Clearing a URL from `cd1-bookings` does not invalidate a URL already delivered to a Customer. Provider-side expiration is required.

## Settlement and invoice projection

The settlement ledger is append-only:

```text
ledgerEntry = {
  entryId,
  kind = "settlement" | "credit" | "refund" | "adjustment",
  amountCents,
  currency,
  providerObjectId?,
  providerEventId?,
  quoteVersion,
  occurredAt,
  recordedAt,
  actor
}
```

The Customer/Admin invoice or balance statement derives from:

- canonical quote line items and adjustments;
- approved amount and quote version;
- settlement/credit/refund entries;
- derived remaining amount; and
- payment attempt status/reference.

The statement must show the same values in Customer and Admin for the same `bookingVersion`. Stripe remains the payment processor, not the source of service pricing.

## Historical payments

Historical adapters must fail closed:

- legacy `Paid` and `Closed` map to completed history and zero payable balance unless an explicit reviewed debt record says otherwise;
- `paymentStatus=paid`, verified capture fields, or a compatible legacy settlement produce a ledger projection rather than leaving the original due intact;
- ambiguous/conflicting records show “payment review required” and disable payment;
- Release A reads legacy records non-destructively and records compatibility telemetry; it does not bulk rewrite production history.

## Stripe mode boundary

One shared Stripe client factory must run before all SetupIntent, Checkout, PaymentIntent, capture, policy-charge, and refund operations.

| Context | Allowed key/object mode | Required behavior |
|---|---|---|
| Local automated fixture | Stub/intercepted client or test key | No live-key dispatch; deterministic recorded request |
| Deploy preview | Test key only | Reject live-prefixed/misconfigured secret before network |
| Production | Explicit production configuration | Reject test/live mismatch according to deployment policy |

The audit found test-mode enforcement in setup/configuration paths but not uniformly across money-moving endpoints. No live or test Stripe object was created during this audit.

## Deterministic Release A acceptance matrix

| Scenario | Expected approved | Expected settled | Expected remaining | Stripe/result assertion |
|---|---:|---:|---:|---|
| New `$310` approved, unpaid | 31000 | 0 | 31000 | Session amount 31000, correct versions |
| `$310` approved, `$50` settled | 31000 | 5000 | 26000 | Session amount 26000 |
| Approved changes from `$310` to `$460`, `$50` settled | 46000 | 5000 | 41000 | Old 26000 session expired; new request sends 41000 |
| Existing add-on reselected | unchanged | unchanged | unchanged | No new price/session |
| Approved discounted `$256.50` | 25650 | 0 | 25650 | No route sends 28500 catalog total |
| Stale request against version N, current N+1 | unchanged | unchanged | unchanged | `409 quote_version_conflict`; no Stripe call |
| Customer balance Checkout completed | unchanged | increases once | decreases once | Duplicate completion is idempotent |
| Amount/currency/version mismatch | unchanged | unchanged | unchanged | Quarantine/review; no credit |
| Legacy Paid/Closed `$225` | historical projection | 22500-compatible | 0 | Payment disabled; no Stripe call |
| Preview with live key | N/A | N/A | N/A | `stripe_test_mode_required`; zero network calls |

## Payment rollback gates

Roll back Release A if any of these occur:

- displayed approved/remaining differs between Customer and Admin for the same booking version;
- Stripe amount differs from canonical `remainingCents` by any cent;
- a stale quote/session can still be paid;
- a completed matching payment is not credited exactly once;
- a mismatch is credited rather than quarantined;
- a paid/closed historical record becomes payable;
- any local/preview endpoint reaches Stripe with a live key; or
- a retained route derives a charge from catalog `totalPrice` when an approved amount exists.
