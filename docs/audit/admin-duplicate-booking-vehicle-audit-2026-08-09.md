# AUDIT REPORT — Admin Ops duplicate Magno bookings + duplicate boat line

**Date:** 2026-08-09  
**Workspace:** `C:\Projects\Cardetail1\repository\cardetail1-stage2b`  
**Scope:** Audit only — no code fixes. Findings for Claude to analyze.  
**Surfaces:** Deploy Preview Admin Ops Jobs list vs Customer portal (My Garage); vehicle add while editing.

---

## 1. Symptom summary

| Observation | Detail |
|---|---|
| Admin Ops Jobs | Two nearly identical **Magno oliveira** rows for **2026-08-20**, both **3 vehicles**, both **$2616.00** balance, both **pending review / awaiting customer payment**, both **Unassigned**. Differ only by preferred/operational time (**10:00 AM** vs **8:00 AM**). |
| Customer portal | **No** duplicated appointment rows (observer judges this correct / single appointment view). |
| Vehicle edit side-effect | While customer was adding another vehicle, booking also gained **another boat** with the **same length** and **same package/service** (duplicate vehicle line). |
| Third Admin row | Magno oliveira **Escalade**, **2026-08-18**, **completed pending payment / payment action required**, **$270** — treat as a separate historical job unless Blob IDs prove otherwise. |

**Working distinction for analysis:**

1. **Two Admin job rows** = either two distinct Blob booking records, or one logical booking listed twice.
2. **Duplicate boat line** = mutation of `service.vehicles[]` / projected `vehicles[]` on a single booking (orthogonal unless both clones were forked with the same vehicle set).

---

## 2. Evidence from code

### 2.1 How Admin `listJobs` builds rows (no logical-id dedupe)

**File:** `netlify/functions/admin-ops-jobs.js`  
**Function:** `listJobs(q)`

Flow:

1. `blobsStore('cd1-bookings')` → `listAllBlobs(store, 'cd1-bookings')` — **one entry per Blob key**.
2. Each blob is loaded; if payload lacks `id`/`bookingId`, `raw.id = blob.key`.
3. Every loaded record keeps `raw.__blobKey = blob.key` (comment explicitly: *key ≠ payload.id* is expected).
4. Filter with `isVisibleSubmittedBooking` (+ optional test/archive/status/search filters).
5. Map through `projectJobForAdminList` (`netlify/lib/ops-workflow.js`).
6. Display id set via `normalizeBookingKey(j.id || j.bookingId || b.__blobKey)` — **does not collapse rows that share the same payload id across two keys**.

**Critical absence:** There is **no** `Map`/`Set` dedupe by `payload.id` / `bookingId` / normalized key.  
**Implication:** Admin Jobs is a **Blob-key cardinality** feed. Two keys ⇒ two rows, even when payloads look identical (or share the same `id` field).

Supporting resolution code that already assumes key ≠ id:

| Location | Behavior |
|---|---|
| `netlify/lib/ops-db.js` → `getBooking` | Direct key variants, then **full scan** matching `payload.id`/`bookingId` **or** blob key; logs `getBooking resolved via scan`. |
| `getBookingsByIds` | Batch variant of same dual resolution; dedupes **lookup ids**, not list rows. |
| `listRawBookings` / `listSubmittedBookings` | Also one record per blob fetch; no id-collapse. |

`listAllBlobs` / `fetchBlobRecords` (`netlify/lib/tech-security.js`) paginate and fetch by key; they do not invent duplicates, but they also do not detect “same logical booking, two keys.”

### 2.2 Lean Admin row fields (why the two Magno rows look identical)

**File:** `netlify/lib/ops-workflow.js`  
**Functions:** `projectJobForAdminList`, `listVehicleSummary`, `listMoneySummary`

- Rows surface `preferredDate` / `preferredTime`, name, `vehicleCount` / `"N vehicles"`, money from `financialProjection`, workflow status, assignment.
- `listVehicleSummary` counts **top-level** `b.vehicles` (not `b.service.vehicles`). Canonical aggregate prefers `service.vehicles` (`normalizeAggregate` in `netlify/lib/booking-aggregate.js`). If those arrays ever diverge, list count can disagree with drawer/detail.
- Same customer + same date + same money + same vehicleCount with only `preferredTime` different is **exactly** what two separately finalized bookings on different slots look like in this projection.

### 2.3 How Customer portal lists appointments (why Admin can show 2 while Customer looks like 1)

