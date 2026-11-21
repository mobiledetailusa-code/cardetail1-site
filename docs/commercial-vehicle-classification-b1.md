# Commercial vehicles B1: Cars & SUVs shadow classification

Status: **observe-only**.
- No price, tier, routing, payment or checkout behavior changes.
- `CHANNEL_ENFORCEMENT_ENABLED` stays `false`.
- The 8-seat comparable boundary is still a draft policy, and nothing enforces it.
- No commercial amount exists in production code.

## What B1 adds

**`netlify/lib/vehicle-classification-shadow.js`**
- Classifies each Cars & SUVs booking vehicle with the shared classifier (`vehicle-pricing-channel.js`).
- Classifies only when every attribute that could change the category is known. Otherwise the result is `unresolved`, with a list of the missing attribute names.
- Missing passenger counts are never treated as zero.
- Configuration is never inferred from make/model. A plain "Transit" is not assumed to be a cargo van here, even though Cars pricing defaults it to cargo.
- Reads a JSON copy of the booking, never writes to it, and never throws.
- Loads no pricing engine, price table, travel, payment or checkout module (test-enforced).

**`submit-booking.js` hook**
- One `try { … } catch {}` statement, after server pricing, travel and offers have been applied and before anything is stored.
- Its return value is ignored. Nothing is added to the booking record.

**Diagnostics**
- One structured log line per *final* (non-draft) submission, only when a vehicle is a van, a 3500-class pickup, or the classifier failed.
- Example: `[vehicle-classification-shadow] {"v":1,"mode":"observe_only","enforced":false,"vehicles":[{"i":0,"status":"unresolved","category":"unresolved","reason":"configuration_incomplete","missing":["body","roof",…],"make":"Ford","model":"Transit","vanUse":null,"tierKey":"full_size_van"}]}`
- Contains no name, phone, email, address, ZIP or booking id. Ordinary cars and SUVs produce no log.

**Rollback:** delete the hook statement in `submit-booking.js`.

## Task 1: data gaps in today's Cars & SUVs selections

Today the Cars & SUVs form sends make, model (or a vehicle label) and year.

For vans, cargo vs passenger is known only when the customer picks a "Cargo" or "Passenger" model label. A plain model name is priced as cargo by default (`defaultVanUse: 'cargo'`). That default is fine for pricing, but it is not evidence of the configuration.

**Never collected today:**
- body type (van vs cutaway shuttle vs box truck);
- roof height;
- length or wheelbase;
- passenger seats;
- wheelchair positions;
- pickup bed vs chassis cab with a work body.

As a result, **no van selection can be classified from today's data** (test-enforced for all 13 public van records × plain/Cargo/Passenger labels).

| Cars record | Size | Missing today (plain label) | Possible categories |
|---|---|---|---|
| Ford Transit | full | body, roof, length, passengerCapacity, wheelchairAccessible | comparable van, large van, shuttle bus, cutaway box truck |
| Chevrolet Express / GMC Savana | full | body, length, passengerCapacity, wheelchairAccessible | same as Transit |
| Mercedes-Benz Sprinter | full | vanUse, roof, length, passengerCapacity, wheelchairAccessible | comparable van, large van |
| Ram ProMaster (cargo only) | full | roof, length, wheelchairAccessible | comparable van, large van |
| Nissan NV | full | vanUse, roof, passengerCapacity, wheelchairAccessible | comparable van, large van |
| Ford Transit Connect | compact | vanUse, length, passengerCapacity, wheelchairAccessible | comparable van, large van |
| Ram ProMaster City | compact | vanUse, passengerCapacity, wheelchairAccessible | comparable van, large van |
| Mercedes-Benz Metris | midsize | vanUse, passengerCapacity, wheelchairAccessible | comparable van, large van |
| Nissan NV200 (cargo only) | compact | wheelchairAccessible | comparable van, large van |
| Ford E-Series, Dodge Sprinter, Chevrolet City Express | full / compact | no commercial catalog equivalent (needs a mapping decision) | comparable van, large van (+ shuttle/box for E-Series) |
| Ford F-350 SD, Ram 3500 (both records), Silverado / Sierra 3500HD | pickup | bedType (pickup bed vs chassis cab with a body) | Cars vehicle, chassis-cab box truck |
| All other 684 public records (cars, SUVs, minivans, 1500/2500 pickups) | — | nothing | Cars vehicle |

