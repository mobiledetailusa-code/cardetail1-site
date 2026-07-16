# RV Sales Optimization — Phase 1 Commercial Audit

**Scope:** `rv-detailing.html` sales experience only.  
**Constraint:** No changes to Stripe, checkout, booking engine math, length pricing, travel fees, portals, auth, RevOps, or Garage Plan backend.

## Current bookable inventory (unchanged IDs)

| ID | Current sales name | From price | Role today |
|----|--------------------|------------|------------|
| `exterior` | Exterior Wash | $349 | Entry exterior |
| `interior` | Interior Detail | $299 | Living-space only |
| `full` | Full RV Detail | $549 | In/out bundle (popular) |
| `premium` | Premium Exterior | $849 | Oxidation / gloss |

## Findings

1. **Ladder gap:** No maintenance entry, no named paint-correction tier, no premium exterior+interior flagship above `full`.
2. **Cannibalization risk:** `full` ($549) undercuts buying exterior+interior separately ($648) — good for ticket, but named “Full” undersells premium positioning.
3. **Premium Exterior sits above Full on price but is exterior-only** — shoppers need clear “why upgrade vs Complete.”
4. **Copy is commodity** (“vacuum”, “wash”, “wipe”) vs premium RV market language (gelcoat, living-area restoration, UV protection).
5. **No membership / recurring offer** on-page despite high LTV of RV owners.
6. **Add-ons exist in booking** (roof, awning, odor, sanitize…) but are invisible on the sales page.
7. **Interior $299** is market-competitive for travel-trailer living spaces ($250–$400 class). **Hold price** — do not inflate without length-engine change.
8. **Exterior $12/ft / Premium $38/ft** sits mid-to-upper US mobile RV range. **Hold mins.**

## Architecture decision (constraint-safe)

- Keep bookable IDs: `exterior`, `interior`, `full`, `premium`.
- Reposition `full` → **Premium Complete Detail** (recommended flagship).
- Present **Maintenance Wash**, **Paint Correction**, **Paint Correction + Interior**, **RV Care Membership**, and **Super Interior** as commercial sales structures.
- Quote / consult CTAs for correction & membership until dedicated package IDs exist in a later pricing-engine phase.
- Sync booking modal display names/feats for the four IDs only (copy), not prices or length rules.
