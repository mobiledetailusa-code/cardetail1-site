# External Integrations

All integrations are **optional** and **disabled by default**. Booking works when any adapter is blocked or unconfigured.

## HubSpot CRM (server-side)

| Variable | Purpose |
|----------|---------|
| `HUBSPOT_INTEGRATION_ENABLED` | `false` default |
| `HUBSPOT_PRIVATE_APP_TOKEN` | Server-only |
| `HUBSPOT_PORTAL_ID` | Portal reference |

Contacts/deals sync only after legitimate lead identification. No anonymous session sync. Dedupe by normalized email/phone/`cardetail1_lead_id`.

Browser HubSpot tracking: **not installed** — audit found no existing snippet; do not duplicate if added later.

## GA4 / GTM

| Variable | Purpose |
|----------|---------|
| `GTM_CONTAINER_ID` | Set as `CD1_GTM_CONTAINER_ID` in page config |
| `GA4_MEASUREMENT_ID` | Set as `CD1_GA4_MEASUREMENT_ID` fallback |

Loaded only after Analytics consent. CSP updated in `netlify.toml` for GTM/GA4/Clarity domains.

## Google Ads (gtag.js)

| Variable | Purpose |
|----------|---------|
| `CD1_GOOGLE_ADS_ID` | Optional override; default `AW-11321647982` |
| `CD1_GOOGLE_ADS_PAGE_VIEW_SEND_TO` | Optional override; default `AW-11321647982/r6SRCJeL998YEO7GypYq` (Page view — observation only) |
| `CD1_GOOGLE_ADS_BOOKING_SEND_TO` / `CD1_GOOGLE_ADS_PURCHASE_SEND_TO` | Optional override; **Booking submitted** conversion on durable finalize; default `AW-11321647982/yrODCJGL998YEO7GypYq` |

Base tag + **Page view** conversion load on every public page via `assets/revenue-events.js` (`initAdapters`), using **Consent Mode v2**:

- Defaults: `ad_storage` / `ad_user_data` / `ad_personalization` / `analytics_storage` = `denied`
- Marketing opt-in → `ad_*` = `granted`; Analytics opt-in → `analytics_storage` = `granted`
- Tag + conversion always fire so Google Ads receives pings (cookieless when denied); full attribution cookies only after Marketing accept

**Booking submitted** conversion (`CD1_GOOGLE_ADS_BOOKING_SEND_TO` / legacy `CD1_GOOGLE_ADS_PURCHASE_SEND_TO`) fires once via the canonical persist path:

`Cardetail1BookingReview.markPersisted` → `Cardetail1CheckoutAnalytics.onBookingSubmitted(evidence)` → `Cardetail1Revenue.trackGoogleAdsBookingConversion`

only when finalize evidence shows `ok`, durable booking `id`, `bookingCreated === true` (or idempotent replay of that same id), and an authoritative `approvedFinalAmount`. Payload: `send_to`, `value`, `currency: 'USD'`, `transaction_id: bookingId`. Cash and Card share this conversion. It is not tied to a Stripe charge and is never the Page view label.
CSP allows `googletagmanager.com` / `googleadservices.com` / `google.com` / `googleads.g.doubleclick.net` / `ad.doubleclick.net` / `pagead2.googlesyndication.com`.

## Microsoft Clarity

| Variable | Purpose |
|----------|---------|
| `CD1_CLARITY_PROJECT_ID` | Project ID |

Custom tags: `page_type`, `category`, `package_id`, `booking_step`, `household_segment`, `lead_temperature`, `vehicle_count_band`. Masked: forms, payment, PII fields (`data-clarity-mask="true"`).

## Resend / Twilio

Existing: booking notifications, inquiries, auction dispatch.

New: recovery communications (`recovery-communications.js`) — dry-run by default.

## Google Ads Data Manager readiness

| Variable | Purpose |
|----------|---------|
| `GOOGLE_ADS_EXPORT_ENABLED` | `false` default |
| `GOOGLE_ADS_CUSTOMER_ID` | Account ID when ready |

Preserves `gclid`, `gbraid`, `wbraid` first-party. Server-side hashed email/phone for future offline conversion upload. No deprecated legacy-only upload path.

## Environment summary

See `docs/privacy-and-consent.md` for consent requirements per integration.
