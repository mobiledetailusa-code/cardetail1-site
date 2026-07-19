# Implementation Roadmap — Release A Only

**Handoff baseline:** `fix/my-garage-operational-portal` at `5fa47b99c4d8707dba29b35c6559b3cdba3eb125`  
**Current production readiness:** blocked  
**Cursor implementation readiness:** ready  
**Single blocker to remove:** no single versioned canonical booking/quote aggregate exists.

No Releases B–E are defined here. Items outside the explicit Release A boundary are listed only as exclusions so they are not accidentally implemented.

## Scope guard

Release A includes only:

- draft/request/appointment separation;
- shared source of truth;
- Customer/Admin synchronization;
- request and quote versioning;
- authoritative server totals;
- Stripe amount consistency;
- refresh consistency; and
- historical-read compatibility.

Release A must not add or redesign Technician workflows, communications preferences, automated refunds, auto-confirm policy, marketing/UX enhancements, or other unrelated controls. It may preserve Technician fields and prevent Release A writes from corrupting them.

## Delivery order

| Order | Workstream | Outcome | Findings closed |
|---:|---|---|---|
| 0 | Characterization and safety gates | Current behavior and historic shapes captured without changing state | Validation gaps |
| 1 | Canonical aggregate and compatibility adapter | One versioned booking source with non-destructive old-record reads | PDA-02, PDA-06, PDA-16 |
| 2 | Draft/request/appointment separation | Drafts are scoped; submitted requests and confirmed appointments are distinct | PDA-13, PDA-14 |
| 3 | Canonical quote and request application | All service/money changes use structured inputs, canonical quote, and version conflicts | PDA-01, PDA-05, PDA-06, PDA-07, PDA-12 |
| 4 | Customer/Admin refresh parity | Same revision and deterministic records after refresh | PDA-02, PDA-05, PDA-12, PDA-15, PDA-16 |
| 5 | Authoritative Stripe balance and reconciliation | Exact remaining cents, version-bound sessions, idempotent settlement, uniform test mode | PDA-03, PDA-04, PDA-08, PDA-09, PDA-17, PDA-18 |
| 6 | Full deterministic verification and guarded rollout | Release gates prove all required invariants and rollback signals | All Release A findings |

## Workstream 0 — Characterization and safety gates

1. Preserve the baseline SHA and add failing characterization tests before behavioral edits.
2. Replace simulated parity assertions with handler/store fixtures using synthetic records only.
3. Resolve the contradictory SetupIntent expectations: choose the existing card-only contract deliberately, update stale tests, and keep the decision explicit.
4. Repair stale copy/scope guard assertions without broadening the product scope.
5. Add an intercepted Stripe client for every payment test; assert no real network dispatch.
6. Inventory actual historical shapes from repository fixtures/documented schemas only. Do not read or mutate real customer records as part of implementation validation.

Gate to continue: the new tests reproduce each Release A defect on the baseline and cannot touch production or a live Stripe key.

## Workstream 1 — Canonical aggregate and compatibility adapter

1. Add `schemaVersion`, monotonic `bookingVersion`, canonical lifecycle, canonical `service.vehicles[]`, immutable current quote, ledger inputs, embedded request transitions, payment attempts, and events to the submitted booking aggregate.
2. Make top-level `package`, `addons`, `totalPrice`, `amountDueApproved`, and `balanceDue` derived compatibility outputs. Remove them as independent mutation inputs.
3. Build one repository/command service that performs expected-version writes. If the storage adapter cannot provide conditional writes, introduce an equivalent serialized/idempotent mechanism; do not use read-then-unconditional-set as conflict protection.
4. Build read adapters for schema version 0/current records, including safe arrays, aliases, `Paid`, and `Closed`.
5. Preserve unknown/Technician fields during Release A commands.

Gate to continue: concurrent version-N synthetic commands produce exactly one N+1 commit, one `409 version_conflict`, and no lost unrelated fields.

## Workstream 2 — Draft/request/appointment separation

1. Centralize record-kind/visibility guards across every Customer/Admin/Technician booking read.
2. Require scoped `draftSaveToken` proof for existing-draft read/write/finalize; bind and rotate/revoke it appropriately.
3. Make finalization idempotent and atomically link/close the draft to one submitted booking version.
4. Model submitted public request as `pending_review`; model Admin-approved schedule as a distinct confirmed appointment state.
5. Remove the public localStorage booking mirror as an authority; if temporarily retained for compatibility, clearly namespace/expire it and never read it into portal state.

Gate to continue: all read endpoints omit drafts; absent/wrong/replayed draft proof cannot mutate; repeated valid finalization returns the same submitted booking.

## Workstream 3 — Canonical quote and request application

1. Route public booking, Customer changes, Admin approval, Admin money/service mutations, and payment preparation through one canonical pricing service based on structured service input.
2. Remove fixed portal prices as quote authority. UI catalog data may display server-provided labels/prices but cannot calculate an approvable amount independently.
3. Add stable vehicle IDs and explicit structured request targets/deltas.
4. Store `requestVersion`, `baseBookingVersion`, `quoteVersion`, catalog/input identity, and status on every request transition.
5. On Admin decision, reject stale versions or reprice and require a decision on the new quote. Never trust `requestedState.proposedTotal`.
6. Apply request decision and booking version in one authoritative commit. A request index in `cd1-customer-change-requests` is rebuildable only; make index failure retryable and visible.
7. Iterate/index all pending requests before sorting/capping; return a stable cursor.
8. Reject/no-op an already-selected add-on and support removal only through an explicit structured delta. Do not expose a removal action until it is implemented end to end.

