# Cross-Portal Parity Matrix

**Baseline:** `fix/my-garage-operational-portal` at `5fa47b99c4d8707dba29b35c6559b3cdba3eb125`  
**Legend:** Pass = same canonical persisted state; Partial = shared data with known divergence; Fail = no enforceable parity.

## State ownership and visibility

| State / event | Public booking | Customer / My Garage | Admin | Technician | Persisted authority today | Parity | Evidence / defect |
|---|---|---|---|---|---|---|---|
| Unsubmitted draft | Creates/updates `isDraft:true` in `cd1-bookings`; client also keeps draft state | Current portal hides drafts; retained lookup endpoints can return them | Modern feeds hide drafts | Hides drafts | Booking Blob plus scoped draft-token fields, but existing-draft mutation does not verify token | **Fail** | PDA-13, PDA-14 |
| Final submission | Finalizes booking and clears draft flags; writes redundant `cd1_bookings` localStorage mirror | Reads server booking, not the local mirror | Reads server booking | Reads server booking if assigned | `cd1-bookings`; local mirror is non-authoritative residue | **Partial** | Final server state is shared, but no aggregate version and finalization authority is incomplete |
| Customer change request | N/A | Creates and lists request | Lists/decides request | N/A | `cd1-customer-change-requests`, with snapshots from `cd1-bookings` | **Fail** | No version; Admin pre-filter cap; non-atomic application (PDA-02, PDA-05, PDA-12) |
| Appointment approval | N/A | Reads updated booking after successful refresh | Applies request/appointment mutations | Sees it only if assignment/lifecycle permits | `cd1-bookings` | **Partial** | Same store, but action-link refresh and write failures can diverge (PDA-05, PDA-15) |
| Package selection | Canonical structured `vehicles[]` and server repricing | Portal request uses top-level package and secondary catalog | Approval patches top-level package; other Admin mutation may target vehicle | Displays assigned job service | Competing top-level fields and `vehicles[]` | **Fail** | PDA-01, PDA-06 |
| Add-on selection | Structured per booking/vehicle inputs | Offers catalog items without excluding existing; proposes additive total | Deduplicates item but trusts proposed money | Displays/uses booking service | Competing top-level `addons` and vehicle data | **Fail** | PDA-06, PDA-07 |
| Quote / approved total | Public submission is server-recalculated | Change proposal is server-produced, but from secondary catalog | Trusts stored proposal; other mutations write money independently | Completion can mutate approved money | Multiple booking money fields plus request snapshot | **Fail** | PDA-01, PDA-02, PDA-09 |
| Remaining balance | Not a public-booking authority | `computeDue` and Pay Balance | Shows/mutates stored money; can generate/manual-link | Completion/adjustment paths can change totals | `approvedFinalAmount`, `amountPaid`, `amountDueApproved`, `balanceDue`, `totalPrice`, link amount | **Fail** | PDA-03, PDA-04, PDA-08, PDA-09 |
| Payment success | SetupIntent stores card for later use | Return URL can claim receipt before verified ledger update | Booking remains stale for Customer balance Checkout | N/A | Stripe plus incomplete `cd1-bookings` ledger | **Fail** | PDA-03, PDA-04 |
| Job assignment | N/A | May display technician info | Assigns technician | Filters by assignment only | `cd1-bookings` assignment fields | **Partial** | Same record, but stable-ID/name and eligibility concerns (PDA-10) |
| Job lifecycle | N/A | Classification prefers appointment status | Reads shared job status | Writes `jobStatus`/display status | Multiple lifecycle fields in `cd1-bookings` | **Fail** | PDA-10, PDA-11 |
| Page refresh | N/A | Server reload for account/lookup; action link can lose refresh credential | Server reload | Manual reload reads shared store | Blob store with no revision/CAS; unsorted/unpaged reads | **Fail** | PDA-02, PDA-05, PDA-12, PDA-15, PDA-16 |
| Historical record | N/A | Projects account history | Admin projection is more per-record tolerant | Assigned historical work may appear active | Mixed unversioned shapes in `cd1-bookings` | **Fail** | PDA-04, PDA-16 |

## Request lifecycle parity

