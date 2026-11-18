# Vehicle selection fix and cars catalog audit (2026-11-17)

Branch `fix/booking-vehicle-selection`, based on master `21050349` (after PR #407).
Nothing here changes a price, a pricing tier, a package, or a model's class.

## 1. What the booking's vehicle step does now (cars)

| Problem (confirmed on cardetail1.com, 2026-11-17) | Now |
|---|---|
| "chevy", "vw", "range rover" returned "No make found" | Nicknames resolve to the existing catalog make: Chevy/Chev/Vette → Chevrolet, VW → Volkswagen, Benz/Mercedes/Merc/MB → Mercedes-Benz, Range Rover/Landrover → Land Rover (shown as "Land Rover · Range Rover"), Caddy → Cadillac, Bimmer/Beemer → BMW, Infinity → INFINITI, Lambo → Lamborghini. No make is added or duplicated. |
| A make had to be tapped in the list | An exact make or nickname is accepted on Enter or when the field is left. Enter also takes the only suggestion. |
| No keyboard support in the list | Arrow keys, Enter and Escape. The input is an ARIA combobox with a listbox and an active option. |
| Typing a new make kept the old make's models, year and size | Any edit that no longer matches the selected make clears model, year, size, price and the Continue button. |
| A vehicle not in the catalog was a dead end | "My vehicle isn't listed" (under the selectors, and inside "No make found") opens a short quote form (see 2). |
| 2027 was not selectable (list ran 2026→1990 from the device clock) | The list runs from the catalog's `yearPolicy.selectableMax` (2027) down to 1990. 2027 is priced only for manufacturer-confirmed models (see 4). |

Files: `assets/vehicle-make-search.js` (new, matching only), `index.html` (vehicle step markup, CSS, CAR SEARCH block), `assets/vehicle-catalog.js` (`getYearPolicy`, `modelYearStatus`), `netlify/lib/car-catalog-tier.js` (one check), `data/cars-vehicle-catalog.json` + generated runtime (`modelYearVerification`), `tests/booking-vehicle-selection.test.js`.

Only `index.html` changes in the booking UI. Every hub and city page delegates booking to it through `assets/hub-booking-bridge.js` (iframe of `/?embed=1`). Their inline copies run only if that script fails to load, so they keep the old search (see 9).

## 2. "My vehicle isn't listed": quote request, never a priced booking

- The server prices public car bookings only for catalog vehicles. `submit-booking` and `evaluate-booking-offer` use `catalogTierMode: 'require_identity'`, and anything else is `vehicle_unresolved`. So the fallback does not create a booking, pick a size, or show a price.
- It collects make, model, year (optional), name, phone and email (optional), plus notes. It posts to the existing `/.netlify/functions/submit-inquiry`, the same endpoint as the chat's "talk to a person". That endpoint is rate-limited, refuses writes on preview deploys, and emails and texts the owner. Its contract is unchanged.
- The message says: vehicle, Cars & SUVs, ZIP, notes, and "No price or size was set." It carries no price, tier or amount field. The customer sees "Request sent… Nothing has been booked or charged." If the send fails, they see the phone number instead of a success message.
- Size chips are not offered for these vehicles. A chip would give a price that the server then refuses at submit.

## 3. Pricing security

- Prices still come only from the server and the catalog class. No client field became authoritative.
- New server rule, public mode only (`require_identity`): a model year after `modelYearVerification.verifiedThrough` (2026) is refused (`vehicle_unresolved`) unless that make|model is confirmed for that year. Staff mode (`known_only`) is unchanged. Years up to 2026 behave exactly as before.
- Tests cover these cases:
  - claimed tier ≠ catalog tier → `tier_mismatch` (2027 Camry as suv2, 2006 Sequoia as small)
  - an unconfirmed 2027 under every tier → refused
  - 2028 → refused
  - the year only inside the vehicle label → refused
  - a vehicle not in the catalog (Pontiac Grand Prix, Honda Prelude) → refused

## 4. 2027 model year

Only models confirmed on manufacturer press sites were added, as data in the single catalog source (`data/cars-vehicle-catalog.json` → `modelYearVerification.years["2027"]`, with sources and `checkedAt`). No year band was extended, and no class changed. Each confirmed model keeps its existing class, which matches the 2027 vehicle's body:

| Make | Confirmed for 2027 | Source |
|---|---|---|
| Toyota | Camry, Corolla, Corolla Cross, Crown, Crown Signia, C-HR, Prius, bZ4X (sold as "bZ"), Grand Highlander, Highlander (next generation, still 3-row), Land Cruiser, RAV4, Sequoia, Tundra, GR86 | pressroom.toyota.com "What's New for 2027" + Highlander release |
| Nissan | Altima, Armada, Kicks, Frontier, Murano, Pathfinder, Rogue, Sentra, Z | usa.nissannews.com "What's new" |
| Chevrolet | Silverado 1500 | news.gm.com |
| Hyundai | Tucson (all-new, still compact 2-row) | hyundainews.com 2027 changes |
| Subaru | Outback, BRZ | media.subaru.com |
| Kia | Telluride (new generation, three-row, 199.2 in; there is no 2026 Telluride) | hyundaimotorgroup.com newsroom, added 2026-11-18 |

29 models in total. Seen only in secondary coverage, so **not** confirmed yet: Honda Civic, Kia Sorento, Ford F-150, Ford Mustang, Chevrolet Colorado, Tahoe and Equinox. A 2027 Honda Civic therefore shows "We haven't confirmed the 2027 version of this model yet" and a quote button. Adding a model is a one-line data change with a manufacturer source. The tests require that every listed vehicle exists and that its make has a source.

New 2027 vehicles that are not in the catalog at all: Toyota bZ Woodland, Subaru Uncharted, and the new 2027 Chevrolet Bolt (a different body from the catalog's Bolt EV). Each needs an owner size decision (see 7).

## 5. Data consistency

- **One source of truth:** `data/cars-vehicle-catalog.json`. `scripts/sync-vehicle-catalog.cjs` generates `assets/generated/cars-vehicle-catalog.generated.js`, which the browser and server both load through `assets/vehicle-catalog.js`, and the inline `MAKES`/`MODELS` in the 13 booking pages. `--check` passes on this branch.
- **The reported "drift" on master is line endings, not data.** `sync --check` and `tests/vehicle-catalog-sync…` fail on a Windows checkout (`core.autocrlf=true`). The working copy is CRLF and the generator writes LF. The JSON and the generated data are identical.
- Audit script results over all 424 public records (one hidden fixture):
  - 0 duplicate make/model
  - 0 alias collisions
  - 0 invalid, overlapping or gapped year bands
  - every class has a price row
  - the server resolver and the page `MODELS` give the same class for every model

## 6. Catalog audit results

- **Manufacturers audited:** 44. **Models:** 424 public records, which become 444 selector entries once van cargo/passenger variants are counted.
- **Year ranges:** 409 of 424 records use the blanket 1990–2027 range, not real production years. For example, Tesla Cybertruck, Ferrari F80 and Toyota Grand Highlander all "exist" in 1990. Only 15 records carry real ranges (vans, Dodge Magnum 2005–2008, Hyundai Santa Fe class split at 2024).
  - Single-class models ignore the year at runtime (`strictValidation: false`), so this has no effect on price today.
  - Making ranges real is a large data change and was **not** done. See 8.
- **Duplicates / conflicting tiers across years:** none. The only multi-class model is Hyundai Santa Fe (≤2023 suv2, 2024+ suv3), which is correct for the 2024 3-row redesign.

## 7. Classifications that need an owner decision (nothing changed)

> Superseded by the dimension-based review in section 12. In particular, the CX-70 and the two-row luxury SUVs are **not** smaller than three-row SUVs.

Ordered by likely impact. "Under" means the customer may currently pay less than the work.

| # | Vehicle | Now | Finding | Suggested |
|---|---|---|---|---|
| 1 | Mercedes-Benz EQS / EQE | small | The catalog has only the sedans. The EQS SUV (3-row) and EQE SUV are sold under the same names, so an EQS SUV owner picks "EQS" and is priced small (**under**) | add "EQS SUV" (suv3) and "EQE SUV" (suv2) |
| 2 | Mazda CX-70 | suv3 | Two-row version of the CX-90 | suv2 (over today) |
| 3 | Kia EV6 | small | Crossover, the IONIQ 5's sibling (suv2) | suv2 (**under**) |
| 4 | Toyota 4Runner | suv2 | Body-on-frame midsize with optional 3rd row | owner call (possible **under**) |
| 5 | Jeep Grand Cherokee | suv3 | Two-row midsize. The 3-row Grand Cherokee L is its own record | suv2 (over) |
| 6 | Range Rover Sport, BMW X5/X6, Audi Q8, Mercedes GLE | suv3 | Two-row midsize luxury SUVs. Porsche Cayenne, Maserati Levante, Jaguar F-PACE and Lexus RX are suv2, so the rule is inconsistent | pick one rule (over today) |
| 7 | GMC Hummer EV | suv3 | One record covers both the Pickup and the SUV | split (Pickup → truck) or keep |
| 8 | Toyota Land Cruiser | suv3 | 2024+ (250 series) is two-row midsize; earlier generations were 3-row full-size | year band: ≤2021 suv3, 2024+ suv2 |
| 9 | Land Rover Defender | suv3 | Covers the 2-door 90 through the 3-row 130 | owner call |
| 10 | Mitsubishi Outlander, Dodge Journey | suv3 | Compact or midsize with a small optional 3rd row | owner call (over) |
| 11 | Hyundai Santa Fe 2013–2019 "Santa Fe (XL)" | suv2 | The long-wheelbase version was 3-row | owner call (**under**) |
| 12 | Tier spread | — | suv3 covers both a Mazda CX-90 and a Suburban, Yukon XL, Escalade ESV or Expedition MAX. truck covers both a Ford Maverick and an F-350 crew long-bed | needs new tiers, which require approval; not proposed here |

Regression-protected and unchanged: Dodge Magnum 2005–2008 small, Toyota Sequoia 2006 suv3.

## 8. Missing makes and models (candidates; each needs a size before it can be priced)

Until they are added, these go through "My vehicle isn't listed".

- **Makes not in the catalog:** Pontiac, Saturn, Mercury, Scion, Saab, Suzuki, Hummer (H2/H3), Isuzu, Oldsmobile, Plymouth, smart, Fisker. Pre-2011 "Dodge Ram" pickups are under the Ram make only, so a customer starting from Dodge does not find them.
- **High-volume older models missing from present makes (examples, not exhaustive):**
  - Toyota: Matrix, Yaris, Echo, Celica, Solara, FJ Cruiser, Previa
  - Honda: Prelude, S2000, Crosstour, Element (present)
  - Nissan: Xterra, Juke, Cube, 350Z/370Z (only "Z")
  - Chevrolet: Avalanche, Cavalier, Cobalt, HHR, Sonic, Aveo, Volt, Uplander, Venture, Monte Carlo, S-10
  - Ford: Five Hundred, Freestyle, Crown Victoria, Excursion, Windstar, Freestar, Explorer Sport Trac, EcoSport, C-Max
  - Dodge: Neon, Caliber, Avenger, Stratus, Intrepid, Nitro, Dakota, Caravan, Viper
  - Chrysler: 200, Sebring, PT Cruiser, Aspen
  - Jeep: Liberty, Commander, Patriot
  - GMC: Envoy, Jimmy
  - Buick: LeSabre, Century, Lucerne, Rendezvous, Rainier, Verano
  - Cadillac: CTS, ATS, DTS, STS, XTS, CT6, Escalade EXT
  - Lincoln: MKC, MKT, MKS, Town Car, Continental
  - Hyundai: Accent, Veloster, Azera, Genesis sedan/coupe, Veracruz
  - Kia: Rio, Cadenza, K900, Rondo, Borrego
  - Mazda: Mazda5, Tribute, CX-7, RX-8, MPV
  - Subaru: Baja, Tribeca
  - Mitsubishi: Lancer, Galant, Eclipse, Endeavor, Montero
  - Volkswagen: Beetle, CC, Eos, Routan, Touareg
  - Volvo: S40, S80, V50, V70, XC70, C30, C70
  - Audi: R8, e-tron GT, allroad
  - BMW: 1 Series, i8, Z3
  - Mercedes-Benz: M-Class/ML, GL, GLK, R-Class, SLK/SLC, CLK
  - Lexus: RC, CT, HS, SC
  - INFINITI: G35/G37, M35/M37/M45, FX35/FX45, EX35, JX35, QX56, QX30, QX70
  - Acura: TL, TSX, RSX, RL
  - Jaguar: S-Type, X-Type, XJ, XK
  - Land Rover: LR2, LR3, LR4
- **Current-generation models missing:**
  - Buick Envista
  - Kia K4 (replaced the Forte)
  - Hyundai IONIQ 9 (3-row)
  - Cadillac Optiq, Vistiq, Escalade IQ
  - Mercedes-Benz CLE, EQS SUV, EQE SUV
  - Audi Q6 e-tron
  - Acura ADX
  - Toyota bZ Woodland
  - Subaru Uncharted
  - the 2027 Chevrolet Bolt

Suggested order: current-generation models first, then the older high-volume list by NJ used-car frequency. Each model needs a class with a source.

## 9. Known limitations

- The inline booking copies in the 12 hub/city pages keep the old make search. They only run if `hub-booking-bridge.js` fails to load. Moving them onto the shared module is a separate change.
- 2027 confirmation is a list as of 2026-11-17 and needs updating as manufacturers publish. Until then, unconfirmed 2027 cars go to a quote.
- The fallback relies on `submit-inquiry` email/SMS delivery. If both are unconfigured, the request still returns `ok` without reaching anyone. That is today's chat-handoff behavior too.
- The quote request is not tracked as a funnel event. No analytics or conversion event was added (Phase 3 constraint).

## 10. Tracking check (Phase 3, nothing changed)

- **The customer sees cars as Category → Vehicle → Package → Details → Review**, but internal panels are `bs1` Category, `bs2` Package, `bs3` Vehicle, `bs4` Details, `bs5` Review. `progressTabForPanel` swaps 2↔3 only for the tab labels.
- `assets/revops-booking-hooks.js` maps events by panel number:
  - `bkGoTo(2)` (Package) fires `vehicle_added`
  - `bkGoTo(3)` (Vehicle) fires `contact_captured`
  - `bkGoTo(4)` (Details) fires `payment_step_viewed`
  - `booking_step` carries the panel number, not the visible step
- So "contact_captured" in reports means "reached the vehicle step". `assets/hub-booking-bridge.js`'s header comment also lists the old order (Package before Vehicle).
- **The 7 → 6 → 4 → 0 funnel is unique `anonymous_session_id`s** with `traffic_type = paid`, Nov 10–17. It was recomputed by visible step, not by event name.
- **Production testing:** the live walkthrough on 2026-11-17 used a non-paid session (direct), so it did not enter the paid numbers. It did add a few `direct` booking-step events. The local tests for this branch ran on a static server with no functions, so no event left the machine.
- Correcting the event names changes the meaning of historical lead scoring and dashboard metrics, so it needs its own approval.

## 11. Package screen proposal (not implemented, needs owner approval)

Today for a 2025 Toyota Camry (small), the list is ordered Premium Full Detail $250 (Most booked), Signature $400, Exterior Refresh $335, Interior $200, Maintenance $160, Exterior Hand Wash $125, Ceramic 1-yr $650, Ceramic 3-yr $1,050.

- The order is neither by price nor by scope. The three entry services sit below $250–$400.
- The screen never says when payment happens. The review step does ("Nothing is charged when you book").

Proposal, with no price, availability, eligibility or default-selection change:

```
Before                               After (same cards, same prices)
───────────────────────────────      ─────────────────────────────────────
Pick Your Package                    Pick Your Package
                                     Nothing is charged when you book.
                                     You pay after the service.
○ Premium Full Detail  $250 ★        QUICK CLEAN
○ Signature Restoration $400           ○ Exterior Hand Wash        $125
○ Exterior Refresh     $335            ○ Maintenance Detail        $160
○ Interior Detail      $200            ○ Interior Detail           $200
○ Maintenance Detail   $160          FULL DETAIL
○ Exterior Hand Wash   $125            ○ Premium Full Detail $250 ★ Most booked
○ Ceramic 1 yr         $650            ○ Exterior Refresh & Protect $335
○ Ceramic 3 yr        $1050            ○ Signature Restoration     $400
                                     PROTECTION
                                       ○ Ceramic 1 yr / 3 yr  $650 / $1050
```

- **Group headers** ("Quick clean", "Full detail", "Protection") separate entry services from full detailing without hiding either.
- **One payment line** reuses the review step's own wording.
- **No preselection.** "Most booked" stays on Premium.
- **Measure:** paid sessions reaching Details. The current sample (4 at Package, 0 at Details) is too small to show price sensitivity on its own.

The ordering within groups is the "package reordering" you asked to hold. It is shown here for approval only.

## 12. Final classification review (2026-11-18)

### Prices used below (unchanged; `index.html` PRICING.cars)

| Tier | Exterior Hand Wash | Premium Full Detail | Signature Restoration | Ceramic 1 yr |
|---|---|---|---|---|
| small | $125 | $250 | $400 | $650 |
| suv2 | $145 | $285 | $495 | $725 |
| suv3 | $165 | $310 | $570 | $825 |
| truck | $165 | $300 | $555 | $825 |

### Size reference points

Lengths are rounded overall length. Sources are listed at the end of this section.

| Vehicle | Tier now | Length | Rows / seats |
|---|---|---|---|
| Toyota RAV4 | suv2 | ~181 in | 2 / 5 |
| Hyundai IONIQ 5 | suv2 | ~182.5 in | 2 / 5 |
| Toyota Highlander | suv3 | ~195 in | 3 / 7–8 |
| Mazda CX-90 | suv3 | ~201.6 in | 3 / 7–8 |
| Kia Telluride (2027) | suv3 | 199.2 in | 3 / 7–8 |

The key finding: the two-row luxury SUVs (X5, GLE, Q8, Cayenne) are 194–197 in long and about 78 in wide. That is the same exterior size as a Highlander, and the exterior is most of a detail's workload. Having two rows does not make a vehicle smaller.

### Per vehicle

| Vehicle | Tier now | Years affected | Body | Exterior | Interior | Compared with | Recommended | Price effect today (Full / Signature) | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| Mercedes EQS **Sedan** | small | 2022+ (record is generic 1990–2027) | 4-door sedan/liftback | ~205 in, low roof | 5 seats | other large sedans (S-Class, 7 Series) are small | keep small | — | sedan record |
| Mercedes EQS **SUV** | not in catalog; picked as "EQS" → small | 2023+ | full-size electric SUV | ~201.8 in (5,125 mm), ~80 in wide, ~67.6 in tall | 5 seats, optional 3rd row (7) | Highlander and CX-90 (suv3) | suv3 | was underpriced: $250 vs $310 / $400 vs $570 | MBUSA (5, 7 optional), Wards (3rd row), Carwow (5,125 × 2,034 mm) |
| Mercedes EQE **Sedan** | small | 2023+ | sedan | ~196.9 in | 5 | E-Class (small) | keep small | — | TrueCar (manufacturer specs) |
| Mercedes EQE **SUV** | not in catalog; picked as "EQE" → small | 2023+ | midsize electric SUV | ~191.8 in, 76.4 in wide, ~66 in tall | 2 rows / 5 | Lexus RX, GLC-size (suv2) | suv2 | was underpriced: $250 vs $285 / $400 vs $495 | TrueCar, Yahoo Autos |
| Kia EV6 | small | 2022+ | low crossover / liftback | 184.3–184.8 in, 74.0–74.4 in wide, 60.8 in tall | 2 / 5 | its platform twin IONIQ 5 (182.5 in) is suv2 | suv2 (lower roof than most SUVs, but crossover body and hatch area) | underpriced by $35 / $95 | kiamedia.com 2022 specifications |
| Mazda CX-70 | suv3 | 2025+ | midsize SUV | 200.8–201.6 in, same 122.8 in wheelbase as the CX-90 | 2 / 5 | CX-90 (suv3), the same body with 3 rows | **keep suv3** (it is as large as the CX-90) | — | Edmunds, KBB, Mazda dealer spec |
| BMW X5 | suv3 | G05 2019+ (also earlier gens) | midsize luxury SUV | ~194.3 in, ~78.9 in wide | 5, optional 3rd row on G05 | Highlander (suv3) | keep suv3 | — | vehiclesizes (4,935 mm), dealer (optional 3rd row) |
| Mercedes GLE | suv3 | 2016+ (ML before) | midsize luxury SUV | ~193.9–195 in | 5, optional 3rd row (W167, 2020+) | X5 (suv3) | keep suv3 | — | KBB 2026 (193.9 in), Mercedes dealer (5 or 7) |
| Audi Q8 | suv3 | 2019+ | large two-row coupe-SUV | 196.3–196.8 in, 78.5 in wide (no mirrors), ~67 in tall | 5 seats | larger than the X5 | keep suv3 | — | Audi MediaCenter (4,986 × 1,995 × 1,705 mm, "space for five") |
| Porsche Cayenne | **suv2** | 2003+ | midsize luxury SUV | 194.1 in, 78.1 in wide, 66.8 in tall | 5 seats | same size as X5/GLE/Q8 (suv3) | **suv3** | underpriced by $25 / $75 (ceramic 1-yr $100) | Velocity Journal, Porsche dealer (194.1 in, 114 in wheelbase) |
| Range Rover Sport | suv3 | 2006+ | midsize luxury SUV | not verified this round | 2 / 5 | X5 group | keep suv3 | — | dimensions still to be sourced |
| Jeep Grand Cherokee (2-row) | suv3 | 1993+ | midsize SUV | ~193.5 in (Grand Cherokee L is 204.9 in and 11.4 in longer) | 2 / 5 | X5 group, Highlander | keep suv3 | — | vehiclesizes (L 5,204 mm), dealer comparison (+11.4 in) |
| Toyota 4Runner | **suv2** | 1990+ | body-on-frame midsize SUV | ~194.9 in (2025 generation, 4,950 mm) | 2 / 5; optional 3rd row on some generations | Grand Cherokee (suv3), Cayenne | **suv3**, same rule as Cayenne | underpriced by $25 / $75 | vehiclesizes (4,950 mm) |
| GMC Hummer EV | suv3 (one record) | 2022+ | **Pickup** and **SUV** share one name | Pickup ~216.8 in; SUV ~196.8 in | 5 seats | Pickup ≈ full-size truck; SUV ≈ suv3 | **separate variants**: Pickup → truck, SUV → keep suv3 | Pickup is overpriced by $10 / $15 today | evspecifications, carbuzz (wheelbase 135.6 vs 126.7 in) |
| Toyota Land Cruiser | suv3 | 1990–2021 full-size 3-row; 2024+ (250 series) two-row | SUV | 250 series ~193.9 in | 2024+: 2 rows in the US | X5 group (suv3) | keep suv3 (the 250 is still X5-sized) | — | vehiclesizes (4,925 mm) |
| Land Rover Defender | suv3 (one record) | 2020+ | 90 (2-door), 110, 130 | 90 ~180.4 in; 130 ~210.9 in | 90: 5–6; 110: 5/7; 130: up to 8 | 90 ≈ RAV4 size; 130 ≈ Suburban size | **separate variants**: 90 → suv2, 110 and 130 → suv3 | 90 overpriced by $25 / $75 | Land Rover (seats), vehiclesizes, driving.co.uk |
| Mitsubishi Outlander / Dodge Journey | suv3 | Outlander 2007+ with 3rd row; Journey 2009–2020 | compact or midsize with a small 3rd row | not verified this round | 3 rows (small) | between RAV4 and Highlander | keep suv3 for now | possibly overpriced | dimensions still to be sourced |
| Hyundai Santa Fe XL (2013–2019) | suv2 (through the Santa Fe record) | 2013–2019 | 3-row long-wheelbase version | not verified this round | 3 rows / 6–7 | Highlander (suv3) | separate variant "Santa Fe XL" → suv3, quote until approved | underpriced by $25 / $75 | needs a source |
| Tier spread (suv3, truck) | — | — | — | Mazda CX-90 to Suburban; Maverick to F-350 | — | — | keep tiers; new tiers need owner approval | — | — |

### Recommendations

| # | Vehicle | Action |
|---|---|---|
| 1 | Mercedes EQS SUV | **SEPARATE MODEL VARIANTS.** Done in this PR as a *quote-only* entry. The dropdown shows "EQS Sedan" (same record, same price) and "EQS SUV (quote)". The SUV goes to the quote form and the server refuses it as a priced booking. Pricing it at suv3 needs owner approval. |
| 2 | Mercedes EQE SUV | **SEPARATE MODEL VARIANTS.** Same treatment ("EQE Sedan" / "EQE SUV (quote)"). Suggested suv2. |
| 3 | Mercedes EQS / EQE sedans | **KEEP CURRENT TIER** (small). |
| 4 | Kia EV6 | **CHANGE TIER — OWNER APPROVAL REQUIRED** (small → suv2). |
| 5 | Mazda CX-70 | **KEEP CURRENT TIER** (suv3). This reverses the earlier suggestion: the CX-70 is the CX-90's size. |
| 6 | BMW X5 | **KEEP CURRENT TIER** (suv3) |
| 7 | Mercedes GLE | **KEEP CURRENT TIER** (suv3) |
| 8 | Audi Q8 | **KEEP CURRENT TIER** (suv3) |
| 9 | Porsche Cayenne | **CHANGE TIER — OWNER APPROVAL REQUIRED** (suv2 → suv3, so it matches the vehicles it is the same size as) |
| 10 | Range Rover Sport, Jeep Grand Cherokee | **KEEP CURRENT TIER** (suv3) |
| 11 | Toyota 4Runner | **CHANGE TIER — OWNER APPROVAL REQUIRED** (suv2 → suv3, same rule as Cayenne) |
| 12 | GMC Hummer EV | **SEPARATE MODEL VARIANTS** (Pickup → truck, SUV → suv3). Owner approval required. |
| 13 | Toyota Land Cruiser | **KEEP CURRENT TIER** (suv3) |
| 14 | Land Rover Defender | **SEPARATE MODEL VARIANTS** (90 → suv2; 110 and 130 → suv3). Owner approval required. |
| 15 | Mitsubishi Outlander, Dodge Journey | **KEEP CURRENT TIER** until dimensions are sourced |
| 16 | Hyundai Santa Fe XL 2013–2019 | **MANUAL ESTIMATE UNTIL VERIFIED.** Add it as a quote-only variant like the EQS SUV once you agree. Not done in this PR. |
| 17 | Tier spread | **KEEP CURRENT TIER.** New tiers need owner approval. |

Not implemented in this PR: every CHANGE TIER item, the Hummer and Defender splits, and the Santa Fe XL. Each is a one-record catalog change plus a test, once approved.

### 2027 recheck (Task 3)

- **Confirmed list:** 29 models (Kia Telluride added from the Hyundai Motor Group newsroom).
- **Naming changes:**
  - Toyota sells the bZ4X as "bZ" for 2027. It is mapped to the bZ4X record.
  - The 2027 Highlander is a new generation, still 3-row.
  - The 2027 Telluride is a new generation, still 3-row.
  - None changed body class.
- **Discontinued models never get a 2027 price.** Tests cover the Chevrolet Camaro and Malibu: refused for 2027, still priced for 2024.
- **The browser and server use the same rule** (`modelYearStatus`, from the same JSON).
- **Historical ranges are untouched** (Dodge Magnum 2005–2008 small, Sequoia 2006 suv3, Santa Fe split at 2024).
- **Remaining gap:** 2027 appears in every model's year list, and a model that doesn't exist in 2027 shows "not confirmed yet" plus a quote button, not a price. Real per-model year lists depend on the year-range work below.

### Generic 1990–2027 ranges (Task 4)

**What can go wrong today:** for single-class models the year is ignored, so impossible combinations are accepted and priced with today's class. Examples:
- a "1990 Tesla Model Y" or "1995 Toyota Crown"
- old generations whose body differs from today's: 1990s Ford Bronco and Chevrolet Blazer (two-door full-size or compact), Honda CR-V or Toyota RAV4 first generations, Nissan Rogue 2014–2020 with optional 3rd row

The price risk is mostly small. The identity risk is real (impossible vehicles accepted), and it is what blocks per-model year lists and strict year validation.

**Long-term strategy:**
1. **Source the years.** Use NHTSA's vPIC (`GetModelsForMakeYear`), a free US-government API, to produce each model's first and last US model year. Store the result in `data/cars-vehicle-catalog.json` (one source), with the vPIC snapshot date.
2. **Add generations only where the class changes.** Santa Fe already works this way. Candidates are the Land Cruiser, CR-V/RAV4 first generations, the Bronco and the Blazer. Each needs owner approval with dimensions.
3. **Add a CI guard:** a test that fails if a public model has the blanket range, so new entries can't regress.
4. **Turn on strict years** for public bookings only after steps 1–3. Years outside the range then go to the quote form, as unconfirmed 2027s do now. Staff mode stays lenient.
5. **Ship in batches by make,** each as its own PR, starting with the makes customers actually book (Toyota, Honda, Nissan, Chevrolet, Ford, Jeep, BMW, Mercedes-Benz).

### PR #408 safety recheck (Task 5)

All of the following are covered by tests that run the real `index.html` code in jsdom and the server check:
- **Nicknames:** chevy, vw, benz, mercedes, range rover, caddy, infinity, and all 44 makes by name.
- **Make switching** clears the old selections.
- **Missing vehicles reach the quote form:** "No make found", the "not listed" button, and EQS/EQE SUV.
- **Unknown vehicles are never priced:** Pontiac, Honda Prelude, EQS SUV, unconfirmed 2027s.
- **Server tier validation is active** (`tier_mismatch`, `vehicle_unresolved`).
- **Magnum and Sequoia are unchanged.**
- **2027 works as designed:** Camry and Telluride priced, Civic refused, 2028 refused.
- **No customer data is lost:**
  - the quote request carries name, phone, email, vehicle, ZIP and notes, and is sent to the owner by email and SMS through `submit-inquiry`
  - a failed send shows the phone number, and the form keeps what was typed
  - no existing booking field was removed

**Line-ending regression resolved.** `scripts/sync-vehicle-catalog.cjs --check` and the "MODELS hashes identical" test now compare content with line endings normalized. A Windows checkout with `core.autocrlf=true` no longer reports false drift. On this machine, 12 tests that fail on master now pass, and none fail that pass on master.

### Sources for section 12

- MBUSA EQS 450 4MATIC SUV — https://Mbusa.Com/en/vehicles/model/eqs/suv/eqs450x4
- Wards, EQS SUV — https://www.wardsauto.com/node/386479
- Carwow, EQS SUV dimensions — https://carwow.co.uk/mercedes/eqs-suv/specifications
- TrueCar, EQE sedan vs SUV sizing — https://www.truecar.com/compare/mercedes-benz-eqe-sedan-vs-mercedes-benz-eqe-suv/sizing/
- Kia Media, 2022 EV6 specifications — https://kiamedia.com/us/en/models/ev6/2022/specifications
- Edmunds, CX-70 — https://www.edmunds.com/mazda/cx-70/2025/st-402026411/features-specs
- KBB, CX-70 — https://www.kbb.com/mazda/cx-70/2026/specs
- vehiclesizes, X5 G05 LCI — https://www.vehiclesizes.com/cars/bmw/x5/x5-g05-lci-facelift-2023-suv-2024
- BMW dealer, X5 dimensions — https://www.bmwofarlington.com/bmw-research/bmw-x5-dimensions-arlington-tx/
- KBB, GLE — https://www.kbb.com/mercedes-benz/gle/2026/specs/
- Mercedes dealer, GLE — https://www.rusnakarcadia.com/mercedes-benz-information/mercedes-benz-gle-dimensions/
- Audi MediaCenter, Q8 dimensions — https://audi-mediacenter.com/en/the-audi-q8-the-new-top-model-of-the-q-family-10412/dimensional-and-space-concept-10415
- Velocity Journal, 2024 Cayenne — https://www.velocityjournal.com/models/37590/configuration/97055
- Porsche Westlake, Cayenne dimensions — https://westlake.porsche.com/en/porsche-information/porsche-cayenne-dimensions
- vehiclesizes, Grand Cherokee L vs 4Runner — https://www.vehiclesizes.com/compare/10269-1631/jeep-grand-cherokee-l-v-wl-facelift-2025-suv-2026-vs-toyota-4runner-vi-suv-2025
- evspecifications, Hummer EV Pickup — https://www.evspecifications.com/en/model/08e81ca
- CarBuzz, Hummer EV SUV vs Pickup — https://carbuzz.com/news/gmc-hummer-ev-suv-vs-pickup-the-main-differences
- vehiclesizes, Land Cruiser vs Defender 90 — https://www.vehiclesizes.com/compare/1950-2716/toyota-land-cruiser-j250-suv-2024-vs-land-rover-defender-90-l663-off-road-vehicle-2020
- Land Rover, Defender — https://www.landrover.com/vehicles/defender/index
- Hyundai Motor Group, 2027 Telluride — https://www.hyundaimotorgroup.com/en/news/introducing-the-all-new-2027-kia-telluride-first-ever-hybrid-increased-x-pro-capability-elevate-the-three-row-suv

Third-party spec sites were used where the manufacturer page publishes dimensions only as images. Figures vary by trim and model year by up to about 1 inch. No recommendation depends on a difference that small.

## 13. Owner decision implemented (2026-11-18)

The quote-only approach for recognizable variants is withdrawn. Recognized vehicles are now classified and priced automatically, from `data/cars-vehicle-catalog.json` only. The `quoteOnlyModels` block and its booking code were removed. No service price changed.

### Classifications

| Vehicle | Before | Now | Note |
|---|---|---|---|
| Mercedes-Benz EQS Sedan | "EQS", small | **EQS Sedan**, small | old name "EQS" kept as an alias, so stored bookings still resolve to the sedan |
| Mercedes-Benz EQS SUV | not in catalog | **EQS SUV**, suv3 (2023–2027) | new record |
| Mercedes-Benz EQE Sedan | "EQE", small | **EQE Sedan**, small | alias "EQE" kept |
| Mercedes-Benz EQE SUV | not in catalog | **EQE SUV**, suv2 (2023–2027) | new record |
| Kia EV6 | small | **suv2** | approved |
| Porsche Cayenne | suv2 | **suv3** | approved |
| Toyota 4Runner | suv2 | **suv3** | approved |
| Mazda CX-70, BMW X5, Mercedes GLE, Audi Q8 | suv3 | suv3 | kept |
| GMC Hummer EV | one record, suv3 | **Hummer EV SUV**, suv3 (2024–2027) + **Hummer EV Pickup**, truck (2022–2027) | old name "Hummer EV" is an alias of the SUV (same price as before) |
| Land Rover Defender | one record, suv3 | **Defender 90**, **Defender 110**, **Defender 130**, all suv3 | old name "Defender" is an alias of the 110 |

In the selector, the customer now sees "EQS Sedan", "EQS SUV", "EQE Sedan", "EQE SUV", "Hummer EV Pickup", "Hummer EV SUV" and "Defender 90/110/130". There are no bare ambiguous names and no extra steps.

### Exceptions (reported, not applied)

1. **Defender 90 kept at suv3.** At about 180 in it is RAV4-sized, and suv2 would fit. That would lower its price, which was not approved, so it stays at the current size.
2. **Porsche Cayenne Electric stays suv2.** It is the same size class as the Cayenne, so suv3 is recommended for consistency.
3. **The card label shows the price tier.** It reads "Porsche Cayenne · 3-Row SUV" and "Toyota 4Runner · 3-Row SUV". A test requires the display class to equal the pricing class, so the label follows the tier. The `rows` field keeps the real count (2). Changing the label wording would be a separate UI decision.
4. **Hyundai Santa Fe 2013–2018 naming.** In those years "Santa Fe" was the 3-row long-wheelbase model and the 2-row was "Santa Fe Sport". In 2019 the 3-row was "Santa Fe XL". The catalog prices every 2013–2023 "Santa Fe" as suv2, so 3-row owners are underpriced by $25 / $75. The fix (Santa Fe 2013–2018 → suv3, plus "Santa Fe Sport" suv2 and "Santa Fe XL" suv3) raises a price and needs approval.

### Catalog expansion

- **282 records added.** Old: 44 makes, 424 public records. New: **56 makes, 706 public records**.
- **New makes:** Pontiac, Saturn, Mercury, Scion, Saab, Suzuki, Hummer, Isuzu, Oldsmobile, Plymouth, smart, Fisker.
- **Rule for in-between bodies:** the larger tier is used, so nothing is silently placed in a cheaper tier. Minivans use display "Minivan" with suv3 pricing, like the existing ones.
- **Year ranges on added records are approximate US model years.** Years don't change the price for these models: there's one size per model, and the runtime isn't strict about years. They only decide that none of them gets a 2027 price. A vPIC pass (section 12) should refine them.
- **2027:** Toyota bZ Woodland and Subaru Uncharted joined the manufacturer-confirmed list (31 models). The bZ4X also answers to "bZ".
- **The "My vehicle isn't listed" quote form stays** for genuinely unknown vehicles only. It never sets a size or price.

### Added models by make
- **Acura** (7): ADX (2025–2027, suv2); TL (1996–2014, small); TSX (2004–2014, small); RSX (2002–2006, small); RL (1996–2012, small); CL (1997–2003, small); Legend (1990–1995, small)
- **Audi** (5): Q6 e-tron (2025–2027, suv2); e-tron GT (2022–2027, small); R8 (2008–2023, small); A4 allroad (2013–2016, small); A6 allroad (2020–2025, small)
- **BMW** (3): 1 Series (2008–2013, small); i8 (2014–2020, small); Z3 (1996–2002, small)
- **Buick** (10): Envista (2024–2027, suv2); LeSabre (1990–2005, small); Century (1990–2005, small); Lucerne (2006–2011, small); Park Avenue (1991–2005, small); Rendezvous (2002–2007, suv3); Rainier (2004–2007, suv2); Terraza (2005–2007, minivan/suv3); Verano (2012–2017, small); Cascada (2016–2019, small)
- **Cadillac** (11): Optiq (2025–2027, suv2); Vistiq (2026–2027, suv3); Escalade IQ (2025–2027, suv3); CTS (2003–2019, small); ATS (2013–2019, small); DTS (2006–2011, small); STS (2005–2011, small); XTS (2013–2019, small); CT6 (2016–2020, small); DeVille (1990–2005, small); Escalade EXT (2002–2013, truck)
- **Chevrolet** (16): Avalanche (2002–2013, truck); Cavalier (1990–2005, small); Cobalt (2005–2010, small); HHR (2006–2011, suv2); Sonic (2012–2020, small); Aveo (2004–2011, small); Volt (2011–2019, small); Uplander (2005–2008, minivan/suv3); Venture (1997–2005, minivan/suv3); Astro (1990–2005, minivan/suv3); Monte Carlo (1995–2007, small); Lumina (1990–2001, small); S-10 (1990–2004, truck); SSR (2003–2006, truck); Captiva Sport (2012–2015, suv2); Tracker (1999–2004, suv2)
- **Chrysler** (6): 200 (2011–2017, small); Sebring (1995–2010, small); PT Cruiser (2001–2010, small); Aspen (2007–2009, suv3); Crossfire (2004–2008, small); Concorde (1993–2004, small)
- **Dodge** (12): Neon (1995–2005, small); Caliber (2007–2012, small); Avenger (2008–2014, small); Stratus (1995–2006, small); Intrepid (1993–2004, small); Nitro (2007–2012, suv2); Dakota (1990–2011, truck); Caravan (1990–2007, minivan/suv3); Viper (1992–2017, small); Ram 1500 (1994–2010, truck); Ram 2500 (1994–2010, truck); Ram 3500 (1994–2010, truck)
- **Fisker** (1): Ocean (2023–2024, suv2)
- **Ford** (14): Five Hundred (2005–2007, small); Freestyle (2005–2007, suv3); Taurus X (2008–2009, suv3); Crown Victoria (1992–2011, small); Excursion (2000–2005, suv3); Windstar (1995–2003, minivan/suv3); Freestar (2004–2007, minivan/suv3); Contour (1995–2000, small); Escort (1990–2003, small); Thunderbird (1990–2005, small); Probe (1990–1997, small); Explorer Sport Trac (2001–2010, truck); EcoSport (2018–2022, suv2); C-Max (2013–2018, small)
- **GMC** (5): Hummer EV Pickup (2022–2027, truck); Envoy (1998–2009, suv2); Envoy XL (2002–2006, suv3); Jimmy (1990–2005, suv2); Sonoma (1991–2004, truck)
- **Honda** (3): Prelude (1990–2001, small); S2000 (2000–2009, small); Crosstour (2010–2015, suv2)
- **Hummer** (4): H1 (1992–2006, suv3); H2 (2003–2009, suv3); H3 (2006–2010, suv2); H3T (2009–2010, truck)
- **Hyundai** (11): IONIQ 9 (2026–2027, suv3); Accent (1995–2022, small); Veloster (2012–2022, small); Azera (2006–2017, small); Genesis (2009–2016, small); Genesis Coupe (2010–2016, small); Equus (2011–2016, small); Tiburon (1997–2008, small); Entourage (2007–2009, minivan/suv3); Veracruz (2007–2012, suv3); Nexo (2019–2025, suv2)
- **INFINITI** (13): G35 (2003–2008, small); G37 (2008–2013, small); M35 (2006–2010, small); M37 (2011–2013, small); FX35 (2003–2012, suv2); EX35 (2008–2012, suv2); JX35 (2013–2013, suv3); QX56 (2004–2013, suv3); QX4 (1997–2003, suv2); QX30 (2017–2019, suv2); QX70 (2014–2017, suv2); Q70 (2014–2019, small); I35 (1996–2004, small)
- **Isuzu** (5): Rodeo (1991–2004, suv2); Trooper (1992–2002, suv2); Ascender (2003–2008, suv3); Axiom (2002–2004, suv2); i-Series (2006–2008, truck)
- **Jaguar** (4): S-Type (2000–2008, small); X-Type (2002–2008, small); XJ (1990–2019, small); XK (1997–2015, small)
- **Jeep** (3): Liberty (2002–2012, suv2); Commander (2006–2010, suv3); Patriot (2007–2017, suv2)
- **Kia** (8): K4 (2025–2027, small); Rio (2001–2023, small); Spectra (2000–2009, small); Cadenza (2014–2020, small); K900 (2015–2020, small); Amanti (2004–2009, small); Borrego (2009–2009, suv3); Rondo (2007–2010, suv3)
- **Land Rover** (5): Defender 90 (2020–2027, suv3); Defender 130 (2023–2027, suv3); LR2 (2008–2015, suv2); LR3 (2005–2009, suv3); LR4 (2010–2016, suv3)
- **Lexus** (4): RC (2015–2027, small); CT (2011–2017, small); HS (2010–2012, small); SC (1992–2010, small)
- **Lincoln** (7): MKC (2015–2019, suv2); MKT (2010–2019, suv3); MKS (2009–2016, small); Town Car (1990–2011, small); Continental (1990–2020, small); LS (2000–2006, small); Mark LT (2006–2008, truck)
- **Mazda** (10): Mazda5 (2006–2015, minivan/suv3); CX-7 (2007–2012, suv2); Tribute (2001–2011, suv2); RX-8 (2004–2011, small); RX-7 (1990–1995, small); Protege (1990–2003, small); MPV (1990–2006, minivan/suv3); Mazda2 (2011–2014, small); Millenia (1995–2002, small); B-Series (1994–2009, truck)
- **Mercedes-Benz** (10): EQS SUV (2023–2027, suv3); EQE SUV (2023–2027, suv2); CLE (2024–2027, small); M-Class (1998–2015, suv3); GL-Class (2007–2016, suv3); GLK (2010–2015, suv2); R-Class (2006–2013, suv3); SLK (1998–2016, small); SLC (2017–2020, small); CLK (1998–2009, small)
- **Mercury** (10): Grand Marquis (1992–2011, small); Mountaineer (1997–2010, suv3); Milan (2006–2011, small); Sable (1990–2009, small); Mariner (2005–2011, suv2); Montego (2005–2007, small); Monterey (2004–2007, minivan/suv3); Villager (1993–2002, minivan/suv3); Cougar (1999–2002, small); Marauder (2003–2004, small)
- **Mitsubishi** (9): Lancer (2002–2017, small); Galant (1990–2012, small); Eclipse (1990–2012, small); Endeavor (2004–2011, suv2); Montero (1990–2006, suv3); Montero Sport (1997–2004, suv2); Raider (2006–2009, truck); Diamante (1992–2004, small); i-MiEV (2012–2017, small)
- **Nissan** (7): Xterra (2000–2015, suv2); Juke (2011–2017, suv2); Cube (2009–2014, suv2); 350Z (2003–2009, small); 370Z (2009–2020, small); 300ZX (1990–1996, small); Rogue Select (2014–2015, suv2)
- **Oldsmobile** (6): Alero (1999–2004, small); Aurora (1995–2003, small); Bravada (1991–2004, suv2); Intrigue (1998–2002, small); Silhouette (1990–2004, minivan/suv3); Cutlass (1990–1999, small)
- **Plymouth** (2): Voyager (1990–2000, minivan/suv3); Neon (1995–2001, small)
- **Pontiac** (13): G6 (2005–2010, small); Grand Prix (1990–2008, small); Vibe (2003–2010, small); Torrent (2006–2009, suv2); Aztek (2001–2005, suv2); Grand Am (1990–2005, small); Bonneville (1990–2005, small); Sunfire (1995–2005, small); Solstice (2006–2009, small); G8 (2008–2009, small); G5 (2007–2009, small); Montana (1999–2009, minivan/suv3); Firebird (1990–2002, small)
- **Porsche** (2): Boxster (1997–2016, small); Cayman (2006–2016, small)
- **Saab** (3): 9-3 (1999–2011, small); 9-5 (1999–2011, small); 9-7X (2005–2009, suv2)
- **Saturn** (9): Ion (2003–2007, small); Vue (2002–2010, suv2); Aura (2007–2009, small); Outlook (2007–2010, suv3); Sky (2007–2009, small); L-Series (2000–2005, small); S-Series (1991–2002, small); Relay (2005–2007, minivan/suv3); Astra (2008–2009, small)
- **Scion** (8): tC (2005–2016, small); xB (2004–2015, suv2); xD (2008–2014, small); FR-S (2013–2016, small); iA (2016–2016, small); iM (2016–2016, small); iQ (2012–2015, small); xA (2004–2006, small)
- **smart** (1): fortwo (2008–2019, small)
- **Subaru** (3): Uncharted (2027–2027, suv2); Baja (2003–2006, truck); Tribeca (2006–2014, suv3)
- **Suzuki** (9): SX4 (2007–2013, small); Grand Vitara (1999–2013, suv2); Kizashi (2010–2013, small); XL-7 (2002–2009, suv3); Aerio (2002–2007, small); Forenza (2004–2008, small); Reno (2005–2008, small); Equator (2009–2012, truck); Vitara (1999–2004, suv2)
- **Toyota** (10): bZ Woodland (2026–2027, suv2); Matrix (2003–2014, small); Yaris (2007–2020, small); Echo (2000–2005, small); Celica (1990–2005, small); Solara (1999–2008, small); FJ Cruiser (2007–2014, suv2); Previa (1991–1997, minivan/suv3); MR2 (1991–2005, small); Supra (1990–1998, small)
- **Volkswagen** (6): Beetle (1998–2019, small); CC (2009–2017, small); Eos (2007–2016, small); Routan (2009–2014, minivan/suv3); Touareg (2004–2017, suv3); Rabbit (2006–2009, small)
- **Volvo** (7): S40 (1995–2011, small); S80 (1999–2016, small); V50 (2005–2011, small); V70 (1998–2010, small); XC70 (2003–2016, suv2); C30 (2008–2013, small); C70 (1998–2013, small)

## 14. Final corrections (owner-approved 2026-11-18)

### Classifications

| Vehicle | Years | Size now |
|---|---|---|
| Land Rover Defender 90 | 2020+ | **suv2** (was suv3) |
| Land Rover Defender 110 | — | suv3 (the alias "Defender" still resolves here) |
| Land Rover Defender 130 | 2023+ | suv3 |
| Porsche Cayenne Electric | — | **suv3** (was suv2), years unchanged |
| Porsche Cayenne | — | suv3 |
| Hyundai Santa Fe | 1990–2012 | suv2 |
| Hyundai Santa Fe | **2013–2018** | **suv3** (the long-wheelbase 3-row model) |
| Hyundai Santa Fe | 2019–2023 | suv2 |
| Hyundai Santa Fe | 2024+ | suv3 (3 rows standard) |
| Hyundai **Santa Fe Sport** (new entry) | 2013–2018 | suv2 |
| Hyundai **Santa Fe XL** (new entry) | 2019 | suv3 |

- The Santa Fe's no-year default stays suv2, so a stored record with no year doesn't move.
- The page's offline fallback in `assets/vehicle-class-resolver.js` mirrors the same year bands.

### Customer-facing size wording (display only)

| Internal tier | Customer sees |
|---|---|
| small | Car |
| suv2 | SUV / Crossover |
| suv3 | Large SUV |
| truck | Truck |
| minivans | Minivan |
| vans | their existing van labels |

Where it is used:
- the vehicle card on the Vehicle step
- the vehicle pill on the Package step
- the Package step's sticky footer (single car)

What stays unchanged:
- **Internal data:** tier keys, `ST.displayLabel`, prices, the server, booking validation, analytics events, admin tools, saved customer vehicles and existing booking records. A test asserts that the server, summary and analytics modules don't use the wording helper.
- **Booking display:** the cart and the review step keep their current labels.

### Validation of the additions

All additions were reviewed by make, model name, body, tier, years and naming. Automated checks after the corrections found:
- 0 duplicates and 0 alias collisions
- browser and server resolve the same class for every model
- every class has a price row

**Year corrections:**
- Toyota MR2: 1991–1995 and 2000–2005 (not sold in the US in 1996–1999).
- Lincoln Continental: 1990–2002 and 2017–2020.

Gaps between bands are intentional.

**Seven of the 14 held-back names are now priced** (eight catalog records, because the Ascender's two wheelbases are separate, the same way the Envoy and Envoy XL already are). Each one matches a vehicle this catalog already prices. No new tier and no price was created.

| Vehicle | Years | Tier | Why this tier, and not the other one |
|---|---|---|---|
| Chevrolet HHR | 2006–2011 | suv2 | GM's 2006 spec sheet: 176.2 in long, 63.1 in tall, 5 seats, EPA class "2WD Sport Utility Vehicle". Larger than the Kia Soul, which is already suv2. |
| Chrysler PT Cruiser | 2001–2010 | suv2 | Tall 5-seat wagon, about 168.8 in long and 63 in tall. Same body class as the Soul, and larger than it. |
| Scion xB | 2004–2006, 2008–2015 | suv2 | Box wagon, the same class as the Soul. The Scion xD stays small because it is an ordinary hatchback. No 2007 model year. |
| Nissan Cube | 2009–2014 | suv2 | Box wagon, about 156.7 in long and 65 in tall. Same class as the Soul and the xB. |
| Audi A4 allroad | 2013–2025 | suv2 | Audi of America: raised ground clearance and crossover cargo, sold in the US from 2013 through the 2025 model year (media.audiusa.com). Same class as the Outback and XC70. The low V60/V90 wagons stay small. |
| Volkswagen Touareg | 2004–2017 | suv3 | Same PL71/PL72 platform, body frame and doors as the Cayenne. US lengths 187.2 in (2004–2010) and 188.8 in (2011–2017), within 2 inches of the Cayenne of those years. The Cayenne is suv3. |
| Isuzu Ascender | 2004–2008 | suv2 | Five-seat GMT360, 113 in wheelbase, 191.6 in long. The same truck as the GMC Envoy, which is suv2. |
| Isuzu Ascender EXT | 2003–2006 | suv3 | Seven-seat long wheelbase, 129 in, 207.6 in long. The same truck as the GMC Envoy XL, which is suv3. The 2003 Ascender was the long one only. |

**Still unresolved (7).** Two existing tiers still fit, so these stay on "My vehicle isn't listed". They do not block the release.

| Vehicle | Years | Why it is still open |
|---|---|---|
| INFINITI FX35 | 2003–2012 | 189.1–191.3 in long and 75.8–75.9 in wide: the same footprint as the first Cayenne (suv3) and also the same length as the Murano (suv2). |
| INFINITI QX70 | 2014–2017 | The FX renamed. Same open question. |
| Buick Rendezvous | 2002–2007 | One body, about 187 in, with an optional third row. |
| Kia Rondo | 2007–2010 | Compact MPV, about 180 in, with an optional third row. |
| Mazda Mazda5 | 2006–2015 | Compact six-seat MPV with sliding doors, about 181 in. A full minivan such as the Odyssey is a different size, and there is no compact-minivan tier. |
| Audi A6 allroad | 2020–2025 | Lifted like the Outback (suv2) and as long as the V90 (small). |
| Chevrolet Astro | 1990–2005 | Sold as a minivan and as a van. Through 1994 it had two lengths, and cargo and passenger versions, under one name. |

**Result:** 268 of the 282 additions are kept, plus the 2 Santa Fe entries, plus these 8 records. The catalog now has **56 makes and 702 public models** (the selector lists 722 entries, because van cargo/passenger variants show separately).

The kept additions use conservative tiers. They were checked against body type and known size class, but not against a dimension sheet per model. Section 12's vPIC plan is the way to tighten their year ranges.
