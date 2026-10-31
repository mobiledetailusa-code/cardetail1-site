# Revenue Intelligence

## Overview

Cardetail1 Revenue Operations (RevOps) adds a first-party event layer, household/garage account model, and protected admin dashboard **without changing production pricing, Stripe flows, or package IDs**.

## Architecture

| Layer | Location | Purpose |
|-------|----------|---------|
| Client events | `assets/revenue-events.js` | `Cardetail1Revenue.track()` |
| Segments | `assets/customer-segments.js` | Deterministic ICP classification |
| Scoring | `assets/lead-score.js` | Intent + household value |
| Next action | `assets/next-best-action.js` | Commercial recommendations |
| Consent | `assets/consent-manager.js` | Necessary / Analytics / Marketing |
| First-party ingest | `netlify/functions/revenue-event.js` | Validated POST endpoint |
| Private stores | Netlify Blobs `revenue-*` | Events, leads, households, opportunities |

## Event dictionary

See `netlify/lib/revenue-event-schema.js` for the full allowlist. Internal Cardetail1 names are preserved in the first-party store; GA4 recommended events are mapped when analytics consent is granted.

## GA4 mapping (consent: Analytics)

| Cardetail1 event | GA4 event |
|------------------|-----------|
| `lead_created` | `generate_lead` |
| `booking_started` | `begin_checkout` |
| `payment_method_saved` | `add_payment_info` |
| `booking_submitted` | `booking_submitted` (persisted request, not a purchase or captured payment) |
| `booking_confirmed` | `booking_confirmed` |
| `service_completed` | `service_completed` |

Primary conversions (validate before marking in GA4): `generate_lead`, `booking_submitted`, `booking_confirmed`, `service_completed`. A booking request, an approval, a completed service, and a captured payment are separate events.

## Retention

| Store | Default retention |
|-------|-------------------|
| `revenue-events` | 400 days |
| `revenue-leads` / `revenue-households` / `revenue-opportunities` | 730 days |
| `revenue-recovery-queue` | 180 days |
| `revenue-resume-tokens` | 90 days |

## Rollback

1. Remove RevOps script tags from public HTML (or revert branch).
2. Disable env flags (`*_ENABLED=false`).
3. RevOps Blob stores are isolated — no impact on `cd1-bookings`.

## Activation checklist

- [ ] Legal review of consent copy and SMS/email automation
- [ ] Set `GA4_MEASUREMENT_ID` in Netlify (read by `analytics-public-config`; no Measurement ID is stored in the repo). Do not add GTM unless the container is actually provisioned.
- [x] Google Ads base tag `AW-11321647982` + Page view conversion (Consent Mode; Marketing grants ad cookies)
- [ ] Set `CD1_CLARITY_PROJECT_ID` if using Clarity
- [ ] Configure `HOUSEHOLD_DEDUP_SECRET`, `RESUME_TOKEN_SECRET` (32+ chars) in production
- [ ] Enable offers only after commercial approval
