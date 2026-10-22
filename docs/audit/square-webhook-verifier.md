# Square webhook signature verification

This module checks a Square webhook signature and interprets the validated event. It is not a public endpoint. Nothing in booking, My Garage, Quick Ops, Admin, the Stripe webhook, or the ledger imports it. `getActivePaymentProvider()` still returns `DisabledPaymentProvider`. The selected provider remains `none`.

No Square subscription is registered in this phase. No production notification URL is configured.

## Signature

Square's webhook protocol signs the exact notification URL concatenated with the raw request body. The key is the webhook signature key. The algorithm is HMAC-SHA256. The digest is base64. The header name is `x-square-hmacsha256-signature`.

`verifySquareWebhookSignature` applies that protocol and compares the digest with `crypto.timingSafeEqual`. When the lengths differ, it still uses `timingSafeEqual` on an equal-length buffer and then rejects the signature. It does not compare the signature with `===`.

The function does not parse JSON. An object is rejected instead of being stringified. The raw bytes are not rewritten before the HMAC. The notification URL is the string supplied by the caller. A `Host` or `X-Forwarded-Host` header is never used to build that URL.

These inputs are rejected:

| Condition | Error |
|---|---|
| Body is not a string or buffer | `square_webhook_body_unusable` |
| URL missing | `square_webhook_notification_url_missing` |
| URL is not `https`, or its host is `cardetail1.com`, a subdomain of it, `connect.squareup.com`, or `connect.squareupsandbox.com` | `square_webhook_notification_url_rejected` |
| Signature key missing | `square_webhook_signature_key_missing` |
| Signature missing | `square_webhook_signature_missing` |
| Signature, URL, key, or body does not match | `square_webhook_signature_invalid` |

A rejected result uses status `403` only as a label for a future HTTP handler. This module does not send a response. A valid result has `parsed: false`, `paymentConfirmed: false`, `paid: false`, and `financialEffect: 'none'`. The signature key and the body are not copied into the result.

The published Square example is covered by the tests: URL `https://example.com/webhook`, key `asdf1234`, body `{"hello":"world"}`, signature `2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=`. That key is Square's documentation sample, not a Cardetail1 credential. This module does not read `SQUARE_SANDBOX_ACCESS_TOKEN` or any Netlify variable.

## Events

`interpretVerifiedSquareWebhook` parses JSON only after the signature result is verified and the SHA-256 of the same raw body matches that result. A caller cannot pass `verified: true` with a different body.

Recognized types are `payment.created` and `payment.updated`. The fields read from a recognized event are `event_id`, `merchant_id`, `type`, `created_at`, `data.object.payment.id`, `data.object.payment.status`, and `data.object.payment.amount_money.amount` with `currency`.

Square's documented payment statuses are `APPROVED`, `PENDING`, `COMPLETED`, `CANCELED`, and `FAILED`. `COMPLETED` is the only status that means Square reported the payment complete (`squareReportedCompleted: true`). `APPROVED` and `PENDING` are not complete. `FAILED` and `CANCELED` are not payments received. Any other status string is `statusClass: 'other'` and is not treated as complete. The British spelling `CANCELLED` is not the Square `CANCELED` status.

An unknown event type returns `unknownEvent: true` and `financialEffect: 'none'`. A missing field on a recognized type returns `square_webhook_payload_incomplete`. When the caller supplies `expectedMerchantId` and the event merchant differs, the result is `square_webhook_merchant_unexpected`. Omitting that argument does not authorize the merchant. This phase has no merchant registry and still executes no financial effect.

Receiving an event, including a `COMPLETED` event, does not confirm a Cardetail1 payment. `paymentConfirmed`, `paid`, and `created` stay false.

## Order and duplicates

`reviewSquareWebhookSequence` reviews one caller-supplied list and returns. The set of event ids inside that call is discarded. A second call does not remember the first. That is intentional.

| Arrival | Result |
|---|---|
| First valid event | `apply: true`, no financial effect |
| Same `event_id` again in the list | `duplicate: true`, state unchanged |
| Different `event_id` for the same payment | not a duplicate; `samePayment: true` |
| Older `created_at` after a newer event | `older_event_after_newer`, status unchanged |
| `payment.created` after an applied `payment.updated` | `created_after_updated`, status unchanged |
| Newer status for the same payment | `statusChanged: true`, `paymentConfirmed: false` |
| Incomplete, unknown, unexpected merchant, or unbound object | not applied |

`PERSISTENT_DEDUPLICATION_CONTRACT` records the future requirement: `implemented: false`, `durable: false`, `productionSafe: false`, `memoryOnlySufficient: false`. Deduplicating in memory is not enough for production. Square retries webhook deliveries across processes. A future integration has to persist `event_id` and the reconciled financial state. This phase does not create that table and does not write the database.

## What this module does not do

It does not create a payment attempt, write a ledger row, change a payment status, confirm a booking, charge a card, refund a payment, create a payment link, update a balance, change a reservation, or send a commercial notification. It does not call `fetch`. It does not import Stripe, Prisma, or the Square Sandbox client. A validated event is not authorization to create another charge.

## Tests

`tests/square-webhook-verifier.test.js` uses the documentation sample and local HMAC fixtures. It does not use a real signature key and it does not call Square. CI does not gain a Square token or a webhook URL.

## Future sandbox receiver

Not implemented in this phase. Do not subscribe to Square notifications yet. A later, separate change would have to include all of the following before any sandbox delivery is accepted:

- An isolated HTTPS endpoint used only for Square Sandbox, not `https://cardetail1.com` and not a production Square host.
- A signature key that belongs only to that sandbox webhook subscription. The key stays in server configuration and is never written to source, logs, or the browser.
- The exact notification URL registered in the Square Sandbox dashboard. The verifier must receive that same string. It must not be taken from the request `Host` header.
- HMAC authentication with this module before JSON is trusted. A missing or invalid signature is rejected. Square's own samples use HTTP 403 for an invalid signature. HTTP 200 is reserved for an authenticated delivery and is not proof of a completed payment.
- No ledger write, no payment attempt, and no call into booking, My Garage, Quick Ops, Admin, Stripe, or the Square payment client.
- A maximum body size and a rate limit, so retries cannot overwhelm the process.
- Safe retries. Square resends a notification when the endpoint does not return a `2xx` response. The same `event_id` must be stored durably before a `2xx` response. An in-memory set is not that store. A retry must not create a charge.
- Minimal diagnostic logs: event id, type, and the verification result. No signature key, no raw payload, and no access token.
- No production subscription and no change to `getActivePaymentProvider()`.

Until that separate change exists, there is no public Square webhook route.
