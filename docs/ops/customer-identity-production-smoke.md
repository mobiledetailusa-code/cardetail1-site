# Authenticated Customer Identity Production smoke

## Goals

Exercise Stage 2A profile/address paths on a live deploy with:

- no forged cookies using admin secrets;
- no persistent QA accounts;
- no secrets / PII in logs;
- explicit audit events;
- disabled by default.

## Preferred operator paths

### A. Magic-link (preferred when mailbox access exists)

1. Create or reuse a disposable QA identity that has (or will get) a booking contact email you control.
2. Open Production My Garage → request magic link for that email.
3. Complete verify in the browser.
4. Manually exercise Profile + Addresses UI.
5. Logout.
6. Archive/delete any QA fixtures via Admin/ops policy.

This path uses the normal auth flow end-to-end.

### B. Restricted smoke harness (operational automation)

Function: `/.netlify/functions/qa-customer-identity-smoke`

**Disabled unless** Netlify env `CUSTOMER_IDENTITY_SMOKE_SECRET` is set (32+ chars) on the target context.

Invoke:

```bash
# Secret only in local shell / CI secret store — never commit
export CUSTOMER_IDENTITY_SMOKE_SECRET='...'   # 32+ chars
export SMOKE_BASE_URL='https://cardetail1.com'
node scripts/prod-customer-identity-smoke.mjs
```

Request auth: header `x-cd1-smoke-secret` must match (timing-safe). Wrong/missing secret → HTTP `404 not_found` (no oracle).

Harness behavior:

1. Creates tagged ephemeral CustomerAccount + profile (`@example.test`).
2. Opens a normal `createAccountSession` (same helper as magic-link verify).
3. Runs get/update profile + create/update/set-default/archive address.
4. Revokes the session (logout).
5. Deletes QA account rows and related smoke audits.
6. Emits non-PII `customer_identity_smoke.started` / `.completed` AuditEvents.

## Safety properties

| Property | How |
|----------|-----|
| No forged admin cookies | Uses `createAccountSession` with the deploy’s customer session secret resolution |
| No permanent QA account | Cleanup deletes account/profile/addresses |
| No Production backdoor when unset | Function returns 404 if secret unset |
| No secret logging | CLI prints step PASS/FAIL + hashes only |
| Authorization not bypassed for real customers | Only operates on the ephemeral account it creates |

## Enable on Production (optional)

1. Set `CUSTOMER_IDENTITY_SMOKE_SECRET` in Netlify **Production** (32+, unique).
2. Prefer also setting dedicated `CUSTOMER_SESSION_SECRET` first (see `customer-session-secrets.md`).
3. Redeploy.
4. Run the CLI against `https://cardetail1.com`.
5. Unset / rotate the smoke secret when not actively testing.
