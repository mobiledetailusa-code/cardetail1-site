# Verified Square reconciliation bridge

Local prototype inheriting adapter correction `3d30f9885c9a512776da95ee9edba6cbee1a2411` and settlement recovery correction `87806a7a7f9334e328f4762f759dd9fbb9650bdd` through normal local merges into published bridge checkpoint `25f545ab3153cc75af09bd60a5eadd15ef2045aa`. The inherited isolation correction `8c7ee9a8f7d18136218d2a37708c632157eb5eab`, bridge integrations `544e5e910cc09f47884f543d5da297d0dda36fe8` and `6389624f0db1ffbca1b5aafdbd30aa96aa1a6b70`, and original Cursor history remain intact. Phase 7E.9E is local only: no draft PR modification, push, GitHub Actions execution, deployment, or provider API request is authorized or performed. Historical CI results below do not validate these new local commits.

The published sandbox webhook receiver is unchanged. Signature checks call `verifySquareWebhookSignature`. Event interpretation calls `interpretVerifiedSquareWebhook`. Settlement calls the existing sandbox settlement service. The bridge does not implement a second HMAC.

A fixture is eligible for settlement only when the synthetic signature matches the raw body and the trusted notification URL, the merchant matches trusted server configuration, a payment operation was already stored for that payment id, and the injected `GET /v2/payments/{payment_id}` mock returns that same payment as `COMPLETED` in USD at the trusted location. The webhook payload, event type, and timestamp are not settlement authority. `reference_id` is not a booking association. Caller-supplied authentication flags are rejected.

Retrieval uses the payment id on the stored operation. The mock is injected. The bridge does not call `globalThis.fetch` and does not read `process.env`. The signing key must match the synthetic prefix `synthetic-square-webhook-`. No Square signing key is retrieved.

The database remains disposable local PostgreSQL `cardetail1_square_settlement_7d` on loopback. No schema migration was added. No commercial financial table is written.

## Local P1 response and recovery remediation

The adapter now rejects unsuccessful HTTP responses before inspecting payment authority, and rejects nonempty or malformed provider error envelopes even alongside matching `COMPLETED` data. Its existing HTTP 2xx success contract and valid receipt-optional responses remain supported. The settlement service separately requires a successful, error-free classified retrieval before committing.

Failed server-generated retrieval attempts without payment status, amount, or currency remain durable audit history, but do not assert a conflicting payment identity. Normal bridge retries can retrieve again after 429, 500, invalid JSON, or timeout. This interpretation also covers legacy failed rows without rewriting them. Genuine contradictory evidence and quarantined provider identity conflicts continue to block retries; untrusted observations cannot select the server-origin marker. The database schema, canonical connection boundary, shared transaction gate, and lock ordering are unchanged.

All 49 local PostgreSQL-backed bridge tests pass, with zero failures or skips. The 21 added cases cover eight signed contradictory-response flows (including HTTP 404 plus `NOT_FOUND` and matching `COMPLETED` data), eight same/new-event transient recovery flows, early-event recovery after association retrieval failure, and four persistent provider identity quarantines. Recovery assertions require a second real invocation of the injected GET mock, one exact committed settlement, unchanged stored authorization, preserved failed-attempt history, and duplicate recognition without another retrieval. The original bridge implementation is unchanged.

The existing error-only HTTP 404 expectation changes from `quarantined` to `rejected`: unsuccessful retrieval is classified before absent payment fields can be mistaken for contradictory identity. Its no-settlement assertion remains unchanged. Original rollback, committed-row, synchronization, HMAC, merchant, association, and duplicate-event protections remain in place.

## Provider retrieval trust boundary

The current `fetchImpl` is an injected synthetic test client, not proof of Square authenticity. The bridge rejects direct `globalThis.fetch`, constrains the requested URL to the Square Sandbox Payments API, and validates the returned payment against the stored operation, amount, currency, location, and trusted synthetic merchant configuration. Those checks limit this prototype, but a caller-supplied wrapper can still execute arbitrary code or make a network request. The bridge is safe only because it is test-context-only, uses a synthetic token, writes only to the loopback settlement database, and is not imported by the published receiver or commercial payment paths. `externalCall: false` describes the supplied test fixture, not an enforceable production guarantee.

A future internal Square Sandbox retrieval client must be a server-owned dependency constructed outside request handling. It must load credentials and merchant/location identity only from protected server configuration, fix the origin to `https://connect.squareupsandbox.com`, take the payment id only from the stored operation, validate the documented Payments API response before returning a typed result, and never accept a browser-selected provider, payment id, host, token, merchant, or location. Receipt metadata must remain non-authoritative. The settlement service must consume that internal client's result through a production-specific interface rather than treating an arbitrary callback as authentication. No such production client is implemented in this phase.

Provider retrieval runs after the read transaction commits. A new transaction is opened only after the retrieval result has been classified, so no database row or advisory lock is held across the injected call.

## Operation-retry lock cycle and inherited correction

Phase 7E.5 local validation reproduced a separate PostgreSQL `40P01` deadlock between an idempotent `createOperation` retry and `verifyAndSettle`. The retry locks the obligation before the existing operation, whereas verification locks the operation before the obligation. Two temporary blocker transactions and `pg_stat_activity` lock barriers establish the ordering before releasing the blockers; this is not a timing-only stress result.

The same diagnostic reproduced on original bridge commit `1b2197b115431515082c628636e070abcced8752` and earlier settlement correction `cb678658e7c28e8e023de39e44bd4e44584b4473`. Each reproduction incremented the database deadlock counter by one and returned `square_settlement_failed` for one operation. Rollback left a recoverable state, and a subsequent verification left exactly one settlement.

