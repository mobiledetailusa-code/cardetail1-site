# Phase 1 — Delta Audit (scoped per owner decision: delta against existing PDA register)

**Date:** 2026-07-18
**Baseline:** `docs/audit/portal-defect-register.md` (PDA-01…19) and `docs/audit/final-production-readiness-report.md` (dated 2026-07-17, HEAD `32f63b36e`).
**Scope decision:** Per explicit owner instruction, this Phase 1 does not re-derive the 11 documents the general brief requests from scratch. It (a) verifies the 3 explicitly-deferred PDA items against current source, (b) maps the 5 commits made after the prior report to the "Owner portal retest findings" they were meant to fix, and (c) records one new defect found while verifying PDA-10. It supersedes nothing in the existing audit docs; treat this file as an amendment layer on top of them.
**Posture:** Read-only. No application code was modified to produce this document.

## A. Post-report commits mapped to prior report's open findings

`docs/audit/final-production-readiness-report.md` ended with three owner-observed issues on preview and said fixes were "local; deploy when ready." All three are now committed on `fix/final-production-readiness`:

| Report's issue | Commit(s) | Verified this session |
|---|---|---|
| Duplicate charge risk (stale `payLink`, second Checkout link mintable while balance still shows open) | `99fb0a4` (approve add-ons without version_conflict), `d4ad054` (auto-apply + price swaps) | Not re-verified against live Stripe in this session (no test-mode keys available). Source-level: `appointment-status-policy.js:canPayBalance` still derives `due` from ledger first (§B below) — consistent with the claimed fix, but not re-run end-to-end. |
| Intermittent "no booking for code" after refresh | `f624d89` (Admin list key vs booking.id lookup), `0d5f3cd`+`3c8d2af` (sessionStorage lock/unlock) | Source-level only. Not re-verified via browser in this session. |
| Vehicle replace no-op / wrong trailer pricing | `d4ad054` (auto-apply pack/addon/vehicle + trailer-to-SUV price swap in `booking-price-catalog.js`) | Source-level only. |

**Residual risk:** none of these three were re-verified end-to-end against a running preview or Stripe test mode this session — Phase 0 found no Netlify CLI and no confirmed-fresh deploy preview (the recorded preview URL is 5 commits stale). Treat as "fixed in source, unverified in the running system" until a Phase 4/5-style browser+Stripe pass is done.

## B. PDA-10 — Technician feed/actions do not require confirmed eligible work — **STILL OPEN**, plus one new finding

Verified against current `netlify/functions/tech-jobs.js` (2026-07-18):

- GET still filters only on `!isDraft && !isTest && !archived` + assignment (`tech-jobs.js:30-33`). No check that the booking is in a confirmed/eligible lifecycle phase before listing it as tech-actionable.
- POST still accepts any status in `TECH_STATUS_UPDATES` without validating it's a legal transition from the booking's *current* status (`tech-jobs.js:53-55`). No state-machine/transition matrix.
- **New finding (not in the original PDA-10 text):** the write path uses **unconditional `store.setJSON(bookingId, { ...booking, ...updates })`** (`tech-jobs.js:89`) — no CAS / `bookingVersion` check, unlike the Admin money/service path which the final-production-readiness-report says was moved onto `commitBooking` with CAS. This means a concurrent Admin write (e.g. approving a change request) and a Technician status update on the same booking can race and silently lose one write (classic last-write-wins), even though the report's PDA-02/CAS claims are true for the Admin path specifically. This is a **P1 concurrency gap** distinct from PDA-10's original authorization framing, and should be tracked separately when Phase 2/3 lands CAS everywhere.

Verdict: **PDA-10 confirmed still open**, unchanged from prior audit, plus the CAS-bypass finding above.

## C. PDA-11 — Customer lifecycle ignores Technician in-progress status — **STILL OPEN**

Verified against current `netlify/lib/appointment-status-policy.js` (2026-07-18):

```js
function normalizeStatus(booking) {
  const raw = String(
    booking?.appointmentStatus || booking?.status || booking?.jobStatus || ''
  ).trim().toLowerCase();
  return raw;
}
```