| Transition | Customer expected view | Admin expected view | Current implementation | Required invariant |
|---|---|---|---|---|
| `draft -> submitted booking` | Draft disappears; submitted request/booking appears once | New pending booking appears once | Modern feeds generally separate them; retained APIs expose draft and finalization lacks token verification | Finalization is token-authorized, idempotent, and atomically creates version 1 of a submitted booking |
| `booking N -> request pending` | Pending request with immutable requested changes and base version N | Same request/version visible in queue | Snapshot lacks base/request/quote version; Admin can omit beyond first 200; request creation can orphan | Request includes `requestVersion`, `baseBookingVersion`, `quoteVersion`, structured delta, and status |
| `pending -> approved/applied` | Approved request and booking version N+1 appear together | Decision references exactly the applied booking version | Request is marked approved before booking write; stored proposal is trusted | Decision and booking event commit atomically or remain explicitly retryable; stale base returns conflict |
| `pending -> rejected` | Rejected with reason and unchanged booking version | Same decision/reason | Generally same request record after refresh | Decision is idempotent and records actor/time/version without changing booking |
| `approval -> refresh` | Current aggregate and matching request/event | Same aggregate and matching request/event | Normal lookup works after successful writes; action-link may remain stale | Every portal receives one projection of the same aggregate revision; stale clients know their version is old |

## Monetary parity matrix

| Invariant | Public booking | Customer | Admin | Stripe | Current verdict |
|---|---|---|---|---|---|
| One catalog and structured quote inputs | Canonical booking catalog | Secondary portal catalog | Trusts request proposal or operator input on some paths | Receives downstream cents | **Fail** |
| `approved = canonical quote + approved adjustments/offers` | Initial submit recalculates | Displays stored approved | Multiple write paths | Not a pricing authority | **Fail** |
| `remaining = max(approved - settled - credits, 0)` | N/A | Trusts stored due before deriving | Can leave due stale | Session amount mirrors supplied due | **Fail** |
| Payment object bound to `bookingVersion` + `quoteVersion` | N/A | No binding | No binding | Metadata lacks an enforced revision contract | **Fail** |
| Superseded session cannot be paid | N/A | Local link may be cleared | Old Stripe Session not expired | Old URL can remain usable | **Fail** |
| Successful balance payment credits ledger once | N/A | UI can trust `?paid=1` | Booking remains unpaid | Balance metadata not handled by completed-session branch | **Fail** |
| Test/preview uses only test mode | Setup/card path has guard | Balance path lacks uniform guard | Link path lacks uniform guard | Depends on configured secret | **Fail** |

## Control/workflow truthfulness

| Visible control | What it actually does | Classification | Release A disposition |
|---|---|---|---|
| Customer communication preferences | Displays “coming soon” / section unavailable | UX defect; incomplete implementation | Excluded; label remains explicitly nonfunctional |
| Customer maintenance/manual-review request | Creates a request for manual follow-up rather than a fully automated service change | Incomplete implementation | Excluded; do not expand in Release A |
| Admin auto-confirm future jobs | Persists configuration, but the audited booking path does not show complete enforcement | Incomplete implementation | Excluded |
| Admin refund | Records/logs manual Stripe follow-up; does not prove external refund | UX defect; incomplete implementation | Excluded |
| Admin manual Stripe link | Stores an arbitrary HTTP URL without authoritative amount binding | Payment risk | Release A must prevent it from being represented as authoritative payment state |
| Admin Generate Stripe link | Visible action reaches an undefined `getBooking` call | Confirmed defect; payment risk | Included only as part of authoritative Stripe amount consistency |

## Release A parity target

Release A reaches parity only when all of the following are true:

1. Every portal reads a projection containing the same `bookingVersion`.
2. Every request identifies `baseBookingVersion`, `requestVersion`, structured target/delta, and `quoteVersion`.
3. Admin approval either creates exactly one next booking version or returns a conflict without mutation.
4. One canonical quote service produces displayed, approved, due, and Stripe amounts.
5. Payment sessions are bound to the applicable revisions, superseded sessions are expired, and success reconciles exactly once.
6. Refresh returns a deterministic projection, including historical adapters, regardless of Blob page/order.
7. Drafts are visible only through scoped draft workflows and become submitted bookings only through token-authorized idempotent finalization.
