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

Seen only in secondary coverage, so **not** confirmed yet: Honda Civic, Kia Telluride, Kia Sorento, Ford F-150, Ford Mustang, Chevrolet Colorado, Tahoe and Equinox. A 2027 Honda Civic therefore shows "We haven't confirmed the 2027 version of this model yet" and a quote button. Adding a model is a one-line data change with a manufacturer source. The tests require that every listed vehicle exists and that its make has a source.

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