`appointmentStatus` is still checked *before* `jobStatus` in the `||` chain. Reproduction, still valid on current code:

1. Booking has `appointmentStatus: 'confirmed'` (a truthy non-empty string) and `jobStatus: 'in_progress'` (set by a Technician transition — `tech-jobs.js:81` sets `jobStatus` but never touches `appointmentStatus`).
2. `normalizeStatus` returns `'confirmed'` (short-circuits on the first truthy value), never reaching `jobStatus`.
3. `classifyStatus` matches `'confirmed'` against `PENDING_APPROVAL`, returning phase `'confirmed'` — not `'in_progress'`.
4. `canRequestChange(booking, 'package_change')`: phase `'confirmed'` is not in the `blocked` map for `in_progress`/`cancelled`/`paid`, and `package_change` is not in `needsAdminReview` (only `reschedule`/`maintenance` are) — so it returns `{ ok: true, pendingApproval: false }` and, per the `d4ad054` auto-apply change, the request **applies immediately**.

Net effect: a customer can submit and have auto-applied a package/add-on/vehicle/address change on a booking a technician has already started, because nothing ever writes `appointmentStatus` to reflect the in-progress job. This is the same root cause the original PDA-11 identified (status-field precedence, not a single lifecycle state machine) and it is **unresolved**, and now has slightly higher blast radius than when PDA-11 was written, because the `d4ad054` commit made several of these change types auto-apply instead of requiring Admin approval — reducing the window in which an Admin could catch and reject the request before the fact.

Verdict: **PDA-11 confirmed still open, severity unchanged (High), operational impact modestly increased by the newer auto-apply behavior.**

## D. PDA-19 — Placeholder/note-only controls — **STILL OPEN (spot-checked, not re-audited in full)**

Spot check only (full re-audit deferred to Phase 4 button-contract-audit): `my-garage.html:193` still reads `"Preference management is coming soon. Call or text us to update how we reach you."` — the communication-preferences placeholder cited in the original PDA-19 is still present verbatim. Refund and manual pay-link behavior were not re-checked this session; treat PDA-19 as open pending the full Phase 4 pass.

## E. Test baseline (reconfirms Phase 0 §3)

`node --test tests/*.test.js`: **1234 tests, 1231 pass, 3 fail** (3 pre-existing, non-functional: a stale text-scan regex, a repo-hygiene allowlist guard flagging the intentional `booking-prisma-mirror.js` addition, and a working-tree `.env`-presence guard). None of the 3 relate to PDA-10/11/19.

## GATE 1 OUTPUT

**1. Executive verdict.** The Blob-CAS-authoritative architecture described in the prior PDA remediation report is real and largely holds for the Admin money/service path (CAS via `commitBooking`, ledger-derived remaining, webhook-only payment writes). It does **not** yet hold uniformly: Technician writes bypass CAS entirely (new finding, §B), and the lifecycle-precedence bug behind PDA-11 is unresolved and now has larger blast radius because more customer actions auto-apply without Admin review. Postgres remains a JSON mirror, not a financial authority — none of Phase 2's target relational model (`Quote`/`PaymentAttempt`/`LedgerEntry`/`StripeEvent` tables) exists yet.

**2. Root cause of every observed defect.**
- PDA-10 (open): assignment is treated as the sole read/write gate; no centralized lifecycle-transition matrix for Technician actions.
- New CAS-bypass (open): `tech-jobs.js` writes via raw `store.setJSON`, not `commitBooking`; CAS adoption was done for Admin only, not uniformly.
- PDA-11 (open): `normalizeStatus`'s field-precedence chain (`appointmentStatus || status || jobStatus`) predates a single canonical lifecycle state machine; Technician transitions never clear/sync `appointmentStatus`.
- PDA-19 (open): UI labels ("coming soon", note-only saves) were never reconciled with what the backend actually does.

