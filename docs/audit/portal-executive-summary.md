# CARDDETAIL1 Defensive Operational Portal Audit — Executive Summary

**Audit date:** 2026-07-17  
**Branch:** `fix/my-garage-operational-portal`  
**HEAD:** `5fa47b99c4d8707dba29b35c6559b3cdba3eb125`  
**Audit posture:** read-only application review; documentation files are the only intentional changes.

## Executive conclusion

The current implementation is **ready to hand to Cursor for Release A remediation, but it is not production-release ready**. The precise blocker is that there is no single, versioned canonical booking-and-quote aggregate. Customer requests can therefore be calculated from a secondary catalog, approved from a stale snapshot, and persisted through non-atomic last-write-wins updates. Customer, Admin, and Stripe may agree on the same value while that value is still wrong.

Four critical defects require Release A remediation:

1. My Garage uses a pricing catalog that disagrees with the canonical booking catalog.
2. Booking, request, and quote records have no revisions or compare-and-swap protection.
3. successful Customer Pay Balance Checkout Sessions are not reconciled into the booking ledger.
4. historical `Paid` and `Closed` records can project a positive payable balance.

The modern Customer/Admin/Technician feeds share `cd1-bookings`, which is a useful foundation, but the application does not yet enforce one authoritative state model over that store. Service selections exist in both top-level fields and `vehicles[]`; monetary state exists in multiple independently writable fields; change requests live in a second store without an atomic application protocol.

## Answers to the fourteen operational questions

| # | Operational question | Audit result |
|---|---|---|
| 1 | Does an unsubmitted draft remain only a draft? | **No across the whole API surface.** Current My Garage, Admin, and Technician feeds filter drafts, but retained `lookup-booking` and `customer-bookings` endpoints can project a caller-owned synthetic draft as a booking. Draft update/finalization also lacks an ownership-token check. |
| 2 | Does a submitted request appear in both Customer and Admin? | **Usually, not deterministically.** Both use `cd1-customer-change-requests`, but Admin caps the first 200 keys before filtering for pending requests. Cross-store submission failure can also leave an orphan request. |
| 3 | Do Customer and Admin display the same request version? | **No version exists.** Requests, bookings, and quotes have no monotonic revision, immutable quote version, ETag, or conflict response. |
| 4 | Does Admin approval update Customer after refresh? | **Only after every write succeeds.** Approval marks the request approved before updating the booking, so a partial failure can show an approved request with an unchanged booking. Action-link sessions also lose the credential needed to refresh. |
| 5 | Are package and add-on changes stored as structured data? | **Partially.** Structured fields exist, but portal approval updates top-level `package`/`addons` without consistently updating canonical `vehicles[]` or identifying the target vehicle. |
| 6 | Do quote totals come from the server? | **Initial booking totals do; portal-change totals are not authoritative.** The portal server uses a secondary fixed-price catalog and Admin later trusts the stored proposal instead of repricing canonically. |
| 7 | Does Stripe test mode receive the same approved amount? | **Not reliably established.** When duplicated money fields are internally consistent, cents conversion is correct. Stale due fields, stale quote snapshots, a broken Admin generator, and missing reconciliation violate the invariant. No Stripe transaction was made during this audit. |
| 8 | Does Pay in Full use the authoritative balance? | **No current visible Pay in Full workflow exists.** The dormant PaymentIntent route recalculates catalog `totalPrice` and can discard an approved discount instead of using the authoritative approved balance. |
| 9 | Does Pay Balance use the authoritative remaining balance? | **Only if the record is already internally consistent.** `computeDue` trusts stored derived fields before `approved - paid`; normal mutations can leave those fields stale, and successful Checkout is not credited. |
| 10 | Does the Technician see only assigned confirmed work? | **No.** The feed filters by assignment and draft/test/archive flags, not by confirmed/eligible lifecycle. |
| 11 | Does Technician status update Admin and Customer? | **The shared record becomes visible after a valid refresh, but lifecycle behavior is inconsistent.** Technician writes change `jobStatus` while Customer classification prefers `appointmentStatus`, so an in-progress job can still accept structural customer changes. |
| 12 | Do records remain consistent after page refresh? | **No deterministic guarantee.** Full-record last-write-wins updates, missing revisions, stale action-link state, non-atomic request application, and nondeterministic list selection can produce divergent refresh results. |
| 13 | Are historical records still readable? | **Not reliably.** Legacy `Closed` is not normalized consistently; paid records can become payable; non-array legacy `vehicles`/`addons` can throw; list operations are not fully paginated. |
| 14 | Are any visible controls placeholders or note-only workflows? | **Yes.** Communication preferences say “coming soon”; maintenance/manual-review requests are follow-up workflows; auto-confirm settings are persisted without a complete booking consumer; refunds are logged for manual Stripe work; the manual pay-link control is not amount-bound. |

