# Owner Studio — Stages 2–6 Roadmap

Depends on Stage 1 foundation (contracts, schema, services, flags off, legacy fallback).

## Stage 2 — Catalog Manager UI

**Scope:** Editable UI for packages, vehicle-class prices, add-ons, compatibility, active/featured/order. Draft-only writes through validation services. No public cutover.

**Dependencies:** Stage 1 catalog contract, schemas, draft/revision services, auth.

**Effort:** ~5–8 engineering days.

**Migration risks:** Accidental publish; price drift vs legacy while dual-running; hub HTML still stale until later cutover.

**Required tests:** Price cents validation; compatibility; draft isolation; admin auth; no public catalog change with flags off.

**Release gate:** Catalog UI behind `OWNER_STUDIO_ENABLED`; publish still restricted; booking regression green; importer re-run clean on staging DB.

## Stage 3 — Media Library

**Scope:** Upload/metadata for images; alt/captions; prevent hard-delete of referenced media; bind media IDs to pages/packages.

**Dependencies:** Stage 1 `MediaAsset` model; blob storage patterns; auth.

**Effort:** ~4–6 days.

**Migration risks:** Orphan files; oversized uploads; path traversal; mixing ops job photos with marketing media.

**Required tests:** Safe URL/path; reference validation; no secrets in snapshots; delete soft-only when referenced.

**Release gate:** Media APIs authenticated; quarantine for unpublished assets; public site still legacy.

## Stage 4 — Global Content Editor

**Scope:** Header, footer, homepage hero/CTAs, basic SEO fields. Plain-text + media refs only.

**Dependencies:** Stages 1–3; page content schemas; snapshot format.

**Effort:** ~5–7 days.

**Migration risks:** Nav/footer breaking links; SEO regressions; duplicate footer sync with specialty partials.

**Required tests:** HTML/script rejection; slug/URL safety; legacy fallback; visual smoke with flag off unchanged.

**Release gate:** Draft preview internal-only; no public `PUBLIC_CONTENT_SOURCE` flip.

## Stage 5 — Page Sections and Gallery Editor

**Scope:** Specialty/hub section editor, gallery ordering, FAQ entries, service-area marketing lists (not ops ZIP enforcement).

**Dependencies:** Stages 2–4; inventory of specialty/hub pages.

**Effort:** ~6–10 days.

**Migration risks:** Hub generator conflict; SEO location drift; treating ops ZIP rules as marketing lists.

**Required tests:** Per-page publish readiness; gallery integrity; hub regression tests.

**Release gate:** Generators either consume Owner Studio or are frozen; no half-migrated hubs in production.

## Stage 6 — Preview, Publish, Release History, Rollback UI

**Scope:** Full preview of release candidate; publish + rollback controls; release history; audit views; optional staging content source.

**Dependencies:** All prior stages; staging DB + blob isolation; authorization publish grants.

**Effort:** ~5–8 days.

**Migration risks:** Atomic pointer failure; incompatible content/catalog pair; accidental production publish; booking snapshot not yet wired.

**Required tests:** Atomic release; rollback; snapshot purity; booking snapshot write on new bookings (staging); full payment/booking suite; production flag defaults.

**Release gate:**

1. Staging fingerprint ≠ production  
2. `OWNER_STUDIO_ENABLED` explicit on staging only  
3. `PUBLIC_CONTENT_SOURCE=owner-studio` only after parity sign-off  
4. Booking snapshot persisted for new bookings  
5. Rollback drill succeeded  
6. Independent audit pass  

## Suggested sequence gate before any production content cutover

Legacy importer clean report → staging publish → public snapshot parity tests → booking price parity vs `booking-price-catalog.js` → enable read path behind flag → monitor → remove duplicate HTML pricing in a dedicated cleanup PR.
