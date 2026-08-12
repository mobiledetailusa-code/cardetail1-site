# Owner Studio — Offers & Discounts module (design)

**Status:** design only. No code in this document is implemented.
**Companion:** [`owner-studio-control-plane-matrix.md`](./owner-studio-control-plane-matrix.md), which lists
"Discounts / promotions / quote rules" as **Money / Not-modeled**.

## 1. What already exists

A discount engine is already in production — it is just not editable by the owner.

`netlify/lib/booking-offers.js` implements a single hardcoded offer:

| Field | Value |
|---|---|
| Offer id | `first_booking_welcome` |
| Version | `WELCOME10-v1` |
| Public name | New Customer Welcome — 10% |
| Eligibility | Zero prior completed services, no prior welcome redemption, not a custom-quote booking |
| Applies to | `computeEligibleServiceSubtotalCents(booking)` |

Two properties of that file are load-bearing and must survive any redesign:

1. **`CLIENT_OFFER_BLOCKED_FIELDS`** — `discountAmount`, `discount_amount`, `offerDiscount`,
   `offer_discount` and friends are stripped off the inbound booking before anything reads it.
   The browser cannot propose a discount. This is correct and non-negotiable.
2. **Eligibility is recomputed server-side** from booking history, never trusted from the client.

So the ask "uma seção de desconto no final do checkout" is not a missing engine. It is a missing
**control plane** over an engine that already exists, plus a checkout surface for the one thing a
customer legitimately supplies: a code they were given.

## 2. What is actually missing

| Gap | Today | Consequence |
|---|---|---|
| Owner cannot create an offer | Code edit + deploy | Every promotion is an engineering ticket |
| Only one offer can exist | Single `WELCOME10-v1` constant | No seasonal, no referral, no win-back |
| No customer-supplied codes | No concept of a code | Cannot run "SPRING20" on a flyer |
| No stacking rules | One offer, so the question never arose | Two offers would silently both apply |
| No budget / redemption cap | Unbounded | A leaked code has no ceiling |
| No audit of who changed what | — | Financial change with no trail |

## 3. Why the discount cannot live at the end of checkout

The obvious shape — a "discount code" input next to the total that subtracts from the amount — is
the one shape this codebase explicitly forbids, and rightly.

The invariant, enforced by tests in `package-financial-mutation` and `addon-financial-mutation`:

> browser price/amount/total/proposedTotal are ignored — catalog price wins
> operator-supplied price/name/total fields are ignored — catalog price wins

The amount charged is derived server-side by `canonical-quote.js` and handed to Stripe as an exact
figure with the quote version in metadata. A discount is therefore **an input to the quote, not a
subtraction from it**. The correct flow:

```
customer enters code at checkout
  → code sent to server (a string, never an amount)
  → server resolves code → offer rule → validates eligibility, window, budget, stacking
  → canonical-quote recalculates with the discount as a priced line
  → immutable quote snapshot records offerId + offerVersion + discountCents
  → Stripe PaymentIntent for the exact recalculated amount
  → webhook settles against that quote
```

The customer's browser supplies a **code**. It never supplies a **value**. Everything else in this
document follows from that one line.

## 4. How stable products model this

Four reference models, chosen because each solves a different part of the problem:

**Stripe (Coupons / Promotion Codes).** Splits the concept in two: a *coupon* is the rule (percent
or fixed amount, duration, redemption cap, expiry); a *promotion code* is a customer-facing string
pointing at a coupon. One coupon can have many codes. This split is the single most valuable idea
to copy — it lets you run the same promotion across a flyer, an email and a partner with separate
codes and separate tracking, without duplicating the rule or its budget.

**Shopify (Discounts).** Adds the parts a service business needs: an explicit
`combinesWith` matrix (product / order / shipping) so stacking is declared rather than emergent, a
minimum-purchase threshold, per-customer usage limits, and scoping to specific products or
collections. The lesson: **stacking must be a declared property of each offer**, not an accident of
evaluation order. Our equivalent scoping axis is category / package / add-on.

**Square and Toast (service & hospitality POS).** Both distinguish *automatic* discounts from
*applied* ones, and both require a reason code plus operator identity on any manual discount, which
lands in an audit report. That is the model for the Admin side: a technician or admin granting
goodwill on-site is a different act from a customer redeeming a code, and it must be attributable.

**Sanity and Contentful (the control-plane half).** Draft → validate → publish → immutable version,
with rollback to a prior version. Owner Studio already implements exactly this for the catalog. An
offer is content with financial consequences, so it belongs in the same draft/release lifecycle
rather than in a live-edit admin table.

