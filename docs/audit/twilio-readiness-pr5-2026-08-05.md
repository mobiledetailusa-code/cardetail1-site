# PR5 — Twilio readiness (disabled by default)

Date: 2026-08-05
Branch: `feat/twilio-readiness-pr5`
Base: PR4 `fix/customer-admin-operations-pr4` (`7c5377ed8a05a8a3a7a67f4a2ab73a934cdcf424`)
Production/deploy: not performed
Live SMS: none

## Executive result

PR5 replaces direct SMS sends with a PostgreSQL outbox written only after the owning business transaction has committed. Delivery is fail-closed and disabled by default. A deploy preview, branch deploy, local environment, test process, non-production host or incomplete configuration cannot call Twilio, even if legacy Twilio credentials are present.

The implementation adds explicit consent, centralized branded templates, deterministic deduplication, bounded retries, signed inbound/status webhooks and monotonic provider status tracking. Financial transactions never contain a Twilio API call. No live credential, phone number or message was used during implementation or verification.

## Runtime gates and configuration

All three send switches must be explicitly enabled, and runtime identity must match the production branch and host:

- `TWILIO_OUTBOX_ENABLED`
- `TWILIO_ENABLED`
- `TWILIO_PRODUCTION_SENDS_ENABLED`
- `TWILIO_ALLOWED_BRANCH` (defaults to `master`)
- `TWILIO_ALLOWED_HOST` (defaults to `cardetail1.com`)

Provider configuration is separate from the runtime gates:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY`
- `TWILIO_API_SECRET`
- `TWILIO_MESSAGING_SERVICE_SID`
- `TWILIO_STATUS_CALLBACK_URL` (`https://cardetail1.com/.netlify/functions/twilio-status-callback`)
- `TWILIO_AUTH_TOKEN` (webhook signature validation only)
- `TWILIO_INBOUND_WEBHOOK_URL` (`https://cardetail1.com/.netlify/functions/twilio-inbound`)
- `TWILIO_WORKER_SECRET`

Consent remains independently opt-in:

- `CUSTOMER_TRANSACTIONAL_SMS_ENABLED`
- `ADMIN_SMS_CONSENT_GRANTED`

No value is committed to the repository. GitHub/Netlify secrets must be supplied only by the owner after review. Preview validation deliberately leaves all send switches empty.

## Implemented behavior

- Additive `SmsOutbox` table with a unique idempotency key, payload hash, audience, recipient, template, provider SID/status, retry lease and audit timestamps.
- Provider lifecycle states are normalized to `accepted`, `sent`, `delivered` and `failed`.
- Enqueue occurs after commit; financial Stripe webhook handling can enqueue intent but cannot call the provider.
- One isolated provider module owns the only `client.messages.create` call in the repository.
- Messaging Service SID is mandatory; raw `from` numbers are not accepted by the provider adapter.
- Customer and technician transactional SMS consent is explicit, off by default, versioned and audited. A stale consent write returns 409.
- STOP revokes matching consent idempotently. HELP is recognized. Messaging Service Advanced Opt-Out is expected to send the configured compliant response, so the webhook returns empty TwiML and does not duplicate it.
- Every outbound customer template starts with `Cardetail1:` and contains STOP/HELP guidance. Admin operational templates start with `Cardetail1 Admin:`. Legal A2P Brand remains Detailing Zone L.L.C.; Cardetail1 is the registered DBA / customer-facing sender identity.
- Same idempotency key plus same payload replays the existing row; payload drift returns 409.
- Explicit 429 and retryable 5xx responses are retried with a bounded backoff. An ambiguous network failure is terminal to prevent duplicate delivery.
- Status callbacks use an atomic compare-and-set transition so concurrent or late callbacks cannot regress `delivered` to an earlier state.
- `X-Twilio-Signature` is checked with the official Twilio SDK against the exact public URL and complete form payload. Invalid signatures are rejected.
- Worker schedule identity is read only from the trusted Netlify event shape. A caller-supplied header cannot impersonate the scheduler; manual invocation requires a timing-safe worker secret.
- Logs contain internal IDs, coarse states and sanitized provider error codes, never credentials, message bodies or full phone numbers.
- Legacy direct-send paths in booking, inquiry, auction, recovery and Stripe flows were removed or routed through the outbox.

