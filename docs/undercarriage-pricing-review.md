# Accessible Undercarriage Cleaning — status and pricing review

Status: **NOT VERIFIED — suspended for new bookings** on branch
`review/undercarriage-suspension`. Nothing here is live until the owner approves
and the branch is merged and released.

## What exists today (master ffe1fdc3, production deploy 6b05d1f5)

- Catalog id `undercarriage`, name "Accessible Undercarriage Cleaning".
- Price by server size band (`netlify/lib/ceramic-coating.js` `SIZE_ADDONS`),
  mirrored in `assets/ceramic-booking.js` `SIZE_PRICE`:

  | Size band | Car tiers | Price | Minutes |
  |---|---|---|---|
  | compact | `small` (sedan / coupe) | $125 | 45 |
  | crossover | `suv2` (2-row SUV) | $150 | 45 |
  | large | `suv3`, `truck`, `compact_van`, `midsize_van` | $175 | 60 |
  | oversized | `full_size_van_passenger` | $225 | 60 |
  | (none) | `full_size_van` (cargo) | not offered; server refuses | — |

- Offered on Exterior Hand Wash, Exterior Refresh & Protect, Premium Full
  Detail, Signature, and both ceramic packages. Not on Maintenance or Interior.
- **$150 vs $175 is a size difference, not a bug**: $150 is the 2-row SUV band,
  $175 is the 3-row SUV / pickup / minivan band.
- Description promises a "high-pressure rinse of accessible undercarriage
  areas". Elsewhere the site says it *avoids* aggressive high-pressure washing
  near seals, bearings and electronics.

## Why it is NOT VERIFIED

Nothing in the repository or the booking system confirms:

| Requirement | Evidence found |
|---|---|
| Equipment (undercarriage wand / sprayer, ramps or creeper) | None. The commercial catalog records `undercarriageKitForTrucksAndBuses: false`. |
| Water use per vehicle and tank capacity | None documented. |
| Cleaning method (pressure, chemicals, rinse) | Only the catalog sentence above. |
| Access without lifting | Description excludes lifting; reach under low cars not documented. |
| Residential driveway feasibility | Not documented. |
| Winter safety (freezing runoff, ice on driveways) | Not documented. |
| Wastewater / salt-laden runoff handling and discharge rules | Not documented; no containment or reclaim equipment recorded. |
| Operating cost, time and margin | Only scheduling minutes (45/60). No cost data. |

The commercial catalog also records `mobileWaterApproved: false`.

## What the suspension does (this branch)

- Hides the add-on on all 13 booking pages and in the ceramic checkout panel.
- `submit-booking` refuses it on new bookings (`addon_not_available`).
- The customer portal does not list it and refuses `addon_request` for it.
- Stored bookings that already carry it keep their line and price; repricing
  stays on the existing size bands. No data is deleted.
- To reinstate: remove the `undercarriage` line from
  `RETIRED_FOR_NEW_BOOKINGS.cars` in `assets/addon-rules.js`.

## Proposed price table (for review only, not implemented)

Owner proposal, mapped to the existing tiers so no category gets a price meant
for another:

| Tier | Current | Proposed | Note |
|---|---|---|---|
| `small` sedan / coupe | $125 | **$75** | |
| `suv2` 2-row SUV | $150 | **$90** | |
| `suv3` 3-row SUV | $175 | **$110** | |
| `truck` pickup | $175 | **$110–$125** | decision needed |
| `compact_van`, `midsize_van` | $175 | **$110–$125** | decision needed |
| `full_size_van_passenger` | $225 | not proposed | keep $225, or set a value |
| `full_size_van` cargo | not offered | not proposed | stays unavailable |

Implementation note: today `suv3`, `truck` and both small vans share one band
("large"). Giving pickups and vans a different price from 3-row SUVs needs a new
band in `TIER_BAND` / `SIZE_ADDONS` (server) and `BAND` / `SIZE_PRICE`
(browser). Ceramic Water Spot and Contamination prices use the same bands and
must not move with it.

## Decisions needed before reinstating

1. Confirm equipment, method and water source for a residential driveway.
2. Confirm how salt-laden runoff is handled, and whether it is allowed in the
   service area, especially in winter.
3. Confirm time per band and the cost per job, then pick prices.
4. Pick the pickup / van price ($110 or $125) and the passenger-van price.
5. Rewrite the description so it does not promise a "high-pressure" rinse
   unless that is the real method.
