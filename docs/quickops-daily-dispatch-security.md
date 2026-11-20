# QuickOps Daily Dispatch — technician access rules

Source of truth: `netlify/lib/tech-dispatch-privacy.js`. Every technician-facing
read goes through it on the server. The browser never decides access.

## 1. Who counts as "assigned" (`resolveTechAssignment`)

There is one assignment authority. The old synchronous
`bookingAssignedToTech` (which matched on display name) was removed.

Rules, evaluated in order; the first that applies wins:

| # | Booking state | Result |
|---|---|---|
| 1 | Session has no technician id | deny `no_session` |
| 2 | `assignmentKind = freelance` | deny `freelance_assignment` (freelance jobs are reached only through the signed SMS link) |
| 3 | `assignedTechId` equals the session id (case-insensitive) | **allow, via id** |
| 4 | `assignedTechId` empty and `assignedTech` equals the session id | **allow, via id** (auction awards and older writers) |
| 5 | The id field (`assignedTechId`, else `assignedTech`) looks like `TECH-…` and is someone else | deny `assigned_to_other_id` |
| 6 | No `assignedTechId`, `assignedTech` or `assignedTechName` | deny `unassigned` |
| 7 | Technician roster cannot be loaded | deny `roster_unavailable` |
| 8 | The id field equals some other roster account's id (non-`TECH-` legacy ids such as `sam`) | deny `assigned_to_other_id` |
| 9 | Session has no display name | deny `no_session_name` |
| 10 | Any non-empty value among `assignedTechId`, `assignedTech`, `assignedTechName` differs from the session's name (case and spacing ignored) | deny `name_mismatch` |
| 11 | More than one roster account has that name, **active or not** | deny `ambiguous_name` |
| 12 | Otherwise | **allow, via legacy_name** |

So "id-only" and "legacy unique name" do not contradict:

* Whenever a booking carries an id, the id decides. A matching name never
  overrides a different id (rules 3–5, 8).
* The name path (rules 9–12) exists only for records with no id at all. Every
  current writer stores an id: Quick Ops assignment, auction award, and
  `ops-workflow` projection. The name path only serves old records.
* A duplicate name, even on a deactivated account, closes the name path for
  everyone with that name. The fix is to re-assign the booking from Admin,
  which writes the id.

## 2. When customer PII is released (`technicianAccess`)

All three must hold:

1. **Assigned:** see section 1.
2. **Not terminal in any status field:**
   * Any cancellation signal wins: `cancelled`/`canceled`/`no-show`/`archived_test` in `status`, `jobStatus`, `serviceStatus` or `appointmentStatus`; or `archived`, `isTest` or `isDraft`.
   * Completion counts in any field: `jobStatus` completed_* or closed; `serviceStatus` service_completed, awaiting_customer_action or closed; legacy `status` Completed, Paid or Closed; `completionSubmitted`; `completedAt`, `jobCompletedAt` or `techCompletedAt`.
   * The one exception is an explicit reopen: `jobStatus` or `serviceStatus` is `reopened`, `reopenedAt` is set, and neither active field reports completion again.
3. **Inside the 12-hour window:** `now ≥ arrival start − 12 h`.
   * The arrival start is the start of the confirmed arrival window, falling back to the preferred window or slot, in `America/New_York`.
   * It fails closed when any of these is true:
     * no date, or an invalid date
     * `confirmedDate` and `preferredDate` disagree
     * the time is unparseable (for example "Morning" or "9-11")
     * the slot lies outside its own window
     * "anytime" with no slot
     * the time is outside 06:00–21:00
     * the wall time doesn't exist (DST gap)
   * Windows written as `2:00-4:00 PM` take the trailing AM/PM for the start, as admin reschedule does.
   * The 12 hours are elapsed hours. On DST eves the wall-clock unlock is 7 PM (spring) or 9 PM (fall) for an 8 AM arrival.

**Locked fields:** name, phone, email, address, ZIP, customer, admin, access and tech notes, service location, and photos.

**Fields that stay:** package, vehicle, date, window, zone, status, add-ons, checklist, pay and equipment hints.

## 3. Where it is enforced

| Path | Assignment check | PII/photo policy |
|---|---|---|
| `GET tech-jobs` (portal list) | `resolveTechAssignment` | `technicianAccess` → `redactTechJob` |
| `POST tech-jobs` status update | `resolveTechAssignment` | terminal in any field → 403 |
| `POST tech-jobs` `request_withdrawal` | `resolveTechAssignment` | reason ≥ 10 chars; arrival start resolves and is ≥ 12 h away |
| `tech-job-photos` GET/POST | `resolveTechAssignment` | `technicianAccess.piiAllowed` |
| `tech-complete-job` | `resolveTechAssignment` | cancelled in any field → 403 (completion retries unchanged) |
| `job-photo-image` protected photos | admin session, or tech session + `technicianAccess` per request | `private, no-store` |
| `job-photo-image` legacy photos | none (public, unchanged) | public immutable, see below |
| `tech-quick-ops` signed SMS link | link session = booking id + assignee phone + live token hash (unassign/reassign revokes) | `quickOpsPiiDecision` on every GET and every POST response view |
| `tech-auctions` | any onboarded tech (unchanged) | customer notes never sent |

## 4. What is not revoked

* JSON already delivered to a device stays in that page's memory until it reloads.
* Legacy photos (uploaded before this change) were served `public, max-age=31536000, immutable` with wildcard CORS.
  * They stay public so existing links keep working.
  * Copies already in browser or intermediary caches can't be recalled.
* A protected photo already fetched into a page stays visible as a `blob:` URL until that page reloads.
