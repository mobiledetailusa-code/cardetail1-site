# Boundary Analysis — What Stays Custom, What Gets Bought

**Question:** if operations after "customer requested a booking" move to Square (or Jobber
/ Housecall Pro), what exactly stays in this repository, what disappears, and what can
those platforms genuinely not do?

**Method:** every backend file classified against the described target flow — request →
confirmation by SMS/email → one click that charges card or records cash → receipt.
Line counts are measured, not estimated.

---

## The headline

| Class | Lines | Share | Files |
|---|---:|---:|---:|
| **KEEP** — genuine differentiator, no platform does it | **4,526** | **12%** | 21 |
| **REPLACE** — Square/Jobber covers it | **24,143** | **65%** | 88 |
| **OPTIONAL** — subsystems that may not be paying for themselves | **8,756** | **23%** | 66 |
| **Total backend** | **37,425** | | 175 |

Two thirds of this backend exists to do things a $29/month product already does, and does
with PCI compliance, mobile apps and real-time sync included.

---

## What stays — the 12%

The pricing engine is the asset. It is also the one thing no booking platform can
reproduce, for reasons set out below.

| File | Lines | Why it stays |
|---|---:|---|
| `functions/submit-booking.js` | 867 | Public request intake — the top of the funnel |
| `lib/booking-price-catalog.js` | 543 | **78 package×tier price combinations** across 5 vehicle categories |
| `lib/public-rate-limit.js` | 403 | Protects the public endpoints that remain |
| `lib/canonical-addon-catalog.js` | 354 | **30 add-ons**, category-scoped compatibility |
| `functions/garage-plan-submit.js` | 274 | Custom intake path |
| `lib/customer-catalog.js` | 221 | Customer-facing catalog projection |
| `lib/rv-type-catalog.js` | 202 | RV type resolution |
| `lib/trusted-site-origin.js` | 183 | Origin trust for the public surface |
| `lib/package-details-resolve.js` | 182 | Package content resolution |
| `lib/arrival-windows.js` | 181 | Arrival window logic |
| `lib/travel-fee.js` | 157 | **ZIP → miles → fee**, zone-based |
| `functions/booking-availability.js` | 142 | Availability for the request form |
| `lib/booking-schedule.js` | 135 | Scheduling rules |
| `lib/canonical-package-catalog.js` | 134 | Package definitions |
| `lib/length-pricing.js` | 132 | **RV price as a function of length in feet** |
| `functions/submit-inquiry.js` | 102 | Lead capture |
| `lib/garage-plan-validation.js` | 96 | Intake validation |
| `lib/prisma.js` | 60 | DB client |
| `lib/booking-routing-validation.js` | 58 | ZIP routing |
| `lib/schedule-flexibility.js` | 51 | Flexibility handling |
| `lib/phone-auth.js` | 49 | Phone normalisation |

Plus the marketing surface, which is not backend but is the acquisition machine:
the state and city hub pages at ~420–515 KB each.

---

## What Square genuinely cannot do

This is the decisive section. Four pricing behaviours in the catalog have no equivalent
in any booking platform's catalog model:

| Behaviour | Measured | Why no platform models it |
|---|---|---|
| **RV price per foot** | 3 length brackets, price is a *function* of length | Catalogs store fixed prices per service variation. They cannot evaluate `price = f(length)`. |
| **Travel fee by distance** | ZIP → miles → zone → fee | No distance-based fee computation. Fixed service prices only. |
| **Add-ons with category compatibility** | 30 add-ons, valid per vehicle category | Square Appointments has no true service add-on model; modifiers are a POS/Items concept and do not carry compatibility rules. |
| **Multi-vehicle rollup** | N vehicles per booking, each with its own package + add-ons | One appointment maps to services, not to a nested per-vehicle structure with its own subtotals. |

The 78 package×tier combinations alone would fit as service variations. The four
behaviours above would not.

### But this does not block the split

The resolution is that **Square never has to price anything**. It is told the price.

Square's Invoices and Orders APIs accept arbitrary line items with arbitrary amounts.
So the boundary is:

```
this repo computes the price  →  pushes a quote as line items  →  Square owns everything after
```

The pricing engine stays exactly where it is. Square receives a finished number.

---

## What disappears — the 65%

