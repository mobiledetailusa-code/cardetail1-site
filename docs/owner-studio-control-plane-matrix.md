# Owner Studio — Control-Plane Matrix (Stage 2)

**Purpose:** Establish the single authoritative inventory of every website data / configuration
domain, its current source of truth, and the Owner Studio module that will eventually own it.
This exists to **stop future agents from creating parallel sources of truth**.

**Baseline branch:** `feat/owner-studio-catalog-manager` (PR #140, stacked on PR #139)
**Site ID:** `detailing-zone`
**Public content source today:** `legacy` (`PUBLIC_CONTENT_SOURCE=legacy`, `OWNER_STUDIO_ENABLED=false` by default — see `netlify/lib/owner-studio/flags.js`)
**Companion:** field-level content inventory in [`owner-studio-content-inventory.md`](./owner-studio-content-inventory.md).

## Legend

- **Implementation status:** `Authoritative-legacy` (live source today) · `Draft-modeled` (schema + Catalog Manager draft edit exists, not yet published to public) · `Planned` (schema/contract only) · `Not-modeled`.
- **Migration risk:** `Money` (financial correctness / history) · `SEO` · `Presentation` · `Low`.
- Owner Studio never becomes the *runtime* authority for any domain until a catalog version is **published** and `PUBLIC_CONTENT_SOURCE=owner-studio`. Stage 2 only proves the draft/edit path.

---

## Control matrix

| Domain | Current source of truth | Read path | Write path | Public consumers | Admin consumers | Stripe/payment dependency | Migration risk | Recommended Owner Studio module | Implementation status |
|--------|-------------------------|-----------|------------|------------------|-----------------|---------------------------|----------------|--------------------------------|-----------------------|
| **Package base prices** | `netlify/lib/booking-price-catalog.js` (`PRICING.*.tiers`, dollars) | `booking-price-catalog` → `canonical-quote` at booking time | Code edit + deploy; **duplicated** inline in `index.html` `PRICING` + hub HTML | Homepage/hub booking modals | `admin-ops` package mutation | Indirect — feeds server-calculated amount into `create-payment-intent` | **Money** | Catalog › Packages | Authoritative-legacy; **Draft-modeled** (`OsPackagePrice.amountCents`) |
| **Add-on prices** | `booking-price-catalog.js` `PRICING.*.addons` (dollars) | Same as packages | Code edit + deploy | Booking add-on pickers | `addon-financial-mutation.js`, `admin-ops` | Indirect (quote delta → PaymentIntent) | **Money** | Catalog › Add-ons | Authoritative-legacy; **Draft-modeled** (`OsAddOnPrice.amountCents`) |
| **Vehicle classes / tiers** | `booking-price-catalog.js` tier keys (`small`,`suv2`…) + `ids.js` `VEHICLE_CLASS_ID_MAP` | Quote calc | Code edit | Booking size pickers | Admin | Indirect (drives price selection) | Money | Catalog › Vehicle classes | Authoritative-legacy; **Draft-modeled** (`OsVehicleClass`) |
| **Length pricing (RV/boat/trailer per-foot)** | `netlify/lib/length-pricing.js` + `LENGTH_PRICING` in `index.html`/hubs | Quote calc for length categories | Code edit | Boat/RV/fleet booking | Admin | Indirect | **Money** | Pricing & Travel (per-foot rules) | Authoritative-legacy; **partially** modeled (`OsPackagePrice.priceModel=per_foot/base_plus_per_foot`, `perFootCents/baseCents/minCents`) |
| **Travel-distance pricing / free radius / per-mile / zones / surcharges** | `netlify/lib/travel-fee.js` | Quote calc | Code edit | Booking travel fee | Admin | Indirect | **Money** | Pricing & Travel | Authoritative-legacy; **Not-modeled** in Owner Studio (contract boundary defined below) |
| **Package names / descriptions / short desc** | `canonical-package-catalog.js` (`PACKAGE_DESCRIPTIONS`) + specialty HTML copy | Portal serializer / static HTML | Code edit | Portal + public pages | Admin | None (display) | Presentation | Catalog › Packages | Authoritative-legacy; **Draft-modeled** (`OsPackageRevision`) |
| **Included / excluded features** | Package-card HTML + specialty pages | Static HTML | Code edit | Public | Admin | None | Presentation | Catalog › Packages | Draft-modeled (`OsPackageFeature`) |
| **Package ordering / featured** | Homepage card order, specialty tabs | Static HTML/JS | Code edit | Public | Admin | None | Presentation | Catalog › Packages | Draft-modeled (`OsPackage.displayOrder`, `featured`) |
| **Add-on names / descriptions / compatibility** | `canonical-addon-catalog.js` + implicit category membership | Portal serializer | Code edit | Portal + public | Admin | None (labels snapshot on quote) | Presentation | Catalog › Add-ons | Draft-modeled (`OsAddOnRevision`, `OsAddOnCompatibility`) |
| **Cover images / galleries / image order / alt text** | `assets/**` + specialty `specialty-gallery.js` + inline HTML | Static | Code edit / asset commit | Public, OG | Admin | None | Presentation/SEO | Content & Media | Schema exists (`OsMediaAsset`); **Not-modeled** editor |
| **Service visibility (active/inactive)** | Presence in `PRICING` (0 = unavailable sentinel) | Quote logic | Code edit | Public + booking | Admin | Indirect | Money-adjacent | Catalog | Draft-modeled (`OsPackage.active`, `OsAddOn.active`) |
| **State / city / ZIP availability** | `RICH_ZIPS` (client) + hub routing + `#service-areas` | ZIP gate JS + hubs | Code edit | Public ZIP gate, hubs | Admin | None | SEO/Ops | Service Areas | Schema partial (`serviceAreas` payload field); **Not-modeled** editor |
| **Minimum booking totals / deposits** | Booking/policy logic + `terms-conditions.html` copy | Booking flow | Code edit | Booking, legal page | Admin | **Money** (deposit → PaymentIntent) | **Money** | Pricing & Travel / Publishing | Not-modeled |
| **Discounts / promotions / quote rules** | Not centralized (ad-hoc in booking flow) | Booking flow | Code edit | Booking | Admin | **Money** | **Money** | Pricing & Travel | Not-modeled |
| **Service duration estimates** | Sparse marketing copy | Static | Code edit | Public | Admin | None | Low | Catalog › Packages | Draft-modeled (`OsPackageRevision.durationMinutes`, optional) |
| **Navigation / footer** | `index.html` nav + `assets/partials/specialty-public-footer.html` | Static HTML (+ sync script) | Code edit / `sync-public-surface.mjs` | Public | Admin | None | Presentation | Content & Media | Draft-modeled (`navigation`, `footer` payload) |
| **SEO title / description / canonical / structured data** | Per-page `<head>` + JSON-LD | Static HTML | Code edit | Crawlers | Admin | None | SEO | Content & Media | Schema partial (`pages[].seo`); Not-modeled editor |
| **Approved quote → payment amount** | `canonical-quote.js` → booking ledger; `payment-service.js` / `create-payment-intent.js` | Server calc | Booking mutation + Stripe webhook | — | Admin | **Authoritative** — exact server amount, quote/catalog version in metadata | **Money (immutable history)** | Publishing (read-only consumer of published catalog) | Authoritative-legacy; **out of Owner Studio write scope by design** |

---

## Catalog authority decision (unchanged, reaffirmed)

The **published Owner Studio catalog release** will become the single authority for prices and
package identity. Until a release is published **and** `PUBLIC_CONTENT_SOURCE=owner-studio`,
runtime continues to read legacy `booking-price-catalog.js`. The Stage 2 Catalog Manager writes
**drafts only**; publish/rollback are hard-denied server-side (`publication_not_available`).

## Stripe / pricing architecture boundary (Part 5)

Owner Studio / Postgres is authoritative for catalog and pricing **rules**. Stripe is **never** the
catalog source of truth. The correct flow is:

```
Owner edits catalog/pricing rule
  → validated draft (Catalog Manager)
  → published immutable catalog version        (future stage — not in Stage 2)
  → server-side pricing engine (canonical-quote)
  → immutable quote snapshot (ledger)
  → customer/admin approval
  → Stripe PaymentIntent for the exact approved amount
     (metadata: bookingId, accountId, quoteId, quoteVersion, catalogVersion, idempotencyKey)
  → Stripe webhook → PaymentAttempt + LedgerEntry
  → booking balance / status
```

Rules:
- Changing a price in Owner Studio affects **newly calculated quotes after the catalog version is published** — never previously approved quotes, paid bookings, existing PaymentIntents, ledger entries, or completed transactions.
- If an approved quote must change, create a **new quote revision / explicit adjustment**. Never mutate financial history.
- Do **not** create a Stripe Product/Price per dynamic distance/vehicle/add-on/quote combination. Use the exact server-calculated amount + idempotency key + metadata; the webhook is the settlement authority.

## Distance-pricing module boundary (deferred, not built here)

The travel-distance pricing engine is **not** implemented in this repair. This document defines its
data contract boundary (Pricing & Travel module: free radius, per-mile, fixed zones, surcharges,
minimums) so it can be added next **without rebuilding the catalog**. The Catalog Manager and the
`OsPackagePrice.priceModel` field already reserve room for `per_foot` / `base_plus_per_foot`; travel
zones would attach as a separate pricing-rules entity, not as catalog packages.
