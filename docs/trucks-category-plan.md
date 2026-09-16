# Trucks category plan (commercial semis)

**Status:** Live in booking preview — solo Trucks category card + packages; hubs mirrored  
**Branch:** `cursor/trucks-category-plan-9a4f`  
**Scope clarification (2026-09-16):** This category is **only commercial semi-trucks** (Class 7–8 highway tractors). **Consumer pickups stay under Cars** (`tierKey: truck`).

## Why a new category

Pickups already price under Cars. Over-the-road **semis** are a different product:

- Day cab vs **sleeper / sleep cab** living space
- Sleeper interiors often include bunk, fridge, microwave, cabinets, storage compartments
- Exterior scale and wash labor differ from light-duty pickups
- Customers should pick **Trucks** in booking step 1 — not “Car / SUV / Truck”

## What belongs here vs elsewhere

| In **Trucks** (this category) | Stay in **Cars** | Stay in **Fleet** (quote) |
|-------------------------------|------------------|---------------------------|
| Semi tractor (day cab) | Pickup (F-150, Silverado, Tacoma, etc.) | Multi-unit fleets |
| Semi tractor with sleeper cab | Mid-size / full-size pickup tiers | Box trucks booked as fleet jobs |
| Cab detail with or without trailer attached\* | | Buses / coach fleets |

\*Trailer body / reefer box exterior may be quote or Fleet add-on; v1 packages price the **tractor cab** (and cab exterior). Confirm on booking notes if full trailer wash is requested.

## Icon alignment

| Asset | Path | Role |
|-------|------|------|
| Category card | `assets/icons/3d/cat-trucks.webp` | Booking grid `bkcat-trucks` — **semi tractor**, not pickup |
| Package family | `assets/icons/3d/pack-trucks-family.webp` | Day cab + sleeper cab tractors |
| Cars pickup tier (unchanged) | studio `midsize-pickup.webp` / `tier-truck.webp` | Remains under **Cars** |

Wire in `assets/icon-3d.js`:

- `CAT.trucks` → `cat-trucks.webp` (semi)
- `FAMILY.trucks` → `pack-trucks-family.webp` (day + sleeper)
- Cab chips: `day_cab`, `sleeper_cab` (optional later: `other_cab`)

## Cab taxonomy (customer language)

| Tier key | Customer label | PT-friendly cue | Interior notes |
|----------|----------------|-----------------|----------------|
| `day_cab` | Day Cab / Single Cab | Day cab — no bunk | Driver area only; no bunk living space |
| `sleeper_cab` | Sleep Cab / Sleeper Cab | Sleeper bunk / living | Bunk + often fridge, microwave, cabinets, compartments |
| `other` | Other commercial cab | Outro | Custom note; price as day cab + review, or quote |

**Loaded sleeper (booking question):**  
“Does the sleeper include living appliances or extra compartments (fridge, microwave, cabinets)?”  
- Yes → expect Super Interior add-on and/or arrival adjustment  
- Always relevant for `sleeper_cab`

## Package ladder (initial suggested prices)

Flat starting menu for commercial trucks. Values from operator:

| ID | Customer name | Price | Scope |
|----|---------------|------:|-------|
| `interior` | Interior Detail | **$325** | Cab interior (day or sleeper): vacuum, soft surfaces, plastics UV, glass inside; sleeper living area when present |
| `int_wash` | Interior + Wash | **$400** | Interior + tractor exterior hand wash, wheels, tire shine |
| `int_wash_wax` | Interior + Wash & Wax | **$500** | Interior + wash + wax / sealant on accessible painted panels |

v1: **same package dollars for day cab and sleeper**; differentiate via add-ons (`superint`) and notes. Optional phase-2 sleeper uplift (~+25%) if ops wants automatic pricing.

### Relationship to Cars pickup tier

| | Cars pickup (`truck`) | This Trucks category |
|--|----------------------:|---------------------:|
| Vehicle | Consumer pickup | Semi / carreta |
| Interior | $235 | **$325** |
| Interior + wash path | via `full` etc. | **$400** (`int_wash`) |
| Interior + wash & wax | via `premium` etc. | **$500** (`int_wash_wax`) |

Do **not** migrate pickup models out of Cars.

## Add-ons

**Reuse the cars add-on list and prices** (same IDs):

`pethair`, `superint`, `odor`, `mold`, `sanitize`, `biohazard`, `engine`, `floormats`, `rainx`, `polymer`, `wax1yr`, `claybar`, `headlight`, `trashcans`, `ozone` (portal/server).

De-emphasize: `babyseat`, `stroller`.

**Phase-2 truck-specific candidates:**

| ID | Name | Suggested | Notes |
|----|------|----------:|-------|
| `sleeper_deep` | Sleeper Living Area Deep Clean | 95–125 | Fridge/microwave/cabinets focus; or keep as `superint` |
| `trailer_wash` | Trailer Exterior Wash | quote / 75+ | Only if operator wants à la carte |
| `chrome_polish` | Commercial Chrome Polish | quote | Large bumper/stacks — often quote |

Until phase 2, heavy sleeper work → **`superint` (+$125)** + notes.

## Catalog / code surfaces (implementation checklist)

1. **Price authority** — `netlify/lib/booking-price-catalog.js` new `PRICING.trucks`  
2. **Client mirror** — `index.html` (+ hubs) `PRICING.trucks` + `bkcat-trucks`  
3. **Icons** — `assets/icon-3d.js` ✅; HTML card still TODO  
4. **Canonical copy** — package/addon catalogs  
5. **Vehicle catalog** — **do not** move pickup `pricingClass: "truck"` into this category; optional light make list (Freightliner, Peterbilt, Kenworth, Volvo, International, Mack…)  
6. **Owner Studio** — `vc_trucks_day_cab`, `vc_trucks_sleeper_cab`; packages `pkg_trucks_*`  
7. **AI chat / homepage** — Trucks from **$325**; Cars still from Interior $190; pickups remain Cars  
8. **Parity tests**  
9. **Legacy** — historical `cars` + `truck` (pickup) prices unchanged  

## Booking UX sketch

1. Category: Cars | **Trucks** | Boats | RVs | Powersports  
2. Trucks subtitle: *Semi-trucks & sleeper cabs* (not pickups)  
3. Package → cab type (`day_cab` / `sleeper_cab`) → optional loaded question → car-style add-ons  
4. Clear line under Cars: pickups book as Cars  

## Copy notes (EN)

- Category title: **Trucks**  
- Subtitle: **Semi-trucks & sleeper cabs**   
- Explicit: *Pickups book under Cars*  
- Sleeper disclaimer: *Living appliances and storage compartments may require Super Interior — final price confirmed on arrival if condition is heavier than booked.*

## Non-goals (v1)

- Repricing consumer pickups  
- Per-foot trailer pricing as default  
- Replacing Fleet multi-unit quote flow  
- Specialty landing page (optional follow-up)

## Decision log

| Date | Decision |
|------|----------|
| 2026-09-16 | New category `trucks`; packages $325 / $400 / $500; car add-ons reused |
| 2026-09-16 | **Clarified: commercial semis only — not pickups** |
| 2026-09-16 | Icons regenerated as semi tractors (day + sleeper); pickups remain Cars |
| 2026-09-16 | Solo `bkcat-trucks` card + `PRICING.trucks` live in booking preview |
| 2026-09-16 | Cab Type section (day/sleeper) + semi icons; Trucks labeled specialty section |

| 2026-09-16 | Home specialty nav + `trucks-detailing.html`; EN-only copy; footer Cars & SUVs separate from Trucks / Semis; checkout coerce hardened |