Settlement commit `4432d8000e2c8a6712b26cde3fcbb51933a9bf17` corrects this cycle by acquiring a shared transaction gate before financial SQL. Its authoritative PR #374 Actions run [40506707071](https://github.com/mobiledetailusa-code/cardetail1-site/actions/runs/40506707071) passed all six jobs, including 35 settlement tests and the operation-retry regressions. This bridge integration inherits those source changes and tests unchanged. It adds no independent financial correction or gate bypass. The gate's cooperative-writer and throughput limitations remain documented in `square-sandbox-settlement.md`.

## Inherited PostgreSQL destination isolation

Phase 7E.9C inherits the canonical PostgreSQL client boundary and its 52 offline isolation regressions unchanged from PR #374 commit `8c7ee9a8f7d18136218d2a37708c632157eb5eab`. Its authoritative Actions run [40596512215](https://github.com/mobiledetailusa-code/cardetail1-site/actions/runs/40596512215) passed all six jobs, including those 52 cases and 36 settlement tests. Connection-setting queries, fragments, sockets and unauthorized destinations are rejected before client construction; explicit driver settings prevent environment fallback, and server identity is checked after connection. Details and limitations remain in `square-sandbox-settlement.md`.

The bridge implementation and its financial and synchronization assertions are unchanged. Bridge tests now resolve the inherited corrected settlement/database modules directly, without validation-only dependency aliases. PR #375 adds no independent isolation implementation or settlement patch.

## Deterministic bridge synchronization

The earlier verification-versus-webhook row-blocking schedule still passed after the settlement merge. Its synchronization was strengthened to identify the shared gate specifically, rather than accepting any advisory lock. A short observer transaction discovers the gate's actual `pg_locks` tag and releases it before starting either participant. A blocker then holds the operation row; verification must hold that exact gate while waiting for the row. Webhook ingestion must wait on the same gate, with `pg_blocking_pids` identifying verification as its blocker.

Releasing the operation row lets both requests complete. All existing financial assertions remain unchanged: one `settled`, one `already_settled`, exactly one committed matching row, both financially settled, no failed financial result, and no deadlock-counter increase. After completion, the observer must reacquire the shared gate immediately and acquire operation, obligation, settlement and event rows using `FOR UPDATE NOWAIT`; this verifies that locks were released. No timing-only substitute or weaker outcome expectation was introduced. The settlement suite separately retains the operation-retry, association, uniqueness, rollback and retrieval-outside-transaction proofs.

## CI password-log follow-up

Phase 7E.8 inherits the credential remediation from PR #374; it does not duplicate that correction. The following historical audit describes public Actions run `40431732525` before the correction, without copying secret values into this note:

1. The ephemeral Postgres password is hardcoded in `.github/workflows/integration.yml`. It is the same literal as the ephemeral role name.
2. It is the service password for the CI Postgres containers and the settlement test step. Local settlement tests do not require it. It is not a Neon credential and it is not a Square credential.
3. The public log shows it unmasked in the service container create command (`POSTGRES_PASSWORD`) and in the full-test step environment (`SQUARE_SETTLEMENT_TEST_PASSWORD`). `DATABASE_URL` userinfo is masked in that log. No `::add-mask::` directive is present.
4. The settlement step environment is printed before the step script runs, so a mask emitted inside the script cannot hide that line.
5. Phase 7E.2 removes both step-level `SQUARE_SETTLEMENT_TEST_PASSWORD` literals. Database preparation and the settlement-test launcher derive the disposable password inside their scripts from the already masked, loopback-only `DATABASE_URL`. The launcher registers the derived value with `::add-mask::` before forwarding it into the PostgreSQL network namespace.
6. Remaining exposure: the static disposable password is still present in the PostgreSQL service-container configuration, which Actions logs before user steps run. Fully masking that line would require a repository/organization Actions secret available to the workflow, while removing the password would change service authentication. Neither broader change is made automatically in this phase. No Neon, Square, Stripe, or production credential is introduced.

## CI external provider activity requiring later authorization

The `stripe_test_mode` job in `.github/workflows/integration.yml` invokes `node scripts/isolated-balance-proof.js` in its "Prove the Stripe test-mode balance" step. That script and the application handlers it invokes use real Stripe test-mode API requests to create, retrieve, cancel, and confirm PaymentIntents and query charges. The job supplies `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from Actions secrets. This workflow is therefore not completely offline.

No provider credentials were retrieved, no secrets or workflows were modified, and that script was not executed during this local remediation. Before a later push or PR update can trigger this workflow, explicitly disclose the anticipated Stripe test-mode activity and obtain authorization, or implement a separately authorized gating change first. The publication sequence is adapter PR #373, settlement PR #374, then bridge PR #375; no publication is authorized in this phase.

## Skipped repository test

PR #374 full-test run `40431732525` reported the repository suite as 4567 passed, 0 failed, 1 skipped. The skipped test was `fleet-branch city URLs preserved on NJ/NY/CT state hubs` because git ref `ux-remove-fleet-from-booking` is not in that checkout. The settlement file in the same run reported 24 passed and 0 skipped.

Two conditional suites also appear as skipped in that log and were not executed: `customer identity postgres concurrency (isolated DB)` when `CUSTOMER_IDENTITY_TEST_DATABASE_URL` is unset, and `owner-studio catalog staging integration` when `OWNER_STUDIO_STAGING_INTEGRATION` is not `1`. This phase does not claim those suites were executed.