| File | Lines | Covered by |
|---|---:|---|
| `functions/admin-ops-jobs.js` | 2,771 | Square Dashboard |
| `functions/submit-customer-action.js` | 969 | Square customer messaging / Jobber requests |
| `lib/booking-commands.js` | 959 | Platform booking lifecycle |
| `lib/booking-transactional-notifications.js` | 905 | Square automatic SMS/email confirmations |
| `lib/customer-account-service.js` | 768 | Square Customers |
| `lib/payment-service.js` | 738 | Square Payments |
| `lib/db/payment-authority-service.js` | 706 | Square Payments |
| `lib/admin-booking-mutations.js` | 653 | Square Dashboard |
| `lib/customer-address-service.js` | 642 | Square Customers |
| `functions/customer-appointment-access.js` | 599 | Square customer-facing booking links |
| `functions/stripe-webhook.js` | 582 | Square handles settlement internally |
| `lib/appointment-access-token.js` | 527 | Square's own links |

…and 76 more files: the whole customer portal, the whole Admin portal, the ledger, the
receipt projection, the review and service-issue workflow, the payment-method policy, the
price-adjustment authority, and every Stripe integration file.

**Everything repaired in the current branch sits inside this block.** The cheapest way to
fix those defects permanently is for the code not to exist.

---

## What needs a decision — the 23%

These are not covered by Square and are not obviously differentiators either. Each is a
separate business question:

| Subsystem | Lines (approx) | Question |
|---|---:|---|
| Technician portal + auction/dispatch | ~2,400 | Does the auction model earn its complexity, or would Jobber's assignment do? |
| Revenue intelligence / RevOps dashboard | ~1,900 | Is anyone acting on these numbers weekly? |
| Owner Studio (catalog CMS) | ~1,700 | Is the catalog edited often enough to justify a CMS over a code deploy? |
| Subscriptions | ~550 | Active revenue, or aspirational? |
| Recent-work gallery + photos | ~540 | Instagram embed would cost 0 lines |
| QA/smoke endpoints | ~640 | Keep — but they only exist to test code that is being deleted |
| HubSpot + Google Ads adapters | ~160 | Cheap, keep if used |
| AI chat | ~104 | Converting? |

Honest note: **the technician portal is the one with a real claim to stay**, because
mobile detailing dispatch with an auction model is not standard in off-the-shelf tools.

---

## Target architecture

```
┌──────────────────────────────────────────┐
│  STAYS — this repo, Netlify              │
│  hub pages + booking form                │
│  pricing engine (78 combos, RV per-foot, │
│  travel fee, add-on compatibility)       │
│  ~4,526 lines                            │
└───────────────┬──────────────────────────┘
                │  quote as line items (~300 new lines)
                ▼
┌──────────────────────────────────────────┐
│  BOUGHT — Square / Jobber                │
│  confirmation SMS + email                │
│  scheduling and calendar                 │
│  one-click card charge OR cash recording │
│  receipts, customer history              │
│  real-time Admin ↔ customer, mobile apps │
│  PCI scope                               │
└──────────────────────────────────────────┘
```

**Net: 37,425 → ~4,800 lines. An 87% reduction.**

---

## What is gained and lost

**Gained**

- The 24,143 lines of deleted code take every defect in them along — including the ones
  repaired in this branch and the ones not yet found.
- PCI scope becomes the platform's problem.
- Real-time Admin ↔ customer sync arrives natively, which is the requirement that Netlify
  Functions structurally cannot meet (stateless, no push).
- Native mobile apps for Admin and technicians, at no build cost.
- The 39 public endpoints without rate limiting mostly cease to exist.

**Lost**

- Full control of the Admin UX.
- The custom multi-vehicle Admin view.
- The auction dispatch model, unless the technician portal is kept.
- Payment processing economics change — compare Square's rate against the current Stripe
  rate before committing.

---

## Migration path

1. **Bridge first, delete nothing.** Build the quote → Square Invoice push (~300 lines).
   Run it in parallel: bookings continue in the existing system *and* appear in Square.
2. **Operate from Square for two weeks.** Same data in both. Confirm the flow works for
   real jobs before anything is removed.
3. **Cut the customer portal over.** Customers get Square links. `my-garage.html` retires.
4. **Cut the Admin portal over.** Square Dashboard becomes the operational surface.
5. **Delete.** Only now, and in the order: portals → payments → notifications → ledger.
6. **Decide the 23%** as separate, unhurried questions.

Nothing is deleted before something else has demonstrably replaced it.

---

## Verify before committing

Platform capabilities and pricing change, and this analysis reasons from the shape of the
repository rather than from a live Square account. Before deciding, confirm directly with
the vendor:

- Square Invoices/Orders accept arbitrary line items at the volume and shape needed.
- Cash payment recording produces the receipt behaviour expected.
- Bookings API availability model fits a mobile, travel-based service.
- Current plan pricing and card-processing rates versus the existing Stripe arrangement.

The build-versus-buy conclusion is robust to the details. The exact integration surface
is not.
