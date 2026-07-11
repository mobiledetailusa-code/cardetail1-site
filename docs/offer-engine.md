# Offer Engine

## Feature flags (all disabled by default)

```
FIRST_BOOKING_OFFER_ENABLED=false
FIRST_BOOKING_PERCENT=10
FIRST_BOOKING_CAP_CENTS=4000

MULTI_VEHICLE_OFFER_ENABLED=false
MULTI_VEHICLE_ADDITIONAL_CREDIT_CENTS=2500
MULTI_VEHICLE_MAX_ADDITIONAL_VEHICLES=2

OFFER_STACKING_ENABLED=false
```

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
