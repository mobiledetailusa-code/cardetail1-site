# Stripe financial safety baseline

Status: inventory only. This document does not enable Square, does not change a payment rule, and does not open a path that PR #365 closed.

HEAD at the time of the inventory: `1363ffcf96952ea5dc387b669cf7a13de63c2ade`.

The executable check is `tests/stripe-financial-safety-baseline.test.js`. A new `api.stripe.com` call in `netlify/` or `scripts/isolated-balance-proof.js` fails that test until it is classified.

## What this is not

- No Square SDK, Square environment variable, or payment-provider adapter.
- No database migration. `PaymentAttempt.provider` still defaults to `stripe`. `ProviderObjectType` is still `payment_intent | checkout_session | setup_intent`.
- `LedgerEntry` stays append-only. The Postgres triggers `ledger_entry_no_update` and `ledger_entry_no_delete` are unchanged.
- Booking, catalog, schedule, My Garage, Quick Ops, and the technician portal are unchanged.

## Customer-payment gate

`netlify/lib/stripe-customer-payments.js` opens production customer payments only when the baked deploy identity is production, it matches the runtime context, the baked boolean is `true`, and the runtime value is exactly `"true"`. The committed snapshot is `false`.

That gate covers customer SetupIntent, PaymentIntent, ceramic checkout, subscription checkout, payment resume, and saved-card charge. It does not automatically cover every admin or maintenance write.

`netlify/lib/stripe-mode.js` `guardStripeOrReject` is a different control. It rejects a live secret on local and preview. On `CONTEXT=production` it allows the configured secret, including a live secret. Closing the customer gate does not make this guard reject a refund.

## Write inventory

| Operation | Where | Authorization that actually runs | Customer gate in that function |
| --- | --- | --- | --- |
| CREATE PAYMENT | `reserveAndCreatePaymentIntentLocked` | `guardStripeOrReject` inside the function. Callers in `prepareEmbeddedPaymentInner` also apply the customer gate. | No |
| CREATE PAYMENT | `reserveCeramicPaymentIntent` | `guardStripeOrReject`. `ceramic-checkout-intent.js` applies the customer gate before calling it. | No |
| CREATE PAYMENT, confirm now | `chargeSavedCardAfterService` | Customer gate, then `guardStripeOrReject`. Requires `confirmCharge === true` and a saved `online_after_service` card. | Yes |
| CREATE PAYMENT | `admin-ops-jobs.js` `generate_stripe_pay_link` | `return 410` before the Checkout fetch. The fetch is unreachable. | No, dead |
| CREATE PAYMENT | `admin-ops-jobs.js` `charge_policy_fee` | `return 410` before the off-session PaymentIntent. No-show charging is not active. | No, dead |
| CANCEL | `cancelPaymentIntentAtStripe` | `guardStripeOrReject` only. | No |
| CANCEL | `expireStripeCheckoutSessions` | No guard inside the function. The only production caller, `expireSupersededAttempts`, applies `guardStripeOrReject` before passing the secret. | No |
| CANCEL | `generate_stripe_pay_link` session expire | Same 410 tombstone as the create above. Unreachable. | No, dead |
| REFUND | `createRefund` | `guardStripeOrReject` after a Postgres reservation. Ledger is not debited here; only a signed refund webhook appends a refund `LedgerEntry`. | No |
| SAVE CARD | `create-setup-intent.js` | Customer gate, then `guardStripeOrReject`, then Customer and SetupIntent creates. | Yes |
| SUBSCRIPTION | `customer-subscription-checkout.js` `create_checkout` | Customer gate, then `guardStripeOrReject`. `list_catalog` does not call Stripe. | Yes |
| OTHER FINANCIAL WRITE | `createCustomerSession` | `guardStripeOrReject` only. `prepareEmbeddedPaymentInner` applies the customer gate before the caller reaches it. | No |
| CAPTURE PAYMENT | `scripts/isolated-balance-proof.js` `POST .../confirm` | CI script. Refuses `sk_live_` / `rk_live_` / `pk_live_` and refuses any database host other than localhost. Not a site function. | No |
| READ ONLY | PaymentIntent retrieve, Checkout retrieve, price retrieve, SetupIntent retrieve, financial-audit list/retrieve | `guardStripeOrReject`, customer gate, or `assertStripeGet` (GET only, and only PaymentIntent list/search/retrieve). | Mixed |

There is no live `POST /v1/payment_intents/:id/capture` call. `capture-payment.js` returns 410 and has no Stripe URL. Immediate capture exists only where a PaymentIntent is created with `confirm=true` (`chargeSavedCardAfterService`, and the unreachable policy-fee block).

`create-payment-intent.js`, `create-payment-link.js`, and `customer-portal-pay.js` return 410 or 403 and have no `api.stripe.com` URL.

## Admin refund, and why PR #365 does not cover it

`admin-ops-jobs.js` action `record_refund_request` checks the admin session, booking version, and `postgresPaymentEnabled()`. It then calls `createRefund` without an environment override and without `fetchImpl`. `createRefund` reserves `RefundRequest` rows and then calls `guardStripeOrReject`. It never calls `productionCustomerPaymentsBlocked`.

So, with customer payments disabled:

- a new customer PaymentIntent, SetupIntent, or saved-card charge is refused;
- an authenticated admin refund is not refused by that same gate;
- if `CONTEXT=production` and `STRIPE_SECRET_KEY` is present, `guardStripeOrReject` allows the refund request to reach `POST /v1/refunds`.

This baseline does not change that rule. Historical refunds and new charges are different commercial actions. A later PR has to decide whether admin refunds stay available for already captured Stripe payments or freeze with the customer gate. That decision is not made here.

The unreachable `charge_policy_fee` block also has no idempotency key. It cannot run while the `return 410` stays first. Do not delete that return in order to "finish" the fee.

## Controls that exist

- Dual customer-payment flag, default closed.
- Live secret rejected on local and preview.
- Preview and branch-deploy write refusal on the payment endpoints.
- Idempotency keys on balance PaymentIntents, SetupIntents, saved-card charges, and refunds.
- One active PaymentAttempt per booking and quote version.
- Webhook signature check, 300 second tolerance, and `StripeEvent` inbox.
- Refund webhook, not the admin response, is what appends ledger refund money.
- Financial-history audit allows Stripe GET of PaymentIntents only, and only with `FINANCIAL_AUDIT_COVERAGE_START`.
- Ledger UPDATE and DELETE are rejected in Postgres.

## Controls that are absent

- The customer-payment gate on `createRefund`, `cancelPaymentIntentAtStripe`, `createCustomerSession`, and `reserveAndCreatePaymentIntentLocked` themselves. Some callers add the gate; the refund caller does not.
- A named admin flag for historical Stripe refunds.
- Square sandbox, Square webhook signature check, and a provider value other than `stripe`.
- An enum value for a Square payment or card. Adding one requires a migration, which this baseline does not include.

## Before any Square integration

1. Keep this inventory test green.
2. Confirm a Square sandbox account. None is configured in this repository.
3. Decide the admin-refund policy in its own PR.
4. Add provider-neutral ids beside `stripeCustomerId` and `stripePaymentMethodId`. Do not overwrite historical Stripe ids.
5. Keep `LedgerEntry` append-only. New processor rows are new rows.
6. Do not treat a booking payment preference as a captured payment.
