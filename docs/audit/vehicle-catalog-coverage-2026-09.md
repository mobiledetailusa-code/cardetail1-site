# CARDDETAIL1 — Vehicle Catalog Coverage Audit (Cars)

**Date:** 2026-09-12  
**Scope:** US-market Cars category only (read-only)  
**External reference:** NHTSA vPIC (`GetModelsForMakeYear`, vehicle types `passenger` / `mpv` / `truck`)  
**Status:** AUDIT ONLY — no catalog, pricing, classifier, or UI changes implemented

---

## Verdict

**VEHICLE CATALOG COVERAGE AUDIT COMPLETE — LARGE CATALOG GAP**

The Cars picker has a usable mainstream core (~351 canonical models / 41 makes) but is **not year-aware**, has **no alias layer**, duplicates the catalog across **13 HTML pages**, misclassifies all present full-size/compact vans as `truck`, and is missing entire modern EV makes plus many common used-vehicle families inside the selectable 1990–2026 window.

Machine-readable gaps: [`artifacts/vehicle-catalog-gaps-2026-09.csv`](../../artifacts/vehicle-catalog-gaps-2026-09.csv)  
Summary JSON: [`artifacts/vehicle-catalog-coverage-summary-2026-09.json`](../../artifacts/vehicle-catalog-coverage-summary-2026-09.json)  
Reproducible audit script: [`scripts/audit-vehicle-catalog-coverage.mjs`](../../scripts/audit-vehicle-catalog-coverage.mjs)

---

## 1. Current Cardetail1 scope

### Canonical sources (do not use generated copies first)

| Concern | Authoritative location |
|---|---|
| Make list + model list + tier map | `index.html` → `const MAKES` + `const MODELS` (identical copy in 12 hub/city HTML pages) |
| Display class / minivan / year overrides | `assets/vehicle-class-resolver.js` |
| Published Cars package prices by tier | `netlify/lib/booking-price-catalog.js` → `PRICING.cars.tiers` |
| Portal year list (related, not Cars picker) | `netlify/lib/customer-catalog.js` → `VEHICLE_YEARS` |

### Counts

| Metric | Value |
|---|---|
| Makes | **41** |
| Canonical models | **351** |
| Year-aware mappings | **1** (`Hyundai\|Santa Fe` → suv3 from 2024) |
| Aliases | **0** (no make/model alias table) |
| Pricing classes | **4** — `small`, `suv2`, `suv3`, `truck` |
| Display classes | **5** — pricing 4 + `minivan` (prices as `suv3`) |

### Class distribution (canonical `MODELS.t`)

| Class | Models |
|---|---|
| `small` | 152 |
| `suv2` | 106 |
| `suv3` | 64 |
| `truck` | 29 |

### Minivan display keys (`MINIVAN_KEYS`)

Dodge Grand Caravan, Chrysler Pacifica, Chrysler Voyager, Honda Odyssey, Toyota Sienna, Kia Carnival — all expect catalog tier `suv3`.

### Supported model-year range (Cars booking UI)

Cars `year-sel` in `index.html`:

```text
for (let y = currentYear; y >= 1990; y--)
```

→ **1990–2026** (no per-model filtering).

Note: portal `VEHICLE_YEARS` is `currentYear+1` back 45 years (2027→1983) — slightly different from the Cars picker. Specialty generic years go to 1980. **This audit uses the Cars picker range 1990–2026.**

---

## 2. Coverage boundary

**In scope:** passenger cars, coupes, hatchbacks, wagons, crossovers, 2-/3-row SUVs, minivans, pickups, compact vans, full-size cargo/passenger vans, mainstream + luxury/exotic road EVs/ICE within 1990–2026.

**Out of scope:** RVs, boats, motorcycles, ATV/UTV, heavy commercial, buses, tractors, construction, trailers (specialty flows).

NHTSA trailer/chassis noise was filtered out of gap reporting.

---

## 3–5. External inventory & comparison method

1. Pulled NHTSA `GetModelsForMakeYear` for Cardetail1 makes **plus** Rivian, Lucid, Polestar, VinFast, and legacy US makes (Saturn, Pontiac, etc.).
2. Vehicle types: `passenger`, `mpv`, `truck`.
3. Year sampling: every year 2010–2026; every 2 years 2000–2009; every 5 years 1990–1999.
4. Normalized manufacturer-specific strings into families (e.g. `GLC-Class` → `GLC`, `F150`/`F-150`, Transit variants, Silverado trims) **without** merging genuinely different models (e.g. Corolla ≠ Corolla Cross, Blazer ≠ Blazer EV).

### Primary result sets

