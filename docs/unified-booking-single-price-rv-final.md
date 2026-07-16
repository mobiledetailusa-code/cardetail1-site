# Unified booking single-price UX + authoritative RV pricing

## Problem: dual price on Vehicle step ($483 + $25 = $508)

On the Vehicle step, two totals were shown without clear labeling:

1. **`#rv-service-subtotal`** — length-only service price from `getLengthPrice()` (e.g. $483 for a 19 ft travel trailer on Maintenance Wash).
2. **`#ah-total`** via `updateTotal()` — same service price **plus** `getTravelFeeAmount()` even though the customer had not reached Info & Schedule (step 4).

Travel ZIP is often already known from the early ZIP gate, so `getTravelFeeAmount()` returned a non-zero fee (e.g. $25) while the user was still on step 3. Result: **$483 service + $25 travel = $508** with no breakdown — looked like a second, unexplained price.

Package CTAs from specialty pages also landed on **Package (step 2)** because `launchBooking` / `openBookingFromQuery` did not honor `start=vehicle` or `ST._startStep`.

## Fix: single-price UX

| Step | What the customer sees |
|------|------------------------|
| Vehicle (3) | **Estimated service price** — service + add-ons only; no travel |
| Info & Schedule (4+) | **Estimated total** — service + add-ons + travel, with breakdown when travel > 0 |

Copy updates:

- `#rv-service-subtotal`: `Estimated service price: $X` + note that travel is calculated after service ZIP.
- `#ah-total-lbl`: dynamic — `Estimated service price` before step 4, `Estimated total` from step 4 onward.
- `updateTotal()`: `getTravelFeeAmount()` only when `currentBkStep >= 4`.

Landing RV cards (homepage modal, `rv-detailing.html`) no longer show per-foot rates or minimums — **Price calculated from your vehicle details.**

## Authoritative RV pricing table

Replaced `perFt + min` with **`base + exactLength × ratePerFoot`** (no minimum floor, no per-foot-only display).

| Package | Base | Rate/ft |
|---------|------|---------|
| maint | $150 | $10 |
| maint_light | $250 | $16 |
| interior | $250 | $18 |
| full_basic | $300 | $25 |
| premium | $300 | $28 |
| full | $400 | $36 |

**Formula:** `servicePrice = round((base + exactLength × ratePerFoot) × typeMult × 100) / 100`

### Fixtures (travel type, no addons, no travel fee)

| Length | maint | maint_light | interior | full_basic | premium | full |
|--------|-------|-------------|----------|------------|---------|------|
| 19 ft | 340 | 554 | 592 | 775 | 832 | 1084 |
| 23 ft | 380 | 618 | 664 | 875 | 944 | 1228 |
| 30 ft | 450 | 730 | 790 | 1050 | 1140 | 1480 |
| 40 ft | 550 | 890 | 970 | 1300 | 1420 | 1840 |

## RV type multipliers = 1.0

Prior type multipliers (fifth wheel 1.1×, Class A 1.15×, etc.) are **retired for pricing**. All `RV_TYPES[*].multiplier` and `RV_TYPE_MULTIPLIERS` are **1.0**.

Type keys remain for **eligibility, length bounds, living-quarters gating, and notes** — not price bumps. The clean base+rate table is the single source of truth on client (`index.html`) and server (`booking-price-catalog.js`, `rv-type-catalog.js` → `computeRvServicePrice`).

Boats, cars, powersports, and fleet package prices were **not** changed.

## CTA routing

- `launchBooking({ category, packageId, startStep })` — `vehicle`/`3` opens booking with package preselected and jumps to Vehicle step after category load.
- `openBookingFromQuery` reads `?start=vehicle|package|category|3|2|1`.
- `specialty-booking-bridge.js` sets `start=vehicle` when `packageId` is set, `start=package` when only category.

## Files touched

- `index.html` — pricing, UX, routing, addon dedup
- `netlify/lib/booking-price-catalog.js`
- `netlify/lib/rv-type-catalog.js`
- `assets/specialty-booking-bridge.js`
- `rv-detailing.html`
- Hub pages via `scripts/sync-rv-pricing-blocks.mjs`
- `tests/unified-booking-single-price-rv-final.test.js`
