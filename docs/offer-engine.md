# Offer Engine

## Feature flags (all disabled by default)

```
FIRST_BOOKING_OFFER_ENABLED=false
FIRST_BOOKING_OFFER_PERCENT=10
FIRST_BOOKING_OFFER_CAP_CENTS=4000
FIRST_BOOKING_OFFER_TRIGGER_SECONDS=120
FIRST_BOOKING_OFFER_STACKING=false

# Legacy aliases (still supported)
FIRST_BOOKING_PERCENT=10
FIRST_BOOKING_CAP_CENTS=4000
OFFER_STACKING_ENABLED=false
```

Branch Deploy QA only (do **not** enable in production until review):

```
FIRST_BOOKING_OFFER_ENABLED=true
```

Preview URL pattern: `https://operations-core-job-lifecycle--cardetail1.netlify.app/`

## Offers

### A. First Booking Welcome

- 10% off eligible service subtotal, max $40 savings
- One redemption per eligible new household
- Excludes fleet, maint tier (when configured), fees, custom quotes

### B. Multi-Vehicle Same-Visit

- Credit per additional eligible personal vehicle (same location, same visit)
- Personal vehicles only; max additional vehicles configurable

### C. Stacking

When disabled: evaluate both, apply **higher customer benefit only**. When enabled: stack with transparent line items.

## Server authority

`netlify/lib/revenue-offers.js` validates:

- New-customer status
- Prior completed services
- Vehicle count and same-location rules
- Package/category eligibility
- Fleet exclusion

Client never applies discounts without server confirmation.

## Display rules

- Real financial line items only
- No fake urgency or permanent countdowns
- Transparent terms when enabled

## Google Business Profile

When an offer is enabled, use manual checklist (in `docs/revenue-intelligence.md` activation section): title, description, dates, terms, landing URL, UTM, image, renewal process. Code does **not** auto-publish to GBP.
