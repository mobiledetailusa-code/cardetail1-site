# Square Sandbox webhook receiver

This receiver is code only. It is not deployed, and no Square subscription, Netlify site, or database was created with it.

The commercial site keeps publishing `netlify/functions` from the repository-root `netlify.toml`. The receiver lives in `sandbox/square-webhook/` and is selected only when a separate Netlify site uses that directory as its package directory.

`getActivePaymentProvider()` stays `none`. A stored event does not confirm a Cardetail1 payment.

## HTTP behavior

Only `POST` is accepted. The body is measured after Base64 decoding. The limit is 1 MiB of decoded bytes. A larger body returns 413 and is not signed.

Configuration is checked before the HMAC. The function reads Netlify's runtime `SITE_ID`. It does not read `NETLIFY_SITE_ID`. `CONTEXT=production` is not an allow signal, because the sandbox site's own primary deploy uses that context. Both `SITE_ID` and `SQUARE_SANDBOX_ALLOWED_SITE_ID` must be present and equal. These site ids are always refused:

- Production `d7e5f77c-1f0b-4209-a9df-3d6aae380dd0`
- Staging `982e6338-4a4a-432e-855b-db532b994391`

`SQUARE_SANDBOX_WEBHOOK_CONFIRMATION` must be exactly `square-sandbox`. The merchant id, the exact notification URL, the webhook signature key, and `SQUARE_SANDBOX_WEBHOOK_DATABASE_URL` are also required. The URL must be `https://cardetail1-square-sandbox.netlify.app/...`. `Host` and `X-Forwarded-Host` are ignored. `cardetail1.com` and the Square API hosts are refused. Commercial database and payment variables must be absent. A credential prefix is an extra refusal, not the control that decides the environment is safe.

Incomplete configuration returns 503 and writes nothing.

The HMAC is the PR #370 verifier. JSON is interpreted only after that check succeeds. A missing or invalid signature returns 403 and writes nothing.

A signed event with no `event_id` returns 400. No replacement id is created.

A new authenticated event is inserted, and only then returns 200. The insert is:

```sql
INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING event_id
```

The same `event_id` returns 200 with `result: duplicate` and does not change the row. Two different event ids for one payment id are two rows. An older event does not overwrite a newer row.

| Result | HTTP | Row |
|---|---|---|
| Valid new `payment.created` or `payment.updated` | 200 | `stored` |
| Duplicate `event_id` | 200 | unchanged |
| Other event type, matching merchant | 200 | `unsupported` |
| Valid signature, different merchant | 200 | `rejected_merchant` |
| Database connection or insert failure | 503 | no confirmation |
| Body larger than 1 MiB | 413 | none |
| Bad or missing signature | 403 | none |
| Missing `event_id` | 400 | none |

`paymentConfirmed` is false on every response. `COMPLETED` means Square reported that status. It does not settle a Cardetail1 booking.

Logs for an authenticated delivery contain the event id, the type, and the result, with control characters removed. Logs for a rejected request contain only the result code. The signature, the body, card data, and the database URL are not logged.

## Build isolation

Resolved with `@netlify/config` from the CI Netlify CLI, package directory `sandbox/square-webhook`, base directory unset:

- The commercial site keeps `netlify.toml` at the repository root and `netlify/functions`.
- The sandbox site keeps `sandbox/square-webhook/netlify.toml`, publish `sandbox/square-webhook/public`, and functions `sandbox/square-webhook/netlify/functions`.
- That functions directory contains only `square-sandbox-webhook.js`.
- The commercial `netlify build` output must not contain `square-sandbox-webhook`.
- The sandbox zip must contain the HMAC verifier and `pg`, and must not contain a live credential, the commercial Prisma client, or the commercial booking function. Netlify's bundler otherwise copies `@prisma/client` into every function that can resolve it from the repository root. `included_files` in the sandbox `netlify.toml` removes that client. The function opens only `SQUARE_SANDBOX_WEBHOOK_DATABASE_URL`.

`node sandbox/square-webhook/scripts/verify-build-isolation.mjs --main-dist .netlify/functions` performs that check. It does not call Square and does not open a database.

## Later activation

Do not perform these steps until a separate authorization. None of them run from CI.

1. In Netlify, add a site named `cardetail1-square-sandbox` on the existing team. Connect this repository. Leave **Base directory** empty. Set **Package directory** to `sandbox/square-webhook`. Do not point the existing `cardetail1` or `cardetail1-staging` sites at that package directory.
2. Confirm the resolved publish directory is `sandbox/square-webhook/public` and the functions directory is `sandbox/square-webhook/netlify/functions`. The site hostname should be `https://cardetail1-square-sandbox.netlify.app`. Do not attach `cardetail1.com`.
3. Copy **Site ID** from Project configuration → General → Site details. That value is the runtime `SITE_ID`. Put the same value in `SQUARE_SANDBOX_ALLOWED_SITE_ID`.
4. Create a new Postgres database that is not the commercial database and not the Owner Studio staging database.
5. Apply `sandbox/square-webhook/schema.sql` with `psql` against that new database only. The function does not apply the schema.
6. Set these variables on the sandbox site, scope **Functions**:
   - `SQUARE_SANDBOX_ALLOWED_SITE_ID`
   - `SQUARE_SANDBOX_WEBHOOK_CONFIRMATION` = `square-sandbox`
   - `SQUARE_SANDBOX_MERCHANT_ID`
   - `SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL` = `https://cardetail1-square-sandbox.netlify.app/.netlify/functions/square-sandbox-webhook`
   - `SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY`
   - `SQUARE_SANDBOX_WEBHOOK_DATABASE_URL`
   Do not copy `DATABASE_URL`, Stripe keys, or Square access tokens onto this site.
7. In the Square developer dashboard, open the **Sandbox** application. Add a webhook subscription for `payment.created` and `payment.updated` only. The notification URL must be character-for-character the value in `SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL`. Copy that subscription's signature key into `SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY`. Do not subscribe the production Square application.
8. Redeploy the sandbox site so the function scope values are loaded.
9. Send Square's sandbox test notification. A row with that `event_id` should appear. `result` in the function log should be `stored`, `unsupported`, or `rejected_merchant`.
10. Send the same notification again. The row count for that `event_id` stays one, and the log result is `duplicate`.
11. An unsigned POST should return 403 and add no row. `https://cardetail1.com/.netlify/functions/square-sandbox-webhook` should remain 404.
12. To turn the receiver off, delete the Square Sandbox subscription and remove `SQUARE_SANDBOX_WEBHOOK_CONFIRMATION`. The next deploy returns 503. The commercial site does not need a rollback.
13. A 503 from Postgres means the event was not acknowledged. Square will retry. Fix the sandbox database or the schema, then let the retry insert the same `event_id`. Do not change production data to recover it.
