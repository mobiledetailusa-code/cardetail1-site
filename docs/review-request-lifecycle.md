# Review request lifecycle

Status: built in draft PR #432. **No review solicitation is sent on any path by default.** Every completion still sends its transactional receipt. Activation needs the owner's authorization (see [the activation checklist](review-request-activation-checklist.md)).

## Behaviour

| Path | Default (gates closed) | When review consent and campaign are established |
|---|---|---|
| Technician completion (`booking.review_requested`) | not queued | one initial ask, unless another initial ask exists |
| Admin approval / QuickOps close / Stripe webhook (`booking.service_completed`) | receipt **without** the Google link | receipt with the link, unless another initial ask exists |
| Rows queued before this change | a review ask is cancelled at dispatch; a completion text loses its link but the receipt still sends | re-checked at dispatch |
| Automatic reminder (`booking.review_reminder …:auto`) | never scheduled | one reminder about 48 h after completion, 10:00–18:00 America/New_York, Mon–Sat; live completions only (≤ 6 h old) |
| Manual resend (`booking.review_reminder …:manual`) | button hidden, action refused | one per booking, from Admin → More → Completed / Review |

Caps and timing:
- at most 2 automatic solicitations (initial ask plus reminder) and 3 in total;
- at least 24 h between solicitations;
- nothing more than 14 days after completion.

The owner can stop asking with **Review received** or **Stop**. Either one also cancels pending follow-ups.

## Gates

A **solicitation** is any message that asks for a review. The receipt itself is never gated by these variables.

| Variable | Default | Applies to |
|---|---|---|
| `REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED` | off | every solicitation, the initial ask included |
| `REVIEW_SOLICITATION_CONSENT_VERSIONS` | empty | every solicitation; the booking's consent text version must be listed |
| `REVIEW_REMINDER_AUTOMATION_ENABLED` | off | automatic reminder only |
| `REVIEW_MANUAL_RESEND_ENABLED` | off | manual resend only (independent of automation) |

No existing transactional consent version (`cd1-txn-sms-v3-2026-08-28`, `dz-txn-sms-v2-2026-08-22`) is treated as review consent by the code, and nothing in the code adds one to the list.

## Neutral eligibility

Eligibility never depends on satisfaction, complaints, service issues, disputes, ratings or predicted ratings.
- The earlier rule that excluded `issue_reported` / `disputed` jobs from the initial ask was removed. Excluding unhappy customers would be selective (positive-only) solicitation.
- What ends asking:
  - a review already left, first-party or marked received by the owner, at any rating;
  - the owner's Stop;
  - STOP / opt-out or revoked consent;
  - expiry or the caps.

## Ledger, lock and statuses

- **Ledger.** The PostgreSQL `SmsOutbox` is the only ledger. There is no new table or column, and no migration.
- **Cancellation** uses the existing `status=failed` + `lastErrorCode`, prefixed `review_cancelled_`. This is the same pattern as `superseded`.
- **Removing a review link at dispatch** rewrites the row's `templateData.reviewUrl` and its `payloadHash`. A later enqueue of the same completion therefore stays idempotent.
- **Lock.** Every review enqueue, and every review dispatch decision together with its row update, runs inside a transaction holding `pg_advisory_xact_lock(hashtextextended('cd1-review:<bookingId>', 0))`.
  - Concurrent completion paths, double clicks and parallel workers serialize per booking.
  - A row being sent keeps its lease, so another ask for the same booking sees it in flight and is deferred.
  - If the lock or ledger is unavailable: a receipt is sent without its link, an ask is deferred, and after `maxAttempts` the ask is cancelled.
- **Ambiguous provider failures.** A failed row with no Message SID whose code is not a known pre-send rejection keeps its solicitation slot. It is shown as Failed and is never retried as a new ask.

| Admin label | Ledger evidence |
|---|---|
| Not requested | no solicitation row (a receipt without the link is not one) |
| Queued | `accepted`, no SID, due |
| Reminder scheduled | reminder row `accepted` with a future `availableAt` |
| Sent to Twilio (delivery not confirmed) | SID held (`submitted`) or `status=sent` |
| Delivered (Twilio confirmed) | `status=delivered` from Twilio's own status (send response or signed callback; monotonic) |
| Failed | `failed` with a provider code, or ambiguous |
| Opted out | suppression read true, or a row ended `suppressed` |
| Review received / Stopped / Expired | owner mark or first-party review / owner Stop / more than 14 days |

**Status fetch:** the Admin table shows up to 40 completed jobs. It costs one `SmsOutbox` query for all of them, plus booking and suppression reads in a pool of 8.

## Rollback

There are three different operations. Prefer them in this order.

### 1. Feature deactivation (preferred; this build stays live)
- **To stop follow-ups:** unset `REVIEW_REMINDER_AUTOMATION_ENABLED` and/or `REVIEW_MANUAL_RESEND_ENABLED`, then redeploy the **same** build so functions read the new values. Pending reminders and resends are cancelled at dispatch (`review_cancelled_automation_disabled` / `review_cancelled_manual_resend_disabled`).
- **To stop every review ask:**
  - Unset `REVIEW_SOLICITATION_CONSENT_VERSIONS` or `REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED`, then redeploy the same build.
  - The initial asks stop, pending asks are cancelled, and links are stripped from pending receipts.
  - Receipts and every other transactional text continue.
- **What stays in place:** the consent gate, the de-duplication and Admin observability.
- **When:** first response to any review-request problem.

### 2. Corrective roll-forward (preferred for a defect in this code)
- Fix the defect on a branch, run the full CI gates, and release the fix through the documented CLI-bundled procedure.
- Keep the review switches unset until the fix is live.
- **When:** when deactivation is not enough. For example, a defect in the receipt path itself, or in the worker gate.

### 3. Full deployment rollback (last resort)
Restoring the production build from before #432 removes **all** of this protection. With the previous build live again:
- **Review asks return without the new consent gate.**
  - The tech path queues `booking.review_requested` again.
  - The paid completion receipt again carries the Google link, under transactional consent only.
  - The four `REVIEW_*` variables are ignored by that build.
- **Duplicate review asks can return.** A tech completion followed by a paid approval can again send two asks.
- **Google review links return in every completion receipt**, including receipts for bookings whose owner pressed Stop or marked the review received. The old build does not read `booking.reviewRequest`.
- **Review observability is lost.** The Completed / Review status table, Resend, Review received and Stop are gone. Marks already saved stay on the bookings but are not enforced.
- **What stays safe:** any `booking.review_reminder` row still pending fails at dispatch in the old build with `unknown_sms_template` and is never sent. Rows the new build cancelled (`review_cancelled_*`) stay cancelled.
- **Rows queued by the new build** (`booking.service_completed` without a link) send normally as receipts.

Before a full rollback, the owner should accept these four regressions explicitly. If the rollback is for an unrelated defect, prefer rolling forward with a build that keeps #432.

## Tests

- `tests/review-request-lifecycle.test.js`: in-memory ledger; gates, neutrality, window, caps, dispatch, admin view, batch query count.
- `tests/review-request-lifecycle-postgres.test.js`: real PostgreSQL and the advisory lock.
  - Covers concurrent cross-path completion, concurrent manual resend, two workers on one booking, mark-received race, STOP, monotonic delivery status, ambiguous failure.
  - Skipped locally without `DATABASE_URL`; mandatory in CI.
  - A mutation run with the lock bypassed produced a double ask in 10/10 runs.