Gate to continue: canonical fixtures cover every category/tier/ZIP/add-on; Customer proposal, Admin decision, stored structure, and refreshed amount match exactly; stale request approval cannot mutate.

## Workstream 4 — Customer/Admin refresh parity

1. Return `bookingVersion`, `quoteVersion`, request versions/statuses, effective lifecycle, and canonical money projection to both portals.
2. Make both portals render only the returned aggregate projection; remove local merge/optimistic assumptions that can mask a failed write.
3. Exchange action-link token for a short-lived booking-scoped session or retain it only in memory; ensure poll/focus refresh remains authorized without durable token exposure.
4. Iterate all Blob list pages, normalize each record independently, quarantine malformed entries per record, and sort deterministically.
5. Define deterministic upcoming selection and response pagination.

Gate to continue: after each synthetic command and hard reload, Customer and Admin return the same versions, selections, approved/remaining amounts, and request decision; shuffled multi-page fixtures produce identical results.

## Workstream 5 — Authoritative Stripe balance and reconciliation

1. Derive remaining cents only from canonical approved, settled, and credited ledger inputs.
2. Fail closed on money conflicts and paid/closed/processing states.
3. Replace Customer/Admin payment-link creation with one version-checked server payment service. Ignore/reject browser/operator amount fields.
4. Bind payment attempts and Stripe metadata to booking/quote versions, currency, and exact cents; use idempotency.
5. Expire provider-side open Sessions when a quote becomes superseded.
6. Add an idempotent customer-balance Checkout reconciliation path; update the full ledger and payment attempt atomically. Drive the success UI from verified state, not `?paid=1`.
7. Route every Admin/Technician-compatible money mutation retained in Release A through the aggregate service, while avoiding Technician workflow redesign.
8. Disable dormant non-authoritative PaymentIntent/payment-link routes or route them through the same service. Do not add a new Pay in Full UI.
9. Fix Admin Generate Stripe link through the shared service, not an import-only patch. Remove its amount override.
10. Enforce one Stripe mode/configuration factory for every SetupIntent, Checkout, PaymentIntent, capture, policy-charge, and refund entry point.

Gate to continue: the payment matrix in `payment-and-invoice-model.md` passes in intercepted test mode; successful balance settlement credits exactly once; every local/preview live-key case performs zero network calls.

## Workstream 6 — Verification, rollout, and rollback

### Required automated suites

- Unit: status/visibility guards, historical adapters, canonical catalog, structured deltas, money ledger, version conflict, Stripe mode guard.
- Handler integration: public finalization, Customer request, Admin decision, Customer/Admin refresh, payment creation/reconciliation, pending-request pagination.
- Concurrency/failure injection: two writers at version N; failure before/after secondary-index projection; duplicate payment reconciliation.
- Browser/preview: authorized synthetic Customer and Admin accounts only; hard refresh, focus refresh, action-link session, test-mode Checkout return. Capture console/network traces without customer data.
- Historical: table-driven old schema/status/money/container aliases and multi-page ordering.

### Release gates

1. Full repository suite passes with contradictory/stale guards resolved intentionally.
2. No client/operator-provided total reaches canonical quote or Stripe creation.
3. Same booking revision yields byte-equivalent material projections in Customer/Admin.
4. Every service/money write increments version once and preserves unrelated fields.
5. Pending requests are complete and deterministic beyond 200 records/pages.
6. Stripe receives exactly authoritative remaining cents and settlement reconciles once.
7. Paid/closed historical fixtures are readable and non-payable.
8. Drafts never appear outside scoped draft endpoints and cannot be changed without proof.
9. No production data, live charge, webhook replay, identifier enumeration, or authentication-bypass testing is needed for acceptance.

### Rollout

1. Deploy behind server-side flags for new read adapter, command service, and payment service.
2. Enable dual-read comparison telemetry on synthetic/preview data; do not dual-write competing authorities.
3. Enable new authoritative writes for synthetic preview fixtures, then authorized test-mode operational fixtures.
4. Enable portal projections only after parity gates pass.
5. Retain backward-read adapter and reversible feature routing; never downgrade already versioned records.

### Immediate rollback conditions

- version/CAS bypass or lost update;
- canonical reprice changes an already approved revision without a new quote;
- Customer/Admin mismatch at the same version;
- wrong Stripe cents, stale session payment, or duplicate/missing settlement;
- paid/closed historical record becomes payable;
- malformed history breaks a whole response;
- draft appears in a normal portal feed; or
- local/preview money endpoint reaches Stripe with a live key.

## Explicitly deferred, with no release assignment

- Technician confirmed-only feed and lifecycle transition redesign (PDA-10, PDA-11);
- communications-preference implementation;
- automatic refund execution;
- auto-confirm future-job behavior;
- maintenance/manual-review automation and wording;
- general visual/UX enhancements.

These are audit findings only. They are not Release A work and are not assigned to Releases B–E.
