# Stage 2B — Customer Saved Vehicles

## Objective

Migrate My Garage saved vehicles from the legacy phone-keyed Netlify Blob store
(`cd1-customer-vehicles`) to durable PostgreSQL `CustomerVehicle` rows owned by
`CustomerAccount`.

## Ownership

- Authority: PostgreSQL `CustomerVehicle`
- Owner key: `customerAccountId` from the authenticated customer session only
- Browser-supplied `customerAccountId`, phone, or Blob owner keys are ignored
- Soft-archive via `archivedAt` (never hard-delete)
- Independent from booking/job `Vehicle` rows (no FK in Stage 2B)

## Default-vehicle invariant

- Zero or one **active** default per account
- First created vehicle becomes default
- `set_default` clears other active defaults in the same transaction
- Archiving the current default promotes the oldest remaining active vehicle
  (`createdAt ASC`, then `id ASC`); if none remain, the account has no default
- Archived vehicles cannot be default and are omitted from active lists

## Legacy Blob import

- Source: `cd1-customer-vehicles` / `owner_<10-digit-phone>` (read-only)
- Trigger: migrate-on-login / first authenticated vehicle list or mutation
- Marker: `CustomerAccount.vehiclesImportedAt`
- Dedup key: `legacySourceId = blob:<legacyVehicleId>` unique per account
- Concurrency: `pg_advisory_xact_lock` on `vehicle-import:<customerAccountId>`
- Idempotent: retry after success is a no-op; failed imports roll back fully
- Blob records are **not** deleted or rewritten; TTL cleanup is deferred

## API

`POST /.netlify/functions/customer-portal-vehicles`

Actions: `list` | `add` | `update` | `archive` | `set_default`

- Session `scope=account` required
- Active account gate (`assertCustomerPortalAccountActive`)
- Mutations require `expectedVersion` (account optimistic concurrency)
- Stable errors: `authentication_failed`, `validation_error`, `not_found`,
  `version_conflict`, `service_unavailable`, `rate_limited`

## Authorization

- Customer session secret remains separate from admin
- Cross-account vehicle IDs → uniform `not_found`
- Disabled/merged accounts → uniform `not_found`
- Admin mutations out of scope; optional admin read enrichment only
  (`activeVehicleCount`, `defaultVehicle`)

## Rollout

1. Deploy additive Prisma migration
2. Branch/preview QA with synthetic accounts only
3. Merge Draft PR after independent audit
4. Git-triggered Production deploy

## Rollback

- Code rollback restores Blob-backed reads only if a prior release is redeployed;
  Stage 2B intentionally disables Blob writes
- Prefer forward fix: keep Postgres authority
- Schema is additive; do not drop `CustomerVehicle` as a rollback

## Testing

- Focused: `tests/customer-saved-vehicles.test.js`
- Stage 2A regressions: `tests/customer-profile-address-management.test.js`
- Identity foundation + security prerequisites
- PG concurrency: `tests/customer-identity-pg-concurrency.test.js`
  (requires `CUSTOMER_IDENTITY_TEST_DATABASE_URL`)
- Full suite: `npm test`

## Deferred

- Blob TTL / deletion after soak
- Communication Preferences / Consent UI
- Authenticated booking prefill
- Linking garage vehicles to booking `Vehicle` rows
- Admin vehicle mutations
