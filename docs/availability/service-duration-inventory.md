# Service duration inventory and owner inputs (prepared in Availability V2 Phase 1)

Phase 1 does **not** change any duration or capacity. This inventory records:
- what the code knows today;
- what scheduling assumes;
- the business inputs the owner must provide before durations can be enforced in a separate, isolated PR.

No value below was invented. Where the code has no number, the table says so.

## 1. Scheduling model today

| Aspect | Current behavior | Source |
|---|---|---|
| Grid | Arrival windows every 2 hours: 8:00, 10:00, 12:00 PM, 2:00 PM, plus 4:00 PM only on dates where an exception includes it | `operational-availability.js` |
| Capacity | 1 job per arrival window, unless a date exception sets 1–20 | same |
| Span | A booking holds `ceil(minutes / 120)` consecutive windows **only when it has a duration**. With no duration, or 120 minutes or less, it holds **one** window. | `booking-schedule.js` `occupancySpanCount`, `spannedSlotTimes` |
| Over-long jobs | Ceramic + interior may spill onto the next open day (multi-day reservation) | `planCombinedAppointment` |
| Technicians | Not modeled. Capacity is a per-window job count, not a crew roster. | — |
| Travel time | Not modeled | — |

The result: every car, truck, boat, RV, powersports and fleet booking without a stored duration occupies a single 2-hour window. That holds even for packages that take far longer on site. One window per job is an assumption, not a measurement (audit defect D5).

## 2. Durations that exist in code

| Service | Minutes | Where | Used for scheduling? |
|---|---|---|---|
| Ceramic Protection, up to 1 year (`ceramic_1yr`) | 480 base | `ceramic-coating.js` | **Yes** (multi-slot / multi-day) |
| Ceramic Protection, up to 3 years (`ceramic_3yr`) | 600 base | same | **Yes** |
| Ceramic add-ons | windshield 30, all glass 60, wheels 60, trim 45, lights 20, paint correction 120, water spots 60/90/120/120 by band, contamination 60/90/120/120, undercarriage 45/45/60/60, engine bay 45, water-repellent 15 | same | **Yes**, inside ceramic bookings |
| Interior Detail (cars) | 120 | `booking-price-catalog.js` `PACKAGE_SERVICE_MINUTES` | Only as the companion interior of a ceramic booking |
| Interior add-ons | pet hair 45, odor 30, super interior 60, sanitize 20, mold 45, biohazard 60, floor mats 15, baby seat 20, stroller 20 | `INTERIOR_ADDON_MINUTES` | Only inside a ceramic + interior booking |
| RV exterior wash | `max(90, ceil((130 × ft − 1000) / 15))` | `rv-type-catalog.js` and the browser | Only sent as `durationMinutes` to availability `selection`/`nearby`. **Not persisted** on the booking, so the server finalize and reservation hold one window. |

## 3. Catalog to be given durations

Service categories, size classes and packages, from `booking-price-catalog.js` `PRICING`:

| Category | Size classes (tiers) | Packages |
|---|---|---|
| Cars & SUVs | small, suv2, suv3, compact_van, midsize_van, full_size_van, full_size_van_passenger, truck (pickup) | wash, maint, interior, full, refresh, premium (+ ceramic_1yr / ceramic_3yr) |
| Commercial trucks | day_cab, sleeper_cab | interior, int_wash, int_wash_wax |
| Boats (length-priced) | under20, 20to25, 26to30, over30 | maint, essential, full, premium |
| RVs (length-priced) | travel, fifthwheel, classC, classA, classBC, airstream, specialty | maint, maint_light, interior, full_basic, premium, full |
| Powersports | motorcycle, motorcycle_large, motorcycle_trike, atv, utv, utv_standard, utv_large, jetski | wash, essential, full, premium, maintenance, restore |
| Fleet | vehicle, commercial, powersports, marine_rv | maint, essential, full, premium, custom |
| Commercial vehicles (cv_*) | catalog only; pricing null, checkout off | — |

Add-ons by category (ids):
- **Cars:**
  - pethair, superint, odor, mold, sanitize, biohazard
  - engine, floormats, rainx, polymer, wax1yr, claybar, headlight
  - babyseat, stroller, trashcans, ozone, heavymud, undercarriage, engine_bay, mobile_water
  - ceramic_* add-ons
  - seasonal driveway add-ons
- **Trucks:** pethair, superint, odor, mold, sanitize, biohazard, engine, floormats, rainx, polymer, wax1yr, claybar, headlight, trashcans, ozone
- **Boats:** rainx, polymer, wax1yr, chrome, odor, mold, sanitize, biohazard, trashcans
- **RVs:** polymer, wax1yr, rainx, biohazard, sanitize, superint, awning, roof, capfront, pethair, odor, trashcans, plus the seasonal add-ons
- **Powersports:** polymer, wax1yr, rainx, heavymud, seatdeep, storage, wheeldet, waterspot, saltwash, trimprot, lightdeg, plus the seasonal add-ons
- **Fleet:** polymer, trashcans, disinfect, biohazard, odor, heavymud

## 4. Inputs needed from the owner

The owner provides these real, observed on-site times. Ranges are fine; the implementation will use the upper bound for blocking.

1. **Package × size class minutes** for every Cars & SUVs package above, in each of the 8 classes: 6 × 8 = 48 values. Classes that share a time can be grouped. This is the priority, because it covers almost all bookings.
2. **Add-on extra minutes** for each car add-on that lengthens the visit (for example pet hair, super interior, clay bar, engine, ozone), and whether it is done in parallel or adds time.
3. **Boats and RVs:** minutes per foot, or per length band, for each package. Is the current RV wash formula correct?
4. **Powersports, trucks and fleet:** minutes per package and class.
5. **Crew model:**
   - How many jobs can run at the same time (one technician or several)?
   - Should capacity stay "jobs per arrival window"?
6. **Travel / buffer** between jobs: a fixed number of minutes, or none.
7. **Latest finish time** per day: is 5:00 PM the hard end? Can a job overflow to the next open day like ceramic does, or must it fit the day?
8. **Multi-vehicle bookings:** are times summed for one crew, or done in parallel?

## 5. What the follow-up PR will do with them (outline, not implemented)

- Add `durationMinutes` per package × class, plus add-on minutes, to the canonical catalog.
- Persist `appointmentDurationMinutes` on every booking. The span machinery and atomic reservation already exist.
- Show only start windows whose full span fits. `startFitsDemand` already exists.
- Regression coverage:
  - the 13-page money harness;
  - `booking-financial-e2e`;
  - ceramic multi-day;
  - `nearby`;
  - concurrency on spans.
- Capacity stays as configured. Durations never increase it.
