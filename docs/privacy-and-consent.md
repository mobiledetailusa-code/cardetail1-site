# Privacy and Consent

## Consent categories

| Category | Includes | Required for |
|----------|----------|--------------|
| **Necessary** | Booking, security, session, payment init | Always on |
| **Analytics** | GA4, GTM, Clarity, non-essential HubSpot tracking | Opt-in |
| **Marketing** | Ads pixels, remarketing, promotional automation | Opt-in |

Banner: `assets/consent-manager.js` — optional categories **not preselected**. Version `2026-07-revops-v1` stored in `localStorage`.

## Analytics property allowlist

Only approved properties reach GA4/GTM/Clarity/first-party endpoint. Rejected by default: name, email, phone, address, full ZIP, VIN, tokens, chat transcript, card data, advertising click IDs in third-party payloads.

Click IDs (`gclid`, `gbraid`, `wbraid`, `msclkid`, `fbclid`) stored first-party in `localStorage` attribution object — **not** sent to GA4/Clarity.

## PII handling

- Lead PII in `revenue-leads` Blob store under `_private` — admin-only
- Address dedup via HMAC (`HOUSEHOLD_DEDUP_SECRET`) — hash never public
- Rate limiting uses pseudonymous identifiers (existing `public-rate-limit.js` pattern)

## Booking and SMS consent

Card-on-file policy and terms checkboxes remain separate from marketing consent. Accepting service terms ≠ marketing opt-in.

The public booking flow also has a separate, unchecked-by-default transactional SMS checkbox. Declining it does not block step navigation or booking submission. The browser sends only a strict boolean choice; finalization writes the server timestamp, text version, source/method, program name, and true/false choice into the authoritative booking aggregate. A checked choice may also update the existing `CustomerConsent` current-state row. A later STOP or portal revocation wins over replay of an older booking.

Program scope: booking request receipt, booking/appointment status, confirmation, reminders, service/technician updates, rescheduling/cancellation status, and applicable payment/receipt notices. It does not include promotional SMS.

Public policies:

- `https://cardetail1.com/privacy-policy`
- `https://cardetail1.com/terms-conditions`

## Deletion / retention

Documented per-store in `docs/revenue-intelligence.md`. Admin audit log: 365 days.

## Legal

Recommend legal review before enabling promotional SMS/email automation.

## Withdrawal

Re-open banner by clearing `cd1_consent_v1` from localStorage (future: dedicated preference link in footer).

Transactional SMS consent is withdrawn by replying STOP or through the existing authenticated SMS preference control. HELP is handled by the Twilio Messaging Service's Advanced Opt-Out response when configured; the signed inbound webhook intentionally returns empty TwiML to avoid duplicate replies.
