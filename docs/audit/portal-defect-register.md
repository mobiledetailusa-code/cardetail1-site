# CARDDETAIL1 Portal Defect Register

**Audit baseline:** `fix/my-garage-operational-portal` at `5fa47b99c4d8707dba29b35c6559b3cdba3eb125`  
**Evidence date:** 2026-07-17  
**Method:** repository inspection, existing automated tests, and synthetic local fixtures only.

Severity is an operational prioritization. Classification uses only the requested audit classes: **confirmed defect**, **data-integrity defect**, **incomplete implementation**, **payment risk**, **authorization design concern**, **UX defect**, and **optional enhancement**.

## Finding index

| ID | Severity | Classification | Summary | Release A |
|---|---|---|---|---|
| PDA-01 | Critical | payment risk; data-integrity defect | Portal and canonical pricing catalogs disagree | Yes |
| PDA-02 | Critical | data-integrity defect | No booking/request/quote version or compare-and-swap | Yes |
| PDA-03 | Critical | payment risk; data-integrity defect | Customer balance Checkout is not credited | Yes |
| PDA-04 | Critical | payment risk; confirmed defect | Historical paid/closed records can become payable | Yes |
| PDA-05 | High | data-integrity defect | Request and booking writes are non-atomic | Yes |
| PDA-06 | High | data-integrity defect | Top-level service fields diverge from `vehicles[]` | Yes |
| PDA-07 | High | payment risk; confirmed defect | Existing add-on can be charged twice while stored once | Yes |
| PDA-08 | High | confirmed defect; payment risk | Admin Stripe-link generation crashes and accepts a non-authoritative amount | Yes |
| PDA-09 | High | payment risk; data-integrity defect | Approved total, paid amount, due, and old links diverge | Yes |
| PDA-10 | High | incomplete implementation; authorization design concern | Technician feed/actions do not require confirmed eligible work | No |
| PDA-11 | High | data-integrity defect | Customer lifecycle ignores Technician in-progress status | No |
| PDA-12 | High | incomplete implementation | Admin can omit submitted requests after the first 200 keys | Yes |
| PDA-13 | Medium | confirmed defect | Retained customer endpoints expose caller-owned drafts | Yes |
| PDA-14 | High | authorization design concern | Draft overwrite/finalization does not verify the save token | Yes |
| PDA-15 | Medium | UX defect | Action-link My Garage cannot reliably refresh | Yes |
| PDA-16 | Medium | incomplete implementation; data-integrity defect | Historical projections and lists are not compatibility-safe | Yes |
| PDA-17 | High | payment risk | Local/preview charge endpoints do not fail closed to Stripe test mode | Yes |
| PDA-18 | Medium | incomplete implementation; payment risk | No current Pay in Full workflow; dormant route is non-authoritative | Yes |
| PDA-19 | Medium | incomplete implementation; UX defect | Visible controls include placeholder or note-only workflows | No |

---

## PDA-01 — Portal and canonical pricing catalogs disagree

| Field | Detail |
|---|---|
| Severity / classification | **Critical — payment risk; data-integrity defect** |
| Exact reproduction steps | 1. Create a synthetic standard-ZIP SUV 3-row booking. 2. In My Garage request package `premium`. 3. Capture the server-created request proposal. 4. Reprice the same structured vehicle with `booking-price-catalog`. 5. Approve the request through the Admin handler fixture. |
| Expected result | One canonical server quote: SUV 3-row Premium is `$635` before applicable travel/add-ons, and that same amount is the approved amount, displayed amount, and Stripe basis. |
| Actual result | `customer-catalog` proposes the car base price `$450`; the canonical catalog returns `$635`. Admin trusts the stored proposal and writes it as approved/due. A second confirmed drift is Odor Removal `$149` in the portal catalog versus `$90` in the canonical catalog. |
| Affected file | `netlify/lib/customer-catalog.js:45-57`; `netlify/lib/booking-price-catalog.js:6-18,375-431`; `netlify/functions/submit-customer-action.js:170-215`; `netlify/functions/admin-customer-requests.js:135-166` |
| Affected function | Portal catalog constants; `validateAndRecalculateBookingPricing`; `submit-customer-action.handler`; `admin-customer-requests.handler` decision path |
| Affected store | `cd1-bookings`; proposal snapshot in `cd1-customer-change-requests` |
| Root cause | Two independently maintained price catalogs; portal requests do not preserve canonical quote inputs; Admin approval does not reprice against the current canonical record. |
| Operational impact | Tier, category, ZIP, and add-on undercharges/overcharges. Customer, Admin, and Stripe can appear mutually consistent while all use the wrong approved amount. |
| Required fix | Replace the portal catalog as a pricing authority with one canonical server quote service. Persist structured inputs and immutable `quoteVersion`; reprice on approval and reject stale/incompatible inputs. |
| Deterministic acceptance test | SUV3 Premium fixture produces `$635` before travel; Odor fixture uses `$90`; Customer proposal, Admin approval, refreshed views, and intercepted Stripe unit amount are identical to the canonical quote. |
| Rollback condition | Roll back if any approved or Stripe amount differs from a fresh canonical reprice of the persisted structured selections. |

