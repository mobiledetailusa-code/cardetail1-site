# Legacy Stripe refunds

Administrative refunds of historical Stripe payments are closed unless `STRIPE_LEGACY_REFUNDS_ENABLED` is exactly the string `true`. Any other value, including absence, is closed. The committed deploy snapshot does not set this variable.

The flag is independent of `STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED`. Turning refunds on does not open customer payments, PaymentIntents, saved cards, Payment Links, no-show charges, or subscriptions.

When the flag is closed:

- `record_refund_request` returns HTTP 403 `legacy_stripe_refunds_disabled` before `ensureBookingFinancial`.
- `createRefund` returns the same error before a `RefundRequest` insert and before `POST /v1/refunds`.
- The response is not a refund. `refunded` is false and no ledger entry is written by that request.
- Admin authentication on `admin-ops-jobs` remains in front of the action.

When the flag is explicitly open, the existing refund rules remain:

- the admin session is still required;
- the original succeeded Stripe PaymentIntent, quote version, available amount, and idempotency key are still checked;
- the Stripe response does not settle the ledger;
- a signed `refund.created`, `refund.updated`, or `refund.failed` webhook remains the settlement authority;
- a payment whose provider is not `stripe`, or whose object id is not a PaymentIntent (`pi_`), is not sent to Stripe. That includes a future Square payment.

Inbound webhook reconciliation is intentionally not behind this flag. A refund Stripe already accepted can still be recorded after the flag is turned off. The flag stops new refund initiation only.

Do not set `STRIPE_LEGACY_REFUNDS_ENABLED=true` in production as part of this change.
