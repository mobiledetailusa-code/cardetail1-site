# Owner Studio Stage 1 — Status Notes

## Baseline

| Item | Value |
|------|-------|
| Repository | `mobiledetailusa-code/cardetail1-site` |
| Local path | `C:\Users\magno\Desktop\cardetail1-stage2b` |
| Approved baseline | Production portal canary `605e2f5697850594e2c2a8bea2921b3a02d90eb2` (`feat/final-portal-functional-closure`) |
| Feature branch | `feat/owner-studio-foundation` (recreated from production commit; not bare master) |
| Site ID | `detailing-zone` |

## Production / master alignment

- Classification: **B — production ahead of master**.
- Published production deploy ID: `6a650b94b60f53f5431d1f79` (CLI canary; `commit_ref` null; title `@ 605e2f5`).
- Production commit: `605e2f5697850594e2c2a8bea2921b3a02d90eb2`.
- Production branch label: `master` (CLI publish); content from `feat/final-portal-functional-closure`.
- `origin/master` HEAD: `46dcac54cd3f703532c96017f3e2f78e15bd5d88` (behind production).
- Immediate previous ready production deploy: `6a64fd38791e1b91b9e2dc74` @ `46dcac5`.
- Earlier appointment canary production: `6a645946a7bd8241e226e2ca` @ `0cf4963`.
- Production ancestry includes appointment-access (`0cf4963`) and portal closure (`a1c9f82`).

## Database / migration

- Connected `.env` host fingerprint: `db.prisma.io` (production Prisma Postgres). **No staging URL configured.**
- Migration `20260725180000_owner_studio_foundation` is **generated only** and **not applied**.
- Prerequisite: `OWNER_STUDIO_STAGING_DATABASE_URL` with fingerprint ≠ production.

## Feature flags (defaults)

```
OWNER_STUDIO_ENABLED=false
PUBLIC_CONTENT_SOURCE=legacy
OWNER_STUDIO_ROLE=owner
OWNER_STUDIO_ADMIN_CAN_PUBLISH=false
```

Unknown/missing → legacy public content. Public website and booking catalog remain on existing code paths.

## Full-suite note

`fleet-branch city URLs preserved on NJ/NY/CT state hubs` requires a local git ref named `ux-remove-fleet-from-booking` (`git show ux-remove-fleet-from-booking:…`). With only `origin/…` fetched, the helper returns `[]` and the assertion fails identically on clean baseline and Owner Studio candidate. Creating the local tracking branch makes the suite green; this is an environment/reference issue, not an Owner Studio regression.

## Branch deploy

Not executed in Stage 1 delivery. Permitted later only with flags off, admin auth required for shell, and no production data writes.