## PDA-02 — No booking/request/quote version or compare-and-swap

| Field | Detail |
|---|---|
| Severity / classification | **Critical — data-integrity defect** |
| Exact reproduction steps | 1. Submit synthetic change request A against booking state N. 2. Apply a different valid mutation, producing logical state N+1. 3. Approve A. 4. Reload the booking from the store. |
| Expected result | Approval returns `409 version_conflict` or requotes A against N+1; the newer mutation remains intact. |
| Actual result | No version is stored or checked. The stale `requestedState.proposedTotal` and associated fields can overwrite newer booking state through a last-write-wins full-object write. Notification persistence can later repeat another stale full write. |
| Affected file | `netlify/lib/customer-change-requests.js:12-50`; `netlify/functions/admin-customer-requests.js:86-216`; `netlify/functions/submit-booking.js:523-568` |
| Affected function | `sanitizeSnapshot`; `createChangeRequest`; Admin `decide`; booking finalization and notification persistence |
| Affected store | `cd1-bookings`; `cd1-customer-change-requests` |
| Root cause | No monotonic `bookingVersion`, immutable `requestVersion`/`quoteVersion`, conditional write, idempotency key, or conflict state. |
| Operational impact | Lost updates, stale approvals, wrong amounts, and nondeterministic Customer/Admin results after refresh. |
| Required fix | Introduce one aggregate revision and immutable quote/request revisions. Require expected-version conditional mutation for every money/service/status write; represent conflict explicitly without mutating state. |
| Deterministic acceptance test | Start two mutations from version N. Exactly one commits N+1; the other returns `409 version_conflict`. Replaying the winning idempotency key returns its original result without a second write. |
| Rollback condition | Roll back if a stale approval or notification write can overwrite a field written by a newer revision. |

## PDA-03 — Customer balance Checkout is not credited

| Field | Detail |
|---|---|
| Severity / classification | **Critical — payment risk; data-integrity defect** |
| Exact reproduction steps | 1. Use a synthetic confirmed/completed booking with an approved positive balance. 2. Intercept the Stripe client while invoking `customer-portal-pay` and confirm Checkout metadata contains `purpose=customer_balance`. 3. Inspect or unit-invoke the pure dispatch logic for a matching synthetic `checkout.session.completed` payload without sending a webhook. 4. Reload the booking. |
| Expected result | One idempotent reconciliation validates booking, currency, exact amount, session ID, and quote version; it credits `amountPaid`, derives zero/new due, records the session, and disables repeat payment. |
| Actual result | The completed-Checkout branch handles only `metadata.type === customer_subscription`. It has no `customer_balance` branch, so the booking ledger remains unchanged. My Garage can display “Payment received” solely from `?paid=1`. |
| Affected file | `netlify/functions/customer-portal-pay.js:71-114`; `netlify/functions/stripe-webhook.js:345-358`; `assets/my-garage.js:1037-1038` |
| Affected function | `customer-portal-pay.handler`; `stripe-webhook.handler` `checkout.session.completed`; My Garage boot/banner logic |
| Affected store | Stripe Checkout Session; `cd1-bookings` |
| Root cause | The Checkout creator emits customer-balance metadata that the webhook never consumes; UI success is driven by a query string rather than verified ledger state. |
| Operational impact | Money can be collected while Admin/Customer continue to show the old balance, allowing confusion and repeat payment. |
| Required fix | Add a canonical idempotent customer-balance reconciliation service and make the UI read its verified state. Store Stripe session/payment references and quote version; never infer success from the return URL alone. |
| Deterministic acceptance test | A synthetic paid customer-balance session reconciles exactly once and atomically updates paid/due/workflow/reference; a duplicate event is a no-op; mismatched amount/currency/version is quarantined without credit. |
| Rollback condition | Roll back if a successful matching payment leaves a positive stale balance, credits a different quote revision, or leaves Pay Balance enabled. |

## PDA-04 — Historical paid/closed records can become payable

