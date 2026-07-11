# Recovery Automation

## Default state (safe for preview/production until approved)

```
RECOVERY_AUTOMATION_ENABLED=false
RECOVERY_DRY_RUN=true
```

No real SMS or email is sent while dry-run is true.

## Abandonment definition

Abandonment is recorded only when:

- Booking was started
- Booking was **not** submitted
- Inactivity threshold passed (30 minutes client-side classification; server queue on identified leads)

Anonymous visitors: **analytics only** — no contact attempts.

## Identified abandonment requirements

- Contact captured
- Transactional recovery consent
- Secure resume token exists

## Abandonment steps

`after_package_selection`, `after_zip`, `after_contact`, `after_vehicle`, `after_schedule`, `before_payment`, `during_payment`, `after_payment_method_save`

## Suggested sequence (when enabled)

| Timing | Message | Consent |
|--------|---------|---------|
| 20 min | Secure resume link | Transactional |
| 24 hr | Package assistance | Transactional |
| 72 hr | Eligible offer mention | Marketing only if enabled + consented |

Maximum: 2 recovery messages + 1 promotional follow-up. Stop on booking, reply, opt-out, or expiration.

## Opt-out keywords

`STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`

## Secure resume

- High-entropy token, server-side hash storage
- 72-hour TTL (`revenue-resume-tokens` store)
- No PII in URL; token never sent to analytics
- `/resume` → `resume.html` validation → booking prefill

## Adapters

- **Resend** — `netlify/lib/recovery-communications.js`
- **Twilio** — same module (customer-facing recovery; distinct from existing admin dispatch SMS)
