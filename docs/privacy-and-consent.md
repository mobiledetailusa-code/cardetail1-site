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

## Booking consent (unchanged)

Card-on-file policy and terms checkboxes remain separate from marketing consent. Accepting service terms ≠ marketing opt-in.

## Deletion / retention

Documented per-store in `docs/revenue-intelligence.md`. Admin audit log: 365 days.

## Legal

Recommend legal review before enabling promotional SMS/email automation.

## Withdrawal

Re-open banner by clearing `cd1_consent_v1` from localStorage (future: dedicated preference link in footer).
