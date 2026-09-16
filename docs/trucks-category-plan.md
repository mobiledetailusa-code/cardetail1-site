# Trucks category plan

**Status:** Planning — icons aligned first; pricing catalog not yet live  
**Branch:** `cursor/trucks-category-plan-9a4f`  
**Principle:** Split trucks out of `cars` into their own booking category so cab type and loaded interiors can price honestly. Reuse car add-ons.

## Why a new category

Today pickups share one `cars` tier (`truck` @ Interior $235). That underprices:

- larger cab / bed labor vs a sedan
- **sleeper / sleep cab** living space (bunk, fridge, microwave, storage compartments)
- work trucks with service bodies / overloaded interiors

Trucks also need a **distinct category card + icon** in booking step 1 — they must not stay buried under “Cars / SUV / Truck”.

## Icon alignment (done in this pass)

| Asset | Path | Role |
|-------|------|------|
| Category card | `assets/icons/3d/cat-trucks.webp` | Booking grid `bkcat-trucks` |
| Package family | `assets/icons/3d/pack-trucks-family.webp` | Package cards when category = trucks |
| Existing tier (legacy) | `assets/icons/3d/tier-truck.webp` + studio `midsize-pickup.webp` / `truck.webp` | Keep until cab-specific studio shots exist |

Wire in `assets/icon-3d.js`:

- `CAT.trucks` → `cat-trucks.webp`
- `FAMILY.trucks` → `pack-trucks-family.webp`
- Update `CAT.cars` / `FAMILY.cars` alt copy to drop “and trucks” when the category card ships

**Still needed before launch:** booking HTML card (`bkcat-trucks`), hub mirrors, and preferably studio tier images for each cab class (see below).

## Cab taxonomy (customer language)

| Tier key | Customer label | What it is | Interior notes |
|----------|----------------|------------|----------------|
| `single_cab` | Single / Regular Cab | 2 doors, 1 row | Smallest cab; bed still in scope where accessible |
| `extended_cab` | Extended / Super Cab | 2–3 doors, jump seats | Mid cab labor |
| `crew_cab` | Crew / Double Cab | 4 full doors, 2 rows | Default consumer pickup |
| `sleeper_cab` | Sleep / Sleeper Cab | Semi or HD with bunk | Treat as **living space**: bunk, fridge, microwave, cabinets, compartments |

**Out of this category (stay Fleet / quote):** box trucks with cargo only, buses, multi-unit commercial fleets. A sleeper tractor **without** trailer can book here; attached trailers / reefers → Fleet quote.

**Loaded flag (booking question, not a separate tier):**  
“Does the cab include living appliances or extra compartments (fridge, microwave, cabinets)?”  
- If yes on `single_cab` / `extended_cab` / `crew_cab` → apply **Loaded Interior** surcharge or steer to `sleeper_cab` pricing  
- Always assumed relevant for `sleeper_cab`

## Package ladder (initial suggested prices)

Flat **starting** menu for trucks (same three packages across light-duty cabs initially). Values from operator:

| ID | Customer name | Price | Scope |
|----|---------------|------:|-------|
| `interior` | Interior Detail | **$325** | Cab + accessible bed / compartments vacuum, shampoo/steam soft surfaces, plastics UV, glass inside |
| `int_wash` | Interior + Wash | **$400** | Interior + exterior hand wash, wheels, tire shine |
| `int_wash_wax` | Interior + Wash & Wax | **$500** | Interior + wash + wax / sealant protect |

### Suggested cab multipliers (phase 2 — not required for v1)

| Tier | Multiplier on package | Example Interior |
|------|----------------------:|-----------------:|
| `single_cab` | 1.00 | $325 |
| `extended_cab` | 1.00 | $325 |
| `crew_cab` | 1.00 | $325 |
| `sleeper_cab` | 1.25 | $406 → round **$405** |

