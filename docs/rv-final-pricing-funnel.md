# RV Final Pricing Funnel

## Baseline

- Branch: `fix/rv-final-pricing-funnel`
- Baseline SHA: `1a4a2b4` (origin/master after PR #107)
- Worktree: external `cardetail1-rv-funnel`

## Authoritative mileage table

Source: `netlify/lib/travel-fee.js` (mirrored in funnel JS and index.html).

| Band (mi) | Fee |
|-----------|-----|
| 0–30 | $0 (Included) |
| 31–50 | $15 |
| 51–65 | $25 |
| 66–85 | $35 |
| 86–100 | $40 |
| 101–120 | $55 |
| >120 | rejected |

Origin: Bergen County / Palisades Park (`076xx`). Method: ZIP3 static mile table + zone defaults. Toll/congestion: not calculated in code (legal copy only).

## Per-foot rate audit (≤7% on base packages only)

| Package | Old $/ft | New $/ft | Increase |
|---------|----------|----------|----------|
| Maintenance Wash (`maint`) | 8 | 8.5 | 6.25% |
| Maint + Light Interior (`maint_light`) | 15 | 16 | 6.67% |
| Interior Detail (`interior`) | 20 | 21 | 5.00% |
| Premium Exterior (`premium`) | 31 | 33 | 6.45% |
| Full RV Detail (`full_basic`) | — | 27 | derived `(8.5+21)×0.92` |
| Premium Complete (`full`) | 44 | 49.5 | derived `(33+21)×0.92` |

Rounding: nearest $0.50 without exceeding 7%. Mileage fees, Super Interior ($135), Sanitize ($75) unchanged. Mold Treatment remains absent from new RV bookings.

## RV type multipliers

| Type | Multiplier |
|------|------------|
| Travel Trailer | 1.0 |
| Fifth Wheel | 1.1 |
| Class B / Class C | 1.1 |
| Class A | 1.15 |
| Airstream | 1.08 |
| Specialty | 1.0 |

Specialty without finished living quarters: exterior packages only (`maint`, `premium`).

## Formula

```
serviceSubtotal = max(packageMinimum, exactLength × perFt × typeMultiplier)
estimatedTotal = serviceSubtotal + mileageAdjustment + addOns
```

Frontend estimates only; backend recalculates via `booking-price-catalog.js` + `travel-fee.js`.
