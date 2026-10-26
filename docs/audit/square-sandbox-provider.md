# Square Sandbox provider

This client is a local Square Sandbox probe. It is not the payment provider selected for Cardetail1.

`getActivePaymentProvider()` still returns `DisabledPaymentProvider`. The selected provider remains `none`. No environment variable changes that selection. Booking, My Garage, Quick Ops, Admin, the ledger, and Stripe do not import this client. There is no public HTTP endpoint that can run it.

Three kinds of test are different:

| Kind | What it does |
|---|---|
| Mock test | The automated tests pass a fake `fetch`. No connection to Square. |
| Square Sandbox test | `scripts/square-sandbox-smoke-test.js` calls `https://connect.squareupsandbox.com` with a sandbox access token. The charge is simulated by Square. |
| Production payment | Not implemented and not authorized. `https://connect.squareup.com` is rejected. |

## What the client can do

Square API version `2026-09-16`, confirmed against the Payments API reference and the 2026-09-16 changelog.

| Operation | Square endpoint | This phase |
|---|---|---|
| `createPayment` | `POST /v2/payments` | Sandbox only |
| `getPayment` | `GET /v2/payments/{payment_id}` | Sandbox only |
| `refundPayment`, `saveCard`, `chargeSavedCard`, `createPaymentLink` | none | `payment_provider_disabled` |

`createPayment` sends only `source_id`, `idempotency_key`, `amount_money`, and `autocomplete: true`. The source must be one of Square's published sandbox nonces, such as `cnon:card-nonce-ok` or `cnon:card-nonce-declined`. A customer card nonce is rejected before any request. The host is the constant `https://connect.squareupsandbox.com`. A caller cannot replace it.

An HTTP 2xx response is not treated as a completed payment. Completion requires Square `status` `COMPLETED`, amount and `USD` currency, a payment id, and a receipt URL on `squareupsandbox.com`. `APPROVED` and `PENDING` stay incomplete. A receipt on `squareup.com` is rejected.

The client does not insert `PaymentAttempt` or `LedgerEntry` and does not mark a booking paid. Cash, card at the appointment, and `external_manual` stay on their existing paths.

## Credentials

The only credential the client will send is `SQUARE_SANDBOX_ACCESS_TOKEN`, supplied in the environment of the local command. It is not read from `SQUARE_ACCESS_TOKEN` or any other production variable. If the sandbox variable is missing, blank, too short, or equal to a production token variable, the client returns an error and does not call Square.

Do not put the token in source, tests, documentation, logs, error messages, the frontend, or Netlify production variables. The token is not printed by the smoke script.

The client also refuses to run when `CONTEXT` or `NETLIFY_CONTEXT` is `production`, `deploy-preview`, or `branch-deploy`, and when it is running inside Netlify or Lambda. The local confirmation string does not override that refusal. CI sets `CI=true`; the smoke script exits before calling Square.

## Local smoke test

Mock tests do not need a token. The live sandbox script does.

```sh
SQUARE_SANDBOX_ACCESS_TOKEN='sandbox token from the Square developer dashboard' \
  node scripts/square-sandbox-smoke-test.js --confirm-square-sandbox
```

Without the token, the script prints `BLOCKED — SANDBOX CREDENTIALS NOT CONFIGURED` and does not call Square. Do not invent a token.

When the token is a real sandbox token, the script creates a simulated 100 cent USD payment with `cnon:card-nonce-ok`, reads that payment back, and repeats the same request with the same idempotency key. It prints only:

- `environment: sandbox`
- `paymentId`
- `status`
- `amountCents: 100`
- `currency: USD`
- `idempotency: same_payment` when the create, the read, and the retry all return that same id

`same_payment` means Square returned one payment for the repeated request. It does not mean Cardetail1 recorded a booking or a ledger entry.

## Idempotency

Square requires `idempotency_key` on `CreatePayment`. The key is at most 45 characters. This client does not generate a replacement key during a retry or a timeout. The caller supplies the key, and every attempt sends that same key.

Square's rule is: the same key and the same request return the original payment; the same key with a different body, including a different amount, returns an idempotency error and does not create another payment. A timeout or an HTTP 500 is `outcomeUnknown`. It is not a definitive financial failure and it is not success. Retry the original key. Do not start a second key for that unknown attempt.