The synthesis: **Stripe's rule/code split, Shopify's declared stacking and scoping, Square's
attributable manual discounts, all inside Owner Studio's existing draft → release lifecycle.**

## 5. Proposed model

```
OsOffer                     the rule (Stripe "coupon")
  offerId, siteId, name, internalNotes
  kind                      percent | fixed_amount
  percentBps                integer basis points (2000 = 20%) — never a float
  amountCents               integer cents, for fixed_amount
  appliesTo                 order_subtotal | category | package | addon
  scopeIds[]                category / package / add-on ids for the non-order scopes
  minSubtotalCents          threshold
  combinesWith[]            offerIds this may stack with; empty = exclusive
  startsAt, endsAt
  maxRedemptions            global cap
  maxPerCustomer            per-identity cap
  budgetCents               total discount spend ceiling
  trigger                   automatic | code
  active

OsOfferCode                 the customer-facing string (Stripe "promotion code")
  code (unique, case-insensitive), offerId, active, maxRedemptions, endsAt

OsOfferRedemption           immutable ledger, one row per applied discount
  redemptionId, offerId, offerVersion, codeId, bookingId, quoteId
  customerIdentityKey, discountCents, appliedAt
  grantedBy                 'system' | admin username, for manual grants
  reasonCode                required when grantedBy is not 'system'
```

Three deliberate choices:

- **`percentBps`, not a float percentage.** Same reasoning as `amountCents` everywhere else in this
  codebase: 20% is `2000`, and no rounding drift can enter through the rule itself.
- **`OsOfferRedemption` is a ledger, not a counter.** Caps are derived by counting rows, so a cap
  can never drift from reality, and every discount ever granted is attributable. This mirrors how
  `PaymentAttempt` / `LedgerEntry` already work.
- **`combinesWith` defaults to empty (exclusive).** The safe default for money is that two offers do
  not stack unless someone said so in writing.

## 6. Resolution order

Deterministic and total — given the same booking and codes, the same discount, always:

1. Collect candidates: automatic offers in window + offers resolved from supplied codes.
2. Drop ineligible ones (window, min subtotal, per-customer cap, global cap, budget, scope match).
3. Sort by `discountCents` descending, then `offerId` ascending as a stable tiebreak.
4. Take the best candidate; then take further candidates only if every already-taken offer lists
   them in `combinesWith` **and** they list every taken offer in turn. Mutual consent, not one-way.
5. Cap total discount at the eligible subtotal — a booking can reach zero, never negative.
6. Emit a priced discount line into the quote; snapshot `offerId` + `offerVersion` + `discountCents`.

Step 4 is the part most implementations get wrong by making stacking transitive. It is not:
A stacks with B and B with C does not imply A stacks with C.

## 7. Staging

| Stage | Scope | Risk |
|---|---|---|
| **O1** | Schema + resolution engine as a pure module, exhaustively unit-tested. No wiring. | None — nothing reads it |
| **O2** | Migrate the hardcoded `WELCOME10-v1` into an `OsOffer` row; engine runs in **shadow mode** beside `booking-offers.js`, logging any divergence, with the legacy path still authoritative | None — legacy still decides |
| **O3** | Cut over once shadow mode is clean for a full booking cycle. Legacy path deleted in a dedicated PR | Money — needs the shadow evidence |
| **O4** | Owner Studio editor: offers and codes as draft → validate → publish, reusing the catalog lifecycle | Money — publish gate |
| **O5** | Checkout code field (a string, server-resolved) + Admin manual grant with mandatory reason code | Money + abuse surface |

O2 is the important one and the one most likely to be skipped under time pressure. Shadow mode is
what converts "the new engine looks right" into evidence, before a single customer is charged
differently.

## 8. Dependencies and blockers

- **Isolated staging database.** `OWNER_STUDIO_STAGING_DATABASE_URL` is still unset, so no Owner
  Studio migration has been applied anywhere outside CI. O1 can be built without it — the engine is
  a pure module — but O2 onward cannot be exercised.
- **Stage 6 publish is not built.** O4 needs the transactional release path that publish/rollback
  would provide. Until then an offer draft has nowhere to become authoritative.
- **`canonical-quote.js` has no discount line concept.** O3 adds one. This is the only change to a
  money-critical file in the whole plan and deserves its own PR and its own review.

## 9. What this is not

Not a loyalty programme, not gift cards, not subscription pricing (`subscription-checkout.js`
already owns that), and not per-customer negotiated rates. Each is a separate domain; folding any of
them in here would recreate the "parallel sources of truth" problem the control-plane matrix exists
to prevent.