| Field | Detail |
|---|---|
| Severity / classification | **Critical — payment risk; confirmed defect** |
| Exact reproduction steps | 1. Project the synthetic legacy record `{status:'Paid', totalPrice:225}` with no modern money fields. 2. Run `computeDue` and `canPayBalance`. 3. Repeat with `{status:'Closed', totalPrice:225}`. |
| Expected result | Both records appear in completed history, have due `$0`, and cannot create/reuse Checkout. |
| Actual result | The Paid fixture normalizes to a paid phase but computes `$225` due and `canPayBalance.ok === true`. `Closed` is accepted by legacy mutation code but is absent from the schema status map, so it can project as Pending Review with `$225` due. |
| Affected file | `netlify/functions/update-booking.js:56-60`; `netlify/lib/ops-schema.js:19-35,87-95`; `netlify/lib/portal-money-sync.js:9-15,67-72`; `netlify/lib/appointment-status-policy.js:53-73`; `netlify/functions/customer-portal-pay.js:50-78` |
| Affected function | Legacy status validation; `normalizeMoney`; `computeDue`; `canPayBalance`; customer pay handler |
| Affected store | Historical records in `cd1-bookings` |
| Root cause | Legacy lifecycle and money adapters disagree; missing paid amount is treated as unpaid total; the paid phase is not a hard payment lock. |
| Operational impact | A historical paid customer can be asked or allowed to pay again; closed jobs can appear active/upcoming. |
| Required fix | Add a compatibility adapter/migration for every legacy status and money shape. Fail payment closed for paid/closed/processing records and derive zero due from verified historical payment indicators. |
| Deterministic acceptance test | Table-driven fixtures for every historic status/field alias; Paid and Closed always render completed, due zero, `canPay=false`, and the pay endpoint returns a stable non-payable response. |
| Rollback condition | Roll back if any paid/closed fixture becomes payable, appears upcoming, or produces a positive due without an explicit unresolved-balance record. |

## PDA-05 — Request and booking writes are non-atomic

| Field | Detail |
|---|---|
| Severity / classification | **High — data-integrity defect** |
| Exact reproduction steps | 1. In a synthetic store, allow request creation then inject failure on booking persistence. 2. Separately, allow Admin decision persistence then inject failure on booking application. 3. Read both stores. |
| Expected result | The operation is all-or-nothing, or the request remains in an explicit retryable `apply_failed` state that is visible to both portals and idempotently recoverable. |
| Actual result | Submission can leave an orphan request while returning failure. Approval marks the request approved before the booking update; it can disappear from the pending list while the booking remains unchanged. |
| Affected file | `netlify/functions/submit-customer-action.js:308-325`; `netlify/functions/admin-customer-requests.js:95-116,212-216`; `admin-ops.html:844-856` |
| Affected function | Customer action submit; Admin request `decide`; Admin optimistic toast/refresh |
| Affected store | `cd1-customer-change-requests`; `cd1-bookings` |
| Root cause | Cross-store ordered writes without a transaction, embedded event, idempotent outbox/saga, or applied-version marker. |
| Operational impact | Customer and Admin disagree; requests vanish from the work queue; retries can create duplicates or apply twice. |
| Required fix | Prefer one booking aggregate with embedded request transition events. If two stores remain, use an idempotent application protocol with `pending_apply`, target version, outbox, and reconciliation. |
| Deterministic acceptance test | Inject failure at every write boundary. No `approved/applied` request may exist without the matching booking version/event; retry converges once with no duplicate. |
| Rollback condition | Roll back if an approved request lacks a matching booking application revision or an orphan request is invisible to operations. |

## PDA-06 — Top-level service fields diverge from `vehicles[]`

| Field | Detail |
|---|---|
| Severity / classification | **High — data-integrity defect** |
| Exact reproduction steps | 1. Start with a booking containing structured `vehicles[]`. 2. Approve a portal package or add-on change. 3. Reload and run canonical repricing or use Admin “Save service.” 4. Compare top-level fields, each vehicle, subtotals, and approved amount. |
| Expected result | One targeted vehicle selection remains structurally and monetarily identical through serialize, reload, and canonical reprice. |
| Actual result | Portal approval patches top-level `package`/`addons`; canonical pricing prefers unchanged `vehicles[]`. The request carries no stable vehicle target, so later canonical mutation can revert, drop, or differently price the approved change. |
| Affected file | `netlify/functions/admin-customer-requests.js:135-175`; `netlify/lib/booking-price-catalog.js:375-431`; `assets/my-garage.js:856-885`; `admin-ops.html:1270`; `netlify/lib/admin-booking-mutations.js:182-237` |
| Affected function | Admin request apply; canonical repricing; Customer request builder; Admin service mutation |
| Affected store | `cd1-bookings`; target/proposal in `cd1-customer-change-requests` |
| Root cause | Duplicate canonical fields, no stable vehicle ID in portal requests, and compatibility fields that are writable rather than derived. |
| Operational impact | A refresh may look correct until a later legitimate mutation silently changes service selections and totals. Multi-vehicle requests are ambiguous. |
| Required fix | Make stable-ID `vehicles[]` the canonical service structure; target each requested delta to a vehicle; derive read-only compatibility fields from that structure. |
| Deterministic acceptance test | Approve a multi-vehicle change, serialize/reload/reprice, and assert identical vehicle IDs, selections, line items, subtotal, travel, approved total, and quote version. |
| Rollback condition | Roll back if canonical reprice changes an already approved selection or amount without an explicit new quote. |

