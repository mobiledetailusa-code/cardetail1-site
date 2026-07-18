# Deploy Preview PostgreSQL Environment Requirements

**Date:** 2026-07-18
**Trigger:** owner correction — Netlify has no `DATABASE_URL`/PostgreSQL variable configured, so the deployed Deploy Preview cannot reach Postgres even though local `.env`-based migrations succeeded. This document is read-only investigation + two new, isolated, additive files (a health-check function and a hardened smoke test). **No existing application file, no checkout code, and no Netlify configuration was changed.** Phase 3 was not started.

---

## 1. What was inspected

- `package.json` — scripts block
- `prisma.config.ts` — CLI datasource resolution
- `prisma/schema.prisma` — datasource block
- `netlify/lib/prisma.js` — the actual runtime database client used by deployed Functions
- `netlify.toml` — `[build]`, `[functions]`, `[dev]` blocks
- Repo-wide search for any `.github/workflows` or other CI file, and for any `migrate deploy`/`migrate dev` invocation outside `package.json`

## 2. Required variables

| Variable | Required by | Read where |
|---|---|---|
| **`DATABASE_URL`** | **Yes — this is the only variable the deployed app needs at runtime.** | `netlify/lib/prisma.js#prismaConfigured()`/`tryGetPrisma()` — every Netlify Function that touches Postgres (the `BookingRecord` mirror today; nothing else is wired to a live endpoint yet) goes through this one module, which reads `process.env.DATABASE_URL` directly. |
| `DIRECT_URL` | **No — not read by any deployed Function.** Only used by `prisma.config.ts` (`process.env["DIRECT_URL"] \|\| process.env["DATABASE_URL"]`), which is the Prisma **CLI's** datasource resolver for `prisma migrate`/`generate`/`studio` — commands that run on a developer's machine, never inside a Netlify Function at request time. |
| Separate "Prisma Accelerate" variable | **No — none exists.** The Accelerate endpoint and API key are already encoded inside the `DATABASE_URL` value itself (`prisma+postgres://accelerate.prisma-data.net/?api_key=...`). There is no second env var to configure for Accelerate specifically. |

No values were printed or logged at any point.

## 3. Required Netlify scope and deploy context, per variable

| Variable | Scope | Deploy context |
|---|---|---|
| `DATABASE_URL` | **Functions** only. Not needed under Builds — see §4 (no build-time DB connectivity requirement). | **Deploy Previews** only. |
| `DIRECT_URL` | Not required in Netlify at all. It's a local/CLI-only variable for whoever runs `prisma migrate` by hand; there is no automated place in this repo's Netlify config that would read it. | N/A |

**No Production scope or context is recommended for either variable**, consistent with the standing rule to never configure Production. If the owner wants this to also work under Branch Deploys (not just PR-numbered Deploy Previews), that would be a separate, explicit decision — not assumed here.

## 4. Does `prisma generate` require database connectivity in this repo?

**No — confirmed empirically, not just by reading the schema.** `prisma/schema.prisma`'s `datasource db` block has **no `url` field at all** (Prisma 7's config-based datasource resolution is used instead, via `prisma.config.ts`, which is CLI-only). Ran directly in this environment with both `DATABASE_URL` and `DIRECT_URL` unset:

```
$ env -u DATABASE_URL -u DIRECT_URL npx prisma generate
✔ Generated Prisma Client (v7.8.0) to .\node_modules\@prisma\client in 257ms
```

Succeeded with zero network activity. This means `DATABASE_URL` does **not** need to be present at Netlify's install/build step (which runs `npm install` → `postinstall` → `prisma generate`) for the build to succeed — it is only needed later, at Function invocation time, by `netlify/lib/prisma.js`.

## 5. Does any migration command run during Netlify builds?

**No.** Checked three places, all negative:

- `netlify.toml` `[build]` block has no `command = ...` line — Netlify runs its default install step only (`npm install`, which triggers `postinstall: prisma generate`), then publishes the static site. No `npm run build` script exists in `package.json` to have run anything else.
- `package.json` scripts (`prisma:migrate` = `prisma migrate dev`, `prisma:deploy` = `prisma migrate deploy`) exist but are **not** referenced from `netlify.toml`, `postinstall`, or anywhere else that runs automatically.
- No `.github/workflows` or other CI file exists in this repo that references `migrate deploy`/`migrate dev`.

**Migrations are applied manually only** (as they were for this session's Phase 2 migration, via `npx prisma migrate dev` against the local `.env`'s `DIRECT_URL`). Deploy Previews will run against whatever schema state the configured `DATABASE_URL` database is already in — this document does not add any automated migration step, since that would be an application/infra behavior change outside this instruction's scope.

## 6. Deploy Preview database health endpoint

**New file:** `netlify/functions/db-health.js` (no endpoint existed before; nothing in the repo already served this purpose).

Behavior (all 5 cases exercised directly against the handler, not guessed — see `tests/db-health.test.js` for the automated regression versions):