| Set | Finding |
|---|---|
| **A. Present + valid** | Most current Toyota/Honda/Ford/Chevy/Jeep/Kia/Hyundai volume models exist |
| **B. Missing model** | Material gaps (see P1 list); entire makes absent (Rivian/Lucid/Polestar) |
| **C. Partial year** | **0** — architecture has no model year ranges at all |
| **D. Present but suspect** | Vans-as-truck, Mach-E as small, ID.Buzz as suv2, 4Runner as suv3 |

Because every model accepts every year 1990–current, year problems appear as **INVALID_YEAR** (over-acceptance), not MISSING_YEAR.

---

## 6. Full-size van audit

### Present (wrong class → currently `truck`)

| Make | Model | Notes |
|---|---|---|
| Ford | Transit | Full-size cargo/passenger |
| Chevrolet | Express | Full-size cargo/passenger |
| Ram | ProMaster | Full-size cargo/passenger |

### Compact vans present (wrong class → `truck`)

| Make | Model |
|---|---|
| Ford | Transit Connect |
| Ram | ProMaster City |

### Missing full-size families

- Mercedes-Benz **Sprinter** (and legacy Dodge Sprinter)
- GMC **Savana**
- Nissan **NV** (in-range discontinued)
- Ford **E-Series** / Econoline (legacy + ongoing cutaway presence)

### Missing compact vans

- Nissan **NV200**
- Mercedes-Benz **Metris**

### Recommendations (not implemented)

| Question | Answer |
|---|---|
| New `full_size_van` class? | **YES** |
| Passenger vs cargo subtype feasible? | **YES** (metadata/label only; one price tier is enough initially) |
| Compact vans into `full_size_van`? | **NO** — keep nearest existing `suv2` (or future `compact_van`) |
| Intended pricing Minivan+10% | **Compatible** — minivan already displays separately while pricing as `suv3`; `full_size_van` can be a real tier at ≈ `suv3 * 1.10` |

---

## 7–8. Common gap families & discontinued-but-relevant

### Entire makes missing (high impact)

- **Rivian** (R1T, R1S)
- **Lucid** (Air, Gravity)
- **Polestar** (2, 3, 4)

### High-impact missing models (examples)

Grand Highlander, Corolla Cross, Fusion, Focus, Flex, Impala, Cruze, Passat, Maxima, Ariya, Bolt EV/EUV, Blazer EV, Equinox EV, Silverado EV, CX-9, Town & Country, Lexus TX, Volvo EX30/EX90, Audi Q4 e-tron, GMC Hummer EV, Mazda CX-9, etc.

### Discontinued but still in year range (should remain eligible)

Examples missing today: Ford Flex/Fusion/Focus, Chevy Impala/Cruze, Chrysler Town & Country, Nissan NV/NV200/Quest, Kia Sedona/Optima, Honda Fit/Element, Mazda CX-9.

External current-production status is **not** the coverage rule.

---

## 9. Year validity

**Architecture today:** year ⊕ make ⊕ model is **not** validated.

- Selecting model unlocks **all** years 1990–current.
- Only one year override exists (Santa Fe rows).
- Audit flagged **~282** INVALID_YEAR rows (sampled NHTSA first/last appearance vs unrestricted picker).

Desired contract (future): selectable combination must be a real US model year.

---

## 10. Classification audit (canonical metadata)

| Model | Current | Recommended | Issue |
|---|---|---|---|
| Ford Transit | truck | full_size_van | WRONG_CLASS |
| Chevrolet Express | truck | full_size_van | WRONG_CLASS |
| Ram ProMaster | truck | full_size_van | WRONG_CLASS |
| Ford Transit Connect | truck | suv2 (compact van) | WRONG_CLASS |
| Ram ProMaster City | truck | suv2 (compact van) | WRONG_CLASS |
| Ford Mustang Mach-E | small | suv2 | WRONG_CLASS |
| Volkswagen ID.Buzz | suv2 | minivan | WRONG_CLASS |
| Toyota 4Runner | suv3 | suv2 | WRONG_ROWS |

No specialty-catalog leakage into Cars `MODELS` was found in this pass.

---

## 11. Pricing class coverage

All published Cars packages (`wash`, `maint`, `interior`, `full`, `refresh`, `premium`) have **finite numeric** prices for every current tier in `booking-price-catalog.js`.

| Check | Result |
|---|---|
| All class/package mappings numeric | **YES** |
| Classes needing new tier | **`full_size_van`** |
| Minivan+10% architecture-compatible | **YES** |

Missing models map to existing classes except full-size vans.

---

## 12. Priority counts