## PDA-07 — Existing add-on can be charged twice while stored once

| Field | Detail |
|---|---|
| Severity / classification | **High — payment risk; confirmed defect** |
| Exact reproduction steps | 1. Use a synthetic booking that already contains Pet Hair Removal, approved total `$310`. 2. Open My Garage; select Pet Hair again. 3. Submit and approve. 4. Inspect structured add-ons and approved total. |
| Expected result | Existing item is preselected/unavailable and resubmission is a no-op or validation error; total remains `$310`. |
| Actual result | My Garage offers the item; request proposes `$405`. Approval deduplicates the stored add-on to one item but applies `$405`. |
| Affected file | `assets/my-garage.js:674-700`; `netlify/functions/submit-customer-action.js:138-165`; `netlify/functions/admin-customer-requests.js:157-166` |
| Affected function | Add-on option rendering; request pricing; Admin add-on merge/application |
| Affected store | `cd1-bookings`; `cd1-customer-change-requests` |
| Root cause | Price calculation adds all selected prices to the existing approved total, while the item merge later deduplicates by ID. |
| Operational impact | Customer can pay twice for one visibly stored service. |
| Required fix | Calculate a canonical structured delta from current selections, reject duplicate IDs, and derive price from the resulting complete quote rather than incrementing a stored total. |
| Deterministic acceptance test | Re-request every existing add-on across vehicle/category fixtures; structured quantity and approved/due values remain unchanged. |
| Rollback condition | Roll back if a duplicate selection changes money without increasing an explicitly supported structured quantity. |

## PDA-08 — Admin Stripe-link generation crashes and accepts a non-authoritative amount

| Field | Detail |
|---|---|
| Severity / classification | **High — confirmed defect; payment risk** |
| Exact reproduction steps | 1. In a normal authorized Admin fixture, open a non-draft booking. 2. Invoke the visible “Generate Stripe link” action with an intercepted Stripe client. 3. Observe the handler before network dispatch. 4. Inspect the submitted amount path. |
| Expected result | Handler reads the fresh versioned booking, derives the authoritative remaining balance, creates one test-mode Checkout Session, and stores its matching version/amount. |
| Actual result | `getBooking` is called but never imported/defined, producing `ReferenceError` before Stripe. The UI/handler also accepts `body.amount`; once the crash is minimally fixed, that value can undercharge, overcharge, or silently redefine approved total. |
| Affected file | `admin-ops.html:1305-1311`; `netlify/functions/admin-ops-jobs.js:393-435`; `netlify/lib/portal-money-sync.js` `applyPayLinkMoney` |
| Affected function | Admin payment action; `handleAdminAction`; `applyPayLinkMoney` |
| Affected store | `cd1-bookings`; Stripe Checkout Session |
| Root cause | Missing booking-read dependency plus payment-link creation conflated with quote amendment through an operator-entered amount. |
| Operational impact | Visible Admin control is nonfunctional; a superficial repair exposes wrong-balance collection risk. |
| Required fix | Use the existing store/repository service for a version-checked fresh read. Remove amount override; quote amendment must be a separate approved/versioned operation. |
| Deterministic acceptance test | Invoke with in-memory store and intercepted Stripe fetch; assert no exception, exact canonical remaining cents, one stored session/version, and rejection of any client amount field. |
| Rollback condition | Roll back if the action throws, accepts an amount override, creates from a stale revision, or persists a link whose amount/version differs from the aggregate. |

## PDA-09 — Approved total, paid amount, due, and old links diverge

| Field | Detail |
|---|---|
| Severity / classification | **High — payment risk; data-integrity defect** |
| Exact reproduction steps | 1. Start with approved `$310`, paid `$50`, stored due `$260`. 2. Use a normal Admin adjustment mutation to approve `$460`. 3. Reload Customer state and invoke Pay Balance with an intercepted Stripe client. 4. Check any previously issued Checkout URL. |
| Expected result | Approved `$460`, paid `$50`, derived due `$410`; all old payment sessions are unusable; Stripe receives `41000`. |
| Actual result | Several mutations update approved/total without synchronizing due or invalidating a session. `computeDue` trusts stored `amountDueApproved`/`balanceDue` before deriving approved minus paid, so the stale `$260` can be displayed and transmitted. Local link fields may be cleared on some paths, but already issued Stripe Sessions are not expired. |
| Affected file | `netlify/lib/portal-money-sync.js:22-72`; `netlify/lib/admin-booking-mutations.js:180-325`; `netlify/functions/admin-ops-jobs.js`; `netlify/functions/tech-complete-job.js`; `netlify/functions/customer-portal-pay.js:50-114`; `netlify/functions/customer-portal-data.js` `safePaymentState` |
| Affected function | `applyApprovedMoney`; `computeDue`; money-changing Admin/Technician handlers; customer pay/data handlers |
| Affected store | `cd1-bookings`; Stripe Checkout Sessions |
| Root cause | Due is persisted as a competing source of truth, money mutations bypass one synchronization service, conflict detection is not enforced, and session invalidation is only local. |
| Operational impact | Undercharge, overcharge, contradictory portal displays, and payment through a stale Checkout URL after an approved quote changes. |
| Required fix | Persist ledger inputs, derive due, route every money mutation through a versioned aggregate service, and expire superseded Stripe sessions. Reject payment whenever monetary invariants conflict. |
| Deterministic acceptance test | Run every money mutation from approved `$310`/paid `$50`, change approved to `$460`, and assert derived due `$410`, old session expiration, no reusable link, and Stripe unit amount `41000`. |
| Rollback condition | Roll back if `approved - paid !== due`, a stale session survives a quote revision, or any payment handler proceeds while a money conflict exists. |

