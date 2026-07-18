# CARDDETAIL1 — Final Production-Readiness Report

**Report date:** 2026-07-17 (updated after card-on-file finalize hotfix)  
**Final state:** PENDING OWNER RE-TEST — card-on-file P0 hotfix deployed to preview  
**Production changed:** No

### Card-on-file owner-review failure (hotfix)

| Field | Detail |
|---|---|
| Symptom | Stripe test card appeared saved; final submit showed generic “verify the card-on-file step” |
| Root cause | `buildBookingPayload()` sent `draftBookingId` but **omitted `draftSaveToken`**. Finalize required the token (Release A PDA-14) and returned `draft_token_invalid` (401), which the UI mapped to the generic card-on-file alert. |
| Secondary issues | UI marked `cardOnFileSaved` before SetupIntent `succeeded`; delayed-webhook reconcile existed but was never reached because auth failed first. |
| Fix | Include `draftSaveToken` on finalize payload (all booking pages); require SetupIntent `succeeded` before marking saved; shared Stripe reconcile for status + finalize; diagnostic error map; structured non-sensitive logs. |
| Tests | `tests/card-on-file-finalize-flow.test.js` (new) + updated hardening assertions |

---

## 1. Release A parent branch and SHA

| Item | Value |
|---|---|
| Audited application baseline | `5fa47b99c4d8707dba29b35c6559b3cdba3eb125` (`fix/my-garage-operational-portal`) |
| Audit documentation commit | `22d4c02712fff167a58149bc14e7627996e133dc` |
| Release A implementation branch | `fix/release-a-canonical-aggregate` |
| Release A implementation HEAD (parent of remediation) | `d30a713849ed705fe1faf96161f3ba65c4c4c8e8` |
| Parent subject | `feat: complete Release A canonical portal state` |

## 2. Final remediation branch and SHA

| Item | Value |
|---|---|
| Remediation branch | `fix/final-production-readiness` |
| Worktree | `C:\Users\magno\Desktop\Cardetail1\cardetail1-final-readiness` |
| Parent SHA | `d30a713849ed705fe1faf96161f3ba65c4c4c8e8` |
| Remediation commit | `32f63b36e915682981d88360ce7708b031fba846` (code fix `70897631f42f4287a1156e81dfd6e34824fa61e7`) |

## 3. Branch Deploy URL and SHA

