# Notification pipeline — operational runbook (Cardetail1)

Keep this stage cheap: **read this + run the status script**. Do not re-audit Production history unless a real booking failed.

**PR split:** public Call/Text digits live in a separate phone PR. This runbook is notification/ops only.

## Providers (contract)

| Channel | Provider | Do not |
|---|---|---|
| Email | **Resend** | Migrate to Twilio Email / SendGrid |
| SMS | **Twilio** Messaging Service | Buy a second DID for admin alerts |

Customer SMS requires valid customer consent. Owner/admin alerts use `ADMIN_SMS` + `ADMIN_SMS_CONSENT_GRANTED` and are **not** gated by customer consent.

## Model (one Twilio number)

| Role | What it is |
|---|---|
| Outbound SMS sender | Messaging Service DID `+1…5668` |
| Owner SMS recipient | Netlify `ADMIN_SMS` (owner cell) |
| Public Call/Text on site | Separate phone PR (presentation only) |

## Email roles (cardetail1.com) — live Workspace aliases

| Address | Role | Configured |
|---|---|---|
| `support@cardetail1.com` | Production `ADMIN_EMAIL` (TO) | Netlify Production + Google alias (deliverable) |
| `booking@cardetail1.com` | `RESEND_FROM` (FROM) | Resend + Google alias (deliverable) |
| `billing@cardetail1.com` | Reserved | Google alias |
| `admin@cardetail1.com` | Not required while support@ is TO | Not created |
| Legacy Gmail | Preview/dev/branch `ADMIN_EMAIL` only | Non-production contexts |

Spelling: **cardetail1.com** only (not cardtel1).

## Cheap status / owner QA (local ops — no Netlify Function)

```bash
node scripts/notification-ops-status.js
# Optional read-only audit (needs DB URL when inspecting bookings):
node scripts/notification-pipeline-audit.js
# Owner synthetic email uses scripts/lib/notification-qa.js helpers (ADMIN_EMAIL only).
```

There is **no** `qa-notification-pipeline` Netlify Function in Production runtime.

## What agents should not redo

- Full booking timeline recon when ops status is green
- Buying Twilio numbers
- Pointing destinations at `cardtel1` typos
- Shipping a public QA Function that accepts arbitrary recipients