## PDA-10 — Technician feed/actions do not require confirmed eligible work

| Field | Detail |
|---|---|
| Severity / classification | **High — incomplete implementation; authorization design concern** |
| Exact reproduction steps | 1. Assign synthetic jobs in `pending_review`, `cancelled`, `confirmed`, and `completed` states to one authorized Technician. 2. Invoke the Technician list. 3. Attempt a normal status action on each assigned fixture. |
| Expected result | Only assigned, confirmed, operationally eligible work appears; transitions are permitted only from the declared lifecycle state. |
| Actual result | List filtering checks assignment and draft/test/archive flags, not confirmed eligibility. POST verifies assignment and a permitted target status but not the current-state transition, so assigned non-confirmed/cancelled work can be exposed or advanced. Completion has the same missing eligibility guard. |
| Affected file | `netlify/functions/tech-jobs.js:31-89`; `netlify/functions/tech-complete-job.js`; `netlify/lib/tech-security.js:210-215` |
| Affected function | Technician GET/POST handler; completion handler; `bookingAssignedToTech` |
| Affected store | `cd1-bookings`; technician identity/session data |
| Root cause | Assignment is treated as the sole record/action gate; lifecycle transitions are not centralized. Legacy name-based assignment also assumes technician names are unique. |
| Operational impact | Technicians can see or mutate assigned work that is not confirmed or no longer actionable; duplicate names can blur legacy assignment boundaries. |
| Required fix | Centralize an explicit transition matrix and require stable technician ID plus eligible current revision for reads and writes. |
| Deterministic acceptance test | Matrix-test every lifecycle/assignment combination; only assigned confirmed/eligible records are returned, and invalid transitions return a non-mutating conflict/forbidden response. |
| Rollback condition | Roll back if an assigned cancelled/pending/completed record appears as active work or accepts an active-job transition. |

## PDA-11 — Customer lifecycle ignores Technician in-progress status

| Field | Detail |
|---|---|
| Severity / classification | **High — data-integrity defect** |
| Exact reproduction steps | 1. Start with `appointmentStatus:'confirmed'`. 2. Apply the normal Technician transition to `jobStatus:'in_progress'` and corresponding display status. 3. Evaluate Customer `canRequestChange` for a package change. |
| Expected result | In-progress work is structurally locked; Customer sees the current job phase and cannot request package/add-on/date changes that conflict with execution. |
| Actual result | Status classification selects `appointmentStatus` before `jobStatus`; Technician does not clear/change the confirmed appointment value. The synthetic fixture returns `{ok:true, pendingApproval:true, phase:'confirmed'}`. |
| Affected file | `netlify/lib/appointment-status-policy.js:16-23`; `netlify/functions/tech-jobs.js:66-70`; `netlify/functions/submit-customer-action.js` policy use |
| Affected function | `normalizeStatus`; `classifyStatus`; `canRequestChange`; Technician status mutation |
| Affected store | `cd1-bookings` |
| Root cause | Multiple lifecycle fields have an incorrect precedence order instead of one authoritative state machine. |
| Operational impact | Customer can submit structural changes after service has started; Customer/Admin/Technician describe different phases of the same record. |
| Required fix | Introduce one canonical lifecycle state/event model. Compatibility fields must derive from it, and Customer policy must use the effective current job phase. |
| Deterministic acceptance test | For every Technician transition, reload Customer/Admin projections and assert identical effective phase and the exact allowed action set; `in_progress` denies structural changes. |
| Rollback condition | Roll back if a record can be simultaneously classified confirmed and in progress or if an in-progress record accepts a structural Customer request. |

## PDA-12 — Admin can omit submitted requests after the first 200 keys

