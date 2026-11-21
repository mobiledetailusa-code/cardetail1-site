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
| `job-photo-image`, every photo (legacy and new) | admin session (header or cookie), or tech session + ownership check + `technicianAccess`, per request; no credentials → 401 before any lookup | `private, no-store` |
| `tech-quick-ops` signed SMS link | link session = booking id + assignee phone + live token hash (unassign/reassign revokes) | `quickOpsPiiDecision` on every GET and every POST response view |
| `tech-auctions` | any onboarded tech (unchanged) | customer notes never sent |

### Read consistency for authorization

Every technician authorization decision reads the booking (and, for legacy name-only assignments, the technician roster) with a strong read. There is no eventual fallback.

* `readJsonStrong` (in `tech-security.js`) throws `StrongReadError` when the strong read fails. A missing key is not a failure; it returns no data.
* Every path in the table above that reads a booking for a technician (portal list phase 2, status update, withdrawal request, photos, photo bytes, completion, signed SMS link) uses it, through `getBookingRecord(id, { requireStrong: true })` where the repository is used.
* A failed strong read gives a retryable `503 temporarily_unavailable` (the SMS link's HTML view shows the neutral page). No PII, photo URLs or image bytes are returned, and nothing is written.
* The roster is read with `fetchBlobRecords(..., { strict: true })`. Any failed account read makes the roster unavailable, which denies the legacy name path (`roster_unavailable`). Id assignments don't need the roster.
* Admin withdrawal approval reads the request and the booking strongly. On failure it returns 503 and unassigns nobody; a claimed request becomes open again after the claim timeout.
* Admin photo access doesn't read the booking, so it is unaffected.
* Unchanged: `getBookingRecord` and `fetchBlobRecords` without the new options behave as before for every other caller. Phase 1 of the portal list still uses eventual reads, but only to shortlist candidates; it never decides disclosure.
* Not changed (pre-existing, outside this fix): `validateTechSession` reads the session and account with the default read, so a just-revoked session or deactivated account may still authenticate briefly. Assignment, schedule and status are still checked on the strong booking read.

## 4. What is not revoked

* JSON already delivered to a device stays in that page's memory until it reloads.
* Legacy photos (uploaded before this change) were served `public, max-age=31536000, immutable` with wildcard CORS. They now require authorization on every new request, but these can't be recalled:
  * copies already in a browser cache
  * any copy an intermediary or CDN stored, until it is purged
  * images already downloaded, saved or screenshotted
* A photo already fetched into a page stays visible as a `blob:` URL until that page reloads.

## 5. Legacy photos: authorization and remaining exposure

"Legacy" means every photo whose stored meta has no `cachePolicy`, which is every photo uploaded before this branch. The owner approved requiring authorization for them on 2026-11-20. No photo or meta record is deleted, migrated or rewritten.

**Behavior now.** Legacy and new photos follow the same rules in `job-photo-image.js`:
* No credentials → `401` before any storage lookup, so an anonymous caller can't tell whether an id exists.
* Admin session (x-admin-key or the HttpOnly admin cookie) → allowed.
* Technician session → allowed only when all of these hold:
  * the photo's meta names a booking (`meta.bookingId`)
  * that booking exists (strong read)
  * that booking lists the photo in `photosBefore` or `photosAfter`
  * `technicianAccess` passes: assigned, not terminal in any status field, inside the 12-hour window
* Anything else gets `401` or `403` with no image bytes. Every success is `private, no-store` with no wildcard CORS.

**Ownership resolution.** The only writer of the photo store has always recorded `bookingId`, `phase` and `techId` in the meta, since the feature shipped in `925e9839` (2026-06-23).
* This was verified from git history; the stored records themselves were not inspected, because that needs production access.
* A legacy record without `bookingId`, pointing at a missing booking, or not listed by its booking is refused to technicians (fail closed). An admin can still view it.
* A photo the uploader stored but never linked to its booking (the booking write lost a race) is therefore technician-invisible. It was already invisible in every UI, since no booking listed its URL.

**Rendering.** The Admin drawer and the technician photo grid fetch every photo with their session header and display it as a `blob:` URL, so both keep working for legacy photos. No SMS or email template, receipt, customer page, review flow, Admin snapshot cache or Prisma table carries photo URLs.

**Remaining exposure (cannot be revoked):**
* Responses served before deploy were `public, max-age=31536000, immutable`. A browser that loaded a photo may keep serving it from its own cache for up to a year without contacting the server.
* Whether Netlify's CDN stored those function responses is not verified. If it did, cached URLs bypass the function until that cache is purged. Netlify normally purges on a new deploy; that is not verified here.
* Images already downloaded, saved, screenshotted or forwarded are outside the system's control.
* Links that were shared outside the app (an admin texting a photo link, a bookmark) stop working for new requests. That is the intended effect, and their number can't be determined without production logs.

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

**Synthetic performance acceptance test (required before release):**

1. Get N, the current production booking count, read-only, for example from the `blobCount` timing the Admin list already records.
2. On a deploy preview with a synthetic booking store of **2 × N** (and never fewer than 2,000), call `GET tech-jobs` 20 times for a technician with at least 20 assigned jobs.
3. **Pass** when all of these hold:
   * p95 server time ≤ 4 s
   * maximum ≤ 6 s, which leaves at least 40 % headroom under the 10 s limit
   * zero timeouts (no 502/504 or client timeout)
   * complete assigned-job results: the returned count equals the seeded count for that technician
4. **Fail:** release is blocked. The options then are a technician-assignment lookup or a higher read concurrency. Both need separate approval: the first is a new index, the second exceeds the tested ceiling.
5. Re-run the check whenever N doubles.

**Synthetic run, 2026-11-20 (local, not a deploy preview).** This was not run on a deploy preview.
* Deployed functions open Blobs stores through the site runtime context. Site-wide stores are shared by production and every deploy preview, so a preview would read the real `cd1-bookings`, and seeding it would write synthetic bookings into production.
* The run therefore used the task's fallback: a local Node process with an in-memory Blobs fake and injected latency. The production count was unavailable, so the formal 2 × N criterion remains **unverified**.

**Method:**
* Synthetic bookings only, with 1,000-key list pages.
* One technician with 40 assigned jobs (half inside the 12 h window), everyone else's bookings marked so leakage is detectable.
* 2 warm-up requests, then 20 measured sequential requests.
* Timeout at 10 s.
* Each response is checked for: status 200, the exact assigned-job set, and PII redaction.
* On Windows, timer granularity rounds a 20 ms injected wait up to about 31 ms.

| Latency profile | Bookings | p50 | p95 | Max | Timeouts | Complete | PII violations | Result |
|---|---|---|---|---|---|---|---|---|
| Fixed: list 60 ms, read 20 ms, strong 20 ms | 2,000 | 3.58 s | 3.68 s | 3.70 s | 0 | 20/20 | 0 | PASS |
| Fixed: list 60 ms, read 20 ms, strong 20 ms | 5,000 | 8.52 s | 8.54 s | 8.54 s | 0 | 20/20 | 0 | **FAIL** |
| Fixed: list 60 ms, read 20 ms, strong 40 ms | 2,000 | 3.65 s | 3.65 s | 3.66 s | 0 | 20/20 | 0 | PASS |
| Fixed: list 60 ms, read 20 ms, strong 40 ms | 5,000 | 8.61 s | 8.63 s | 8.63 s | 0 | 20/20 | 0 | **FAIL** |
| Jitter: list 40–120 ms, read 10–40 ms (+200 ms on 2 %), strong 2× | 2,000 | 11.7 s | 13.8 s | 13.8 s | 20 | 20/20 | 0 | **FAIL** |
| Jitter: same | 5,000 | — | 15 s (client cut-off) | 15 s | 20 | 0/20 | 0 | **FAIL** |

These are simulated latencies, not production measurements.

**Bottleneck.**
* Phase 1 reads every booking (`N` eventual reads) in sequential batches of 20. Each batch waits for its slowest read.
* With a 2 % slow tail, about a third of batches take the slow path, so tail latency is multiplied by `N / 20`.
* Phase 2 (strong reads of 40 candidates) costs 2–3 batches and isn't the bottleneck.

**Negative control.**
* Setup: list page 2 throws.
* The handler returns `200` with 20 of 40 jobs, because `listAllBlobs` falls back to a single unpaginated page.
* The harness counts this as incomplete, not as a success.
* In production a technician would see a silently partial list. This is not a PII exposure, but it is an open defect.

**Correction options identified in that run:**
1. Sliding pool at the same concurrency of 20 (implemented, see below).
2. Raise phase-1 concurrency above 20. This exceeds the documented tested ceiling and needs load testing against Blobs rate limits. Not implemented; needs approval.
3. Add a technician-to-booking assignment lookup. This is a new index (an architecture change). Not implemented; needs approval.
4. Make the technician list fail with `503` when the listing is incomplete (implemented, see below).

### Rolling pool and incomplete-listing protection (approved 2026-11-20)

`GET tech-jobs` only. The Admin list, the shared `listAllBlobs`, booking records and every POST path are unchanged.

* **Rolling pool (`forEachPooled`):** at most 20 reads in flight, and the next read starts as soon as one finishes. Exactly 20 worker promises exist, with no promise per booking created up front. Both phases use it. On the first error, the pool stops starting new reads, waits for in-flight reads to settle, then rethrows.
* **Phase 1 keeps only matching keys,** never the booking records, so memory holds one booking per worker plus the key list.
* **Two-phase design unchanged:** the eventual read only shortlists; disclosure is decided on the strong re-read (`readJsonStrong`, failure → 503).
* **Complete listing (`listBookingKeysComplete`):** every page must be read. Any of these is an incomplete listing and returns `503 temporarily_unavailable` with no job list:
  * a page that throws (first, middle or final)
  * a malformed page
  * a store without pagination support
  * a booking read that throws during phase 1

  A key deleted between listing and read is skipped; that is not incomplete.
* **Roster loading:** shared within a request, so concurrent workers trigger at most one roster read.

**Before/after, same harness, datasets and profiles** (local, synthetic, injected latency; 2 warm-ups + 20 measured requests per row; 40 assigned jobs).

| Profile | Bookings | Before p95 / max | After p95 / max | After timeouts | After complete | PII violations | After result |
|---|---|---|---|---|---|---|---|
| Fixed: read 20 ms, strong 20 ms | 2,000 | 3.62 / 3.65 s | 3.61 / 3.62 s | 0 | 20/20 | 0 | PASS |
| Fixed: read 20 ms, strong 20 ms | 5,000 | 8.62 / 8.82 s | 8.59 / 8.61 s | 0 | 20/20 | 0 | **FAIL** |
| Fixed: read 20 ms, strong 40 ms | 2,000 | 3.66 / 3.66 s | 3.66 / 3.66 s | 0 | 20/20 | 0 | PASS |
| Fixed: read 20 ms, strong 40 ms | 5,000 | 8.64 / 8.64 s | 8.64 / 8.64 s | 0 | 20/20 | 0 | **FAIL** |
| Jitter: read 10–40 ms (+200 ms on 2 %), strong 2× | 2,000 | 13.26 / 13.39 s (19 timeouts) | 4.67 / 4.71 s | 0 | 20/20 | 0 | **FAIL** (p95 > 4 s) |
| Jitter: same | 5,000 | 15 s cut-off (20 timeouts, 0 complete) | 10.28 / 10.41 s | 17 | 20/20 | 0 | **FAIL** |

* **Negative control** (list page 2 throws): before, `200` with 20 of 40 jobs; after, `503` with no job list.
* **Interpretation:**
  * The pool removes the tail amplification from slow reads: jitter at 2,000 drops from 13.3 s to 4.7 s.
  * With uniform latency it can't beat the throughput floor, so fixed-latency rows are unchanged.
  * These are simulated latencies, not production measurements. Windows timer granularity rounds each 20 ms wait up to about 31 ms, so the fixed rows overstate a true 20 ms read by about 1.5×.

**Remaining scalability limit.**
* With 20 reads in flight, phase 1 costs about `N × mean_read / 20`. To stay under p95 4 s (about 3.5 s for reads after list pages and phase 2), N must stay below about `70 / mean_read_seconds`:
  * about 3,500 bookings at a 20 ms mean read
  * about 2,300 bookings at a 30 ms mean read
* 5,000 bookings fails under every profile.
* Going further needs one of the unapproved options: higher concurrency, or an assignment lookup.
* The formal 2 × production-count criterion is still **unverified**: the production count is unknown, and a deploy preview would use production Blobs.
