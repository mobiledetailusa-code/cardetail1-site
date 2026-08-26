# Notification pipeline — operational runbook (Cardetail1)

Keep this stage cheap: **read this + run the status script**. Do not re-audit Production history unless a real booking failed.

## Model (one Twilio number)

| Role | What it is | Buy new Twilio DID? |
|---|---|---|
| Public Call/Text on site | Same DID shown as `551-373-5668` / `tel:5513735668` | **No** |
| Outbound SMS sender | Messaging Service SID → single DID `+1…5668` | **No** |
| Owner SMS recipient | Netlify `ADMIN_SMS` (owner cell, e.g. `…2956`) | **No** — not a Twilio number |
| Customer SMS recipient | phone on the booking | No |

Customer + admin alerts both leave from the **same** Messaging Service number. `TWILIO_FROM` stays unset when Messaging Service is used. Public HTML `ADMIN_SMS` constants are **display/sms: handoff only**; they do not override Netlify `ADMIN_SMS`.

## Email roles (cardetail1.com) — live Workspace aliases

| Address | Role | Where configured |
|---|---|---|
| `support@cardetail1.com` | **TO** for owner alerts (`ADMIN_EMAIL`) | Netlify Production + Google alias |
| `booking@cardetail1.com` | **FROM** (`RESEND_FROM`) | Resend + Google alias |
| `billing@cardetail1.com` | Billing / receipts contact (reserved) | Google alias only for now |
| Optional `admin@` | Not required while `support@` is ADMIN_EMAIL | — |
| Legacy Gmail | Preview/dev/branch `ADMIN_EMAIL` only | Netlify non-production contexts |

Resend domain `cardetail1.com` is **verified**. MX → `smtp.google.com`.

## Netlify Production (agent can set)

Required presence:

- `ADMIN_EMAIL=support@cardetail1.com`
- `ADMIN_SMS=+1…` (owner E.164)
- `ADMIN_SMS_CONSENT_GRANTED=true`
- `RESEND_FROM=Cardetail1 <booking@cardetail1.com>`
- Twilio gates: `TWILIO_ENABLED`, `TWILIO_OUTBOX_ENABLED`, `TWILIO_PRODUCTION_SENDS_ENABLED`, `CUSTOMER_TRANSACTIONAL_SMS_ENABLED`
- Provider: `TWILIO_ACCOUNT_SID`, auth, `TWILIO_MESSAGING_SERVICE_SID` (no second DID)

After env writes: trigger a Production redeploy so Functions pick up values.

## Cheap status check

```bash
# Netlify CLI login once (or NETLIFY_AUTH_TOKEN). Never paste secrets into chat.
node scripts/notification-ops-status.js
```

Prints masked presence only. Exit `0` when Production notification gates look ready.

## Human checklist

1. ~~Google aliases~~ — `support@`, `booking@`, `billing@` created.
2. Confirm mail arrives in the primary Workspace inbox when you email those aliases (or when a booking fires).
3. Do **not** purchase another Twilio number for admin alerts.
4. Optional controlled owner SMS test: only with explicit owner auth; never customer SMS from agents.

## What agents should not redo

- Full booking timeline recon when ops status is green
- Buying Twilio numbers / changing Messaging Service membership without need
- Pointing `ADMIN_EMAIL` at verbal typos (`cardtel1`, etc.)
- Enabling `NOTIFICATION_QA_ENABLED` in Production unless running an intentional owner-only check
