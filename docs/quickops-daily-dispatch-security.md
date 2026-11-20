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

## 5. Remaining legacy photo exposure

"Legacy" means every photo whose stored meta has no `cachePolicy`, which is every photo uploaded before this branch is deployed. How many exist is unknown: counting them needs production access, which this work did not use.

**How exposed they are.** A legacy URL is `/.netlify/functions/job-photo-image?id=jobph_<upload ms>_<16 hex>`.
* The 16 hex characters are 64 random bits, so the URL can't be guessed or enumerated.
* Anyone who holds the URL can fetch the image, with no session, from any site (`Access-Control-Allow-Origin: *`).

**Who can hold a legacy URL:**
* Admins: the old drawer rendered it as a link that opened in a new tab, so it could be copied, bookmarked or forwarded.
* Every technician who was ever assigned to the job, including ones later unassigned. Before this branch, `tech-job-photos` returned URLs with no window or terminal-state check.
* Anyone those people shared it with.

**Cached copies.** Responses were `public, max-age=31536000, immutable`, so a browser that loaded a photo may keep it for up to a year.
* Whether Netlify's CDN also stored these function responses is not verified.
* If it did, a request served from that cache never reaches the function, so even an origin auth check would not apply until the cache is purged. Netlify normally purges its CDN cache on a new deploy; that is not verified here.

**Can legacy photos require authorization on future requests without breaking anything?**

| Question | Finding |
|---|---|
| In-repo viewers | Only the Admin drawer and the technician photo grid. Both now fetch with their session header (`blob:` URLs), so both keep working. |
| Other in-repo routes for photo URLs | None. No SMS or email template, receipt, customer page (`my-garage`, `customer`, `receipt`), review flow, Admin snapshot cache or Prisma table carries them. `tech-complete-job` only copies the arrays within the booking record. |
| What would stop working | Only URLs used outside the app: a link an admin texted to a customer, a bookmark, a pasted link. Whether any exist can't be determined without production logs. |
| What it could not do | Recall copies already in a browser cache, or in the CDN until a purge. |
| Size of the change | One condition in `job-photo-image.js`: apply the protected check to every photo, not only `private-v1`. |

**Status:** not implemented. It changes existing behavior, and the approved scope protects new photos only. It is listed as an owner decision.

## 6. Technician job list scalability

`GET tech-jobs` keeps the approved architecture: no booking index, no date index.
* It lists every page of `cd1-bookings` and reads each booking with an eventual read, 20 at a time. This is the same pattern and concurrency as the Admin Jobs list (`ADMIN_LIST_BLOB_READ_CONCURRENCY = 20`, documented there as the tested ceiling).
* It then re-reads only that technician's own candidates with strong consistency.

**Cost model** (round trips, not bytes):

```
time ≈ ceil(N / 1000) × L_list            (paginated listing, N = all booking blobs)
     + ceil(N / 20)   × L_get             (eventual reads, dominant term)
     + ceil(M / 20)   × L_strong          (M = this technician's candidates)
     + roster list/reads (only for legacy name-only assignments)
     + withdrawal-request list
```

**Simulated measurement.** I ran master's handler and this branch's on an in-memory store with injected latency: 60 ms per list page, 20 ms per read, strong reads at 1× and 2×; synthetic data only.

| Bookings N | Master | Branch |
|---|---|---|
| 200 | 0.16 s, 20/20 jobs | 0.67 s, 20/20 |
| 1,000 | 0.17 s, 100/100 | 2.0–2.2 s, 100/100 |
| 2,500 | 0.17 s, **100/250** (pagination bug) | 4.9–5.2 s, 250/250 |
| 5,000 | 0.16 s, **100/500** (pagination bug) | 9.4–10.1 s, 500/500 |

* Master is fast only because it reads the first 1,000-key page with unbounded parallelism and drops every job after it.
* The policy CPU cost is about 25 µs per assigned booking, which is negligible.

**Limitation.** Wall time grows linearly with the total store size N, not with the technician's own jobs. At about 20 ms per read, N ≈ 5,000 reaches Netlify's 10 s synchronous function limit. The Admin Jobs list scales the same way, because it uses the same read pattern.

**Proposed acceptance criterion (measurable, before release):**

1. Get N, the current production booking count, read-only, for example from the `blobCount` timing the Admin list already records.
2. On a deploy preview with a synthetic booking store of **2 × N** (and never fewer than 2,000), call `GET tech-jobs` 20 times for a technician with at least 20 assigned jobs.
3. **Pass** when all of these hold:
   * p95 server time ≤ 4 s and maximum ≤ 6 s, which leaves at least 40 % headroom under the 10 s limit
   * zero 502/504/timeout responses
   * every assigned job is returned (count equals the seeded count)
4. **Fail:** release is blocked. The options then are a technician-assignment lookup or a higher read concurrency. Both need separate approval: the first is a new index, the second exceeds the tested ceiling.
5. Re-run the check whenever N doubles.
