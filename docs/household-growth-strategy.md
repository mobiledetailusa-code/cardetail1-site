# Household Growth Strategy

> See also: [Universal Customer Strategy](./universal-customer-strategy.md) — every visitor gets an appropriate path; multi-vehicle is a priority growth segment, not the only ICP.

## Primary ICP: Multi-Vehicle Household

Residential customers with **two or more personal vehicles** at the **same service location**, eligible for coordinated scheduling and recurring maintenance.

## Household / Garage Account

A household is a private first-party account containing:

- Opaque `household_id` and linked `lead_id`
- Vehicle count and asset categories (customer-provided)
- Service address reference (server-side dedup hash only)
- Opportunity stage, intent score, household value score
- Consent flags (transactional, marketing, SMS, email)

**Not used:** ZIP affluence, inferred income, race, family status, or other sensitive traits.

## Commercial segments

1. **SINGLE_VEHICLE_NEW** — one vehicle, no completed booking
2. **MULTI_VEHICLE_HOUSEHOLD** — 2+ personal vehicles, same location (primary ICP)
3. **PREMIUM_ENTHUSIAST_HOUSEHOLD** — 2+ enthusiast/luxury vehicles from customer-provided make data
4. **SPECIALTY_ASSET_OWNER** — boat, RV, powersports, etc.
5. **RECURRING_MAINTENANCE_PROSPECT** — stated maintenance interest
6. **COMMERCIAL_FLEET** — business-owned or 7+ vehicles (quote-only)
7. **RETURNING_CUSTOMER** — prior completed service
8. **MANUAL_REVIEW_OR_ALTERNATIVE_PATH** — operational alternative path (extended area, specialty access review)

## Build Your Garage Plan

Public flow (`assets/garage-plan.js` + `garage-plan-submit` function):

- Collects vehicle count, categories, same-visit interest, contact, ZIP, consent
- **No card data** in discovery
- 2–6 personal vehicles → household opportunity
- 7+ or business → fleet quote route

## Messaging principles

- All customers: *Professional mobile detailing at your home, office or approved location.*
- Multi-vehicle: *One visit. Multiple vehicles. A service plan built around your garage.*
- No fake timers, crossed-out prices, or hidden fees

## Landing page

`/multi-vehicle-detailing.html` — focused SEO page, in sitemap, linked from footer and contextual CTAs.
