# RV Per-Foot Pricing Audit

**Baseline SHA:** `1aba446d7ab49ff5c9ca1a865a720faeb0518a41`  
**Branch:** `fix/rv-per-foot-pricing-commercial-reset`

## Authoritative formula (before change)

```
serviceSubtotal = max(package.min, round(package.perFt × selectedFt))
```

Sources: `LENGTH_PRICING.rvs` in `index.html` and `netlify/lib/booking-price-catalog.js`.  
`getLengthPrice(cat, pkgId, ft)` implements the formula. RV type tier table is **not** used when length pricing applies.

## Fixed 24-ft bucket — YES (effective)

High `min` values relative to `perFt` made many lengths pay the same as ~24 ft:

| Package | Old perFt | Old min | Crossover ft (min/perFt) | Effect |
|---------|-----------|---------|--------------------------|--------|
| maint | 10 | 279 | 27.9 | 12–27 ft all $279 |
| exterior | 16 | 399 | 24.9 | 12–24 ft all $399 |
| interior | 24 | 379 | 15.8 | mild floor |
| premium | 40 | 899 | 22.5 | 12–22 ft all $899 |
| full | 54 | 1299 | 24.1 | 12–24 ft all $1299 |
| correction | 52 | 1199 | 23.1 | 12–23 ft all $1199 |
| correction_int | 62 | 1499 | 24.2 | 12–24 ft all $1499 |

## Double-counting — NO

No base + per-foot duplication. Single `max(min, perFt×ft)` path. Rich ZIP multiplier is **not** applied on the client length path.

## Display issue

Sales cards showed large “From $899 / $1,299 / …” mins before length selection.

## Approved target formula

```
serviceSubtotal = max(packageMinimumServiceCharge, selectedExactLength × authoritativeRatePerFoot)
```

- No rounding length up to 24  
- Mins only for mobile setup on the smallest units (floor ends well before 18–22 ft)  
- 15–20% rate reduction; premium exterior uses ~22.5% rate cut so former 24-ft floor prices also clear the 15% customer-price reduction
