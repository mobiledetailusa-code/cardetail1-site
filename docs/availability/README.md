# Operational Availability: Phase 1 (reliability, precedence, bulk scheduling)

Phase 1 makes the availability configuration a reliable authority and gives the owner bulk scheduling tools. It does this before any automatic booking confirmation is introduced. The change needs no database migration and no new Netlify Function. It changes no prices, payments, booking approval, dispatch or review behavior.

## 1. Problems fixed (operational audit of 2026-11-27)

| Audit ref. | Problem | Fix |
|---|---|---|
| D3 | A failed read of `cd1-ops-settings/availability` silently returned the legacy calendar. Saturdays reopened, and opened Sundays and closures were lost. | The loader now reports `availability_unavailable`, and every booking path fails closed (§2). |
| D1 | Holidays always beat explicit openings, so 12-24 and 12-31 could not be opened. | An open override with `holidayOpening: true` opens a holiday. A plain open override does not (§3). |
| D4 | The public snapshot omitted closed dates, so the calendar offered dates that submit would refuse. | The snapshot publishes `closedDates`, and the browser never offers them (§4). |
| D6 | The atomic slot reservation used capacity 1 regardless of configuration. | `reserveBookedSpan` and `relocateBookedSpan` receive the resolved configuration. With no configuration they stay at capacity 1. |
| D2 (tooling) | Weekends close from 2026-12-27, and opening them meant saving one date at a time. | Bounded bulk open/close with preview, protected dates and explicit confirmation (§5). |

## 2. Read contract and fail-closed behavior

`netlify/lib/ops-config.js`, `loadOperationalAvailability()`:

| State | Result | Callers do |
|---|---|---|
| Key absent (never saved) | `{ ok: true, source: 'default' }` with the legacy defaults | Normal booking (unchanged behavior) |
| Saved and valid | `{ ok: true, source: 'stored', etag, revision }` | Normal booking |
| Read error, after 3 strong-consistency attempts (150 ms and 400 ms backoff) | `{ ok: false, error: 'availability_unavailable', reason: 'read_failed', retryable: true }` | Fail closed |
| Saved but structurally invalid, including supervised mode without a date | `{ ok: false, reason: 'invalid_config:<why>', retryable: false }` | Fail closed |

What fail-closed means at each surface:

| Surface | Behavior |
|---|---|
| `booking-availability` (every action) | HTTP 503 `{ status: 'unavailable', error: 'availability_unavailable', userMessage }`. No dates, slots or overrides. |
| `submit-booking` (draft and finalize) | 503 `availability_unavailable`. Nothing is written, and the customer is told nothing was booked plus the phone number. |
| Admin reschedule (`booking-commands`) | 503. The booking is not moved. |
| Admin Ops (`ops-settings`) | GET returns `availability: null` and `availabilityStatus.ok: false`. Every availability action returns 503. Legacy defaults are never shown in place of the real configuration. |
| Browser (`booking-availability-client.js`) | Offers no date until the snapshot loads, and none if it cannot be loaded (two attempts). A recovery panel appears with **Try again** and **Call or text (551) 389-3986**. |

Existing reservations are never touched by any of these paths.

Log lines to monitor:
- `[availability] read_failed` (with attempts and message)
- `[availability] invalid_config` (with reason)
- `[availability] bulk_applied` (with actor, range, change count, revision)

### Why there is no last-known-good copy

The brief allows a last-known-good configuration only if its persistence, version, freshness and cross-instance consistency can be established. They cannot be established here:

- Netlify Blobs is the only shared store. A second blob (`availability-lkg`) lives in the same service, so it would almost always be unreadable exactly when the primary read fails.
- A process-local copy differs between function instances and cold starts. It cannot be proven fresh, so it could serve a closure that was already lifted (or the opposite).

Phase 1 therefore relies on three things: strong-consistency reads, short retries, and failing closed. The cost is that customers cannot book online during a Blobs outage. The benefit is that no date is ever offered or accepted on a calendar the owner did not set.

### Concurrent edits

