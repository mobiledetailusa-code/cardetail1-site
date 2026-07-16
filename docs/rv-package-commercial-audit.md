# RV Package Commercial Audit

**Baseline:** `ad904aecb9cabf77df537e1d841180f6402f6c44` (`origin/master`)  
**Branch:** `fix/rv-package-commercial-finalization`  
**Worktree:** `C:\Users\magno\Desktop\cardetail1-rv-packages`

## Authoritative sources

| Source | Role |
|--------|------|
| `index.html` → `PRICING.rvs` / `LENGTH_PRICING.rvs` | Client booking + specialty embed |
| `netlify/lib/booking-price-catalog.js` | Server-authoritative price validation |
| Hub / city HTML copies | Duplicated client catalogs (must stay synced) |
| `rv-detailing.html` | Public sales cards (not source of money math) |
| `assets/specialty-booking-bridge.js` | Package ID whitelist for specialty CTAs |

`scripts/sync-public-surface.mjs` syncs footer/nav only — **not** pricing.

## Current Production packages (baseline)

| ID | Name | perFt | min | Scope |
|----|------|-------|-----|-------|
| exterior | Exterior Wash | 12 | 349 | ext |
| interior | Interior Detail | 21 | 299 | int |
| full | Full RV Detail | 30 | 549 | both |
| premium | Premium Exterior | 38 | 849 | ext |

## Critical inconsistencies

1. **Price vs content:** `full` (From $549) is marketed as complete care but is cheaper than `premium` exterior-only ($849). If Complete includes one-step polish + interior, this hierarchy is commercially invalid.
2. **Interior underpriced** for cockpit + living + kitchen + bath labor (several hours).
3. **Exterior Wash** under-communicates protection vs a basic wash.
4. **No Maintenance Wash** bookable ID.
5. **No Paint Correction** bookable path with truthful one-step scope.
6. **Mold Treatment** present on RV add-ons — must be removed from RV.
7. **Super Interior** not in RV add-on catalog (cars have `superint` at $125).

## Competitor benchmark (internal only — not published on site)

Operator PDFs show approx wash+mini-int ~$24–$26/ft and wash/wax+mini-int ~$36–$40/ft by unit class. Cardetail1 is self-contained premium mobile — should not race the cheapest wash.

## Target architecture

See `docs/rv-package-pricing-decision.md`.
