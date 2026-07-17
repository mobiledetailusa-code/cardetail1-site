# Cursor Command — CARDDETAIL1 Release A

Use the prompt below only after reviewing the audit. It authorizes a future implementation task; this audit did not execute it.

```text
CARDDETAIL1 — IMPLEMENT RELEASE A ONLY

Repository baseline:
- expected implementation branch: fix/release-a-canonical-aggregate
- committed baseline before Release A code: 22d4c02712fff167a58149bc14e7627996e133dc
- original audited application HEAD (evidence preserved): 5fa47b99c4d8707dba29b35c6559b3cdba3eb125
- see docs/audit/release-a-ship-baseline.md

This is an authorized defensive implementation on my own application. Use only repository inspection, existing tests, synthetic local/preview fixtures, normal authorized workflows, browser console/network inspection, and Stripe test mode.

Do not access real customer records.
Do not enumerate booking, customer, job, or draft identifiers.
Do not attempt authentication bypass or exploit techniques.
Do not replay webhooks.
Do not manipulate production data.
Do not use a live Stripe key or create a live payment object.
Do not deploy, merge, push, or commit unless I separately ask.

First:
1. Print current branch, HEAD, upstream divergence, and git status.
2. If HEAD differs from the audited SHA, inspect the delta and state whether each audit finding still applies before editing. Do not discard unrelated/user changes.
3. Read all of:
   - docs/audit/portal-executive-summary.md
   - docs/audit/portal-defect-register.md
   - docs/audit/cross-portal-parity-matrix.md
   - docs/audit/authoritative-state-model.md
   - docs/audit/payment-and-invoice-model.md
   - docs/audit/implementation-roadmap.md
4. Add failing characterization tests for every Release A finding before changing behavior.

RELEASE A SCOPE — IMPLEMENT ONLY:
- draft/request/appointment separation
- shared source of truth
- Customer/Admin synchronization
- request and quote versioning
- authoritative server totals
- Stripe amount consistency
- refresh consistency
- historical-read compatibility

EXPLICITLY OUT OF SCOPE:
- Technician workflow/UX redesign
- communication-preference implementation
- automated refunds
- auto-confirm feature completion
- maintenance/manual-review automation
- unrelated visual, marketing, pricing, or booking-funnel work
- any Releases B–E

Required architecture:

1. Make one submitted booking aggregate in cd1-bookings the authoritative post-submit state.
   - Add schemaVersion and monotonic bookingVersion.
   - Preserve unrelated and Technician fields on every write.
   - Make service.vehicles[] with stable vehicleId the canonical service structure.
   - Make top-level package/addons/money fields derived compatibility projections, never independent write authorities.
   - Add one repository/command boundary with expected-version conditional writes. A read-then-unconditional-set is not acceptable conflict protection.

2. Separate draft, submitted request, and confirmed appointment.
   - A draft is not returned by any normal Customer/Admin/Technician booking endpoint.
   - Existing-draft read/write/finalize requires its scoped draftSaveToken, not draft ID possession.
   - Finalization is idempotent, closes/links the draft, and creates exactly one versioned pending-review submitted booking.
   - Centralize record visibility instead of duplicating isDraft checks.

3. Add immutable request and quote versioning.
   - Every request has requestVersion, baseBookingVersion, quoteVersion, target, structured delta, and status.
   - Every quote has quoteVersion, basedOnBookingVersion, catalogVersion/input identity, integer-cent line items, and approved total.
   - Admin decision rejects stale versions with 409 version_conflict or requotes and requires an explicit decision on the new quote.
   - Request applied status and next booking version commit atomically. A secondary request store/index may be rebuildable only; it cannot be authority.
   - Pending request listing must paginate/index before filtering and sort deterministically; never cap the first 200 keys before finding pending work.

4. Use one canonical server quote service.
   - Route initial submit, Customer package/add-on request, Admin approval, retained Admin service/money paths used by Release A, and payment preparation through it.
   - Ignore/reject all client/operator totals.
   - Remove customer-catalog fixed prices as an approvable authority.
   - Target changes by stable vehicleId.
   - Duplicate existing add-on is a no-op/rejection and cannot change money.
   - Do not expose add-on removal until its structured end-to-end handler exists.

5. Implement authoritative Customer/Admin projections and refresh.
   - Both return/render bookingVersion, quoteVersion, request versions/status, canonical service, lifecycle, approvedCents, settledCents, and derived remainingCents.
   - Do not merge stale local booking mirrors into portal state.
   - Fix action-link refresh by exchanging the raw token for a short-lived scoped session or retaining it only in memory; never persist raw token in URL history/localStorage/logs.
   - Iterate every Blob list page, adapt records independently, quarantine malformed entries per record, sort deterministically, and define stable upcoming selection.

6. Implement one authoritative payment service.
   - Persist integer-cent approved/settled/credited ledger inputs; derive remainingCents = max(approved - settled - credited, 0).
   - Reject payment on any money conflict and for paid/closed/processing/non-payable state.
   - Customer and Admin payment creation derive the same current remainingCents; reject any submitted amount override.
   - Bind each Stripe attempt/session to bookingVersion, quoteVersion, currency, and exact cents with idempotency.
   - Expire provider-side old open Sessions when a quote is superseded.
   - Reconcile customer_balance Checkout completion exactly once into the full ledger/attempt record. Do this through a pure, directly testable reconciliation function; do not test by replaying a webhook.
   - Drive Customer payment success from verified aggregate state, never ?paid=1 alone.
   - Fix Admin Generate Stripe link by routing it through this service; do not make an import-only getBooking patch.
   - Disable dormant non-authoritative PaymentIntent/payment-link routes or route them through the same service. Do not add a new Pay in Full UI.
   - Centralize Stripe mode validation. Local/preview contexts must reject a live-prefixed key before any network call for every SetupIntent, Checkout, PaymentIntent, capture, policy-charge, and refund entry point.

7. Add non-destructive historical-read compatibility.
   - Treat missing schemaVersion as legacy version 0.
   - Normalize shared ID/phone/status/money aliases once.
   - Guard vehicles/addons with Array.isArray and prevent one malformed record from failing a whole response.
   - Map legacy Paid and Closed to completed history with zero payable balance unless an explicit reviewed debt record exists.
   - Read all pages and sort deterministically.
   - Do not bulk rewrite historical production records.

Required deterministic tests:
- every normal read endpoint excludes drafts; scoped draft token valid/invalid/expired/replayed cases
- idempotent draft finalization
- two concurrent commands from version N: exactly one N+1 and one 409, with no lost unrelated fields
- cross-store/index failure injection: no approved request without matching applied booking version
- canonical category/tier/ZIP/package/add-on matrix, including SUV3 Premium $635 and Odor $90 at the audited catalog baseline
- duplicate existing add-on leaves structure and total unchanged
- pending request beyond key/page 200 is visible and ordered
- Customer/Admin hard refresh returns identical material projection at the same versions
- action-link focus/poll refresh without durable raw-token storage
- multi-page shuffled historical fixtures, malformed arrays, aliases, Paid, and Closed
- approved $310/paid $50 then approved changes to $460: remaining $410, old $260 Session expired, new Stripe amount 41000
- approved discounted $256.50 never sends catalog $285/28500
- customer_balance completion updates ledger once; duplicate is no-op; amount/currency/version mismatch is quarantined
- every local/preview payment endpoint with a live key makes zero network calls and returns stripe_test_mode_required

Verification:
1. Run targeted Release A tests with the repository's bundled/runtime Node.
2. Run the complete test suite.
3. Resolve stale/contradictory tests intentionally; do not weaken assertions or exclude failures.
4. Use only synthetic authorized browser fixtures in a local/preview HTTP origin. Capture console and network evidence for Customer/Admin hard refresh and test-mode Checkout return.
5. Confirm git diff contains only Release A implementation, tests, and directly necessary documentation.

Rollback gates:
- lost update or bypassed version conflict
- Customer/Admin mismatch for the same bookingVersion
- canonical repricing changes an already approved quote without a new quoteVersion
- Stripe cents differ from canonical remainingCents
- old Session remains payable after quote change
- missing or duplicate settlement credit
- paid/closed historical record is payable
- malformed historical record breaks a whole response
- draft appears in a normal portal feed
- local/preview endpoint reaches Stripe with a live key

Final report format:
1. Branch and final HEAD.
2. Files changed.
3. Findings closed, mapped to PDA IDs.
4. Tests run with exact pass/fail counts.
5. Browser/Stripe-test evidence obtained and any evidence gaps.
6. Remaining Release A blockers, exactly one primary blocker if any.
7. Confirm no out-of-scope feature, real-customer access, webhook replay, live payment, commit, push, deploy, or merge occurred.

End with exactly one:
READY FOR RELEASE A REVIEW
or
RELEASE A BLOCKED — <one precise reason>
```
