# Admin authority + portal stabilize — 2026-08-08

## Goal

Ship Phase 1 P0 fixes (Admin cash/card conclude path, Customer multi-booking hero, clock-poison) then Phase 2 Admin work-order drawer — Admin-first, without merging PR #172’s false “Confirmed by your bank” copy.

## Phase 1 — Stabilize

### 1A Admin cash/card / complete / close

- Inline cash/card panels replace `prompt()` amount paths; `parseCashAmountInput` strips `$`/commas and rejects NaN.
- Prefer omitting `amount` when it matches remaining so Postgres settles `remainingCents`.
- Toasts surface `error` + `message`/`reason` + `expectedAmountCents`.
- `payment_attempt_in_progress` blocks settle with a clear explanation (capability + toast).
- New lifecycle action `close_job` / `closeJobWhenPaid` — marks `completed_paid` only when invoice is settled; does **not** invent ledger credits.
- Explicit 3-step copy: Complete service → Record cash/card → Close job when paid.

### 1B Customer priority + poll

- After successful pay / settle poll: pin `appointmentFocusRef` to the paid booking.
- `selectUpcoming`: after actionable, prefer open balance / payment-pending; settled-paid only competes when nothing else is active.
- Safe #172 cherry-pick: remove `msRemaining` + nested `serverTime` from `postServiceState` (stops sync hash poison); silence idle “Updating…” unless `portalHasPendingState()`.
- **Not** brought over: false bank-confirmed copy.

### 1C Validation

- Unit tests: `tests/admin-authority-stabilize.test.js` (cash parse, close when paid, selectUpcoming, clock-poison, UI seams).
- Manual checklist (Deploy Preview):
  - [ ] Admin: record cash / card on-site for remaining balance; toast on mismatch / PI in progress
  - [ ] Admin: Complete service then Close job when paid after settle
  - [ ] Customer: two bookings same email — pay one; hero stays on paid (pin); unpaid sibling becomes default when pin cleared / new session prefers open balance
  - [ ] Customer: idle poll does not flicker “Updating…” or swap hero

## Phase 2 — Admin hub

Drawer tabs: **Resolve → Services → Schedule → Money → Create → Notes → More**

1. **Resolve** — contact, confirm/assign/cancel/reopen, tech status, complete service, approve completion, close when paid  
2. **Schedule** — reschedule only  
3. **Money** — balance, inline cash/card, refund, adjustments; 410 affordances (no-show / late cancel / mark refunded / legacy checkout) hidden  
4. **Create** — “New appointment from this booking” → `create_appointment` prefilled  
5. **More** — dispatch, requests, completion evidence, audit; **Customer access links last**

## Out of scope (unchanged)

- Merge of PR #172 intact  
- Homepage / hubs redesign  
- Stripe webhook / Connect  
- Action-link single-use security PR  

## Files touched (primary)

- `admin-ops.html`
- `netlify/functions/admin-ops-jobs.js`
- `netlify/lib/admin-booking-mutations.js`
- `netlify/functions/customer-portal-data.js`
- `netlify/lib/post-service-experience.js`
- `assets/my-garage.js`
- `tests/admin-authority-stabilize.test.js` (+ small expectation updates in related Admin UI tests)
