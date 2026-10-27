# Verified Square reconciliation bridge

Local prototype inheriting corrected draft settlement commit `cb678658e7c28e8e023de39e44bd4e44584b4473` through a merge that preserves the original bridge commit. It does not modify draft PRs #372, #373, or #374, deploy, or call Square. Phase 7E.5 publication is blocked by the additional concurrency limitation below.

The published sandbox webhook receiver is unchanged. Signature checks call `verifySquareWebhookSignature`. Event interpretation calls `interpretVerifiedSquareWebhook`. Settlement calls the existing sandbox settlement service. The bridge does not implement a second HMAC.

A fixture is eligible for settlement only when the synthetic signature matches the raw body and the trusted notification URL, the merchant matches trusted server configuration, a payment operation was already stored for that payment id, and the injected `GET /v2/payments/{payment_id}` mock returns that same payment as `COMPLETED` in USD at the trusted location. The webhook payload, event type, and timestamp are not settlement authority. `reference_id` is not a booking association. Caller-supplied authentication flags are rejected.

Retrieval uses the payment id on the stored operation. The mock is injected. The bridge does not call `globalThis.fetch` and does not read `process.env`. The signing key must match the synthetic prefix `synthetic-square-webhook-`. No Square signing key is retrieved.

The database remains disposable local PostgreSQL `cardetail1_square_settlement_7d` on loopback. No schema migration was added. No commercial financial table is written.

## Provider retrieval trust boundary

The current `fetchImpl` is an injected synthetic test client, not proof of Square authenticity. The bridge rejects direct `globalThis.fetch`, constrains the requested URL to the Square Sandbox Payments API, and validates the returned payment against the stored operation, amount, currency, location, and trusted synthetic merchant configuration. Those checks limit this prototype, but a caller-supplied wrapper can still execute arbitrary code or make a network request. The bridge is safe only because it is test-context-only, uses a synthetic token, writes only to the loopback settlement database, and is not imported by the published receiver or commercial payment paths. `externalCall: false` describes the supplied test fixture, not an enforceable production guarantee.

A future internal Square Sandbox retrieval client must be a server-owned dependency constructed outside request handling. It must load credentials and merchant/location identity only from protected server configuration, fix the origin to `https://connect.squareupsandbox.com`, take the payment id only from the stored operation, validate the documented Payments API response before returning a typed result, and never accept a browser-selected provider, payment id, host, token, merchant, or location. Receipt metadata must remain non-authoritative. The settlement service must consume that internal client's result through a production-specific interface rather than treating an arbitrary callback as authentication. No such production client is implemented in this phase.

Provider retrieval runs after the read transaction commits. A new transaction is opened only after the retrieval result has been classified, so no database row or advisory lock is held across the injected call.

## Remaining operation-retry lock cycle

Phase 7E.5 local validation reproduced a separate PostgreSQL `40P01` deadlock between an idempotent `createOperation` retry and `verifyAndSettle`. The retry locks the obligation before the existing operation, whereas verification locks the operation before the obligation. Two temporary blocker transactions and `pg_stat_activity` lock barriers establish the ordering before releasing the blockers; this is not a timing-only stress result.

The same diagnostic reproduced on original bridge commit `1b2197b115431515082c628636e070abcced8752` and corrected settlement commit `cb678658e7c28e8e023de39e44bd4e44584b4473`. Each reproduction incremented the database deadlock counter by one and returned `square_settlement_failed` for one operation. Rollback left a recoverable state, and a subsequent verification left exactly one settlement. No financial source change is made here. This inherited settlement lock cycle must be corrected and independently validated before publishing the bridge dependency update. The bridge's deterministic verification-versus-webhook regression covers the original advisory-lock cycle, not this operation-retry cycle.

## CI password-log follow-up

Phase 7E.5 inherits the credential remediation from PR #374; it does not duplicate that correction. The following historical audit describes public Actions run `40431732525` before the correction, without copying secret values into this note:

1. The ephemeral Postgres password is hardcoded in `.github/workflows/integration.yml`. It is the same literal as the ephemeral role name.
2. It is the service password for the CI Postgres containers and the settlement test step. Local settlement tests do not require it. It is not a Neon credential and it is not a Square credential.
3. The public log shows it unmasked in the service container create command (`POSTGRES_PASSWORD`) and in the full-test step environment (`SQUARE_SETTLEMENT_TEST_PASSWORD`). `DATABASE_URL` userinfo is masked in that log. No `::add-mask::` directive is present.
4. The settlement step environment is printed before the step script runs, so a mask emitted inside the script cannot hide that line.
5. Phase 7E.2 removes both step-level `SQUARE_SETTLEMENT_TEST_PASSWORD` literals. Database preparation and the settlement-test launcher derive the disposable password inside their scripts from the already masked, loopback-only `DATABASE_URL`. The launcher registers the derived value with `::add-mask::` before forwarding it into the PostgreSQL network namespace.
6. Remaining exposure: the static disposable password is still present in the PostgreSQL service-container configuration, which Actions logs before user steps run. Fully masking that line would require a repository/organization Actions secret available to the workflow, while removing the password would change service authentication. Neither broader change is made automatically in this phase. No Neon, Square, Stripe, or production credential is introduced.

## Skipped repository test

PR #374 full-test run `40431732525` reported the repository suite as 4567 passed, 0 failed, 1 skipped. The skipped test was `fleet-branch city URLs preserved on NJ/NY/CT state hubs` because git ref `ux-remove-fleet-from-booking` is not in that checkout. The settlement file in the same run reported 24 passed and 0 skipped.

Two conditional suites also appear as skipped in that log and were not executed: `customer identity postgres concurrency (isolated DB)` when `CUSTOMER_IDENTITY_TEST_DATABASE_URL` is unset, and `owner-studio catalog staging integration` when `OWNER_STUDIO_STAGING_INTEGRATION` is not `1`. This phase does not claim those suites were executed.