**Server — account mode:** `netlify/functions/customer-portal-data.js` → `handlePortalData`

1. `listRawBookings()` — all visible blobs (same store; **also no id-dedupe**).
2. Keep bookings owned by session/account via:
   - Prisma `customerAccountId` link (authoritative when present),
   - session `bookingIds`,
   - Blob `customerAccountId`,
   - legacy phone/email contact match only for unlinked bookings.
3. Project all owned bookings into `bookings[]`; `selectUpcoming` picks **one** hero — **does not remove siblings from the collection**.

**Client — My Garage:** `assets/my-garage.js`

| Path | `state.bookings` | Effect on “duplication” |
|---|---|---|
| `loadAccount` (authenticated account) | `r.data.bookings` (full owned set) | Hero = one; other upcoming rows go to `#appointments-list` (excludes current hero id). **Two owned Magno jobs should still be visible as hero + list row** unless the user only looked at the hero. |
| `loadLimited` / booking-scope lookup | **`[r.data.booking]` only** (`state.scope = 'booking'`) | Customer **cannot** see a sibling Magno booking at all. Matches “Customer portal: NO duplication” if they used Booking ID + phone / action link. |

Additional ownership asymmetry vs Admin:

- Admin lists **every** submitted blob (minus draft/archive/test filters).
- Customer only lists bookings that pass ownership / contact gates. A second blob with the same name/phone but **no** account link and **not** in `session.bookingIds` can appear in Admin and vanish from Customer account mode.

### 2.4 Booking creation paths that legitimately create two Magno-like jobs

Slot lock is **date + time**, not “one active booking per customer/day”:

| Mechanism | File / function | Notes |
|---|---|---|
| Public draft + finalize | `netlify/functions/submit-booking.js` (`newUniqueId`, draft `setJSON`, finalize in-place on `rawDraftId`) | Finalize is idempotent for the **same** draft id. A **second** draft with another slot (8 AM vs 10 AM) finalizes to a **second** booking id. |
| Slot conflict | `netlify/lib/booking-schedule.js` → `hasSlotConflict`; enforced in `enforceScheduleFields` | Blocks same date+time; **allows same date, different window**. Covered by `tests/booking-schedule.test.js`. |
| Admin fork | `admin-ops.html` → `#dCreateFromBooking` → `action: 'create_appointment'`; `createAdminAppointment` in `netlify/lib/admin-booking-mutations.js` | Explicitly creates a **new** id, copies customer/address/vehicles/package; UI copy: *“Creates a new booking prefilled…”*. Does **not** require a new preferred time in the click handler shown (time may default empty / caller-supplied). Documented in `docs/audit/admin-authority-pass-2026-08-08.md` (Create tab). |

**Draft + submitted dual keys:** Normal finalize writes the finalized payload **onto the same draft key** (`store.setJSON(rawDraftId, b)`), clears `isDraft`. That path alone should **not** leave draft+submitted twins unless something else wrote a second key (abandoned second draft, admin create, or a buggy dual-write). Sticky draft flags are healed for reads (`healStickyDraftFlags` / `hasSubmissionMarkers` in `booking-visibility.js` + `ops-db.js`), so a finalized record with stale `isDraft` still appears in Admin — it does not by itself produce two rows.

### 2.5 Vehicle add flow — how a boat can be duplicated (same length + package)

**Customer submit:** `assets/my-garage.js` → modal `vehicle_add_request` → `submitAction` → `netlify/functions/submit-customer-action.js`  
**Command:** `submitChangeRequestCommand` / `decideChangeRequestCommand` in `netlify/lib/booking-commands.js`  
**Mutation:** `applyVehicleOperation(..., { op: 'add' })` in `netlify/lib/vehicle-financial-mutation.js`

Findings:

1. **`op: 'add'` always appends** a new `vehicleId` (`newVehicleId()`). There is **no** server check for “already have a boat with this `lengthFt` + `packageId`.”
2. **Pending-review / unconfirmed bookings auto-apply vehicle adds.**  
   `appointment-status-policy.js` → `canRequestChange`:
   - `pending_review` / “Pending Review” classify as phase **`draft`**.
   - Admin-gated actions are only `reschedule`, `maintenance`, `vehicle_remove` (plus paid-invoice catalog changes).
   - **`vehicle_add` → `pendingApproval: false`** for draft/confirmed unpaid appointments → `autoApplySubmittedRequest` in `submit-customer-action.js` immediately decides/applies.