Admin writes are conditional on the exact blob version that was read: `onlyIfMatch` with the etag, or `onlyIfNew` on an empty store. Every saved configuration carries a monotonically increasing `revision`. A stale tab gets HTTP 409 `version_conflict` and the fresh configuration. The UI sends `expectedRevision`, and the legacy `expectedUpdatedAt` is still honored.

## 3. Rule precedence (deterministic, highest first)

| # | Rule | Phase 1 |
|---|---|---|
| 1 | Emergency booking suspension (blocks **new** bookings only) | Phase 2: documented slot, not implemented |
| 2 | Date override, **closed**: always closes the date | ✅ |
| 3 | Explicit holiday opening: open override with `holidayOpening: true` | ✅ |
| 4 | Holiday closure: also beats a plain open override (pre-Phase-1 behavior kept) | ✅ |
| 5 | Seasonal schedule | Phase 2 |
| 6 | Recurring weekly schedule | Phase 2 |
| 7 | Date override, **open**, on an ordinary date | ✅ |
| 8 | Base rule: weekdays open; weekends per Legacy (Sat open, Sun closed) or Supervised (closed once the activation date is reached) | ✅ unchanged |
| then | Same-day lead time (120 min, America/New_York), then capacity per window, then existing reservations (slot index, atomic) | ✅ |

`resolveDateAvailability(iso, config, now)` is the single implementation of this table. `slotsForDate`, `capacityForSlot`, `validateBookingSchedule`, `findNearbyOpenings`, the public projection, the admin calendar and the bulk planner all use it.

Each rule source is a stable string, shown in Admin and asserted in tests:
- `override_closed`
- `holiday_opening`
- `holiday`
- `override_open`
- `weekday`
- `legacy_saturday`
- `legacy_sunday_closed`
- `supervised_weekend_closed`

Fixed holidays (unchanged list) are:
- 01-01
- Easter Sunday
- Memorial Day
- 07-04
- Labor Day
- Thanksgiving
- 12-24
- 12-25
- 12-31

### Backward compatibility

The production configuration as read on 2026-11-27 resolves **exactly** as before for every date across 400 days at four different clocks. Legacy, null and test configurations do too. `tests/availability-v2-precedence.test.js` checks this against a verbatim copy of the old resolver. Behavior differs only when the new `holidayOpening` flag is set, and no stored override has it.

## 4. Public snapshot additions

`GET /.netlify/functions/booking-availability` now also returns:

| Field | Meaning |
|---|---|
| `status: 'available'` | Distinguishes a real calendar from a 503 `unavailable` |
| `closedDates` | Dates in the horizon closed by an explicit closure or a (not reopened) holiday. Ordinary closed weekends follow the published base rule and are not listed. |
| `horizonStart` / `horizonEnd` | Window covered by `closedDates` and `dateOverrides` |
| `dateOverrides[iso].holidayOpening` | Present on authorized holiday openings, so the page's static holiday list does not hide them |

Notes, `updatedBy` and closed overrides' details are still never published.

The client uses the snapshot for:
- the primary date;
- the alternate date;
- arrival windows;
- recovery suggestions (`nearby`);
- review and submit.

The server re-validates everything on `selection`, draft and finalize. If the shared client asset itself fails to load, the pages' inline legacy helpers still render, and the server refuses closed dates at selection and submit.

## 5. Admin Ops: Settings → Operational availability