Twilio references used for the contract: [request signature validation](https://www.twilio.com/docs/usage/security), [Messaging Services](https://www.twilio.com/docs/messaging/services), [status callbacks](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status), [outbound status lifecycle](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks), [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out), [API authentication](https://www.twilio.com/docs/usage/requests-to-twilio) and [REST API security practices](https://www.twilio.com/docs/usage/rest-api-best-practices).

## Verification

- Fresh PostgreSQL 16 database: all seven migrations applied from zero; `prisma migrate status` reported up to date.
- Focused PR5 readiness contract: **15 tests, 0 failures**.
- Admin/technician consent regression slice: **44 tests, 0 failures**.
- Full PostgreSQL suite with Twilio disabled: **2,208 tests, 146 suites, 0 failures**.
- Netlify deploy-preview build in offline mode: green; all Functions, including inbound, callback and worker, bundled. No deploy command was invoked.
- Preview/test environment had `TWILIO_OUTBOX_ENABLED`, `TWILIO_ENABLED` and `TWILIO_PRODUCTION_SENDS_ENABLED` empty; no real SMS path was reachable.
- Source-containment test proves the sole provider call is in `netlify/lib/twilio-provider.js` and absent from financial transaction files.
- Browser QA at 1440×1000 and 390×844: no JavaScript console errors, horizontal overflow, sub-16 px inputs or primary touch targets below 44 px.
- Two independent tabs loaded My Garage without sharing transient page state.
- Authenticated consent controls were verified structurally and by computed styles. A real authenticated screenshot was intentionally not fabricated because no customer/Admin credential was introduced into the test environment.
- `npm audit --omit=dev` reports 14 dependency findings (12 moderate, 2 high) in pre-existing Prisma/Cursor/Undici/fast-uri chains. The exact Twilio 6.0.2 addition is not the reported source of those findings; dependency remediation remains a separate owner-reviewed change.
- No Owner Studio file, Stripe/Twilio live credential, live external request, message, merge, deploy or production system was touched.

The final immutable PR head and post-commit rerun are recorded in the PR evidence because a commit cannot contain its own SHA. Any change to that SHA invalidates this evidence and requires the complete verification to run again.

## Visual QA

- [My Garage desktop](../qa/pr5/my-garage-desktop.jpg)
- [My Garage mobile](../qa/pr5/my-garage-mobile.jpg)

The public and authentication-boundary states are shown. Authenticated consent behavior is covered by PostgreSQL/API tests and DOM/style assertions without embedding or inventing account credentials.

## Activation runbook (owner action only)

1. Keep all three send switches off while applying the additive migration and deploying reviewed code.
2. Configure an approved Twilio Messaging Service with API-key authentication, Advanced Opt-Out STOP/HELP responses and the exact inbound/status callback URLs above.
3. Store provider values only in production-scoped secret storage; never expose them to previews or pull requests.
4. Verify signed callbacks and a dedicated consented test recipient in a controlled owner-approved production smoke test.
5. Enable `TWILIO_OUTBOX_ENABLED`, then `TWILIO_ENABLED`, and only lastly `TWILIO_PRODUCTION_SENDS_ENABLED` after host/branch/runtime verification.
6. Monitor accepted/sent/delivered/failed state transitions and sanitized failure codes. Disable the production-send switch immediately on unexpected behavior.

This runbook is documentation only. PR5 does not perform activation.

## Risk and rollback

Primary risk: a production callback URL, Messaging Service opt-out policy or environment identity mismatch can leave rows accepted/failed without delivery. The fail-closed gates make this an availability risk, not an unintended-send risk. The operational mitigation is to inspect sanitized outbox state before enabling the final switch.

Secondary risk: asynchronous delivery introduces eventual consistency between a committed business event and its notification. Idempotency, row leasing and monotonic callbacks prevent normal retry/concurrency paths from duplicating or regressing delivery state.

Rollback order:

1. Set `TWILIO_PRODUCTION_SENDS_ENABLED=false` (or remove it); this immediately makes the worker unable to send.
2. Disable `TWILIO_ENABLED` and `TWILIO_OUTBOX_ENABLED`.
3. Revert the PR5 code while leaving PR4 in place.
4. Retain the additive `SmsOutbox` table and rows for audit. Do not drop it during an incident and do not mutate financial history.

## Owner review checklist

- Confirm the PR base and head exactly match the recorded immutable SHAs.
- Confirm previews and CI have no production Twilio secrets and all three send switches are off.
- Review consent language, single brand, STOP/HELP policy and Messaging Service Advanced Opt-Out configuration.
- Replay valid and invalid signed inbound/status callbacks, including out-of-order delivery updates.
- Exercise same-key retry, payload drift, concurrent worker lease, 429, 5xx and ambiguous-network handling.
- Confirm Stripe webhook replay can only enqueue after authority/commit and cannot directly call Twilio.
- Confirm no message is sent until an owner separately configures production secrets and explicitly enables all gates.
- Do not merge until PR4 and its predecessors are accepted in sequence and this PR is rebased/revalidated on the resulting base.

**READY FOR OWNER REVIEW**
