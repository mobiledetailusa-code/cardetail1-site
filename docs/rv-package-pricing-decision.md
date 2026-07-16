# RV Package Pricing Decision

**Baseline SHA:** `ad904ae`  
**Principle:** Preserve viable mobile labor margins; fix hierarchy; do not copy competitor rates.

## Final LENGTH_PRICING.rvs

| ID | Customer name | perFt | min | Est. @24ft | Est. labor |
|----|---------------|-------|-----|------------|------------|
| maint | Maintenance Wash | 10 | 279 | $279 | ~1.5–2.5h |
| exterior | Exterior Wash & Protect | 16 | 399 | $399 | ~2.5–3.5h |
| interior | Interior Detail | 24 | 379 | $576 | ~3–5h |
| premium | Premium Exterior Detail | 40 | 899 | $960 | ~4–6h |
| full | Premium Complete Detail | 54 | 1299 | $1296→$1299 | ~6–9h |
| correction | One-Step Paint Correction | 52 | 1199 | $1248 | ~5–7h |
| correction_int | One-Step Paint Correction + Interior | 62 | 1499 | $1499 | ~7–10h |

## Hierarchy validation @24ft

1. exterior $399 > maint $279 ✓  
2. premium $960 > exterior $399 ✓  
3. full $1299 > premium $960 ✓ (Complete includes polish-level exterior + interior)  
4. correction $1248 > premium $960 ✓  
5. correction_int $1499 > correction $1248 ✓  
6. À la carte premium+interior ≈ $960+$576=$1536; Complete $1299 ≈ 15% bundle ✓ modest  
7. À la carte correction+interior ≈ $1248+$576=$1824; Combo $1499 ≈ 18% bundle ✓  
8. Super Interior = **$135** flat (server catalog)  
9. Travel/toll unchanged  

## Why each change

- **maint:** New entry path; lighter than Exterior Wash & Protect; no full machine wax claim.  
- **exterior +$50 min / +$4/ft:** Adds machine quick-protect; must beat basic-wash perception.  
- **interior +$80 min / +$3/ft:** Living-space labor (cabin, kitchen, bath, upholstery) was underpriced.  
- **premium +$50 min / +$2/ft:** Clarified as one-step polish, not restoration.  
- **full rewrite:** Now true Complete (one-step exterior + Interior). Price raised above Premium Exterior.  
- **correction / correction_int:** New IDs for focused one-step correction paths with disclaimers.  

## Mold Treatment

Removed from **RV** add-ons only. Cars/boats catalogs may retain mold for historical/other categories. Historical RV bookings with `mold` remain readable; new RV payloads reject unknown IDs via server catalog (mold absent from RV list).

## Super Interior

| Field | Value |
|-------|-------|
| id | `superint` |
| price | 135 |
| scope | int |
| visibility | Standard RV add-on list in six-step booking |
