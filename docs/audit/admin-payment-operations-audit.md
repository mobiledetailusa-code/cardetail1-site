# Admin Operations and Payment Exceptions — Audit and Controlled Repair

**Scope:** cash payment confirmation and receipt, payment-method change, reopen job, price
adjustment, completed-job review, 48-hour service-issue window, Admin/My Garage
synchronisation, email synchronisation, financial and ledger safety.

**Base:** `origin/master` at `142d0b4` (branch identical to master at audit start).

**Execution environment:** Linux container with the repository only. No Netlify
deploy, no staging Admin session, no `DATABASE_URL`, no Stripe keys, no Twilio
credentials, no Resend key. No credential of any kind was requested, issued or
used. No Stripe object was created or read. No production or staging system was
contacted. Verification is therefore deterministic (unit/integration) rather than
live-staging — see [Not executed](#not-executed).

---

## Phase 1 — Execution-path map

| Action | UI control | Handler | Endpoint | Server authorization | Persistence authority | Status transition | Notification | Failure at audit | Root cause |
|---|---|---|---|---|---|---|---|---|---|
| Mark payment as cash | `#dMarkCash` "Mark cash received" (`admin-ops.html`) | `jobAction(id,'mark_cash_received',{})` | `admin-ops-jobs` → `adminMarkCashReceived` | `verifyAdminKey` (HMAC bearer in `x-admin-key`) | Postgres `LedgerEntry` when `DATABASE_URL` set, else Blob `ledger.entries` via `persistMutation` CAS | `paymentStatus=paid_cash`, **and** `jobStatus=completed_paid`, `serviceStatus=closed` | **none** | No customer email ever sent | `booking-transactional-notifications.js` implemented only three events (`request_received`, `confirmed`, `customer_action_required`). No payment event existed in the module, so nothing could emit one. |
| Change payment method | `#dSavePref` select + button | `jobAction(id,'update_payment_preference',{…})` | `admin-ops-jobs` action `update_payment_preference` | `verifyAdminKey` | `store.setJSON` — **unconditional** | none | none | Silent lost update; no rules; allowed on fully-paid bookings | Handler wrote the raw record with no CAS, no `expectedBookingVersion`, no reason, no audit entry, and no reference to the ledger. A method change on a settled booking was indistinguishable from one on an unpaid booking. |
| Reopen job (list row + `#dReopen`) | "Reopen" | `jobAction(id,'reopen_job',{reason})` | `admin-ops-jobs` action `reopen_job` | `verifyAdminKey` | `store.setJSON` — **unconditional**, `bookingVersion` not incremented | sets `jobStatus='reopened'` only; `serviceStatus` left at `closed` | none | Reopen appeared to work then reverted; neither portal refreshed | Three compounding causes — see [Reopen root cause](#reopen-root-cause). |
| Reopen appointment (`#dReopenAppt`) | "Reopen" | `jobAction(id,'reopen_appointment',{reason})` | `admin-ops-jobs` action `reopen_appointment` | `verifyAdminKey` | `persistMutation` CAS (correct) | set `serviceStatus='in_progress'` → **`syncLegacyFields` rewrote `jobStatus` back to `in_progress`** | none | Job never showed as reopened | `reopened` was absent from `SERVICE_STATUSES` and `SERVICE_TO_LEGACY_JOB`, so the derived `jobStatus` overwrote the explicit one. |
| Close / complete job | `#dApprove` "Approve completion" | `jobAction(id,'approve_completion')` | `admin-ops-jobs` action `approve_completion` | `verifyAdminKey` | `store.setJSON` — **unconditional** | `jobStatus=completed_pending_payment` | `emitCustomerActionRequired` (idempotent) | **`completedAt` never written** | Only `tech-complete-job.js` ever wrote `completedAt`. An Admin-completed job had no completion anchor, so review and issue eligibility could never open. |
| Change approved price | `#dFinalAmt` + Approve adjustment | `jobAction(id,'set_approved_final_amount',{…})` | `admin-ops-jobs` | `verifyAdminKey` | `persistMutation` money path (CAS, re-derives ledger, bumps `quoteVersion`) | none | none | Approved total was directly overwritable after settlement | `setApprovedFinalAmount` took a bare number with no reason, no approval and no record. Nothing consulted `settledCents`. |
| Add a supplemental charge | — | — | — | — | — | — | — | **did not exist** | No concept of an adjustment that creates a *new* balance against an already-settled booking. |
| Reduce a total | same as "change approved price" | — | — | — | `persistMutation` | — | — | Reduced `approvedCents` below `settledCents`; `remainingCents` clamps to 0; the overpayment silently disappeared | `remainingCents = max(approved − settled − credited, 0)` is correct arithmetic, but nothing raised the resulting credit owed to the customer. |
| Create receipt | `receipt.html` / `customer-receipt` | — | `customer-receipt` | `authorizeBookingAccess` (session or bookingId+phone) — **sound** | read-only projection | n/a | n/a | **A cash payment printed as "Card"** | `settledPayments()` read `entry.method === 'cash' ? 'Cash' : 'Card'`, but neither settling path wrote `method`. The Blob path wrote only `actor`; the Postgres path wrote `providerObjectId: 'cash'`. |
| Send payment confirmation | — | — | — | — | — | — | — | **did not exist** | As above. |
| Expose review action | — (no control in My Garage) | — | `submit-review` | **bookingId + phone only**, no rate limit, no CSRF | `store.setJSON` — unconditional | writes `reviewLeft` | none | No way for a customer to reach it; endpoint accepted reviews on incomplete bookings and unlimited duplicates | The endpoint predates the portal; `reviewLeft` was written but never read as a gate. |
| Expose service-issue action | `#btn-report-issue` "Report Issue" | `submitPortalAction('report_issue',…)` | `customer-portal-action` | token or `authorizeBookingAccess` | `store.setJSON` — unconditional | **`serviceStatus='disputed'` → `jobStatus='issue_reported'`** | none | Hidden once a job reached `completed_paid`; no time window; reporting an issue erased the completion/payment record | Button visibility keyed on `jobStatus` in a list that excludes `completed_paid`. No window concept existed anywhere in the codebase. |

### Reopen root cause

Precisely three, all independently sufficient:

1. **Enum clobber.** `syncLegacyFields()` derives `jobStatus` from `serviceStatus`
   through `SERVICE_TO_LEGACY_JOB`. `reopened` was a legal `jobStatus` (in
   `ops-schema.js`) but not a legal `serviceStatus`, and had no entry in the
   forward map. Any write that set `serviceStatus: 'in_progress'` alongside
   `jobStatus: 'reopened'` had the `jobStatus` silently replaced by `in_progress`.
   `ALLOWED_SERVICE_TRANSITIONS.closed` was `['reopen']` — a string that is not a
   status, so the transition could never validate either.
2. **No conditional write.** The action the Reopen buttons actually called
   (`reopen_job`) used `store.setJSON` directly. A concurrent Admin or webhook
   write silently discarded the reopen.
3. **No version increment.** Because it bypassed `persistMutation`/`buildNextAggregate`,
   `bookingVersion` did not move. Admin and My Garage both key refresh and CAS off
   that version, so neither portal learned anything had changed, and a later CAS
   write holding the pre-reopen version still succeeded and reverted it.

No authorization, endpoint-routing or persistence-adapter fault was involved.

---

## Phase 2 — State-model verdict

### `STATE_MODEL_REFACTOR_REQUIRED`

The current model couples dimensions that must move independently:

| Coupling | Evidence |
|---|---|
| Payment settlement writes operational status | `markCashReceived()` and `applyCashOperationalClose()` both set `jobStatus='completed_paid'`, `serviceStatus='closed'` as part of recording money. |
| Operational status derives payment status | `SERVICE_TO_LEGACY_JOB.closed = 'completed_paid'` — the operational vocabulary has payment baked into its terms. |
| Customer resolution has no field | `customerApprovalStatus.disputed` doubled as "issue submitted". Review state lived in two ad-hoc booleans (`reviewLeft`, `reviewId`). |
| Reopen had no state | Covered above. |

What is **already correct** and must be preserved: `financialProjection()` derives
`remainingCents` from the ledger identity `approved − settled − credited`, and
`persistMutation` re-derives every compatibility money field from it. That is the
right authority and none of this work changes it.

### What was refactored, and what was deliberately gated

**Done (additive, adapts existing enums — no competing model introduced):**

- `reopened` added to `SERVICE_STATUSES` and to both legacy maps, with real
  transitions. `closed → reopened` now validates.
- New `customerResolutionStatus` dimension: `none | review_available |
  issue_window_open | issue_submitted | closed`. Derived, not stored — nothing
  else owned this vocabulary, so there is nothing to compete with.
- Reporting a service issue no longer writes `serviceStatus`.

**Gated — NOT performed, and requires an explicit owner decision:**

Decoupling cash settlement from the operational close. `markCashReceived` /
`applyCashOperationalClose` still set `jobStatus='completed_paid'` and
`serviceStatus='closed'`. Undoing that is a genuine state-model refactor with
blast radius across `blobNeedsCashClose`, `TERMINAL_JOB_STATUSES` in the customer
portal, the Admin board's status filters and roughly 16 existing assertions that
encode the coupling as a contract. Phase 2 says to declare the verdict before
implementing, so it is declared and left alone.

**Direct consequence: partial cash payments are still refused.** A part-payment
cannot run an operational close, so it cannot use the existing path; the server
returns `cash_amount_mismatch` with the authoritative `expectedAmountCents`, and
the Admin control now states the required full amount up front. Smoke items A2–A5
are therefore **not delivered**. The design is straightforward once the refactor
is approved: credit the ledger for the partial amount, let `financialProjection`
report `due`, and leave `jobStatus`/`serviceStatus` untouched.

---

## Financial model implemented

```text
approvedCents  = current canonical quote + applied adjustments
settledCents   = Σ verified settlement entries        (never edited, only appended)
creditedCents  = Σ verified refund/credit entries
remainingCents = max(approvedCents − settledCents − creditedCents, 0)
```

Price changes are records, not edits (`netlify/lib/price-adjustments.js`):

| Ledger position | Increase | Decrease |
|---|---|---|
| nothing settled | revises the approved total | revises the approved total |
| partly settled | revises approved; remaining stays derived | revises approved; remaining stays derived |
| fully settled | `supplemental_balance_due` — a **new** balance to collect | `refund_or_credit_review` — queued for the refund authority, **no automatic refund** |

In every case the original settlement entry is untouched: `applyAdjustment`
never returns a `ledger` patch.

## Ledger invariants (asserted by tests)

1. `remainingCents` is always derived, never stored as an independent authority.
2. Reopen produces no ledger delta — the action is absent from
   `MONEY_MUTATION_ACTIONS`, so `persistMutation` copies `ledger`,
   `paymentAttempts` and receipts forward untouched.
3. A payment-method change or correction never emits a `ledger` patch.
4. An adjustment never emits a `ledger` patch; only the approved total moves.
5. Re-applying an adjustment is a no-op, not a second price change.
6. A decrease cannot exceed the approved total.

## Stripe invariants (asserted by tests)

1. Cash settlement creates and confirms no PaymentIntent and touches no Checkout
   Session. No Stripe call exists on the cash path.
2. Cash never marks an unrelated Stripe intent succeeded.
3. Reopen leaves `paymentAttempts` byte-identical, so no settled Stripe object is
   reopened.
4. A cash receipt contains no Stripe vocabulary (asserted against the whole
   serialised receipt).

---

## Release boundaries

**Release A — operational and payment repair**

| File | Change |
|---|---|
| `netlify/lib/booking-transactional-notifications.js` | `booking.payment_received` event: settlement-keyed idempotency, required-figure email, email-only channel, transient context stripped on every return path |
| `netlify/lib/payment-method-policy.js` *(new)* | ledger-derived change scope, paid-in-full lock, evidence-backed correction path |
| `netlify/lib/price-adjustments.js` *(new)* | adjustment records, three-position outcome model, direct-total guard, customer statement |
| `netlify/lib/receipt-projection.js` | cash recognised from all three markers, mixed-method label, `receiptId`, `paymentDate`, `balanceStatus`, `paidInFull`, required footer |
| `netlify/lib/admin-booking-mutations.js` | reopen: reason required, transition guard, `reopened` status, completion anchor preserved, reopen history; write-once `completedAt` on tech completion |
| `netlify/lib/operations-lifecycle.js` | `reopened` as a first-class service status with real transitions; `canReopenService` |
| `netlify/functions/admin-ops-jobs.js` | both reopen actions unified onto the versioned audited path; payment-method rules; `correct_payment_method`; `price_adjustment`; direct-total guard; cash confirmation email; `completedAt` on approve_completion (now CAS); `operationalControls` capability projection; `method` on cash ledger entries |
| `admin-ops.html` | capability-driven controls; cash amount + confirmation; reason-required reopen; payment-method and price-adjustment sections; duplicate preference control removed |

**Release B — post-service experience**

| File | Change |
|---|---|
| `netlify/lib/post-service-experience.js` *(new)* | completion anchor, review eligibility, 48-hour window on server time, `customerResolutionStatus` |
| `netlify/lib/service-issue-notifications.js` *(new)* | Admin alert, best-effort, provider body never echoed |
| `netlify/functions/submit-review.js` | `authorizeBookingAccess`, rate limit, completion + one-per-booking gate, CAS write, re-check under write authority |
| `netlify/functions/customer-portal-action.js` | structured issue with category and description, 48-hour server-time gate, CAS write, Admin notification, operational status no longer overwritten |
| `netlify/functions/customer-portal-data.js` | `postService`, `postServiceByBooking`, `priceAdjustments` projections |
| `my-garage.html` / `assets/my-garage.js` | "Leave a review" and "Report a service issue" rendered from server state, with the remaining-hours note |

Release A does not depend on Release B and can ship first.

---

## Security findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `submit-review` authorized on bookingId + phone with no rate limit — a guessable pair could post attributable public content | High | **Fixed** — `authorizeBookingAccess` + `enforcePublicRateLimit` |
| 2 | `report_issue`, `approve_completion`, `update_payment_preference`, `reopen_job`, `approve_completion` all wrote via unconditional `setJSON` — lost updates under concurrency | High | **Fixed** for every path in this scope (CAS + expected version) |
| 3 | No `expectedBookingVersion` on payment-method or reopen mutations | Medium | **Fixed** — required for method change/correction, honoured for reopen |
| 4 | Admin mutations have no Origin check, no CSRF token and no JSON content-type enforcement | Low | **Open, low risk.** The credential is a custom `x-admin-key` header, not a cookie, so a cross-site page cannot attach it — CSRF is structurally not reachable. Recommend adding an Origin allowlist as defence in depth. |
| 5 | Provider error bodies could reach the client | Medium | **Fixed in new code** — `service-issue-notifications` records `provider_<status>` only, never the body |
| 6 | `ADMIN_SESSION_SECRET` falls back to `BID_SECRET`/`ADMIN_DASH_PASSWORD` outside production | Low | **Open by design** (production requires the dedicated 32+ char secret) |
| 7 | Admin session TTL is 8h with no server-side revocation for v1 stateless tokens | Medium | **Open** — `destroyAdminSession` is a no-op for `v1.` tokens, so a leaked token stays valid until expiry. Rotating `ADMIN_SESSION_SECRET` is the only revocation. |

---

## Temporary credential inventory

**Empty.** No temporary credential of any type was requested, issued, stored or
used during this work: no staging Admin session, no Netlify PAT, no Stripe key,
no webhook secret, no Twilio credential, no database URL. Nothing was written to
a tracked file. There is consequently nothing from this task to revoke.

## Credential-rotation checklist

Nothing here is required *because of* this work — this is the standing checklist to
run **after** staging verification and before production release, and only then.

| Item | Action | When |
|---|---|---|
| Admin password (`ADMIN_DASH_PASSWORD`) | Rotate if any staging Admin access was granted to a third party during verification | After staging sign-off |
| `ADMIN_SESSION_SECRET` | Rotate to invalidate all outstanding v1 admin sessions (finding 7 — this is the only revocation mechanism) | After staging sign-off |
| Admin sessions | Invalidated implicitly by the above; no separate step | With the secret rotation |
| Netlify PAT (`NETLIFY_AUTH_TOKEN`) | Revoke any PAT minted for verification | Immediately after verification |
| Stripe keys | **No rotation required** — no Stripe key was used and no Stripe object was touched | n/a |
| Stripe webhook secret | **No rotation required** — no webhook was replayed | n/a |
| Twilio credentials | **No rotation required** — the payment event is email-only and no SMS was sent | n/a |
| `RESEND_API_KEY` | Rotate only if a shared key was exposed during verification | After staging sign-off |

Do not rotate anything before staging verification completes.

---

## Not executed

These parts of the brief could not be run here and are **not** claimed:

- **Phase 11 staging smoke matrix.** No deployed environment, Admin session or
  fixtures. Items A–H were converted to deterministic unit/integration tests
  wherever the behaviour is decidable without a live system; items requiring a
  real Stripe object, a real Postgres authority or a live email round-trip were
  not run.
- **A2–A5, A6–A9 (partial cash).** Blocked by the gated state-model refactor.
- **Postgres-authority cash path.** Cannot execute without `DATABASE_URL`. The
  Postgres path keeps its existing DB-level idempotency (unique `providerEventId`)
  and now emits the same confirmation email; neither was exercised live.
- **Live email delivery.** No `RESEND_API_KEY`. Content, idempotency keys,
  channel selection and failure isolation are asserted; actual delivery is not.
