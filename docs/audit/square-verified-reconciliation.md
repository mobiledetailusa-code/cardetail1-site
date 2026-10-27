# Verified Square reconciliation bridge

Local prototype on draft settlement commit `93ae2dc19e31422f83d882f0cd9b9be180900dee`. It does not modify draft PRs #372, #373, or #374. It does not deploy, push, or call Square.

The published sandbox webhook receiver is unchanged. Signature checks call `verifySquareWebhookSignature`. Event interpretation calls `interpretVerifiedSquareWebhook`. Settlement calls the existing sandbox settlement service. The bridge does not implement a second HMAC.

A fixture is eligible for settlement only when the synthetic signature matches the raw body and the trusted notification URL, the merchant matches trusted server configuration, a payment operation was already stored for that payment id, and the injected `GET /v2/payments/{payment_id}` mock returns that same payment as `COMPLETED` in USD at the trusted location. The webhook payload, event type, and timestamp are not settlement authority. `reference_id` is not a booking association. Caller-supplied authentication flags are rejected.

Retrieval uses the payment id on the stored operation. The mock is injected. The bridge does not call `globalThis.fetch` and does not read `process.env`. The signing key must match the synthetic prefix `synthetic-square-webhook-`. No Square signing key is retrieved.

The database remains disposable local PostgreSQL `cardetail1_square_settlement_7d` on loopback. No schema migration was added. No commercial financial table is written.

## CI password-log follow-up

This phase did not change the credential handling in PR #374. Inspection of public Actions run `40431732525` for that pull request, without copying secret values into this note:

1. The ephemeral Postgres password is hardcoded in `.github/workflows/integration.yml`. It is the same literal as the ephemeral role name.
2. It is the service password for the CI Postgres containers and the settlement test step. Local settlement tests do not require it. It is not a Neon credential and it is not a Square credential.
3. The public log shows it unmasked in the service container create command (`POSTGRES_PASSWORD`) and in the full-test step environment (`SQUARE_SETTLEMENT_TEST_PASSWORD`). `DATABASE_URL` userinfo is masked in that log. No `::add-mask::` directive is present.
4. The settlement step environment is printed before the step script runs, so a mask emitted inside the script cannot hide that line.
5. Required follow-up, separate from this bridge: stop declaring `SQUARE_SETTLEMENT_TEST_PASSWORD` as a step `env` literal. Derive it inside the script from the already masked `DATABASE_URL` and do not print it. Masking the service container password requires storing that ephemeral password as an Actions secret referenced by the service `env`, because the container create line is logged before user steps run.

## Skipped repository test

PR #374 full-test run `40431732525` reported the repository suite as 4567 passed, 0 failed, 1 skipped. The skipped test was `fleet-branch city URLs preserved on NJ/NY/CT state hubs` because git ref `ux-remove-fleet-from-booking` is not in that checkout. The settlement file in the same run reported 24 passed and 0 skipped.

Two conditional suites also appear as skipped in that log and were not executed: `customer identity postgres concurrency (isolated DB)` when `CUSTOMER_IDENTITY_TEST_DATABASE_URL` is unset, and `owner-studio catalog staging integration` when `OWNER_STUDIO_STAGING_INTEGRATION` is not `1`. This phase does not claim those suites were executed.