| Field | Detail |
|---|---|
| Severity / classification | **High — incomplete implementation** |
| Exact reproduction steps | 1. Configure a synthetic request store to list 200 decided records followed by one pending record. 2. Invoke the authorized Admin pending-request GET. 3. Invoke the Customer request list for the pending record. |
| Expected result | The pending record appears in Admin regardless of key position and remains visible to Customer. |
| Actual result | Admin slices the first 200 listed keys before loading/filtering/sorting for pending status, so it returns no pending record. |
| Affected file | `netlify/functions/admin-customer-requests.js:60-75`; related list behavior in customer request endpoints |
| Affected function | Admin request-list handler |
| Affected store | `cd1-customer-change-requests` |
| Root cause | Pre-filter cap, no cursor pagination, and no status/time index. |
| Operational impact | Customer sees a submitted request that Admin cannot process, leaving operational work stranded. |
| Required fix | Iterate cursor pages or maintain a status index; filter pending first, deterministically sort, then cap/paginate the response. |
| Deterministic acceptance test | Put pending records before, at, and after key 200 across multiple pages; Admin returns all in deterministic newest-first order with a cursor. |
| Rollback condition | Roll back if any pending request is excluded solely because of list page/key position. |

## PDA-13 — Retained customer endpoints expose caller-owned drafts

| Field | Detail |
|---|---|
| Severity / classification | **Medium — confirmed defect** |
| Exact reproduction steps | 1. Create one synthetic draft through the normal draft workflow. 2. Using only that fixture's own ID and phone, call retained `lookup-booking` and `customer-bookings`. 3. Compare modern `customer-portal-data`. |
| Expected result | Every non-draft endpoint returns `booking_not_ready` or omits `isDraft:true`; only the scoped draft workflow can read it. |
| Actual result | Modern Customer/Admin/Technician feeds filter drafts, but both retained customer endpoints project the draft as a booking. |
| Affected file | `netlify/functions/lookup-booking.js:27-43`; `netlify/functions/customer-bookings.js:25-45`; correct controls in `customer-portal-data.js:37-41,70-75`, `admin-ops-jobs.js:75`, `tech-jobs.js:31` |
| Affected function | Retained lookup/list handlers and booking projection |
| Affected store | `cd1-bookings` |
| Root cause | Draft visibility is implemented independently in selected endpoints rather than one shared guard. |
| Operational impact | An unsubmitted draft can appear submitted to retained clients/integrations and confuse support or automated workflows. |
| Required fix | Centralize `isVisibleSubmittedBooking` and require it in every Customer/Admin/Technician read outside scoped draft/setup-intent paths. |
| Deterministic acceptance test | Contract-test every read endpoint with finalized, draft, archived, and test fixtures; draft is never returned outside explicitly scoped draft APIs. |
| Rollback condition | Roll back if any draft appears in booking/request/appointment lists or normal lookup responses. |

## PDA-14 — Draft overwrite/finalization does not verify the save token

| Field | Detail |
|---|---|
| Severity / classification | **High — authorization design concern** |
| Exact reproduction steps | Read-only code-path review: trace the normal public draft save and final submission payloads, then verify the server branch for an existing synthetic `draftBookingId`. Do not enumerate IDs or attempt another user's record. |
| Expected result | Any mutation/finalization of an existing draft requires a scoped, constant-time-verified `draftSaveToken` bound to that draft and intended operation. |
| Actual result | `submit-booking` accepts `isDraft:true` plus `draftBookingId` and overwrites the existing draft; final submission also promotes a known draft ID. Neither branch verifies the existing draft's save token. The public final payload sends only the draft ID. |
| Affected file | `netlify/functions/submit-booking.js:462-518`; `index.html:5133-5136`; relevant assertions in current booking-flow tests |
| Affected function | Existing-draft save and finalization branches; public final payload builder |
| Affected store | `cd1-bookings`; draft save-token fields |
| Root cause | Identifier possession is treated as mutation authority despite an existing scoped token model. |
| Operational impact | If a draft ID is disclosed through logs, support, or client state, draft integrity depends on identifier secrecy. This audit did not test exploitation or enumerate identifiers. |
| Required fix | Require the draft save token for overwrite/finalize, bind it to draft ID and operation, rotate/revoke it on finalization, and return indistinguishable failures. |
| Deterministic acceptance test | Synthetic own-draft tests: valid token succeeds; absent/wrong/expired token never mutates; replay after finalization fails; no response reveals record existence. |
| Rollback condition | Roll back if any existing draft can be changed/finalized without a valid scoped token. |

## PDA-15 — Action-link My Garage cannot reliably refresh

