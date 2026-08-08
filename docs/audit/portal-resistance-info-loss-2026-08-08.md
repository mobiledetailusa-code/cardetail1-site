# Portal resistance & information-loss check

Date: 2026-08-08  
Branch / preview: `fix/portal-receipt-refresh-ux` → https://deploy-preview-171--cardetail1.netlify.app  
Method: code audit + HTTP smoke of Customer/Admin/Receipt shells + local portal UI tests (137 pass). Browser automation MCP was unavailable; **admin password was not used** (treat prior chat password as compromised / rotate).

## Smoke — pages load

| Surface | Preview HTTP | Notes |
|---------|--------------|-------|
| My Garage | 200 | Sign-in shell + dashboard markup present |
| Admin login | 200 | Login form present |
| Admin Ops | 200 | Full ops shell present |
| Receipt | 200 | Page shell (auth still required for data) |
| `my-garage.js` | 200 | Contains sticky-focus full-booking resolve (`matchesFocusRef`) |

Local portal UI suite: **137/137 pass** (`portal-ops-smoke`, `my-garage-portal`, admin/customer e2e, loading UX, visual hotfixes, admin-ops-interface).

## Customer — resistance / information loss

| Sev | Finding | Effect |
|-----|---------|--------|
| P0 | Sync hash still includes `msRemaining` + nested `serverTime` in `postServiceState` | `notModified` almost never fires → full dashboard repaint on every poll → flicker / “Updating…” |
| P0 | Hero not auto-pinned after pay unless a focus ref already exists | Paying one booking can hand the spotlight to another (`selectUpcoming`) |
| P0 | Receipt from phone-lookup / action-link without cookie | Auth falls through; customer sees phone-required copy on a page with no phone field |
| P1 | Transient focus miss on poll clears focus + toast | Feels like the portal “kicked” the appointment |
| P1 | Card-on-site / processing looks like $0 paid | Attempt status not explained in Payments panel |
| P1 | Refunded booking may hide receipt CTA while server would still serve | Net settled vs gross settled mismatch |
| P2 | Duplicate scheduling rows / cancelled bare `$` / tip-photos unused | Noise or missing context, not money authority loss |
| Fixed here | Sparse `focusedAppointment` blanking vehicles | Full booking resolved from list |
| Fixed here | Pay CTA with `$0` due | CTA requires `due > 0` |
| Fixed here | Paid markers → History | `appointmentIsPast` expanded |
| Fixed here | Draft Blob + paid ledger blocks receipt | Ledger-paid bypass |

## Admin — resistance / information loss

| Sev | Finding | Effect |
|-----|---------|--------|
| P1 | Settings form can re-stamp on any jobs/requests change poll | Mid-edit overwrite risk |
| P1 | “Updating…” on every poll | Feels unstable even when data unchanged |
| P1 | Changed poll still full DOM rewrite of tabs | Scroll / open menu loss (skip-render only when *both* `notModified`) |
| P2 | 32 `prompt` / 25 `confirm` (not all money) | Friction; cash confirm can show `$NaN` before server rejects |
| P2 | Lean list may lag drawer money fields until re-open | Attempt/refund detail lag |
| Fixed here | Forever-fast poll on `awaiting_customer_payment` | Stable 15s when idle |
| Fixed here | Skip full re-render when jobs+requests both `notModified` | Reduces idle flicker |

## What a logged-in browser pass still needs (you)

Without rotating credentials and signing in, these cannot be proven from here:

1. Multi-booking account: select A, wait 60s — does hero stay on A?
2. After card pay / card-on-site: does History show the paid job and does receipt open?
3. Admin: type in Settings for 30s while Jobs poll — does the field reset?
4. Admin drawer open on a job — does selection jump?

Use **Deploy Preview 171** (or merge), **not** the old compromised password until rotated.

## Relation to PR #172

#172 still has the strongest fix for P0 clock-poison + receipt credential replay + hero pin after pay. Merging only #171 leaves customer poll churn. Merging only #172 may soften paid→History and re-boost admin pending poll — reconcile before production.