**3. Exact files involved.** `netlify/functions/tech-jobs.js` (GET/POST handlers, line 89 unconditional `setJSON`), `netlify/lib/appointment-status-policy.js` (`normalizeStatus` lines 15-20), `netlify/functions/tech-complete-job.js` (not yet re-read this session — same risk class as `tech-jobs.js`, flag for Phase 2/3 verification), `my-garage.html:193`.

**4. Code that can remain.** Everything covered by the prior report's RESOLVED list (PDA-01–09, 12–18) — re-confirmed only at the `canPayBalance`/`canRequestChange` source level this session, not re-run end-to-end. The Admin CAS/ledger path in `booking-commands.js` / `commitBooking` is sound in design and should be the pattern extended to Technician writes, not replaced.

**5. Code that must be rewritten.** `tech-jobs.js` and `tech-complete-job.js` write paths must move onto `commitBooking`/CAS. `appointment-status-policy.js:normalizeStatus` must stop treating `appointmentStatus` as precedence-first; it needs one canonical phase derivation where an active Technician `jobStatus` of `in_progress`/equivalent overrides a stale `appointmentStatus:'confirmed'`.

**6. Database migration recommendation.** No migration required to fix PDA-10/11 — both are pure application-logic fixes on the existing Blob aggregate. Defer the full relational `Quote`/`PaymentAttempt`/`LedgerEntry`/`StripeEvent` migration to the Phase 2 gate, per the owner's delta-scope decision; that remains a separate, larger decision (extend Blob-CAS vs. full Postgres cutover) not resolved by this delta audit.

**7. Stripe migration recommendation.** None needed for these two defects — they are pre-payment/lifecycle bugs, not Stripe-object bugs.

**8. P0/P1/P2 defect list (this delta only — see PDA register for the full list).**
- P1: PDA-11 (customer can mutate an in-progress job; now easier to trigger since auto-apply landed).
- P1: New CAS-bypass in Technician write path (lost-update risk between Admin and Technician on the same booking).
- P2: PDA-10 (Technician can see/act on non-eligible assigned work; no reported customer-facing financial harm, but an operational-integrity gap).
- P2: PDA-19 (mislabeled placeholder controls; UX/trust issue, not a data-integrity or payment issue).
- P2 (process, not code): the three "fixed in source" items in §A need a live preview + Stripe test-mode re-verification before they can be called closed.

**9. Proposed PR decomposition.**
1. `fix: derive canonical lifecycle phase from active Technician job status, not appointmentStatus precedence` (PDA-11) + test.
2. `fix: route Technician status writes through commitBooking CAS` (new finding) + test.
3. `fix: gate Technician list/actions on confirmed-eligible transition matrix` (PDA-10) + test.
4. Separate, later: PDA-19 relabeling (Phase 4 button-contract work), and a live-preview re-verification pass for the three §A items.

**10. Test plan.** Add: (a) a fixture where `appointmentStatus:'confirmed'` + `jobStatus:'in_progress'` asserts `canRequestChange` denies structural actions; (b) a concurrency test asserting a Technician write and an Admin CAS write on the same `bookingVersion` cannot both silently succeed; (c) a Technician transition-matrix test (assigned+non-confirmed cannot be listed/acted on).

**11. Estimated implementation risk.** Low-to-moderate. All three fixes are localized to `appointment-status-policy.js` and the two `tech-*.js` handlers; no schema change. Main risk is behavioral: tightening `canRequestChange`/Technician gating could newly block actions currently in use by real operators, so this should ship behind the same test-driven acceptance pattern used for the PDA-01–18 remediation, and be called out explicitly to the owner before merge.

**Not covered by this delta audit** (still relies on the prior PDA docs, unchanged): PDA-01–09, 12–18; the full Phase-1-A–I checklist items the general brief lists (competitive benchmark, full Stripe object trace, full security audit) — these were not re-run, per the owner's scope decision to do a delta audit rather than a full restart. Recommend covering the competitive benchmark and full security pass in Phase 4 (button-contract) and a dedicated security pass before Phase 5 (embedded payment), respectively.
