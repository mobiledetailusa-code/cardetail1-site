# Owner Studio — Admin Authorization Contract (Stage 1)

## Identity

Reuse the existing authenticated Admin session from `netlify/lib/admin-security.js` + `netlify/functions/admin-auth.js`.

- No new shared static password for Owner Studio.  
- No production QA bypass for Owner Studio APIs.  
- Actor identity for audit = authenticated admin username / session subject.

## Roles (Stage 1 mapping)

The current admin login is a single privileged operator identity (username + password). Stage 1 maps:

| Role | Stage 1 mapping | Permissions |
|------|-----------------|-------------|
| **Owner** | Authenticated admin when `OWNER_STUDIO_ROLE=owner` or default admin treated as Owner in staging with flag on | Edit drafts; publish; rollback; manage catalog/media/nav/footer; view audit |
| **Admin** | Authenticated admin when `OWNER_STUDIO_ROLE=admin` | Edit allowed drafts; **cannot** change infrastructure; publish/rollback only if `OWNER_STUDIO_ADMIN_CAN_PUBLISH=true` |
| **Staff** | Non-admin / tech / customer identities | **No** Owner Studio access |

No editable permission UI in Stage 1.

## Sensitive actions

| Action | Required |
|--------|----------|
| Read foundation status | Admin session + `OWNER_STUDIO_ENABLED` (shell may show disabled state without data writes) |
| Save draft / create revision | Owner, or Admin with edit grant |
| Publish | Owner, or Admin with explicit publish grant |
| Rollback | Owner, or Admin with explicit publish grant |
| Infrastructure / secrets | **Denied** always |

All checks are server-side. Client UI is never authoritative.

## CSRF

Owner Studio mutating endpoints must require:

- Same-origin / trusted site origin checks (reuse `trusted-site-origin` patterns), and  
- Admin session token, and  
- CSRF token bound to session (double-submit or session-stored token) on POST/PUT/PATCH/DELETE.

## Rate limiting

Reuse admin rate-limit patterns for auth failures; apply per-session rate limits to publish/rollback (low QPS).

## Audit

Every draft save, revision, publish, rollback, and denied elevated action appends an Owner Studio audit event with:

- `siteId`  
- `actor`  
- `action`  
- `entityType` / `entityId`  
- `releaseId?`  
- `at`  

## Feature flags

| Flag | Default | Effect |
|------|---------|--------|
| `OWNER_STUDIO_ENABLED` | `false` | Shell shows disabled; write/publish APIs hard-deny |
| `OWNER_STUDIO_ROLE` | `owner` (dev) / unset | Role mapping |
| `OWNER_STUDIO_ADMIN_CAN_PUBLISH` | `false` | Admin publish/rollback gate |
| `PUBLIC_CONTENT_SOURCE` | `legacy` | Public reads ignore Owner Studio |

## Explicit non-goals

- No tech-portal Owner Studio access  
- No customer access  
- No weaker “content password”  
- No production smoke secret bypass  
