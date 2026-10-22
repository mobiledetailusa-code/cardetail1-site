# Payment provider adapter

The payment provider adapter is an internal boundary for a future external processor. Nothing in booking, My Garage, Quick Ops, Admin, the technical portal, the Stripe webhook, or historical Stripe refunds imports it. No new processor is active.

## Responsibility

`netlify/lib/payment-provider-adapter.js` names the operations a processor would own and refuses all of them. It does not calculate prices, create bookings, settle the ledger, or replace the existing Stripe code.

The database default of `PaymentAttempt.provider` stays `stripe`. That column identifies historical attempts. It is not the switch for new operations.

## Interface

`getActivePaymentProvider()` returns `DisabledPaymentProvider`. The operations are:

| Operation | This phase |
|---|---|
| `createPayment` | refused |
| `getPayment` | refused; historical rows are not read here |
| `refundPayment` | refused |
| `saveCard` | refused |
| `chargeSavedCard` | refused |
| `createPaymentLink` | refused |

Money-moving operations are `createPayment`, `refundPayment`, `saveCard`, `chargeSavedCard`, and `createPaymentLink`. `getPayment` is included so a lookup cannot reach a processor either.

## Provider `none`

`none` means no external processor is selected for a new operation. It is a constant in this module. Environment variables, including any Stripe or Square variable, do not change it. This phase has no flag that can enable payments.

## Disabled operations

`DisabledPaymentProvider` returns `ok: false`, `error: payment_provider_disabled`, and HTTP 403. `providerCalled`, `externalCall`, `paid`, and `created` are false. The method does not call `fetch`, Stripe, Square, or a database client. It does not insert `PaymentAttempt`, `LedgerEntry`, `StripeEvent`, or `RefundRequest`, and it does not update an existing financial row.

An online preference (`online_after_service`, `card_online`, `card_on_file`) is not a completed payment. Calling the adapter with that preference does not set a booking to `paid`.

## Offline settlement stays outside

These identifiers already exist. The adapter does not invent replacements.

| Real identifier | Meaning |
|---|---|
| `cash` | Full-balance cash settlement already recorded by the ledger path |
| `card_on_site` | Full-balance card taken at the appointment, same ledger path |
| `cash_onsite` | Customer preference for cash. Not collected money |
| `card_onsite` | Customer preference for a card at the appointment. Not collected money |
| `external_manual` | Admin handling label used while online card payment is closed |

There is no `card_at_service` or `external_transfer` state in the repository. Card at the appointment is `card_on_site` / `card_onsite`. Manual handling is `external_manual`.

A call that names one of those identifiers returns `offline_settlement_outside_adapter` and does not become a processor operation. Cash and card-at-service bookings continue through the existing booking and ledger code.

## Historical Stripe and a future processor

`describeProviderRoles` keeps three facts apart:

- `historicalProvider` is the provider stored on an existing transaction. When the record has no provider value, the description uses the schema default `stripe`. This function does not write that default.
- `selectedProvider` is the provider for a new operation. It is `none`.
- `effectiveProvider` is the processor responsible for an existing transaction. A Stripe PaymentIntent stays Stripe. A new operation with no historical row has effective provider `none`.

`providerObjectId`, `providerObjectType`, `stripePaymentIntentId`, and `stripeCustomerId` are not rewritten. A Stripe transaction is not converted to another processor. Settled ledger rows are not changed.

Historical Stripe customer payments remain behind `STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED`. Historical refund initiation remains behind `STRIPE_LEGACY_REFUNDS_ENABLED`. This adapter does not open either gate. Signed Stripe webhooks stay on their current path.

## Current limits

- The adapter is not connected to any customer or admin flow.
- No Square SDK is installed. A separate sandbox client can call Square only from an explicit local script. It is not selected by `getActivePaymentProvider()`.
- No production flag can turn the adapter on.
- Historical reads and settlements stay in the existing services.
- `getPayment` does not query the ledger. Existing financial screens keep their current reads.

## Square Sandbox

`netlify/lib/square-sandbox-provider.js` implements `createPayment` and `getPayment` against Square Sandbox only. The active provider remains `none`. See `docs/audit/square-sandbox-provider.md`. Booking, the ledger, and production Square are not connected.

`netlify/lib/square-webhook-verifier.js` checks a Square webhook signature and stops there. It is not an HTTP endpoint and it does not select a provider. See `docs/audit/square-webhook-verifier.md`.
