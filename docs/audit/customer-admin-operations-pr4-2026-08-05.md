# PR4 — Customer/Admin appointment operations

Date: 2026-08-05
Branch: `fix/customer-admin-operations-pr4`
Base: `fix/portal-sync-pr3` (`15c60e1611fb27242c97f944862282c1fbb57aba`)
Scope: Customer/My Garage ↔ Admin Ops appointment changes
Database migration: none
Production/deploy: not performed

## Executive result

PR4 makes vehicle, package and add-on changes use one server-authoritative, versioned and idempotent mutation contract. Customer requests and Admin decisions now retain a stable operation key across uncertain retries, reject stale or conflicting writes with HTTP 409, and compute every price change from the canonical server catalog.

Paid reductions create an explicit outstanding credit and preserve settlement history. They do not perform an automatic refund. Paid increases create only the unpaid delta. Stripe remains in test mode for validation and Twilio remains disabled.

## Implemented behavior

- Add, replace and remove vehicles by stable `vehicleId`; the final vehicle cannot be removed.
- Removed and replaced vehicles are copied into append-only vehicle history before leaving the active service.
- Package and add-on mutations target one explicit vehicle; ambiguous multi-vehicle requests are rejected.
- Add-ons already included in the selected package remain visible as included treatments but are removed from billable add-ons.
- Before payment, approved totals are recalculated from the canonical catalog.
- After payment, increases expose an unpaid delta and reductions expose a credit/refund candidate compatible with PR2; no automatic refund is issued.
- Paid customer changes require Admin review. Admin approval executes the same PostgreSQL-authoritative financial mutators used by direct Admin operations.
- Customer submissions, Admin decisions and direct Admin mutations require `expectedBookingVersion` and a valid idempotency key at their HTTP boundaries.
- A lost-response retry with the same key and payload replays the original receipt; reuse with a different payload or a stale new key returns 409 without a second mutation or audit entry.
- Browser mutation keys survive network, 429 and 5xx uncertainty. Canonical state is reloaded after conflicts.
- Existing PR3 session refresh, multiple-tab, focus/visibility, offline/online and last-good-state behavior is preserved.
- Loading, empty, offline, 401, 403, 404, 409, 429 and 5xx states remain distinct in Customer and Admin paths.
- Admin and Customer projections expose the same booking/quote versions, approved amount, settled amount, balance, credit and vehicle/package/add-on state.
- The legacy free-form `update_vehicles` Admin route is retired with HTTP 410 so it cannot bypass the authoritative financial path.
- My Garage and the Admin sign-in boundary have no mobile horizontal overflow, use 16 px form inputs and provide 44 px primary touch targets.

## Financial invariants

| Operation | Approved | Settled | Result |
|---|---:|---:|---|
| Prepay increase | rises to canonical total | unchanged | larger amount due |
| Prepay reduction | falls to canonical total | unchanged | smaller amount due |
| Postpay increase | rises to canonical total | preserved | unpaid delta only |
| Postpay reduction | falls to canonical total | preserved | explicit credit; no automatic refund |
| Same-key replay | unchanged | unchanged | original receipt returned |
| Version/key conflict | unchanged | unchanged | HTTP 409 |

Browser-supplied prices, totals and labels are ignored. PostgreSQL adjustments are immutable, compatibility projections are updated after the authoritative commit, and booking history is not destroyed.

## Verification

- Focused PR4 contract: **9 tests, 4 suites, 0 failures**.
- Full suite with PostgreSQL 16, `POSTGRES_PAYMENT_AUTHORITY=true` and `TWILIO_ENABLED=false`: **2,193 tests, 141 suites, 0 failures**.
- Fresh-database migration deployment: all six existing migrations applied from zero; `prisma migrate status` reported up to date.
- Local Netlify build: green; all Functions bundled. No site deploy was invoked.
- Browser QA: My Garage and the Admin authentication boundary loaded without JavaScript console errors in desktop and 390×844 mobile viewports.
- Mobile measurements: document scroll width did not exceed client width; visible form inputs were 16 px; primary controls were at least 44 px high.
- `git diff --check`: no whitespace errors (Windows CRLF conversion warnings only).
- No Owner Studio file, Prisma migration, live Stripe credential, live Twilio credential, charge, SMS, merge, deploy or production system was touched.

The exact immutable PR head and its post-commit rerun are recorded in the PR evidence. Changing that SHA invalidates the evidence and requires the full verification to run again.

## Visual QA

The branch was served locally. No real Admin credential, customer credential, financial operation or external message was used. The Admin images therefore show the secure unauthenticated boundary; authenticated operation behavior is covered by the automated PostgreSQL test matrix.

- [My Garage desktop](../qa/pr4/my-garage-desktop.png)
- [My Garage mobile](../qa/pr4/my-garage-mobile.png)
- [Admin secure boundary desktop](../qa/pr4/admin-ops-desktop.png)
- [Admin secure boundary mobile](../qa/pr4/admin-ops-mobile.png)

## Risk and rollback

Main risk: PR4 enlarges the mutation surface and introduces idempotent operation receipts in the booking aggregate. A malformed legacy record could expose an unanticipated projection shape. Mitigations are strict server target validation, catalog-only pricing, optimistic CAS, deterministic receipts, PostgreSQL retry classification, bounded receipt history and full compatibility projection tests.

Secondary risk: a paid reduction creates a credit requiring the existing PR2 refund workflow; operators must not interpret it as an already-issued refund. Admin and Customer projections keep credited and refunded amounts separate.

Rollback: revert the single PR4 commit while leaving PR160/PR3 in place. PR4 has no database migration or backfill. Existing PostgreSQL adjustment rows are immutable and safe to retain; reverting removes the new mutation entry points but does not reverse a legitimate operation already committed. Any already-created credit/refund case must be resolved through the PR2 audited workflow, never by editing ledger rows.

## Owner review checklist

- Review the stacked base and confirm the PR head still matches the validated SHA.
- Exercise add, replace and remove vehicle in Customer and Admin test accounts, including the final-vehicle denial.
- Exercise package and add-on changes on single- and multi-vehicle appointments, including an add-on already included in the package.
- Verify prepay increase/reduction and postpay delta/credit in Admin, Customer, quote, ledger, receipt and Stripe test mode.
- Retry the same operation key after an induced lost response; then reuse it with a changed payload and confirm 409.
- Open two Admin/Customer tabs and force a stale-version conflict in both directions.
- Exercise offline/online, focus/visibility, session refresh, 401, 403, 404, 429 and 5xx behavior.
- Confirm no customer can target a booking outside the authenticated subject.
- Confirm Twilio remains disabled and no SMS is emitted.
- Do not merge until PR157, PR158, PR159 and PR160 are accepted in order and this PR is rebased/revalidated on the resulting base.

**READY FOR OWNER REVIEW**