| Condition | Response |
|---|---|
| `DATABASE_URL` unset | `200 { "configured": false, "reachable": false }` |
| `DATABASE_URL` set, real configured DB | `200 { "configured": true, "reachable": true }` — proven via a real `SELECT 1` round trip, not just "client constructed" |
| `DATABASE_URL` set to an unreachable/bad host | `200 { "configured": true, "reachable": false }` — the query throws, is caught, and the response stays exactly these two booleans; the raw driver error (which can contain host/port fragments) is never included in the response body |
| `OPTIONS` | `204` preflight |
| `POST`/other methods | `405 { "ok": false, "error": "method_not_allowed" }` |

It never returns a hostname, credential, connection string, or raw error message under any condition — verified by direct inspection of every response body above, and by an automated `noLeak()` assertion in `tests/db-health.test.js` that greps every response for `db.prisma.io`, `accelerate.prisma-data.net`, `postgres://`, and `api_key=`.

**To use it once you've configured `DATABASE_URL`:** `GET https://deploy-preview-<PR#>--cardetail1.netlify.app/.netlify/functions/db-health`

## 7. Prisma mirror smoke test — hardened against false passes

**Problem found:** every existing test in `tests/booking-prisma-mirror.test.js` deliberately ran with `DATABASE_URL` forced empty — they prove the mirror *fails open safely when unconfigured*, which is correct and necessary, but **none of them ever proved a real database write+read succeeds when it is configured.** A "skipped" or fail-open result could never have been caught as a false pass by this suite, because nothing exercised the configured path at all.

**Fix (additive, existing tests unchanged):** added a new `describe` block to the same file — `booking Prisma mirror — real database round trip when configured` — that:
- Skips (visibly, as `skipped`, never counted as `pass`) only when no `DATABASE_URL` is configured in the running environment at all.
- When a `DATABASE_URL` **is** configured, asserts `upsertBookingMirror(...)` returns `{ ok: true }` (not `{ skipped: true }`), then calls `readBookingMirror(id)` and asserts the row that comes back matches what was written — a real `SELECT`, not just "the write call didn't throw."
- Cleans up the test row afterward (`BookingRecord` has no immutability constraint, unlike the Phase 2 `LedgerEntry` table).

Run against the currently-configured local `.env` database: **8/8 pass, 0 skipped** — the real round-trip proof executed and passed. This is the same test that, in a Deploy Preview once `DATABASE_URL` is set there, will fail loudly instead of silently skipping if the mirror stops actually working end-to-end.

## 8. Files changed / added this turn

| File | Type |
|---|---|
| `netlify/functions/db-health.js` | new — the health-check endpoint (§6) |
| `tests/db-health.test.js` | new — regression coverage for the endpoint's 5 behaviors |
| `tests/booking-prisma-mirror.test.js` | modified — added `require('dotenv/config')` at the top + one new `describe` block (§7); the 7 pre-existing tests are untouched |
| `docs/audit/db-env-requirements-2026-07-18.md` | new — this document |

No `.html` file, no `netlify/functions/*` file other than the new `db-health.js`, and no existing `netlify/lib/*.js` file was touched. No Netlify configuration file (`netlify.toml`) was changed. No secret was added to any file, log, commit, or this report — every environment-variable value referenced above is described by name and purpose only, never by value.

## 9. Confirmation

**No Production configuration is required or recommended anywhere in this document.** Both required-scope statements in §3 are explicitly Deploy-Previews-only. The owner still needs to add `DATABASE_URL` in Netlify's UI (Site settings → Environment variables → scope: Functions, deploy context: Deploy previews) manually — nothing here does that for them, and nothing here prints or requests the value.

**Nothing was committed.** All of §8's files are new/modified in the working tree only, same as the rest of this session's Phase 2 work (still uncommitted per `docs/audit/containment-evidence-2026-07-18.md`).

Stopping here per instruction — waiting for the owner to configure Netlify before any further action.

---

## Addendum — closed out 2026-07-18

`DATABASE_URL` is now correctly configured for `deploy-preview`, `branch-deploy`, and `dev` contexts (set via `netlify-cli env:set`, since the raw Environment Variables API rejected every hand-built payload this session tried — the CLI succeeded on the first attempt with the correct site auto-detected from `NETLIFY_SITE_ID`). `production` context was deliberately left untouched, per this document's original recommendation.

Netlify's env-var read API masks the `value` field for any `is_secret: true` variable (confirmed by comparing against `STRIPE_SECRET_KEY`, a known-good live variable showing the identical masked pattern) — so correctness could not be verified by reading the API back. It was instead verified by deploying and calling the real endpoint:

All 8 commits from this session were pushed to `feat/postgres-payment-core` (not merged to master, not touching `fix/final-production-readiness`). Netlify auto-built a branch deploy: `https://feat-postgres-payment-core--cardetail1.netlify.app` (context: `branch-deploy`).

```
GET https://feat-postgres-payment-core--cardetail1.netlify.app/.netlify/functions/db-health
200 { "configured": true, "reachable": true }
```

This is the first real, live confirmation that a deployed Netlify Function can reach Postgres. Deploy Preview scope closes here. Phase 3 was not started; master was not touched; Production was not configured.
