# RV five-package customer clarity

**Branch:** `fix/rv-per-foot-pricing-commercial-reset`

## Customer-visible packages (exactly five)

1. `maint` — Maintenance Wash — $8/ft · min $129
2. `maint_light` — Maintenance Wash + Light Interior — $15/ft · min $229
3. `interior` — Interior Detail — $20/ft · min $249
4. `premium` — Premium Exterior Detail — $31/ft · min $449
5. `full` — Premium Complete RV Detail — $44/ft · min $699

Removed from customer ladder: Exterior Wash & Protect, One-Step Paint Correction, One-Step Paint Correction + Interior.

Legacy booking IDs still resolve: `exterior`→`maint_light`, `correction`→`premium`, `correction_int`→`full`.

## Add-ons

- Super Interior: **$135**
- Sanitize: **$75**
- Mold Treatment: removed from new RV bookings (historical records remain readable)

## Display

- Cards show **Starting at $XX/ft** before length selection
- Exact-length selector updates estimates
- No estimated service hours on cards
- Duration copy: “Service duration depends on RV size, condition and crew assigned.”
