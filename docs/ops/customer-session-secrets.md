# Customer session secrets (Production)

## Purpose

Customer Portal cookies must be cryptographically separated from Admin sessions.

## Code resolution order

`netlify/lib/customer-session.js` → `sessionSecret()`:

1. `CUSTOMER_SESSION_SECRET` (required for Production cryptographic separation)
2. else `ADMIN_SESSION_SECRET` (legacy fallback — **not intentional long-term**)
3. else non-production only: `BID_SECRET` / `ADMIN_DASH_PASSWORD` / hard-coded dev string

Admin sessions (`netlify/lib/admin-security.js`) use **only** `ADMIN_SESSION_SECRET` in Production.

## Production finding (post Stage 2A release)

| Variable | Production | Notes |
|----------|------------|-------|
| `CUSTOMER_SESSION_SECRET` | **absent** | Present only on `branch-deploy` today |
| `ADMIN_SESSION_SECRET` | present (secret/masked) | Used as customer fallback |

**Blocking:** Production customer sessions currently depend on `ADMIN_SESSION_SECRET` via unintentional fallback.

## Required ops action (manual — do not automate from this repo)

1. In Netlify → Site `cardetail1` → Environment variables.
2. Add **`CUSTOMER_SESSION_SECRET`** for context **Production** only.
3. Value: a new random secret, **≥ 32 characters**, **different** from `ADMIN_SESSION_SECRET`.
4. Do **not** copy the admin secret.
5. Do **not** commit the value.
6. Redeploy Production (or wait for next Git production deploy) so Functions pick up the var.
7. Expect existing customer cookies signed with the admin fallback to fail closed → customers re-authenticate via magic link.

## Verification (no secret values printed)

```bash
NETLIFY_AUTH_TOKEN=... node scripts/check-customer-session-architecture.mjs
```

Exit code `0` when Production has a dedicated `CUSTOMER_SESSION_SECRET`.  
Exit code `2` while Production still falls back to `ADMIN_SESSION_SECRET`.