| Field | Detail |
|---|---|
| Severity / classification | **Medium — UX defect** |
| Exact reproduction steps | 1. Open a synthetic valid booking action link. 2. Let boot remove the token from the URL. 3. Change the same fixture through an authorized Admin store/handler fixture. 4. Trigger focus/poll or reload. |
| Expected result | A scoped in-memory/session credential refreshes the same booking while the token remains absent from browser history and logs. |
| Actual result | The token is removed and not retained for refresh; the action-link view falls back to limited lookup without ID/phone credentials and can remain stale. |
| Affected file | `assets/my-garage.js:185-207,1043-1054,1079-1102` |
| Affected function | Action-link boot; limited lookup credential builder; reload/poll controller |
| Affected store | `cd1-bookings`; frontend scoped authorization state |
| Root cause | URL token sanitization discards the only credential instead of exchanging or retaining it securely for its scoped TTL. |
| Operational impact | Admin approval may not appear to the Customer until a new authenticated lookup, undermining refresh consistency. |
| Required fix | Exchange action token for a short-lived booking-scoped session or retain it only in memory for its TTL; make refresh failure explicit. |
| Deterministic acceptance test | Action-link fixture observes a server mutation on focus/poll without reintroducing the token into URL, localStorage, or logs. |
| Rollback condition | Roll back if an action-link view cannot refresh current state or persists its raw token in durable browser storage. |

## PDA-16 — Historical projections and lists are not compatibility-safe

| Field | Detail |
|---|---|
| Severity / classification | **Medium — incomplete implementation; data-integrity defect** |
| Exact reproduction steps | 1. Project synthetic historical records with `vehicles:{}`, `addons:{}`, legacy `bookingId`/`customerPhone`, and `status:'Closed'`. 2. Configure more than one Blob list page in shuffled order. 3. Load account history/upcoming. |
| Expected result | All valid historical shapes are adapted safely; malformed fields are quarantined per record; every page is read; upcoming selection is deterministic. |
| Actual result | Projection directly calls `.map` on truthy non-array fields and can throw. `Closed` lacks mapping. Some projection aliases do not match authorization aliases. `listRawBookings` reads one page, and upcoming selects the first unsorted active record. |
| Affected file | `netlify/lib/ops-schema.js:19-35,97-121,177`; `netlify/lib/ops-db.js:35-41`; `netlify/functions/customer-portal-data.js:94-112`; pagination reference `netlify/lib/tech-security.js:55-79`; `netlify/lib/booking-customer-auth.js:63-68` |
| Affected function | `projectBookingForCustomer`; legacy normalization; `listRawBookings`; account/upcoming selection |
| Affected store | Historical `cd1-bookings` |
| Root cause | No explicit historical schema adapter/version; unsafe type assumptions; inconsistent aliases; missing cursor iteration and stable sort. |
| Operational impact | One legacy record can break a view; older pages disappear; the wrong booking becomes the action/payment target after refresh. |
| Required fix | Versioned read adapters, per-record quarantine/telemetry, shared aliases, full pagination, and deterministic ordering. Do not destructively rewrite historical source records in Release A. |
| Deterministic acceptance test | Multi-page shuffled fixtures covering every historical schema version return all readable records, quarantine only invalid entries, and select the same upcoming record on every run. |
| Rollback condition | Roll back if a single malformed historical record produces a whole-response failure or any valid page/record disappears. |

## PDA-17 — Local/preview charge endpoints do not fail closed to Stripe test mode

| Field | Detail |
|---|---|
| Severity / classification | **High — payment risk** |
| Exact reproduction steps | 1. In an isolated handler fixture set a local/deploy-preview context and a synthetic `sk_live_...` value. 2. Intercept all outbound fetches. 3. Invoke Customer balance, Admin link, legacy PaymentIntent/link, capture, and policy-charge entry points. |
| Expected result | Every money-moving/session endpoint returns `stripe_test_mode_required` before any outbound call in local/preview context. Production accepts only its explicitly configured environment. |
| Actual result | Card setup/configuration enforce the test-mode guard, but several charge/session endpoints only check that a secret exists. A live-prefixed secret is therefore not rejected uniformly in non-production contexts. |
| Affected file | `netlify/functions/customer-portal-pay.js`; `netlify/functions/admin-ops-jobs.js`; `netlify/functions/create-payment-intent.js`; `netlify/functions/create-payment-link.js`; capture/policy-charge handlers; compare guarded setup/configuration handlers |
| Affected function | Each Stripe charge/Checkout/PaymentIntent entry point |
| Affected store | Stripe objects; `cd1-bookings`; environment configuration |
| Root cause | Test-mode enforcement is endpoint-local rather than one shared Stripe client/configuration boundary. |
| Operational impact | Misconfigured preview/local environments could initiate live-mode payment objects during testing. No such call was made in this audit. |
| Required fix | One Stripe factory that validates deployment context, key mode, account/currency configuration, and blocks before network dispatch; use it for every endpoint. |
| Deterministic acceptance test | Table-test every endpoint with test/live/malformed keys across local, preview, and production contexts; assert zero intercepted fetches for every disallowed combination. |
| Rollback condition | Roll back if any local/preview money endpoint can reach Stripe with a live key or bypass the shared mode assertion. |