3. **Idempotency does not stop a second successful identical add.**  
   Client stores `mutationRequestKeys[requestSignature]` for in-flight retries, but on **success** it **`delete`s** that key (`my-garage.js` ~2351–2352). A second submit of the same payload mints a **new** idempotency key → second change request → second append.
4. **Replace vs add UX:** Vehicle modal (`renderVehicleModal`) does not prefill from an existing boat; length ruler uses category **default feet**. Easy to recreate the same length + same package while intending to add a different vehicle (or intending replace via Edit).
5. **Admin parallel path:** Admin vehicle financial mutation / create-from-booking copy vehicles wholesale; legacy `mutateVehicles` `op: 'add'` also blindly pushes. PR4 notes retiring free-form `update_vehicles` (410) in favor of versioned ops — still no semantic duplicate-boat guard.
6. Related register debt: **PDA-05** (retries can create duplicates / apply twice), **PDA-06** (duplicate canonical vehicle fields / weak targeting), **PDA-07** (duplicate add-on money) in `docs/audit/portal-defect-register.md`. None specifically title “duplicate boat line,” but the append-only + auto-apply pattern matches the observed edit-time twin.

### 2.6 Redesign / payment overlay — likely not causal (confirm)

| Artifact | Assessment |
|---|---|
| `prototypes/portal-redesign/*` (incl. `ops-console.html`) | Local/untracked prototypes; redirect shells. **Not** the production Admin list authority (`admin-ops.html` + `admin-ops-jobs.js`). |
| Admin payment overlay | `applySharedProjectionToAdminJob` / Postgres money overlay in `ops-workflow.js` + `get_job` — mutates **money fields on an existing row**, not row cardinality. |
| Admin authority pass (2026-08-08) | Added Create-tab fork, cash/card UX, customer `selectUpcoming` / sticky focus — can **create** a second appointment if Create was used; does **not** make `listJobs` double-render one blob. |
| Payment Element / balance PI work | Affects settlement display and payability; does not invent Blob keys. |

**Verdict:** Redesign prototypes and payment overlays are **unlikely** to cause two Magno rows by themselves. The Create-appointment affordance and/or a second public booking finalize are far more plausible for **two bookings**. Vehicle duplication is explained by the **auto-apply add path**, not payment UI.

### 2.7 Existing defect register / audit mentions

| Doc | Relevance |
|---|---|
| `docs/audit/portal-defect-register.md` | **PDA-05** retries/duplicates across request+booking writes; **PDA-06** duplicate canonical vehicle fields; **PDA-07** duplicate add-on charge; **PDA-13/14** draft visibility / draft token (related to draft integrity, not proven as this Magno twin). |
| `docs/audit/admin-authority-pass-2026-08-08.md` | Documents Admin **Create appointment from this booking** → second booking by design. |
| `docs/audit/portal-resistance-info-loss-2026-08-08.md` | P2 “Duplicate scheduling rows” (UI noise), not Blob twin Magno case. |
| `docs/audit/customer-admin-operations-pr4-2026-08-05.md` | Versioned vehicle add/replace/remove; no semantic de-dupe of identical boat lines. |
| `docs/audit/phase2-gate-report.md` / financial audits | Duplicate **PaymentIntent / webhook / ledger** idempotency — different domain. |
| `tests/booking-schedule.test.js` | Confirms same date+time conflict; different times allowed. |
| `tests/multivehicle-summary-projection.test.js` | “duplicated booking flow” refers to **shared booking HTML pages**, not Admin twin rows. |

**No prior register entry found** that specifically documents “Admin listJobs shows two Magno rows for same day different slots” or “auto-apply vehicle_add clones boat length+package.”

---

## 3. Ranked hypotheses (defect-first)

### A. Two distinct booking Blob records (same customer, same day, different slots)

**Confidence: High (0.75–0.85)** for the Admin twin rows.

- Differing **8:00 AM vs 10:00 AM** is a first-class field in `projectJobForAdminList`; listJobs does not invent time variants from one record.
- Slot policy allows both.
- Creation via second public finalize **or** Admin `create_appointment` fork produces exactly this shape (same name, money, vehicleCount after parallel edits).
- Customer “no duplication” fits **booking-scoped** My Garage **or** account mode where only one blob is ownership-linked.

### B. Admin list double-row from key ≠ id (same logical booking, two Blob keys)