A "Cargo" / "Passenger" label removes `vanUse`. A Passenger label still needs the seat count, and for cutaway-capable nameplates (Transit, Express, Savana, E-Series) it still needs the body, because a cutaway shuttle bus can be entered as "Transit Passenger".

Each distinction in the request maps to these fields:
- Standard cargo vs passenger van: `vanUse` / `body`.
- Extended or high-roof van: `roof`, `length`.
- Large seating capacity: `passengerCapacity`.
- Wheelchair-accessible: `wheelchairPositions`.
- Cutaway shuttle bus or cutaway box truck: `body`.
- Chassis-cab box truck: `bedType`.

## Task 3: proposed minimum conditional flow for B2 (not built)

These are questions asked only when the selected record needs them, with no defaults. A "Not sure" answer means manual review, never a guess.

1. **Cars, SUVs, minivans, 1500/2500 pickups (684 of 702 records):** unchanged, no new questions.
2. **3500-class pickups (5 records):** one question: "Pickup bed, or a work body (box, flatbed, dump, utility)?" A work body hands off to the existing Commercial & Specialty catalog flow.
3. **Compact / midsize vans (Transit Connect, ProMaster City, Metris, NV200, City Express):**
   - one yes/no question: "Wheelchair lift or ramp?";
   - the seat count only if Passenger was picked.
   - *Owner decision:* whether Transit Connect length matters for pricing. If not, B2 should drop it from the compact classes.
4. **Full-size vans:** up to four short steps, each shown only when that model has the option:
   1. **Type:** cargo / passenger / wheelchair-accessible. Cutaway shuttle bus and box truck are offered only for Transit, Express, Savana and E-Series, and they hand off to the commercial catalog. A Cargo/Passenger label pre-selects this step.
   2. **Roof:** the model's own roof list, e.g. Transit low/medium/high, Sprinter standard/high, ProMaster standard/high/super high.
   3. **Length:** the model's own list, e.g. Transit regular/long/extended, Express 135"/155" wheelbase.
   4. **Seats including driver** (passenger and wheelchair only) and **wheelchair positions** (wheelchair only). Required numbers, no default.
5. **Shuttle buses and box trucks:** the existing commercial catalog (`assets/commercial-vehicle-catalog.js`), unchanged.

These answers map 1:1 onto the fields the shadow already reads:
- `vanUse`, `body`, `roof`, `length`, `passengerCapacity`, `wheelchairPositions` and `bedType`, on the vehicle or under `vehicleConfiguration`.
- So B2 needs no classifier change to start resolving vans.

**Open owner decisions before B2:**
- the comparable boundary (8 seats is a draft);
- a mapping for E-Series, Dodge Sprinter and City Express;
- whether compact length matters;
- what happens to a `large_commercial_van` entered under Cars & SUVs (keep the Cars price, manual quote, or commercial price once approved).

## Task 4 / existing-booking compatibility

**Unchanged by B1:**
- Cars & SUVs prices, tiers and totals: the same with the shadow working, throwing or absent, both through `applyServerTravelAndTotal` and in a real draft→finalize `submit-booking` run (test).
- Fleet routing (`fleet_quote_required`) and the `isCommercial` block.
- Payment gates: no payment, Stripe or checkout file changed.
- Commercial checkout and public pricing: `COMMERCIAL_CHECKOUT_ENABLED` / `COMMERCIAL_PUBLIC_PRICING_ENABLED` false; draft card unapproved.
- Stored bookings: nothing is added to the record.
- Drafts: classified nowhere and logged nowhere.

**Changed by B1:** finalized van or 3500-pickup bookings emit one diagnostic log line.
