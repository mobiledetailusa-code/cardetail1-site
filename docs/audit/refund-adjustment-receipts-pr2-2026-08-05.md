# PR2 — Quote adjustments, Stripe refunds, and authoritative receipts

**Status: READY FOR OWNER REVIEW**

Date: 2026-08-05

Branch: `fix/refund-adjustment-receipts-pr2`

Stack base: PR #158 / `fix/financial-invariants-pr1` at `44faa555184ed130d4720b407f91f465155544f1`

Protected predecessor: PR #157 remained at `0c6ae0ac1393da37e71bb08d83c9ead51f1237cc`

## Outcome

PR2 turns price changes, credits, Stripe refunds, and receipts into explicit versioned financial operations over the PostgreSQL authority introduced by PR1.

- Admin increases/decreases are proposal → approval/decline → apply operations with booking-version and quote-version compare-and-set checks.
- Applying an adjustment creates one immutable quote version. Existing settlements and PaymentIntents are not rewritten.
- A post-payment increase creates only an unpaid delta; a decrease exposes a credit/refund due without a negative ledger entry.
- Stripe refunds are reserved in PostgreSQL, issued with deterministic idempotency keys, and written to the ledger only after a signed refund webhook passes all bindings.
- A booking-level refund that spans an original payment and later delta PaymentIntent is split safely into one provider refund per PaymentIntent.
- Receipts fail closed when PostgreSQL authority is unavailable and render money only from the approved QuoteItem snapshot and append-only ledger.

No production migration, production deploy, merge, live Stripe request, SMS, secret change, or Owner Studio change was performed.

## Scope and isolation

Changed surfaces are limited to:

- authoritative quote/refund/receipt services and projections;
- Stripe refund webhook dispatch and minimized inbox payloads;
- Admin adjustment/refund controls;
- customer receipt endpoint, projection, and page;
- additive Prisma schema/migration;
- focused regressions and existing expectations affected by the new authority.

PR2 is stacked on PR1, not mixed into PR157. `git diff --name-only` found no Owner Studio file.

## Architecture: before and after

### Before PR2

1. Admin price-adjustment records lived in Blob compatibility state.
2. The PostgreSQL adjustment helper could create a quote without reason, operation identity, approval identity, or stale-tab CAS.
3. Refund execution was deliberately disabled by PR1; the former Blob-only `mark_refunded` path could not be financial authority.
4. `charge.refunded` / `refund.updated` compatibility code could change Blob status without an atomic PostgreSQL refund ledger entry.
5. The receipt endpoint could fall back to Blob totals and the page did not render approved QuoteItems, refund rows, safe provider references, or credit/refund-pending amounts.

### After PR2

1. Blob keeps operational proposal/decision UX; PostgreSQL owns the applied immutable quote and money projection.
2. Quote apply locks the Booking row, checks the expected quote version, rejects an active PaymentIntent, records actor/reason/approval, copies the prior snapshot, appends an explicit signed adjustment line, and creates exactly one next version.
3. Refund reservation locks the Booking, checks the approved quote version and unrefunded settlement per PaymentIntent, reserves all parts atomically, and writes a non-PII AuditEvent.
4. Stripe API responses never debit the ledger. Only `refund.created`, `refund.updated`, or `refund.failed` received through the signed webhook can transition the request and append `LedgerEntry(kind=refund)`.
5. Admin and customer projections share PostgreSQL values; Blob is compatibility output only.
6. Receipt authorization remains customer-scoped, but the amount/item/refund response is an explicit allowlist derived from PostgreSQL QuoteItems and ledger rows.

## Defects closed

