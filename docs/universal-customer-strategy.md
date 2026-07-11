# Universal Customer Strategy

> Every legitimate visitor is a potential customer. Multi-vehicle households are a **priority growth segment**, not the only ICP.

## Authoritative configuration

**Single source of truth:** `shared/universal-customer-strategy-config.json`

- Backend loads via `netlify/lib/universal-customer-strategy.js`
- Frontend loads via `assets/universal-customer-strategy.generated.js` (sync script)
- Parity tests fail on any config or behavior divergence

Regenerate frontend bundle after config edits:

```bash
node scripts/sync-universal-strategy-config.mjs
```

## Segment identifiers

| Segment | Purpose |
|---------|---------|
| `SINGLE_VEHICLE_NEW` | First-time single-vehicle customer |
| `MULTI_VEHICLE_HOUSEHOLD` | Priority growth — 2+ vehicles |
| `PREMIUM_ENTHUSIAST_HOUSEHOLD` | Customer-provided enthusiast vehicles |
| `SPECIALTY_ASSET_OWNER` | Boat, RV, powersports, etc. |
| `RECURRING_MAINTENANCE_PROSPECT` | Stated maintenance interest |
| `RETURNING_CUSTOMER` | Prior completed service |
| `COMMERCIAL_FLEET` | Business / 7+ vehicles — quote path |
| `MANUAL_REVIEW_OR_ALTERNATIVE_PATH` | Operational alternative path (not low customer value) |

## Routing controls (replaces `packagesVisible`)

| Property | Meaning |
|----------|---------|
| `catalogVisible` | Public catalog/pricing may be shown |
| `standardBookingAllowed` | Residential checkout/booking modal permitted |
| `quoteRequired` | Must use fleet/commercial quote path |
| `manualReviewRequired` | Routed to manual review — no residential checkout |
| `discardLead` | Must always be `false` for legitimate visitors |

### Expected routing

**Single-vehicle / normal specialty / multi-vehicle / returning / maintenance:**
- catalogVisible ✓, standardBookingAllowed ✓, quoteRequired ✗, manualReviewRequired ✗

**Commercial Fleet:**
- catalogVisible ✓, standardBookingAllowed ✗, quoteRequired ✓, manualReviewRequired ✗

**Manual Review or Alternative Path:**
- catalogVisible ✓, standardBookingAllowed ✗, quoteRequired ✗, manualReviewRequired ✓

Fleet and manual-review segments must **not** enter inappropriate residential checkout even when the catalog is visible.

## Anonymous vs identified

| | Anonymous prospect | Identified lead |
|--|-------------------|-----------------|
| `anonymous_session_id` | Yes | Yes (linked) |
| Intent / segment hypothesis | Yes | Yes |
| Analytics events | Yes | Yes |
| `lead_id` | **No** | Yes (after contact form/booking) |
| CRM contact | **No** | After identification |
| Recovery email/SMS | **No** | With consent |
| Admin identity | **No** | Yes (authorized admin) |

Identification requires approved contact submission (name + phone minimum) through a legitimate form or booking flow. Identity is never inferred from analytics alone.

Implementation: `netlify/lib/anonymous-prospect.js`

## Follow-up tiers

Intent-led: `immediate` → `priority` → `scheduled` → `nurture` (not discard, not “low value”).