**Confidence: Medium-Low (0.25–0.40)** for *this* screenshot (times differ), **Medium (0.50)** as a general latent defect.

- Code **explicitly** supports key ≠ payload.id and **never dedupes** list rows.
- Would typically show **identical** times unless one key’s payload was edited independently (then they are effectively two diverging records anyway).
- Still must be ruled out by comparing `__blobKey` vs `payload.id` on both rows.

### C. Draft + submitted dual visibility

**Confidence: Low (0.15)** for two Magno pending-review rows.

- `isVisibleSubmittedBooking` hides true drafts; submitted markers override sticky `isDraft`.
- Finalize overwrites the draft key in place.
- Would need an anomalous second write to create a twin.

### D. Customer vehicle_add auto-apply + second successful submit (or add-instead-of-replace) duplicated the boat

**Confidence: High (0.70–0.85)** for the duplicate boat line.

- Append-only `op: 'add'`.
- Auto-apply on pending_review.
- Idempotency key cleared after success → identical second submit is a new mutation.
- Default length + same package selection makes “same size + same service” twins easy while “adding another vehicle.”

### E. Admin applied vehicle add / create-from-booking while customer was editing

**Confidence: Medium (0.40–0.55)** as co-cause.

- Admin Create copies full `vehicles[]`.
- Admin vehicle mutation also appends without semantic dedupe.
- Could explain both twin bookings **and** identical 3-vehicle composition if fork happened after vehicles were built (or both were edited in parallel).

### F. Redesign prototype or payment overlay caused the list twin

**Confidence: Very Low (0.05–0.10).**

- Prototypes are not the live Admin feed.
- Payment overlay does not multiply Blob rows.

### G. Prisma mirror / dual-read invented a second Admin row

**Confidence: Very Low (0.05).**

- `listJobs` reads Blobs only; Prisma mirror is fail-open for `getBooking`, not for Admin list enumeration.

---

## 4. Data to collect for repro / disambiguation

Collect for **both** Magno 2026-08-20 Admin rows (and Escalade row for contrast):

| Field | Why |
|---|---|
| Displayed Admin `id` / `bookingId` | Whether UI ids match or collide after `normalizeBookingKey`. |
| Blob key (`__blobKey` — only on raw list path today; may need temporary get/list instrumentation or Netlify Blobs console) | Proves one vs two keys. |
| Payload `id`, `bookingId`, `createdAt`, `finalizedAt`, `updatedAt`, `bookingVersion`, `quoteVersion` | Twin finalize vs fork vs divergence. |
| `preferredDate`, `preferredTime`, `preferredArrivalWindow`, `confirmedDate`/`Time` | Confirms the only intentional difference. |
| `adminCreated` / `createdByAdmin` / eventLog (`admin_create_appointment`, `customer_change_requested`, `admin_vehicle_*`) | Public booking vs Admin fork / vehicle ops. |
| `customerAccountId`, phone, email | Explains Customer ownership filter. |
| `isDraft`, `kind`, `jobStatus`, `status`, `portalReleasedAt` | Draft/submit visibility. |
| Full `service.vehicles[]` and top-level `vehicles[]` (vehicleId, category, lengthFt, packageId/pkgId, label) | Prove boat twin ids vs shared identity; catch service vs top-level skew. |
| `changeRequests[]` entries of type `vehicle_add_request` (status, idempotencyKey, requestFingerprint, delta, decidedAt, appliedBookingVersion) | Count of successful adds / double apply. |
| Ledger `approvedCents` / remaining ($2616) | Whether money was recomputed twice identically. |
| Customer session mode used during observation (account cookie vs Booking ID lookup) | Explains “no duplication” on Customer. |
| Netlify Deploy Preview commit SHA / function version | Tie to current `listJobs` / auto-apply policy. |

**Minimum decisive pair:**

1. If **two Blob keys** and **two different ids** → Hypothesis A/E (real twin bookings).  
2. If **two Blob keys** and **same payload.id** → Hypothesis B (list/storage dual-key defect).  
3. If **one Blob key** but Admin shows two rows → UI/client bug (unexpected; current `listJobs` maps 1:1 from blobs).  
4. On the booking that grew the boat: **two vehicleIds** with equal `lengthFt`+`packageId` and two `vehicle_add_request` applied events → Hypothesis D.

---

## 5. Suggested investigation steps for Claude (NOT the fix)