| Defect | Resolution |
|---|---|
| Two stale Admin tabs could target the same next quote | Serializable Booking lock + expected quote-version CAS + unique `(bookingId, quoteVersion)` |
| Replaying an adjustment could mint another quote | Unique `adjustmentId`; same content returns the existing quote; changed content conflicts |
| Increase after payment risked rewriting paid money | Prior settlements remain immutable; `remainingCents = revised approved - net settled` |
| Decrease after payment could be represented as negative money | No adjustment/refund ledger row is created during quote apply; explicit `outstandingCreditCents` is exposed |
| Manual “mark refunded” could claim movement that had not occurred | Endpoint tombstoned with HTTP 410; Admin exposes only “Issue Stripe refund” |
| Stripe timeout could cause a duplicate refund | PostgreSQL reservation plus deterministic per-part Stripe Idempotency-Key; retry reuses the same request |
| Same refund key could be reused with changed amount/reason/version | Local payload equality check returns `refund_request_conflict` before Stripe |
| Full booking refund could exceed one delta PaymentIntent | Amount is allocated across eligible succeeded PaymentIntents; each part has its own row/key/webhook |
| Stripe API success could be mistaken for ledger success | API response stays `pending_webhook`; signed webhook is the sole ledger authority |
| Duplicate/out-of-order refund event could double-debit or regress success | Unique provider IDs/event IDs, row locks, terminal-state rule, provider event timestamp, append-only unique ledger key |
| `charge.refunded` summary lacked refund-level bindings | It is acknowledged without mutation; refund-level events are authoritative |
| Concurrent statements inside one interactive PG transaction were unsafe | Transaction statements are sequential; serialization/deadlock retries recognize Prisma and SQLSTATE codes with bounded backoff |
| Existing PR1 Quote rows could lack QuoteItems | Exact stored Blob quote snapshot is backfilled once under a Quote row lock; legacy missing snapshots get one transparent approved-total line, never current-catalog repricing |
| Receipt page omitted refund/item detail | Approved quote version/items, payments, masked references, refunds, gross/net paid, balance, pending refund, and credit due are rendered |

## Quote-adjustment state machine

| Operation | Preconditions | Durable result |
|---|---|---|
| Create | type, positive cents, reason, expected Booking version | `draft` or `pending_customer`/`approved` proposal in operational state |
| Decide | expected Booking version; pending record | approval/decline identity, time, and reason |
| Apply | approved record; expected Booking + Quote versions; no active payment attempt | immutable PostgreSQL Quote version, copied QuoteItems, signed adjustment line, AuditEvent |
| Replay | same adjustment ID, booking, amount, reason | existing quote; no second version |
| Stale tab | version differs | HTTP 409; no quote, ledger, or PaymentIntent mutation |

An already confirmed PaymentIntent is never edited. If the revised total is higher, the existing settlement counts toward the new quote and only the delta remains payable. If lower, the credit is explicit and must be handled by the refund authority.

## Refund state machine and invariants

`RefundRequestStatus` values:

- `creating`
- `pending_webhook`
- `requires_action`
- `succeeded`
- `failed`
- `canceled`

Durable invariants:

- positive integer cents and lowercase currency;
- one unique local `idempotencyKey` per provider refund part;
- one unique `(requestGroupKey, partIndex)` per booking-level operation;
- one unique Stripe `providerRefundId` per request;
- refund amount is reserved only against a succeeded Stripe PaymentIntent and its remaining unrefunded/unreserved settlement;
- booking, quote version, purpose, currency, amount, request ID, and PaymentIntent metadata must all match;
- Stripe network timeout leaves `creating` recoverable with the same key;
- successful provider response is not ledger authority;
- signed succeeded refund event appends one positive refund ledger row identified by `refund_<re_id>`;
- succeeded is terminal; older/duplicate events are neutral;
- failures are sanitized and the inbox remains reprocessable;
- `charge.refunded` performs no financial mutation.

## Receipt assessment

The receipt now contains:

- legal/brand display (`Detailing Zone L.L.C.`) and `cardetail1.com` contact;
- deterministic unique receipt number and Booking reference;
- issue/service/completion dates where available;
- customer, vehicle, service address for final receipts, packages, and add-ons;
- approved quote version and authoritative QuoteItem rows;
- service subtotal, travel, discount/offer, adjustment, and tax lines when present in the approved snapshot;
- approved total, gross paid, refunded, net paid, remaining balance, pending refund, and credit/refund due;
- truthful payment method (`Cash`, `Card`, or `Cash and card`) without invented digits;
- masked safe `pi_••••xxxxxx` / `re_••••xxxxxx` references;
- `Paid`, `Partially Paid`, or `Refunded` status;
- short provider-confirmation term and company contact.