## PDA-18 — No current Pay in Full workflow; dormant route is non-authoritative

| Field | Detail |
|---|---|
| Severity / classification | **Medium — incomplete implementation; payment risk** |
| Exact reproduction steps | 1. Search current Customer UI/callers for Pay in Full and `create-payment-intent`. 2. Use a synthetic booking with catalog total `$285` and approved discounted total `$256.50`. 3. Invoke the dormant handler with intercepted Stripe dispatch. |
| Expected result | Either no callable route exists, or Pay in Full uses the versioned authoritative remaining approved balance (`$256.50`, less any paid amount). |
| Actual result | No visible current Pay in Full control/caller exists. The retained handler recalculates/writes catalog `totalPrice` and would dispatch `28500`, discarding the approved `$256.50` amount. |
| Affected file | `netlify/functions/create-payment-intent.js`; current Customer UI/payment callers |
| Affected function | Legacy PaymentIntent handler; absent current Pay in Full flow |
| Affected store | `cd1-bookings`; Stripe PaymentIntent |
| Root cause | Disconnected legacy payment path predates the approved-amount ledger and canonical balance model. |
| Operational impact | If reconnected or invoked operationally, approved offers/discounts can be lost and the customer overcharged. |
| Required fix | During Release A, disable the dormant route or route it through the same authoritative balance service. Do not add a new UI workflow unless separately authorized. |
| Deterministic acceptance test | No unreferenced legacy path can dispatch money; any retained full-balance handler sends exactly `(approved - paid) * 100` for the expected quote version. |
| Rollback condition | Roll back if any route derives a charge from catalog `totalPrice` when an approved amount exists. |

## PDA-19 — Visible controls include placeholder or note-only workflows

| Field | Detail |
|---|---|
| Severity / classification | **Medium — incomplete implementation; UX defect** |
| Exact reproduction steps | 1. Inspect the authorized Customer/Admin controls for communication preferences, maintenance/manual-review requests, auto-confirm future jobs, refunds, and manual pay link. 2. Trace each click/save to a handler and resulting external action. |
| Expected result | Each control either performs the named operation with verifiable state or is visibly labeled as a request/note/manual follow-up. |
| Actual result | Communication preferences display “coming soon”; several request types only create follow-up notes; auto-confirm configuration lacks a complete booking consumer; refund action logs/manual-instructs rather than refunding Stripe; manual pay link accepts a URL without amount binding. |
| Affected file | `my-garage.html:188-190`; `netlify/functions/customer-portal-data.js:124-130`; `admin-ops.html:190,208,217`; `netlify/functions/admin-ops-jobs.js:379-390,498-510`; request auto-apply policy |
| Affected function | Customer section rendering; Admin settings; refund/manual-link actions; request decision workflow |
| Affected store | `cd1-bookings`; request store; Admin settings/logs; external Stripe state where applicable |
| Root cause | UI labels imply completed automation where the implementation records only an internal note, preference, or external manual task. |
| Operational impact | Operators/customers may assume an external action occurred; support and reconciliation work can be missed. |
| Required fix | Outside Release A, relabel note-only controls, add explicit pending/manual state and audit trail, or implement the promised external action with confirmation. |
| Deterministic acceptance test | Control contract matrix asserts each visible label, server mutation, external side effect (if any), confirmation state, and failure behavior. |
| Rollback condition | Roll back if a control claims completion while only a note/configuration was stored or the external operation remains unverified. |

---

## Validation findings, not application defect IDs

- Targeted portal/operations run: **190 total, 189 passed, 1 failed**. The failure expects old manual-review copy (`Manual review required after approval`) while the UI now says `Needs manual follow-up after approve`.
- Full run: **1,110 total, 1,102 passed, 8 failed**. Several failures are branch/scope guard assertions unrelated to portal behavior. Two SetupIntent failures require `automatic_payment_methods`, while `tests/my-garage-portal.test.js:196-200` explicitly requires card-only and forbids that field; the suite is internally contradictory.
- `tests/portal-admin-customer-e2e.test.js:1-4,48-55` is explicitly simulated. It does not invoke the real handlers/stores and derives price from the secondary portal catalog, so it cannot prove cross-portal or canonical-price parity.
- Missing deterministic coverage includes version conflicts, cross-store partial failure, duplicate existing add-on, Admin request pagination, action-link refresh, historical paid/closed, payment reconciliation, every money mutation invariant, and test-mode enforcement across all money endpoints.
- The browser could not open the local `file://` target under the in-app browser URL policy. That is an evidence limitation, not an application finding. No workaround was attempted.
- No webhook replay was performed or used as evidence.
