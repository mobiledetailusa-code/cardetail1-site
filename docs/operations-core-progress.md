# Operations Core — Implementation Log

Branch: `operations-core-job-lifecycle`  
Base SHA: `2c842b8ac92993cd16f6084ddd018a62c50c5408`  
Last updated: 2026-07-12

## CARDDETAIL1 extension — checkout, WELCOME10, Back to Top (2026-07-12)

- **Four-step checkout:** `BK_VISIBLE_STEPS = 4` — Service (ZIP+category+package), Vehicle & add-ons, Contact & schedule, Secure & submit (payment + review)
- **WELCOME10:** `netlify/lib/booking-offers.js`, `evaluate-booking-offer.js`, server apply in `submit-booking.js`; client panel `assets/checkout-offer.js`
- **Analytics:** `assets/checkout-analytics.js` — funnel events without PII; GA4 `begin_checkout` / `add_payment_info` / `purchase` (purchase only on real payment)
- **Back to Top:** `assets/back-to-top.js` uses `document.scrollingElement`, keyboard Enter/Space
- **Tests:** `tests/checkout-offer-btt.test.js`
- **Branch QA:** set `FIRST_BOOKING_OFFER_ENABLED=true` on Branch Deploy only


- **Tests at base:** 871 pass
- **Signature failure root cause:** white stroke (`#ffffff`) on transparent canvas exports invisible PNG on admin white background; `resize()` clears canvas without resetting `hasInk`; server only checks signature string length
- **Deploy architecture:** Netlify static + Functions; Blob stores (`cd1-bookings`, `cd1-tech-*`, `cd1-customer-*`)
- **Stripe:** existing card-on-file + payment link functions unchanged; no new charges in this branch

## Phase 2 — Lifecycle model

- Added `netlify/lib/operations-lifecycle.js` — `service_status`, `payment_status`, `customer_approval_status` with legacy `jobStatus` sync
- Role-based transition permissions and tech adjustment limits (`TECH_ADJUSTMENT_MAX_PERCENT`, `TECH_ADJUSTMENT_MAX_CENTS`)

## Phase 3 — Audit log

- Added `netlify/lib/operations-audit.js` — immutable entries in `cd1-operations-audit` with redacted state

## Phase 4–7 — Technician workflow

- `tech-complete-job.js` rewritten: no mandatory signatures; payment channels (online, cash, card on site, customer unavailable); idempotent completion; adjustment validation
- `technician.html`: optional signatures, technician confirmation checkbox, payment channel UI, pause/resume, package checklist/description in job cards
- `tech-jobs.js`: `paused` status support
- `ops-workflow.js`: expanded `projectJobForTech` (vehicles, package description, checklist)

## Phase 8 — Customer completion link

- `netlify/lib/customer-completion-link.js` — hashed tokens, TTL, revocation
- `netlify/functions/customer-portal-action.js` — view / approve / report issue
- `assets/my-garage.js` — `?action=` token handling with URL cleanup

## Phase 9–14 — My Garage & refresh

- `index.html` — My Garage in desktop + mobile top navigation
- `assets/operational-refresh.js` — shared polling/focus/visibility refresh controller
- `netlify/lib/customer-feature-flags.js` — gift cards / subscriptions / flexible payments disabled by default

## Tests

- **Final count:** 889 pass (`tests/operations-core.test.js` + regression updates)
- Pre-deploy audit: pass

## Remaining (non-blocking for PR open)

- Full Admin operational control expansion (create appointment, notification delivery UI)
- Branch-only synthetic E2E harness (`QA-OPSCORE`) and full lifecycle E2E run
- `sync-public-surface.mjs` propagation of My Garage nav to all public pages (index done)
- Admin audit history tab UI
- Invalid-email notification decoupling in `submit-booking.js` (architecture documented; not yet split)

## Blockers

- None for opening PR; Branch Deploy E2E pending push + Netlify build