| Section | What it does |
|---|---|
| Status | Mode in force now, scheduled supervised activation date, revision and last save. Warns when weekends after the activation date are not opened yet, which is the January cliff on the 2026-11-27 configuration. |
| Open or close dates in bulk | Shortcuts: Open all days, Open all weekends, Open all Sundays, Open a date range, Close a date range. Then range (max **120 days**), days of the week, arrival windows (each day's default, or a custom subset including 4:00 PM), jobs per window (1–20), note. **Preview** lists every matched date with now/after, change type, protected reason and existing bookings. **Confirm** applies exactly the preview. |
| One date (exception) | Open or close a single date. Opening a holiday requires ticking **Open this holiday**, and the server refuses it otherwise. |
| Weekend mode & activation date | The existing mode form (unchanged semantics). |
| What customers can book (next 8 weeks) | Effective calendar: open/closed, windows, capacity, rule source, bookings per date, and dates that flip when the supervised activation takes effect. One column on phones. |

Bulk safety rules (`netlify/lib/availability-bulk.js`):
- The range is bounded (120 days) and the total of future exceptions is capped at 400. Permanent recurring availability is a Phase 2 rule, not an unbounded pile of overrides.
- Protected dates are **skipped** unless ticked one by one in the preview:
  - when opening: holidays and dates you closed by hand;
  - when closing: dates you opened by hand.
- Dates whose result would not change get no override (no bloat).
- Closing dates that already hold bookings requires ticking an acknowledgement. **Bookings are never cancelled or moved.** The slot index is never written by a bulk change.
- Apply must present the preview's `planHash`. It is recomputed from the configuration revision and the booking counts at apply time. Anything changed in between returns 409 `preview_stale` with a fresh preview.
- If booking counts cannot be read, preview and apply fail closed with 503 `reservations_unverified`.

The `ops-settings` actions:

| Action | Body |
|---|---|
| `effective_calendar` | `{ from?, days? (7–120, default 56) }` |
| `preview_bulk_availability` | `{ request: { action: 'open'\|'close', from, to, weekdays: [0–6], arrivalWindows?: [...], capacity?: 1–20, note?, includeProtected?: [iso] } }` |
| `apply_bulk_availability` | the same `request`, plus `planHash` and `acknowledgeReservations?` |
| `upsert_date_override` | now accepts `override.holidayOpening` and `expectedRevision` |
| `remove_date_override` | now accepts `expectedRevision` |
| `update_availability` | now accepts `expectedRevision` |

## 6. Deferred to later isolated work (not in this PR)

| Item | Why deferred / dependency | Recommended order |
|---|---|---|
| Recurring weekly schedules and seasonal schedules (Phase 2) | They need contract v2 (`weeklySchedule`, `seasons[]`) with a v1→v2 normalizer, activation semantics per date, and the precedence slots 5–6 above. Phase 1 deliberately does not fake them with unbounded overrides. | 1 |
| Emergency suspension of new bookings | Precedence slot 1. Needs `intake.paused` in the contract, a submit gate and customer copy. Small, but part of the v2 contract. | with 1 |
| Service durations and real capacity | Needs owner inputs (`service-duration-inventory.md`). `spannedSlotTimes` already enforces multi-slot spans once durations exist. | 2 |
| QuickOps #394 rebuild (silent confirm on assign, link lockout) | Independent of availability. It is a prerequisite for auto-confirmation, because it gives one confirmation path. | 3 |
| Smart Auto-Confirmation | Needs 1 (reliable rules), 2 (durations) and 3 (single confirmation path). The deprecated `autoConfirmAppointments` flag is still unread; it is not touched here. | 4 |
| Admin list performance (#249) | Admin Ops navigation redesign; independent. | 5 |
| Review solicitation activation (#432 gates) | Owner, Twilio and legal steps (`docs/review-request-activation-checklist.md`). | owner |
| Prisma migration reconciliation | Required before any PR with migrations (#376, #223, #143, #144). Not needed for availability, which lives in Blobs. | separate |
| Regional hub SEO hours (#417) | Static copy only. | any time |
| Closing obsolete PRs | Owner authorization. | any time |

## 7. Operations

- **Rollback:** redeploy the previous production deploy. The stored configuration stays readable by the old code. `revision` and `holidayOpening` are extra fields that the old normalizer ignores, which reverts holiday openings to closed.
- **After release:**
  - check `booking-availability` returns `status: 'available'` and `closedDates` (read-only);
  - open Settings, check the effective calendar and the January warning;
  - preview "Open all weekends". Preview writes nothing.
- **Owner decision before 2026-12-27:** either open the weekends after that date with the bulk tool, or move or clear the supervised activation date. Otherwise every weekend from 2027-01-02 closes, which is the configured behavior.
