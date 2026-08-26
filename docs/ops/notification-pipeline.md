# Notification pipeline — operational runbook (Cardetail1)

Keep this stage cheap: **read this + run the status script**. Do not re-audit Production history unless a real booking failed.

## Model (one Twilio number)

| Role | What it is | Buy new Twilio DID? |
|---|---|---|
| Outbound SMS sender | Messaging Service SID → single DID `+1…5668` | **No** |
| Owner SMS recipient | `ADMIN_SMS` (existing cell, e.g. business `…2956`) | **No** — not a Twilio number |
| Customer SMS recipient | phone on the booking | No |

Customer + admin alerts both leave from the **same** Messaging Service number. `TWILIO_FROM` stays unset when Messaging Service is used.

## Email roles (cardetail1.com)

| Address | Role | Where configured |
|---|---|---|
| `admin@cardetail1.com` | **TO** for owner alerts (`ADMIN_EMAIL`) | Netlify Production + **Google Workspace mailbox/alias** |
| `bookings@cardetail1.com` | **FROM** (`RESEND_FROM`) | Resend (domain verified) + Workspace mailbox/alias |
| `support@cardetail1.com` | Optional public/support inbox | Google Workspace only (not required by Functions today) |
| Legacy Gmail | Preview/dev/branch `ADMIN_EMAIL` only | Netlify non-production contexts |

Resend domain `cardetail1.com` is **verified**. MX → `smtp.google.com`. Creating mailboxes is **Google Admin only** (agent cannot create Workspace users).

## Netlify Production (agent can set)

Required presence:

- `ADMIN_EMAIL=admin@cardetail1.com`
- `ADMIN_SMS=+1…` (owner E.164)
- `ADMIN_SMS_CONSENT_GRANTED=true`
- `RESEND_FROM=Cardetail1 <bookings@cardetail1.com>`
- Twilio gates: `TWILIO_ENABLED`, `TWILIO_OUTBOX_ENABLED`, `TWILIO_PRODUCTION_SENDS_ENABLED`, `CUSTOMER_TRANSACTIONAL_SMS_ENABLED`
- Provider: `TWILIO_ACCOUNT_SID`, auth, `TWILIO_MESSAGING_SERVICE_SID` (no second DID)

After env writes: trigger a Production redeploy so Functions pick up values.

## Cheap status check

```bash
# Netlify CLI login once (or NETLIFY_AUTH_TOKEN). Never paste secrets into chat.
node scripts/notification-ops-status.js
```

Prints masked presence only. Exit `0` when Production notification gates look ready.

## Human checklist (do once)

1. Google Admin → create/ensure `admin@`, `bookings@`, optional `support@` (or aliases + forward to Gmail).
2. Until `admin@` exists: forwarding `admin@` → Gmail is mandatory (Production already points TO there).
3. Do **not** purchase another Twilio number for admin alerts.
4. Optional controlled owner SMS test: only with explicit owner auth; never customer SMS from agents.

## What agents should not redo

- Full booking timeline recon when ops status is green
- Buying Twilio numbers / changing Messaging Service membership without need
- Pointing `ADMIN_EMAIL` at verbal typos (`cardtel1`, etc.)
- Enabling `NOTIFICATION_QA_ENABLED` in Production unless running an intentional owner-only check