1. **Blob forensics (Deploy Preview / staging store `cd1-bookings`)**  
   List keys whose payload matches Magno + 2026-08-20. Export both full JSON documents. Diff with attention to id, times, vehicles, eventLog, changeRequests, adminCreated.

2. **Prove list cardinality contract**  
   Trace `listJobs` with those two keys: confirm each key independently passes `isVisibleSubmittedBooking` and projects `$2616` / 3 vehicles. Document that no dedupe layer exists (cite `admin-ops-jobs.js` `listJobs`).

3. **Customer parity experiment**  
   - Account-session `customer-portal-data` `mode:account`: does `bookings.length` include both ids?  
   - Booking-scope lookup with each id+phone: each loads alone.  
   Record which mode the human used when they said “no duplication.”

4. **Vehicle timeline**  
   On the booking that shows the twin boat, order `eventLog` + `changeRequests` by time. Identify whether the second boat came from:
   - auto-applied `vehicle_add_request`,
   - Admin vehicle mutation,
   - Create-from-booking copy,
   - or a replace that actually appended.

5. **Reproduce vehicle twin locally (synthetic store)**  
   - Booking `jobStatus: pending_review`, one boat already on `service.vehicles`.  
   - Submit `vehicle_add_request` with same `lengthFt`+`packageId` twice with **different** idempotency keys (simulate success→clear→resubmit).  
   - Expect two appends under current policy.  
   - Separately try uncertain network retry with **same** key (should idempotent-replay).

6. **Reproduce Admin twin bookings**  
   - Finalize booking A at 8:00 AM; create second draft/finalize at 10:00 AM same date/customer (should succeed).  
   - And/or Admin Create-from-booking from A.  
   - Confirm Admin list shows two rows; Customer account may show two; booking-scope shows one.

7. **Rule out UI-only**  
   Confirm Admin Jobs table keys rows by booking id from API JSON (not a client-side duplicate render of one fetch). Inspect network response array length for `list` / jobs poll.

8. **Do not implement yet**  
   Candidate fix directions (for later design only): list-level soft warning when payload ids collide; semantic guard on vehicle_add; keep idempotency key after success for identical fingerprint window; require admin approval for vehicle_add on pending_review; ownership backfill for orphan Magno blob. **Out of scope for this audit.**

---

## 6. Bottom line for Claude

- **Admin twin Magno rows are best explained as two Blob bookings** (different preferred times), surfaced 1:1 by an undeduped `listJobs`.  
- **Customer “no duplication” is explained by booking-scoped portal and/or ownership filtering**, not by a smarter Customer dedupe of the same twin set.  
- **Duplicate boat line is explained by append-only, auto-applied `vehicle_add` on pending-review bookings**, with client idempotency that only protects in-flight retries—not a second successful identical add.  
- **Payment overlay / portal-redesign prototypes are unlikely causes.**  
- **Prior register** covers related integrity themes (PDA-05/06/07, Admin Create fork) but not this exact Magno dual-row incident.

---

## 7. Primary code index

| Area | Path | Symbol |
|---|---|---|
| Admin list | `netlify/functions/admin-ops-jobs.js` | `listJobs` |
| Admin lean projection | `netlify/lib/ops-workflow.js` | `projectJobForAdminList`, `listVehicleSummary` |
| Visibility | `netlify/lib/booking-visibility.js` | `isVisibleSubmittedBooking`, `isDraftRecord` |
| Key normalize / get | `netlify/lib/ops-db.js` | `normalizeBookingKey`, `getBooking`, `listRawBookings` |
| Customer feed | `netlify/functions/customer-portal-data.js` | account filter, `selectUpcoming` |
| Customer UI | `assets/my-garage.js` | `loadAccount`, `loadLimited`, `submitAction`, `renderVehicleModal` |
| Schedule lock | `netlify/lib/booking-schedule.js` | `hasSlotConflict` |
| Public create | `netlify/functions/submit-booking.js` | draft + finalize |
| Admin create | `netlify/lib/admin-booking-mutations.js` | `createAdminAppointment` |
| Vehicle mutate | `netlify/lib/vehicle-financial-mutation.js` | `applyVehicleOperation` |
| Change commands | `netlify/lib/booking-commands.js` | `submitChangeRequestCommand`, decide/apply vehicle_add |
| Auto-apply policy | `netlify/lib/appointment-status-policy.js` | `canRequestChange` |
| Defect register | `docs/audit/portal-defect-register.md` | PDA-05, PDA-06, PDA-07, PDA-13, PDA-14 |
