# Review request lifecycle

Status: built, **all follow-up sends disabled by default**. Owner authorization is required before any activation.

## What it does

- **Initial request (unchanged).** When a job completes, the existing initial request still goes out:
  - `booking.service_completed`: receipt plus the Google review link, on the paid path;
  - or `booking.review_requested`: the first-party `/reviews` link, on the unpaid path.
- **Cross-path de-duplication (new, active by default).** At most one initial ask per booking:
  - If `review_requested` was already accepted, the later paid completion text keeps the receipt and drops the review link.
  - If the paid completion text already carried the link, a later `review_requested` is skipped. If it is already queued, the worker cancels it at dispatch.
  - A ledger outage keeps today's behaviour (fail-open), so receipt delivery never depends on this check.
- **Automatic reminder (new, off).** One `booking.review_reminder` text:
  - scheduled at about 48 h after completion, at the next 10:00–18:00 America/New_York slot, Monday–Saturday;
  - only from a live completion (within 6 h), so historical bookings never receive one.
- **Manual resend (new, off).** One owner resend per booking, from Admin → More → Completed / Review.
- **Caps:**
  - 2 automatic solicitations: the initial ask plus the reminder;
  - 3 in total, including the manual resend;
  - 24 h minimum between solicitations;
  - expiry 14 days after completion.
- **Owner marks.** "Review received" and "Stop" are stored on the booking as `booking.reviewRequest.receivedAt` / `stoppedAt`. Both cancel pending follow-ups.

## Gates (all must be true for a follow-up)

| Variable | Default | Meaning |
|---|---|---|
| `REVIEW_REMINDER_AUTOMATION_ENABLED` | unset (off) | allows the automatic reminder |
| `REVIEW_MANUAL_RESEND_ENABLED` | unset (off) | shows the Resend button and allows the owner resend |
| `REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED` | unset (off) | set only after the owner confirms in the Twilio console that the registered A2P campaign covers review requests |
| `REVIEW_SOLICITATION_CONSENT_VERSIONS` | empty | comma list of booking consent text versions confirmed to cover review requests and follow-ups |

The existing Twilio switches (`TWILIO_OUTBOX_ENABLED`, `TWILIO_ENABLED`, `TWILIO_PRODUCTION_SENDS_ENABLED`, `CUSTOMER_TRANSACTIONAL_SMS_ENABLED`, production identity) still apply on top of these four.

## Consent and campaign findings (2026-11-26)

- **Booking checkbox** (`cd1-txn-sms-v3-2026-08-28`): "booking request, appointment updates, reminders, and service-related notifications". Below it: "Transactional messages only; no marketing consent". **Review requests are not named.**
- **Terms, SMS program:** the listed message types do not include review requests. The page also says "The program does not include promotional or marketing messages." ("booking review" there means the internal booking approval.)
- **A2P campaign:** the repository records the brand (Detailing Zone L.L.C., DBA Cardetail1), but not the campaign use case or sample messages. It cannot be verified from code.
- **Result:** consent and campaign eligibility are **not established**. `REVIEW_SOLICITATION_CONSENT_VERSIONS` stays empty and `REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED` stays off.
- **Pre-existing question for the owner:** the existing initial completion text already contains a Google review ask. This change does not alter it.
- **Enforcement already in the stack:**
  - **STOP / suppression:** a carrier opt-out code or an inbound STOP writes `cd1-sms-suppression`. The worker checks suppression before every send, and the review gate also re-runs `assertCustomerSmsConsent`, which catches portal revocation.
  - **Quiet hours:** none existed before. The follow-ups add the 10–18 ET, Monday–Saturday window, which sits inside the TCPA 8 am–9 pm rule and stricter state rules.
  - **Neutral wording:** the template offers no incentive and does not ask for a positive rating. There is no sentiment-based targeting.
  - **Open service issues:** jobs with an open service issue or dispute are excluded. This matches the existing initial-request rule; the owner should confirm that this is not selective targeting under Google's policy.

## Ledger and observability

There is no new table or column, and no migration. Everything reuses the PostgreSQL `SmsOutbox` and the existing columns:

| Admin label | Outbox evidence |
|---|---|
| Not requested | no solicitation row |
| Queued | `status=accepted`, no `providerMessageSid`, due |
| Reminder scheduled | reminder row, `status=accepted`, `availableAt` in the future |
| Sent to Twilio (delivery not confirmed) | `providerMessageSid` set (Twilio accepted), or `status=sent` |
| Delivered (Twilio confirmed) | `status=delivered`, only from Twilio's own status (send response or signed status callback) |
| Failed | `status=failed` with a provider or gate code |
| Opted out | suppression read true, or a row ended `suppressed` |
| Review received / Stopped | owner mark, or a first-party review on the booking |
| Expired | more than 14 days after completion |

Cancelled rows use the existing pattern: `status=failed` with `lastErrorCode` prefixed `review_cancelled_`. This is the same approach the code already uses for `superseded`, so the enum is unchanged.

## Reliability

- **Single-use slots.** Each slot has a unique idempotency key:
  - `booking.review_requested:<id>`
  - `booking.service_completed:<id>`
  - `booking.review_reminder:<id>:auto`
  - `booking.review_reminder:<id>:manual`
- **Retries.** Worker retries reuse the same row, and the existing lease and claim logic are unchanged.
- **Dispatch gate** (`applyReviewDispatchGate` in `sms-outbox.js`). It runs for `review_requested` and `review_reminder` after the claim and before Twilio:
  - It re-reads the booking with a strong read and re-reads the ledger.
  - It re-checks switches, consent, received/stopped, caps, cooldown, window and expiry.
  - Follow-ups fail closed: a failed lookup defers the row and counts an attempt; after `maxAttempts` the row is cancelled.
  - Waiting for the send window does not consume an attempt.
- **Marking order.** "Received" and "Stop" commit the booking first, then cancel unleased pending rows. A row leased at that moment is cancelled by its own dispatch check.

## Activation (owner only, after the consent and campaign decision)

1. Confirm in the Twilio console that the A2P campaign use case and samples cover review requests. Update the campaign if needed.
2. Decide, with counsel if needed, whether consent v3 covers review requests, or ship a new consent text version first.
3. Set in Netlify (production scope):
   - `REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED=true`
   - `REVIEW_SOLICITATION_CONSENT_VERSIONS=<approved versions>`
   - then `REVIEW_MANUAL_RESEND_ENABLED=true`, `REVIEW_REMINDER_AUTOMATION_ENABLED=true`, or both.
4. Release through the documented CLI-bundled procedure (no prebuilt function zips).

Only completions after activation can get an automatic reminder (6 h live-completion rule).

## Rollback

- **Fastest:** unset `REVIEW_REMINDER_AUTOMATION_ENABLED` and `REVIEW_MANUAL_RESEND_ENABLED`. Already-scheduled reminders are then cancelled at dispatch with `review_cancelled_automation_disabled` or `review_cancelled_manual_resend_disabled`. Note that a function env change needs a redeploy to take effect.
- **Full:** redeploy the previous production deploy. The old build does not know the `booking.review_reminder` template, so when such a row comes due, the old worker marks it `failed` with `unknown_sms_template` and never sends it. The cross-path de-duplication disappears with the rollback, and the double initial ask returns.