## Confirmed findings by severity

| Severity | Count | Finding IDs |
|---|---:|---|
| Critical | 4 | PDA-01 through PDA-04 |
| High | 10 | PDA-05 through PDA-12, PDA-14, PDA-17 |
| Medium | 5 | PDA-13, PDA-15, PDA-16, PDA-18, PDA-19 |

The full reproduction, root-cause, fix, acceptance-test, and rollback record is in `portal-defect-register.md`.

## Evidence recovered and generated

- The worktree was clean before this audit, `docs/audit/` did not exist, and no usable prior portal-audit notes or runtime evidence were found.
- The branch is three commits ahead of its `master` merge base and already contains Customer/Admin operational work; it contains no Technician Portal change.
- Targeted existing suites: **190 tests, 189 passed, 1 failed**. The failure is a stale manual-review copy assertion.
- Full existing suite: **1,110 tests, 1,102 passed, 8 failed**. Most failures are stale scope guards; two SetupIntent tests contradict the card-only expectation in another current suite.
- Pure synthetic fixtures confirmed catalog drift, stale-due calculation, historical paid/closed payability, duplicate-add-on overcharge, and Customer lifecycle classification of an in-progress job as change-eligible.
- Existing `portal-admin-customer-e2e.test.js` is explicitly simulated and does not execute the handlers/stores end to end.
- The local file target was blocked by the in-app browser URL policy. No policy workaround was attempted, so browser refresh and network traces are an explicit evidence gap rather than a claimed pass or defect.
- No real customer record, identifier enumeration, authentication bypass, exploit technique, production mutation, webhook replay, or Stripe network charge was used.

The test runner changed timestamps on two generated strategy files. Their content hashes remain byte-identical to HEAD and `git diff` contains no content change for them.

Commands executed with the bundled Node runtime:

```powershell
node --test tests/portal-admin-customer-e2e.test.js tests/my-garage-portal.test.js tests/operations-lifecycle-e2e.test.js tests/operations-core.test.js tests/admin-ops-tech.test.js tests/admin-ops-interface.test.js tests/booking-flow.test.js tests/card-on-file-hardening.test.js tests/checkout-parity.test.js tests/security-integration.test.js
node --test tests/*.test.js
```

The eight full-suite failures were: one manual-review label assertion; four Netlify-function scope/change guards; two contradictory SetupIntent parameter assertions; and one single-price UX string guard. They are recorded as validation/test maintenance gaps and were not used to dismiss the confirmed source/control-flow defects.

## Release A boundary

Release A is limited to:

- draft/request/appointment separation;
- a shared source of truth;
- Customer/Admin synchronization;
- request and quote versioning;
- authoritative server totals;
- Stripe amount consistency;
- refresh consistency; and
- historical-read compatibility.

Technician lifecycle restrictions, note-only controls, communication preferences, refunds, and other UX work are documented but explicitly excluded from the Release A implementation command. No Releases B–E are defined in this audit.

## Release decision

**Cursor handoff:** ready.  
**Current implementation for production:** not ready.  
**Single implementation blocker:** no single versioned canonical booking/quote aggregate exists, so stale or catalog-inconsistent requests can become approved monetary state.
