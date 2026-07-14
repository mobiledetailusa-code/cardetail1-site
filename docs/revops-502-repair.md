# RevOps 502 repair — root cause and fix

## Observed symptom

Admin Operations → **Revenue Ops** tab showed:

`RevOps load failed: HTTP 502`

The **Needs Attention Now** section never populated. Refresh did not recover.

## Failing endpoint

| Field | Value |
|-------|-------|
| Function | `revenue-admin` |
| URLs | `GET /.netlify/functions/revenue-admin?view=summary` |
| | `GET /.netlify/functions/revenue-admin?view=priority` |
| | `GET /.netlify/functions/revenue-admin?view=opportunities` |
| Auth | Admin session token via `x-admin-key` header |
| Method | GET |

Unauthenticated requests correctly returned **401**. The **502** occurred only after successful Admin authorization when the function attempted Blob reads.

## Root cause

`netlify/lib/revenue-store.js` → `blobListKeys()` used:

```js
for await (const entry of store.list({ prefix, limit })) { ... }
```

Netlify Blobs `store.list()` resolves to `{ blobs: [...] }` (or a **paginated async iterator** when `{ paginate: true }`). It is **not** directly async-iterable in the standard list mode.

When RevOps loaded, `revenue-admin` called `listRecentEvents()` / `listOpportunities()` → `blobListKeys()` → unhandled `TypeError` → Netlify surfaced **HTTP 502**.

This was **not** missing data, missing HubSpot, or missing env vars. Empty stores must return **200** with empty metrics.

## Blob stores involved

| Logical key | Store name |
|-------------|------------|
| events | `revenue-events` |
| leads | `revenue-leads` |
| households | `revenue-households` |
| opportunities | `revenue-opportunities` |
| recovery | `revenue-recovery-queue` |
| adminAudit | `revenue-admin-audit` |
| eventIdempotency | `revenue-event-idempotency` |

Garage Plan submissions write to **leads**, **households**, and **opportunities** via `garage-plan-submit.js`.

## Repair

1. **`revenue-store.js`** — align `blobListKeys` with `tech-security.listAllBlobs` (paginated iterator + `{ blobs }` fallback).
2. **`revops-dashboard.js`** — bounded aggregation, malformed-record skipping, funnel/summary/priority contract.
3. **`revenue-admin.js`** — top-level try/catch → controlled **503** `revops_temporarily_unavailable`; `Cache-Control: no-store`; unified `view=dashboard`.
4. **`admin-ops.html`** — single dashboard fetch, loading/error/retry UI, Garage Plan section.
5. **`garage-plan-submit.js`** — tag opportunities `isGaragePlan` + `garagePlanStatus: new`.

## Regression tests

`tests/revops-502-repair.test.js`

## Security notes

- No secrets, cookies, or customer PII in this document.
- RevOps remains Admin-authenticated only.
- Responses are bounded and sanitized.