## Declines

Use the sandbox nonce `cnon:card-nonce-declined` only in a mock or in a future explicit sandbox experiment. Square answers `CreatePayment` with HTTP 400 and `GENERIC_DECLINE`. This client maps that, and Square's other payment-method errors, to `square_sandbox_declined`. The payment is not completed. Automated tests cover that response without a network call.

## Reconciliation contract

`netlify/lib/square-sandbox-adapter-contract.js` is the boundary a future settlement component can read. It is not selected by `getActivePaymentProvider()`. It does not insert `PaymentAttempt` or `LedgerEntry`, mark a booking paid, send a notification, or open the webhook event database.

The contract follows the Payments API V2 Payment object for version `2026-09-16`: `id`, `status`, `amount_money.amount`, `amount_money.currency`, `location_id`, and `receipt_url` when Square includes it. That object does not document `merchant_id`. The contract does not require one and does not add one to a response. Square's Location object is where `merchant_id` is documented. This phase does not call RetrieveLocation.

Merchant and location trust come from one injected server object, `trustedSandbox`, with `configuredBy: 'server'`, a synthetic merchant id, a synthetic location id, and `locationMerchantId` equal to that merchant. That pair is configuration, not a live merchant check. `liveMerchantVerification` stays false. A caller field for merchant, location, host, or environment is rejected and is not promoted into the trusted object. A later integration that needs Square to confirm the pair must call the Locations API with the server's own credentials and compare `Location.merchant_id` with the server merchant id. Signed webhook merchant identity stays in the receiver.

A call also needs the test context `noncommercial-test`, the sandbox confirmation, purpose `sandbox_adapter_test`, and a server booking reference matching `TEST-`. A commercial `bookingId` is refused before any request. The reference is echoed on the result and is not sent to Square. `reference_id` on a Payment is not adopted. `bookingAssociationPersisted` stays false. A future settlement step has to write its own payment-to-booking association before it can settle. This phase does not write one.

The amount must be a positive integer number of cents and the currency must be `USD`. The contract does not apply the sandbox client's 100000-cent ceiling. That ceiling is a synthetic exercise limit inside `SquareSandboxProvider`, not a Cardetail1 price. Commercial amounts have to come from server-side pricing and an authorized obligation. This phase does not change commercial prices and does not remove the sandbox client's own cap.

`providerCompleted` is true only when Square status is `COMPLETED` and payment id, amount, currency, and trusted location all match. `eligibleForReconciliation` is true in that same case. `financiallySettled`, `settled`, and `paid` stay false. `APPROVED` is authorized only. `PENDING`, `CANCELED`, and `FAILED` are not eligible. An unknown status is not successful. An HTTP 2xx response is not itself a settlement. No financial writer is attached.

`receipt_url` is optional metadata. A missing receipt on a completed V2 payment does not block eligibility. When the field is present it must be an `https` URL on `squareupsandbox.com` (or a subdomain), with a `/receipt/` path and no user info, query, or fragment. The contract does not fetch that URL, does not copy it into the result, and does not treat the domain as a substitute for the API response. Any other URL is `square_sandbox_receipt_rejected`.

Idempotency uses the caller key that the sandbox client already validates. The same key and same body can return the same mock payment. The same key with a different amount returns Square's idempotency conflict and does not settle. A different currency is refused locally, before a request, because this sandbox contract is USD-only. A timeout stays `outcomeUnknown`. `idempotencyDurable` is false: the mock is not a database of operation ids. Future payment operations have to persist that identity before financial settlement. No migration is added here.

The contract and the Square Sandbox webhook receiver stay separate. They can later be compared, without either calling the other, on payment id, trusted location id, trusted merchant id, amount in cents, currency, and Square status. The receiver's merchant id comes from the signed event. This contract's merchant id comes from server configuration. Neither side writes the commercial ledger.

## Current limits

- Production payments are not implemented.
- The sandbox client is not connected to booking, My Garage, Quick Ops, Admin, or the ledger.
- Refunds, saved cards, and payment links are still disabled.
- No Square SDK is installed. The client uses `fetch`.
- A live sandbox smoke test has to be run by a person with a sandbox access token. CI never does that.
- Webhook signature verification is a separate module. It does not call this client and it does not expose an endpoint. See `docs/audit/square-webhook-verifier.md`.