| Priority | Count | Meaning |
|---|---|---|
| **P0** | **8** | Selectable but wrong authoritative class/pricing posture |
| **P1** | **34** | Common legitimate US vehicles/makes completely missing |
| **P2** | **823** | Mostly INVALID_YEAR systemic rows + secondary missing models |
| **P3** | **415** | Niche / legacy / low booking impact |

> P2 is dominated by the systemic “every model accepts 1990–current” year bug (one row per affected model/window), not 800 unique missing cars.

---

## 13. Top 25 gaps (impact order)

1. Ford Transit → full_size_van (P0)
2. Chevrolet Express → full_size_van (P0)
3. Ram ProMaster → full_size_van (P0)
4. Ford Transit Connect → suv2 (P0)
5. Ram ProMaster City → suv2 (P0)
6. Ford Mustang Mach-E → suv2 (P0)
7. Volkswagen ID.Buzz → minivan (P0)
8. Toyota 4Runner → suv2 (P0)
9. Mercedes-Benz Sprinter (missing)
10. GMC Savana (missing)
11. Nissan NV (missing)
12. Nissan NV200 (missing)
13. Mercedes-Benz Metris (missing)
14. Rivian R1T / R1S (make missing)
15. Lucid Air / Gravity (make missing)
16. Polestar 2 / 3 / 4 (make missing)
17. Toyota Grand Highlander
18. Toyota Corolla Cross
19. Ford Fusion / Focus / Flex
20. Chevrolet Impala / Cruze / Bolt EV / Bolt EUV
21. Chevrolet Blazer EV / Equinox EV / Silverado EV
22. Nissan Maxima / Ariya
23. Volkswagen Passat
24. Chrysler Town & Country
25. Mazda CX-9 · Lexus TX · Volvo EX30/EX90 · Audi Q4 e-tron · GMC Hummer EV

---

## Architecture answers

| # | Question | Answer |
|---|---|---|
| 24 | Year-aware catalog? | **NO** |
| 25 | Aliases supported? | **NO** |
| 26 | Canonical single source of truth? | **NO** — identical `MODELS` embedded in 13 HTML files |
| 27 | Broad catalog rewrite required? | **YES** (centralize + year ranges + aliases + van class) |

---

## Next implementation (estimates only — not started)

| Item | Estimate |
|---|---|
| Models to add (P1+P2 missing, actionable) | **~120–180** after further alias collapse |
| Year-range fixes | **351** (every canonical model needs bounds) + new models |
| Classification fixes | **~10–20** obvious now (8 P0 + follow-ons) |
| Recommended implementation PRs | **5** |

Suggested PR sequence (future):

1. **Centralize** `MODELS`/`MAKES` to one module consumed by pages + server  
2. **P0 classification** + introduce `full_size_van` pricing (minivan+10%)  
3. **P1 adds** — vans, Rivian/Lucid/Polestar, high-volume missing models  
4. **Year-valid combinations** (NHTSA-backed ranges)  
5. **Alias layer** + P2 backfill / discontinued relevance pass  

---

## Final numbered report card

### CATALOG
1. Year range: **1990–2026** (Cars UI)  
2. Makes: **41** (list in summary JSON)  
3. Canonical models: **351**  
4. Classes: pricing `small|suv2|suv3|truck`; display +`minivan`

### COVERAGE
5. External makes reviewed: **~59**  
6. External model/year combos reviewed: **~25k+ sampled**  
7. Missing canonical models (CSV MISSING_MODEL): **~969 raw / ~34 P1 high-impact**  
8. Partial-year models: **0** (no year ranges exist)  
9. Invalid-year combinations flagged: **~282**  
10. Suspect classifications: **8**  
11. Duplicate/alias issues: **~21**

### FULL-SIZE VANS
12. Missing families: Sprinter, Savana, NV, E-Series (+ legacy Dodge Sprinter)  
13. Compact vans present: Transit Connect, ProMaster City (both as `truck`)  
14. Recommend `full_size_van`: **YES**  
15. Passenger/cargo subtype feasible: **YES**

### PRIORITY
16. P0: **8**  
17. P1: **34**  
18. P2: **823**  
19. P3: **415**

### TOP GAPS
20. See Top 25 section above

### PRICING
21. All published class/package numeric: **YES**  
22. New tier needed: **full_size_van**  
23. Minivan+10% compatible: **YES**

### ARCHITECTURE
24. Year-aware: **NO**  
25. Aliases: **NO**  
26. Single SoT: **NO**  
27. Broad rewrite required: **YES**

### NEXT IMPLEMENTATION
28. Models to add: **~120–180** actionable  
29. Year-range fixes: **351+**  
30. Classification fixes: **~10–20**  
31. Recommended PRs: **5**

---

## Final verdict

**VEHICLE CATALOG COVERAGE AUDIT COMPLETE — LARGE CATALOG GAP**
