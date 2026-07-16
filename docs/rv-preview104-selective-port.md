# RV Preview 104 selective port

**Branch:** `fix/rv-preview104-commercial-final`  
**Baseline:** `b8f2c5acdb4f79059f025a6a6722e4516fbb38cc` (origin/master after PR #108)  
**Preview 104 full SHA:** `31237b352d589dc9623dc9b8075c0310f34e12f2`  
**Preview 104 merge:** `ad904aecb9cabf77df537e1d841180f6402f6c44`  
**Preview 104 source branch:** `fix/rv-powersports-ba-from-pics` (PR #104 → master)  
**Netlify Deploy Preview ID:** `6a5675018b116a000890f725`  
**Deploy URL:** https://deploy-preview-104--cardetail1.netlify.app/rv-detailing

## Ported (presentation only)

- Compact tabbed package cards (Outside Only / Inside Only / Inside & Out) via `assets/rv-commercial.css` + `assets/rv-package-tabs.js`
- Accessible tablist with keyboard navigation; inactive panels use `[hidden]` — all six packages remain in DOM
- Hero / trust / FAQ / bottom CTA → Book Online via canonical booking launcher
- Package CTAs: `package-booking-cta` + `data-booking-category="rvs"` + `data-booking-package`
- Per-foot card pricing (`Starting at $X.XX/ft`) — no default length totals on the landing page
- Approved six-package scopes with compact inclusions + `<details>` expansion
- Gallery section unchanged
- Vehicle-step RV type / living quarters / exact length / service subtotal in `index.html` (six-step booking preserved)

## Rejected (not restored)

- ZIP-first pricing funnel (`assets/rv-pricing-funnel.js` / `.css`)
- Preview 104 backend / old booking / default 24 ft pre-pricing
- RV Care Membership section
- Preview 104 legacy package IDs and `~Xh` service-hour badges
- Blanket 7% bump logic
- Changes to boats, powersports, fleet, cars, Stripe, or Twilio

## Authoritative rates

| Package | perFt | min | Reason |
|---------|-------|-----|--------|
| maint | 12.75 | 225 | Approved correction |
| maint_light | 16 | 229 | Preserved |
| interior | 21 | 249 | Preserved |
| full_basic | 31 | 399 | (12.75+21)×0.92 bundle |
| premium | 33 | 449 | Preserved |
| full | 49.5 | 699 | (33+21)×0.92 preserved |

19-ft Travel Trailer Maintenance Wash service subtotal: **$242.25** before travel.

## Sync

- `scripts/sync-rv-pricing-blocks.mjs` and `scripts/sync-public-surface.mjs` are idempotent (second run zero diff).
