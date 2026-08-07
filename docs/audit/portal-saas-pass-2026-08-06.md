# Portal SaaS pass — Customer / Admin

Date: 2026-08-06  
Branch: `fix/portal-receipt-refresh-ux`  
Scope: Customer My Garage + Admin Ops only (no homepage / local hubs / Stripe config changes)

## Live evidence (Postgres)

Booking `CD1-MSI77ZFX-RHK5` (Subaru payment case):

| Field | Value |
|-------|--------|
| Found | yes |
| Postgres status | `submitted` |
| Quote | v3 / `approvedCents` 26000 |
| Ledger | settlement `card_on_site` 26000 |
| Projection | `paymentStatus: paid`, `remainingCents: 0` |
| PaymentAttempts | none (on-site path) |
| Same account siblings | 11 bookings under `cmrzxrek60000f41n6nnxxrhx` |

Root cause of receipt page message **"This booking is not available in My Garage yet"**: visibility gate ran before ledger read; Blob could still look draft while Postgres already showed paid. Browser MCP was unavailable in this session; evidence is from Prisma projection + code path.

## Checklist

### Customer My Garage

| Area | Result | Notes |
|------|--------|-------|
| Sign-in / session | Pass (code) | Soft reload retains session on 429 |
| Multi-appointment select | Fixed | Sticky `appointmentFocusRef`; no longer overwritten by `selectUpcoming` on every poll |
| Pay Balance CTA | Fixed | Requires `due > 0`; specific prepare error messages |
| Payment Element | Untouched | No Stripe contract change |
| Receipt payment/final | Fixed | Ledger-paid unlocks receipt even if Blob draft-looking |
| Print / PDF | Pass (code) | Existing print path unchanged |
| History for paid | Fixed | `paid` / `paid_card_on_site` / `payment_succeeded` → History |
| Sync status | Improved | Stable poll 15s; active 2.5s only while truly pending |
| Change requests / profile | Pass (code) | Out of this defect set |

### Admin Ops

| Area | Result | Notes |
|------|--------|-------|
| Jobs list / drawer | Improved | Skip full DOM rewrite when jobs+requests `notModified` |
| Polling | Fixed | 15s stable; `awaiting_customer_payment` no longer forces 2.5s forever |
| Confirm / portal release | Pass | Existing `portalReleasePatch` retained |
| On-site / card settle | Fixed | Compatibility sync + on-site close apply `portalReleasePatch` when still draft |
| Payment panel / reconcile | Pass (code) | Authority path unchanged |
| Change requests / settings | Pass (code) | No intentional change |

## P0 / P1 addressed in this pass

1. **P0** Receipt blocked after paid ledger → allow when `grossSettledCents`/`settledCents`/`paymentStatus=paid`
2. **P0** Portal flicker / alternating bookings → 15s stable + sticky focus + Admin skip-render on notModified
3. **P1** Generic "Payment is not available yet" → mapped prepare errors + CTA gated on due
4. **P1** Paid Subaru missing from history → paid markers + status `submitted` as submission marker
5. **P1** Draft stuck after card_on_site → portal release on blob compatibility sync / on-site close

## Residual / follow-up (not blocking this PR)

- Browser E2E on production after deploy (login CD1, open Subaru receipt URL, confirm History).
- One-time Blob repair for already-paid draft rows: after deploy, Admin reopen job or any payment sync that calls `syncBlobCompatibilityFromProjection` will release; receipt works immediately via ledger even before Blob catches up.
- Vehicles empty on Postgres row for RHK5 — catalog/vehicle mirror gap; does not block receipt money figures from quote/ledger.
- Full SaaS multi-tenant / RBAC / WebSockets — out of scope.

## Non-goals (confirmed unchanged)

- Homepage / state hubs design
- Stripe webhook signing, Connect, Checkout Session contracts
- New auth system