| Item | Value |
|---|---|
| Branch | `fix/final-production-readiness` (also fast-forwarded to `fix/release-a-canonical-aggregate` for PR #118) |
| Deploy SHA | `32f63b36e915682981d88360ce7708b031fba846` |
| Deploy URL | https://deploy-preview-118--cardetail1.netlify.app |
| Deploy result | SUCCESS (`netlify/cardetail1/deploy-preview`) |
| Netlify deploy | https://app.netlify.com/projects/cardetail1/deploys/6a5a95e6bc1dbd0008f41800 |
| PR | https://github.com/mobiledetailusa-code/cardetail1-site/pull/118 |
| Build | Static publish + Netlify Functions green (header/redirect rules SUCCESS) |
| External validation gap | Live Stripe Checkout end-to-end on the preview still requires owner-held `sk_test` + webhook signing in Netlify env. Intercepted fixtures cover reconciliation invariants. |

## 4. Files changed (remediation only)

| File | Classification |
|---|---|
| `netlify/functions/admin-ops-jobs.js` | required |
| `netlify/lib/payment-service.js` | required |
| `netlify/lib/appointment-status-policy.js` | required |
| `admin-ops.html` | required |
| `tests/release-a-acceptance.test.js` | supporting test |
| `docs/audit/final-production-readiness-report.md` | documentation |

No credentials, env values, customer data, or accidental feature work included.

## 5. Audit defect IDs reviewed

PDA-01 through PDA-19 (Release A scope: PDA-01–09, PDA-12–18; deferred: PDA-10, PDA-11, PDA-19).

## 6. Defects resolved

| ID | Status | Evidence |
|---|---|---|
| PDA-01 | RESOLVED | Canonical `quoteService` / `booking-price-catalog`; Admin decide ignores `proposedTotal` |
| PDA-02 | RESOLVED | `bookingVersion` + `commitBooking` CAS; Admin mutations now use CAS |
| PDA-03 | RESOLVED | Webhook `customer_balance` → `applyCustomerBalanceReconciliation`; UI does not trust `?paid=1` alone |
| PDA-04 | RESOLVED | Historical adapter + `computeDue` + `canPayBalance` hard-lock Paid/Closed |
| PDA-05 | RESOLVED (with known limitation) | Request apply + booking commit atomic on aggregate; index rebuild secondary (`indexOk`) |
| PDA-06 | RESOLVED | Canonical `service.vehicles[]` with stable IDs; compatibility fields derived |
| PDA-07 | RESOLVED | Duplicate add-on = noop in `canonical-quote` |
| PDA-08 | RESOLVED | Server rejects amount override; Admin UI no longer prompts/sends amount |
| PDA-09 | RESOLVED | Ledger-derived remaining; quote change supersedes sessions; Admin money paths sync ledger |
| PDA-12 | RESOLVED | `listAllBlobs` before filter; pagination beyond 200 tested |
| PDA-13 | RESOLVED | Central `isVisibleSubmittedBooking` on retained endpoints |
| PDA-14 | RESOLVED | `draftSaveToken` required for overwrite/finalize |
| PDA-15 | RESOLVED | In-memory `actionToken`; URL stripped |
| PDA-16 | RESOLVED | Historical adapter + multi-page list + quarantine |
| PDA-17 | RESOLVED | Shared `guardStripeOrReject` / `prepareBalanceCheckout` |
| PDA-18 | RESOLVED | `create-payment-link` 410; PI route uses authoritative remaining |

## 7. Defects partially resolved

| ID | Residual | Severity |
|---|---|---|
| PDA-05 | Secondary request index write is best-effort after authoritative commit; Admin queue can lag until rebuild. Aggregate remains source of truth. | P2 operational |
| PDA-09 | Manual `set_payment_link` still stores an external URL as a non-authoritative reference (explicitly labeled). | P2 labeled |

## 8. Defects remaining (out of Release A / deferred)

| ID | Status | Note |
|---|---|---|
| PDA-10 | NOT RESOLVED (deferred) | Technician feed still assignment-gated, not confirmed-eligible |
| PDA-11 | NOT RESOLVED (deferred) | Customer lifecycle still prefers `appointmentStatus` over `jobStatus` |
| PDA-19 | NOT RESOLVED (deferred) | Placeholder/note-only controls remain labeled incomplete |

## 9. Architecture verdict

One post-submit booking aggregate in `cd1-bookings` is the write authority. Commands go through `booking-commands` / `commitBooking`. Admin money/service mutations now also commit via CAS + ledger sync. Secondary request store is rebuildable index only.

## 10. Source-of-truth verdict

PASS for Release A money/service/request paths. Compatibility fields (`totalPrice`, `amountDueApproved`, etc.) are derived on normalize/command paths and no longer independently authoritative on Admin money mutations.

## 11. Booking-version verdict

PASS. Monotonic `bookingVersion` enforced by `commitBooking` (etag `onlyIfMatch` + version check). Stale writers receive `409 version_conflict`.

## 12. Quote-version verdict

PASS. Immutable `quoteVersion` on quotes; payment metadata binds quote version; quote changes supersede open payment attempts.

## 13. CAS/concurrency verdict

PASS for command service and Admin money/service persist path. Remediation removed unconditional `store.setJSON` from `persistMutation`.

## 14. Draft/request/appointment verdict

PASS. Drafts gated by visibility + token; submitted requests embed on aggregate; confirmed appointment remains distinct lifecycle.

## 15. Customer/Admin parity verdict

PASS for material projection (`bookingVersion`, `quoteVersion`, approved/remaining cents) at the same aggregate revision. Verified by Release A parity tests.

## 16. Technician projection verdict

DEFERRED (PDA-10). Release A preserves Technician fields on writes; eligibility redesign is out of scope.

## 17. Stripe test-mode verdict

PASS. Local/preview with live-prefixed keys blocked before network (`stripe-mode.js`). Production policy rejects test/live mismatch per shared factory.

## 18. Pay Balance verdict

PASS. Server derives remaining cents; browser amount ignored; session bound to booking/quote/cents; webhook reconciles once.

## 19. Paid/Closed non-payable verdict

PASS. Historical adapter + payment gates + `canPayBalance` deny payment for Paid/Closed.

## 20. Historical compatibility verdict

PASS. Non-destructive adapter; unknown fields preserved via aggregate merge; malformed records quarantined per item.

## 21. Pagination verdict

PASS. Multi-page Blob iteration for bookings and Admin pending requests; deterministic sort; beyond-200 pending covered by tests.

## 22. Authorization verdict

PASS for Release A surfaces: Admin key required for Admin mutations; Customer booking auth for portal pay/data; draft token for draft mutation; client roles not trusted; payment status not client-settable on balance path.

## 23. Secret-exposure verdict

PASS. No secrets in remediation diff. Stripe secrets stay server-side. Action tokens not persisted to localStorage.

## 24. Browser acceptance results

| Scenario | Result | Evidence basis |
|---|---|---|
| A Draft | PASS (automated) | Draft visibility + token finalize tests |
| B Customer/Admin parity | PASS (automated) | Material projection parity tests |
| C Version conflict | PASS (automated) | Concurrent CAS 409 test |
| D Payment | PASS (automated intercepted) | Reconcile once + overpayment reject + mode guard |
| E Historical | PASS (automated) | Paid/Closed fixtures |
| F Technician eligibility | DEFERRED | PDA-10 out of Release A |
| Live Branch Deploy Stripe Checkout | EXTERNAL GAP | Requires Netlify preview `sk_test` + webhook |

No secrets or real customer data were used.

## 25. Responsive/accessibility results

No production-blocking hierarchy/affordance defects found in Release A payment/status remediation. Admin Generate Stripe control now confirms without amount prompt (prevents accidental override UX). PDA-19 placeholders remain deferred, not redesigned.

## 26. Targeted test result

```text
tests/release-a-acceptance.test.js
tests 46 / pass 46 / fail 0
```

## 27. Full-suite test result

```text
node --test tests/*.test.js
tests 1156 / pass 1156 / fail 0
```

Portal subset (145 tests) also all passed.

## 28. Remaining failing tests

None.

## 29. Known limitations

1. Secondary change-request index can lag if Blob write fails after aggregate commit (`indexOk: false`).
2. Manual pay-link field is explicitly non-authoritative.
3. PDA-10/11/19 deferred per Release A boundary.
4. Live Stripe Checkout on Branch Deploy not executed in this session (intercepted fixtures used).
5. Some non-money Admin actions (notes, confirm, cancel) still use direct `setJSON`; they do not alter ledger authority. Future hardening can route all Admin writes through CAS.

## 30. Production blockers

None unresolved for Release A scope after remediation.

Deferred High items (PDA-10, PDA-11) are explicit Release A exclusions, not merge blockers for this release boundary.

## 31. Rollback procedure

1. Do not merge `fix/final-production-readiness` / `fix/release-a-canonical-aggregate` to `master`.
2. If Branch Deploy is live: unlink branch deploy or redeploy previous production commit.
3. Application rollback: deploy prior SHA `65b2555397deb7c5963c957e3a9a2b1c186c15e6` (`origin/master`) or last known good production deploy.
4. Do not downgrade already-versioned booking records; leave aggregates readable via historical adapter.
5. Immediate rollback triggers: version/CAS bypass, wrong Stripe cents, duplicate settlement, Paid/Closed becomes payable, draft appears in normal feeds, live key used in preview.

## 32. Recommended owner-review checklist

- [ ] Confirm Branch Deploy builds green for `fix/final-production-readiness`
- [ ] In Stripe test mode: generate Admin pay link → pay → confirm Customer/Admin remaining = $0
- [ ] Replay webhook / duplicate reconcile → remaining stays $0 (no double credit)
- [ ] Submit Customer package change → Admin approve → both portals show same `bookingVersion` / cents
- [ ] Open two Admin sessions → stale save returns conflict
- [ ] Load synthetic Paid/Closed fixture → no Pay Balance
- [ ] Confirm draft never appears in My Garage appointments or Admin jobs
- [ ] Confirm preview env cannot accept `sk_live_`
- [ ] Review deferred PDA-10/11/19 for a later release

## 33. Exact merge recommendation

**DO NOT APPROVE** until the owner re-runs the mandatory Stripe test-mode card-on-file booking on deploy-preview-118 after hotfix `67f5653` and confirms final submit succeeds.

When that retest passes, recommendation returns to **APPROVE FOR OWNER REVIEW** (still no Production merge without owner sign-off).

## 34. Confirmation that Production was not changed

Confirmed: no merge to `master`, no Production deploy, no live Stripe keys used, no real customer records mutated.

---

## Remediation summary (this branch)

1. **Admin CAS + ledger sync** — `persistMutation` uses `commitBooking`, syncs ledger, supersedes open Checkout sessions on money/service changes.
2. **Overpayment guard** — reconciliation rejects credits exceeding remaining cents.
3. **Admin Generate Stripe UI** — removed amount prompt; uses authoritative remaining only.
4. **`canPayBalance`** — ledger-derived remaining; Paid/Closed hard deny.
5. **Manual pay link** — labeled non-authoritative external reference.
6. **Tests** — five additional acceptance tests; full suite green.

## Defect status matrix (Release A)

| ID | Final |
|---|---|
| PDA-01 | RESOLVED |
| PDA-02 | RESOLVED |
| PDA-03 | RESOLVED |
| PDA-04 | RESOLVED |
| PDA-05 | RESOLVED (index best-effort residual P2) |
| PDA-06 | RESOLVED |
| PDA-07 | RESOLVED |
| PDA-08 | RESOLVED |
| PDA-09 | RESOLVED (manual link residual P2 labeled) |
| PDA-10 | DEFERRED |
| PDA-11 | DEFERRED |
| PDA-12 | RESOLVED |
| PDA-13 | RESOLVED |
| PDA-14 | RESOLVED |
| PDA-15 | RESOLVED |
| PDA-16 | RESOLVED |
| PDA-17 | RESOLVED |
| PDA-18 | RESOLVED |
| PDA-19 | DEFERRED |
