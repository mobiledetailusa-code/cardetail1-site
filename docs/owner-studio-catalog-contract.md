# Owner Studio — Authoritative Catalog Contract (Stage 1)

## Goal

One published catalog serves:

- public package cards  
- booking price calculation  
- Admin booking review  
- customer appointment display  
- payment preparation  
- future Book Again  

There must not be separate uncontrolled package/price definitions for the website and booking system after cutover.

## Tenant

| Field | Value |
|-------|-------|
| `siteId` | `detailing-zone` |

All tenant-capable entities include `siteId`.

## Stable IDs (not editable names)

Editable names/slugs are never financial or historical primary keys.

| Entity | Example ID |
|--------|------------|
| Package | `pkg_maintenance_detail` |
| Vehicle class | `vc_sedan` (maps legacy `small`) |
| Add-on | `addon_pet_hair` (maps legacy `pethair`) |

Legacy short keys (`maint`, `pethair`, `small`) are retained as `legacyKey` for importer compatibility and booking probes during transition.

### Initial package ID map (cars)

| legacyKey | packageId |
|-----------|-----------|
| maint | `pkg_maintenance_detail` |
| interior | `pkg_interior_detail` |
| full | `pkg_full_detail` |
| refresh | `pkg_paint_refresh` |
| premium | `pkg_premium_detail` |

Other categories use `pkg_{category}_{legacyKey}` (e.g. `pkg_boats_essential`, `pkg_rvs_full_basic`).

### Initial vehicle class map (cars)

| legacyKey | vehicleClassId |
|-----------|----------------|
| small | `vc_sedan` |
| suv2 | `vc_suv_2row` |
| suv3 | `vc_suv_3row` |
| truck | `vc_truck` |

Other categories: `vc_{category}_{legacyKey}`.

### Initial add-on map

`addon_{legacyKey}` with underscores for readability where needed (`pethair` → `addon_pet_hair` via explicit map; unknown legacy ids → `addon_{legacyKey}` deterministic).

## Entities

### Site
- `siteId` (PK)
- `name`
- `status`

### SiteSettings
- `siteId`
- presentation globals (logo media, phone, social, announcement)
- **not** secrets

### Package
- `siteId`, `packageId` (stable)
- `legacyKey`, `category`
- `active`, `featured`, `displayOrder`
- soft-deactivate only (no hard delete if ever published/booked)

### PackageRevision
- immutable row per edit
- `packageRevisionId`, `packageId`, `siteId`
- `name`, `slug`, `description`, `shortDescription`
- `durationMinutes?`
- `createdAt`, `createdBy`

### PackagePrice
- `packagePriceId`, `siteId`, `packageId`, `packageRevisionId?` or release binding
- `vehicleClassId?` (null = category default)
- `currency` (e.g. `usd`)
- `amountCents` (integer ≥ 0)
- `priceModel`: `flat` | `per_foot` | `base_plus_per_foot`
- `perFootCents?`, `minCents?`, `baseCents?`
- uniqueness: one active price row per (`siteId`,`packageId`,`vehicleClassId`,`priceModel`) in a release

### PackageFeature
- `packageId` + revision
- `kind`: `included` | `excluded`
- `label` (plain text)
- `sortOrder`

### PackageAvailability
- `packageId`, `siteId`
- service-area / channel flags
- `active`

### VehicleClass
- `vehicleClassId`, `siteId`
- `legacyKey`, `category`, `label`
- `active`

### AddOn / AddOnRevision / AddOnPrice
- parallel to packages
- `amountCents` integer, `currency`
- `allowQuantity` boolean

### AddOnCompatibility
- `addOnId`, `category` and/or `packageId` allow-lists
- validation required at publish

### ServiceArea
- marketing + optional linkage keys
- enforcement rules remain Category C until later stage

### CatalogDraft
- mutable working state for a site
- never read by public website

### CatalogRevision
- immutable snapshot of a draft save (validation → revision)

### PublishedCatalogRelease
- immutable release
- `releaseId`, `siteId`, `schemaVersion`
- pointers to content snapshot + catalog snapshot digests
- `publishedAt`, `publishedBy`

### CurrentReleasePointer
- `siteId` → `releaseId` (atomic update on publish/rollback)

### AuditLog (Owner Studio)
- actor, action, siteId, entity refs, before/after digests, timestamp

## Money rules

1. Currency stored explicitly (`usd`).  
2. Monetary values stored as **integer cents** only.  
3. Reject floating-point money at validation boundary.  
4. Prohibit negative prices unless an explicit discount model exists (Stage 1: **no negatives**).  
5. Validate vehicle-class and add-on compatibility.  
6. Reject duplicate active price rows in a release candidate.  
7. Validate required booking price coverage (every active package × required vehicle classes for category, or explicit length model).  

Legacy dollar numbers are converted only in the importer: `cents = Math.round(dollars * 100)` with conflict reporting — never guessed.

## Publication flow

```
Draft write → validate → CatalogRevision
Publish → full validate → PublishedCatalogRelease (immutable)
         → atomic CurrentReleasePointer update
         → generate public snapshots (catalog + site-content)
Rollback → validate target release → atomic pointer update → audit
```

Public reads resolve **only** via current pointer → immutable release snapshots.

## Stage 1 runtime binding

| Flag | Default | Behavior |
|------|---------|----------|
| `OWNER_STUDIO_ENABLED` | `false` | Admin shell shows disabled; write APIs deny |
| `PUBLIC_CONTENT_SOURCE` | `legacy` | Public site + booking continue using `booking-price-catalog.js` / HTML |

Unknown/missing flags → safe legacy fallback.