The receipt does not spread database/provider objects and does not expose `client_secret`, card data, raw Stripe payloads, payment-method IDs, vehicle database IDs, refund request IDs, or another customer's information. The browser formats no money and performs no authoritative arithmetic.

### Tax and commercial decision

The New Jersey Sales Tax Guide says Sales Tax must be separately stated on a sales slip, invoice, receipt, or similar statement when applicable, and requires accurate sales records. PR2 therefore renders an approved `tax`/`taxes` QuoteItem separately but does **not** invent a tax rate or recompute tax in the receipt. Owner/accountant confirmation is still required on whether each detailing service/location is taxable and on the canonical tax engine/configuration before a tax line is produced.

The receipt brand remains `Detailing Zone L.L.C.` while the customer-facing site is `cardetail1.com`. Owner must confirm whether `Cardetail1` is a DBA/brand that should also appear on the legal receipt. This is a presentation decision, not a reason to mutate financial history.

## Primary-source decisions (researched 2026-08-05)

- [Stripe Create a refund](https://docs.stripe.com/api/refunds/create): a refund targets a Charge or PaymentIntent; partial refunds are allowed only up to that payment's remaining unrefunded amount. This is why a booking refund spanning original and delta payments is split per PaymentIntent.
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests): POST retries should reuse an idempotency key; Stripe rejects reuse with changed parameters. PR2 enforces the same equality before the request leaves the server.
- [Stripe refund webhook update](https://docs.stripe.com/changelog/acacia/2024-10-28/refund-webhook-update): `refund.created`, `refund.updated`, and `refund.failed` carry refund-level detail and remove the need to rely on `charge.refunded` summaries.
- [Stripe receipts](https://docs.stripe.com/receipts): receipts exist only for successful payments/refunds and should reflect refund status. Cardetail1's receipt remains app-authenticated and ledger-derived; no expiring Stripe receipt URL is exposed.
- [New Jersey Sales Tax Guide](https://nj.gov/treasury/taxation/pdf/pubs/sales/su4.pdf): applicable Sales Tax must be separately stated and sales records retained. PR2 displays the tax line exactly when it exists in the approved quote.

## Migration

Migration: `prisma/migrations/20260805143000_quote_refund_receipts_pr2/migration.sql`

Additive changes:

- `RefundRequestStatus` enum;
- Quote adjustment identity/reason/approval columns;
- `RefundRequest` table with Booking and PaymentAttempt foreign keys;
- positive amount/lowercase currency checks;
- unique local idempotency key and provider refund ID;
- booking, payment-attempt, state, group, and unique group-part indexes.

No existing table, quote, attempt, ledger entry, or event row is deleted or rewritten.

### Migration evidence

| Gate | Result |
|---|---|
| Prisma format/generate/validate | pass, Prisma 7.8.0 |
| Fresh PostgreSQL 16 history | pass, 6/6 migrations on `cardetail1_pr2_empty_20260805b` |
| Migration/schema parity | pass, `No difference detected` |
| Required refund group columns/indexes | pass, 2 columns and 2 indexes found |
| Representative PR1 upgrade | pass on `cardetail1_pr2_upgrade_20260805b` |
| Existing row counts before → after | Booking 1→1; Quote 1→1; PaymentAttempt 1→1; LedgerEntry 1→1 |
| Existing settled quote | `$125.00`, `settled`, unchanged; new adjustment fields null |

All databases above are isolated local test databases. No production database was contacted.

## Verification evidence

| Gate | Result |
|---|---|
| Full repository suite | **2,169 passed; 0 failed; 0 skipped; 134 suites; 54.739 s** |
| Focused concurrent financial/receipt batch | 136 passed; 0 failed |
| PR2 invariant suite | 12 passed; 0 failed |
| Changed JavaScript syntax | pass |
| Prisma schema validation | pass |
| Deterministic pre-deploy audit | pass, generated 2026-08-05T07:16:46Z |
| Netlify build | pass, `deploy-preview`, offline, @netlify/build 36.2.4, 1m15.6s |
| `git diff --check` | pass |
| Stripe calls in tests | injected fake/test-shaped responses only; no live API call |
| SMS/Twilio | no message sent |
| Production deploy/merge | not performed |

High-value test cases include:

- two stale Admin tabs racing for quote version 2;
- same adjustment ID replay and changed-content conflict;
- positive delta after full payment without changing the original attempt;
- decrease/credit without a negative ledger entry;
- refund timeout and same-key retry;
- changed refund payload rejected before Stripe;
- partial and full refund;
- full refund split across original and delta PaymentIntents;
- signed refund webhook, duplicate delivery, out-of-order failure, terminal success;
- receipt full/partial/on-site/add-on/discount/positive adjustment/partial refund/full refund/cancellation;
- approved QuoteItem backfill under concurrent receipt loads;
- two-customer receipt authorization/isolation;
- no secret/raw payload/internal provider ID leakage;
- deterministic unique receipt numbers and no duplicate payment credit.

## UI evidence

The Admin/receipt changes are covered by inline-script parsing, jsdom interaction contracts, server capability tests, receipt render-source assertions, mobile/print CSS assertions, and customer-authorization integration tests. No authenticated staging deployment was authorized for PR2, so no screenshot with fabricated customer/payment data was added. PR1's real local browser evidence for ZIP → vehicle and the card-save notice remains in its audit report.

## Deployment instructions (Owner-controlled; not executed)

1. Review and merge the stack in order: PR157 → PR158 → PR2.
2. Take a database backup and confirm the target is PostgreSQL 16.
3. Confirm the Stripe webhook endpoint API version supports refund-level events.
4. Add `refund.created`, `refund.updated`, and `refund.failed` to the webhook endpoint's enabled events; retain required PaymentIntent events.
5. Apply `prisma migrate deploy` before routing PR2 application traffic.
6. Confirm `DATABASE_URL`, `DIRECT_URL`, `CD1_POSTGRES_PAYMENT`, Stripe test keys, and webhook secret in a non-production deploy-preview/canary first.
7. In Stripe test mode, exercise: partial refund, full refund, original+delta split, delayed webhook, duplicate delivery, and failed refund.
8. Verify Admin and My Garage projections agree after each webhook and that receipts show masked references only.
9. Confirm the taxability/tax-line and legal-brand/DBA decisions before production use.
10. Monitor failed/pending RefundRequest and StripeEvent counts; do not use the tombstoned manual mark endpoint.

## Rollback

1. Stop new refund/adjustment actions in the Admin UI.
2. Roll application code back to PR1 first.
3. Keep the additive table/columns/indexes in place; they are backward-compatible and contain audit/financial history.
4. Do **not** delete or edit succeeded RefundRequests, StripeEvents, Quote versions, or LedgerEntries.
5. Continue accepting Stripe webhooks or reconcile pending provider outcomes before any later schema cleanup.
6. If a provider refund was accepted but the webhook is delayed, retry/replay the signed event; never insert a manual refund ledger row.

A destructive down migration is intentionally not provided.

## Remaining risks and Owner decisions

- Confirm Stripe webhook endpoint API version and enable the three refund-level event types before production.
- Confirm NJ taxability and canonical tax calculation with the company's accountant; receipt rendering is ready but does not create tax.
- Confirm whether the legal receipt should say `Detailing Zone L.L.C.`, `Cardetail1`, or `Detailing Zone L.L.C. d/b/a Cardetail1`.
- PR2 synchronizes compatibility state after refund webhooks; PR3 remains responsible for measuring and hardening end-to-end Admin ↔ Customer propagation/latency.
- Customer self-approval of an adjustment remains PR3 portal work. PR2 lets Admin record customer approval with confirmation and full audit identity.
- Live Stripe test-mode evidence and authenticated staging screenshots require an Owner-approved deploy-preview with configured secrets; neither was fabricated locally.

## Owner review checklist

- [ ] Review the immutable quote/delta/credit semantics.
- [ ] Review the booking-level multi-PaymentIntent refund split.
- [ ] Confirm webhook API version and enabled refund events.
- [ ] Confirm taxability/tax engine with the accountant.
- [ ] Confirm receipt legal brand/DBA display.
- [ ] Review migration backup/deploy order and non-destructive rollback.
- [ ] Run the Stripe test-mode canary before approving production.
- [ ] Do not merge PR2 before PR158.

**Final PR2 classification: READY FOR OWNER REVIEW.**