v1 can ship **one flat price per package** (simpler booking) and use add-ons / notes for sleeper load. Prefer documenting sleeper uplift early so ops is not surprised.

### Hierarchy vs current cars truck tier

| | Cars `truck` today | Proposed trucks category |
|--|-------------------:|-------------------------:|
| Interior | $235 | **$325** |
| Full-ish | $275 (`full`) | **$400** (`int_wash`) |
| Premium-ish | $525 (`premium`) | **$500** (`int_wash_wax`) |

New ladder is interior-led (matches how truck customers ask). Exterior-only wash can stay as a cars-style add path later or reuse `wash` if needed.

## Add-ons

**Reuse the cars add-on list and prices** (same IDs):

`pethair`, `superint`, `odor`, `mold`, `sanitize`, `biohazard`, `engine`, `floormats`, `rainx`, `polymer`, `wax1yr`, `claybar`, `headlight`, `trashcans`, `ozone` (portal/server).

Hide or de-emphasize car-only qty items that rarely apply: `babyseat`, `stroller` (keep available; do not feature).

**Truck-specific add-on candidates (phase 2):**

| ID | Name | Suggested | Notes |
|----|------|----------:|-------|
| `bedliner` | Truck Bed Deep Clean | 45–65 | Bed spray-in / liner scrub |
| `toolboxes` | Toolbox / Compartment Clean | 35 qty | Service body drawers |
| `sleeper_deep` | Sleeper Living Area Deep Clean | 95–125 | Overlaps `superint`; prefer one clear name |

Until phase 2, map heavy sleeper work to **`superint` (+$125)** + notes.

## Catalog / code surfaces (implementation checklist)

1. **Price authority** — `netlify/lib/booking-price-catalog.js` new `PRICING.trucks`  
2. **Client mirror** — `index.html` (+ hub HTML clones) `PRICING.trucks` + category card  
3. **Icons** — `assets/icon-3d.js` ✅ started; HTML `bkcat-trucks` still TODO  
4. **Canonical copy** — `canonical-package-catalog.js`, `canonical-addon-catalog.js`  
5. **Vehicle catalog** — move pickup `pricingClass: "truck"` models off `cars` into trucks resolver / `data/*-truck*` or extend cars catalog with `category: "trucks"`  
6. **Owner Studio** — `vc_truck_*` cab classes; packages `pkg_trucks_interior`, `pkg_trucks_int_wash`, `pkg_trucks_int_wash_wax`  
7. **AI chat / homepage** — starting price From **$325**; stop bundling trucks under cars “from $190”  
8. **Parity tests** — `tests/package-price-parity.test.js`  
9. **Legacy** — bookings that used `cat=cars` + `tierKey=truck` must keep historical dollar meaning

## Booking UX sketch

1. Category grid: Cars | **Trucks** | Boats | RVs | Powersports  
2. Trucks → pick package (`interior` / `int_wash` / `int_wash_wax`)  
3. Cab type chips with icons (single / extended / crew / sleeper)  
4. Optional: “Loaded living appliances?” yes/no  
5. Same add-on step as cars  
6. Make/model can still auto-suggest cab class when known

## Copy notes (EN)

- Category title: **Trucks**  
- Subtitle: Pickups, crew cabs & sleeper cabs  
- Cars card alt/copy: remove “and trucks” once trucks card is live  
- Sleeper disclaimer: *Living appliances and storage compartments may require Super Interior or a custom note — final price confirmed on arrival if condition is heavier than booked.*

## Non-goals (v1)

- Per-foot truck pricing  
- Separating mid-size vs full-size pickup paint correction packages  
- Replacing Fleet commercial quote flow  
- Specialty landing page (can follow boats/powersports pattern later)

## Decision log

| Date | Decision |
|------|----------|
| 2026-09-16 | New category `trucks`; initial packages $325 / $400 / $500; car add-ons reused |
| 2026-09-16 | Category + family icons added under `assets/icons/3d/` and wired in `icon-3d.js` |
