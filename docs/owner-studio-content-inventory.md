# Owner Studio — Content Inventory (Stage 1)

**Baseline:** production portal canary `605e2f5697850594e2c2a8bea2921b3a02d90eb2` (includes master `46dcac5` + appointment/portal closure)  
**Site ID:** `detailing-zone`  
**Inventory date:** 2026-07-25  
**Scope:** Public site + booking catalog sources. No production content modified.

## Authority summary

| Domain | Current authority | Duplication risk |
|--------|-------------------|------------------|
| Transactional package/add-on **prices** | `netlify/lib/booking-price-catalog.js` (`PRICING`, `LENGTH_PRICING`) | **High** — mirrored inline in `index.html` and many hub HTML files |
| Customer portal package display | `canonical-package-catalog.js` + price probes via booking-price-catalog | Descriptions duplicated vs specialty pages |
| Customer portal add-on display | `canonical-addon-catalog.js` (`ADDON_DISPLAY`) + prices from booking-price-catalog | Names/descriptions only in this module |
| Public homepage presentation | `index.html` (inline HTML/CSS/JS) | Footer also in `assets/partials/specialty-public-footer.html` |
| Specialty service pages | `*-detailing.html`, `fleet-services.html`, `multi-vehicle-detailing.html` | Shared footer partial + page-local copy/pricing blocks |
| SEO hubs / city pages | `*-hub.html`, `*-mobile-detailing.html`, `template-city.html`, `scripts/generate-hub-pages.js` | Generated + hand-maintained; PRICING often embedded |
| Legal | `terms-conditions.html` | Presentation/ops policy hybrid |

---

## GLOBAL

| Item | Location | Format | Consumers | Duplicated? | Booking/pricing? | Presentation-only? | Alters existing booking? | Owner Studio entity.field | Priority |
|------|----------|--------|-----------|-------------|------------------|--------------------|--------------------------|---------------------------|----------|
| Logo | `assets/cardetail1-logo.webp`; referenced in `index.html`, footer partial, specialty pages | WebP path | Public HTML, OG rarely uses logo | Path repeated across HTML | No | Yes | No | `SiteSettings.logoMediaId` | P1 |
| Business name | `Cardetail1` / `Detailing Zone LLC` in footer, JSON-LD, meta `og:site_name` | String | SEO, footer, structured data | Yes (many files) | No | Yes | No | `SiteSettings.businessName`, `legalEntityName` | P1 |
| Header navigation | `index.html` `.nav-links`; specialty pages have local nav | HTML anchors | Public pages | Yes | No | Yes | No | `Navigation.headerItems[]` | P1 |
| Announcement bar | Not a dedicated global bar; hero badges / year-round chip in `index.html` | HTML | Homepage | Homepage-local | No | Yes | No | `SiteSettings.announcement` (nullable) | P2 |
| Booking CTA | Hero buttons + sticky booking entry in `index.html`; specialty bridges `assets/specialty-booking-bridge.js`, `hub-booking-bridge.js` | HTML + JS | Public booking entry | Labels duplicated | Indirect (entry only) | Mostly | No | `PageContent.ctaPrimary`, `ctaSecondary` | P1 |
| Phone | `+1-551-313-2956` / `5513132956` in JSON-LD, footer, CTAs | String | Public HTML, AI chat prompts | Yes | No (contact) | Yes | No | `SiteSettings.phoneE164` | P1 |
| Email | Sparse on public surface; more in ops/admin | String | Limited public | Low | No | Yes | No | `SiteSettings.publicEmail` | P2 |
| Social links | Instagram `https://www.instagram.com/cardetail1com` in footer | URL | Footer | Footer + copies | No | Yes | No | `SiteSettings.socialLinks[]` | P1 |
| Footer groups | `assets/partials/specialty-public-footer.html` (+ synced into pages via `scripts/sync-public-surface.mjs`) | HTML | Specialty + homepage footer | Yes if sync lag | No | Yes | No | `Footer.groups[]` | P1 |
| Legal links | Footer → `terms-conditions.html` | HTML | Public | Yes | Policy text may mention deposits | Mixed | No* | `Footer.legalLinks[]` + Page `terms` | P1 |
| Copyright | `© 2026 Cardetail1 · Detailing Zone LLC` | String | Footer | Yes | No | Yes | No | `Footer.copyright` | P1 |
| Global trust statements | Hero facts / year-round chip / homepage trust copy | HTML | Homepage | Some specialty echoes | No | Yes | No | `PageContent.sections[trust]` | P2 |

\*Changing legal/deposit **policy** can affect future bookings; historical bookings must keep snapshot/ledger.

---

## HOMEPAGE (`index.html`)

| Item | Location | Format | Consumers | Duplicated? | Booking/pricing? | Presentation-only? | Alters booking? | Entity.field | Priority |
|------|----------|--------|-----------|-------------|------------------|--------------------|-----------------|--------------|----------|
| Hero title / description | `.hero` markup ~line 140+ | HTML | Public | No (homepage) | No | Yes | No | `PageContent.home.hero.*` | P1 |
| Hero media | CSS/background + vehicle imagery under `assets/vehicles/` | Paths | Public | Shared assets | No | Yes | No | `PageContent.home.hero.mediaId` | P1 |
| CTA buttons | `.hero-btns`, ZIP checker | HTML/JS | Booking funnel entry | Labels elsewhere | Entry only | Mostly | No | `PageContent.home.ctas[]` | P1 |
| Trust indicators | `.hero-facts`, stats | HTML | Public | Partial | No | Yes | No | `PageContent.home.trust[]` | P2 |
| Featured services | Category cards linking specialty pages | HTML | Public | Specialty heroes | No | Yes | No | `PageContent.home.featuredServices[]` | P1 |
| Package cards | Inline package UI + `PRICING` JS (~3101+) | JS objects (dollars) | Booking modal on homepage | **Duplicates server catalog** | **Yes — client quote** | No | Future only if used live | Map → `Package` / `PackagePrice` | P0 |
| Gallery | Homepage gallery sections + `assets/` media | HTML + files | Public | Specialty galleries | No | Yes | No | `Gallery` + `MediaAsset` | P2 |
| Reviews/testimonials | Homepage sections (static) | HTML | Public | — | No | Yes | No | `PageContent.home.testimonials[]` | P2 |
| Service-area section | `#service-areas` + accordion JS | HTML/JS | Public + hubs | Hub pages | Ops routing related | Mixed | No | `ServiceArea` + page section | P1 |
| FAQ | Homepage FAQ markup | HTML | Public | Chat FAQ intents separate | No | Yes | No | `FaqEntry[]` | P2 |
| Closing CTA | Phone CTA grid / booking CTA | HTML | Public | Footer contact | No | Yes | No | `PageContent.home.closingCta` | P2 |
| SEO title/description | `<title>`, meta description, OG/Twitter | HTML meta | Crawlers | Hubs have own | No | Yes | No | `PageSeo` | P1 |
| Structured data | JSON-LD LocalBusiness near head | JSON in HTML | Crawlers | Partial elsewhere | No | Yes | No | `PageSeo.structuredDataSafe` (constrained) | P2 |
| Client `PRICING` / `LENGTH_PRICING` / `RICH_ZIPS` | `index.html` script | JS | Checkout UI | **Mirrored** in hubs + server | **Yes** | No | Future bookings | Must converge to published catalog | P0 |

---

## SERVICE PAGES

| Page | Path | Content notes | Pricing embedded? | Priority |
|------|------|---------------|-------------------|----------|
| Cars (home) | `index.html` | Primary car packages | Yes (`PRICING.cars`) | P0 |
| Boats | `boats-detailing.html` | Specialty copy, gallery, booking bridge | Often page-local + bridge | P1 |
| RVs | `rv-detailing.html` + `assets/rv-package-tabs.js` | RV ladder / tabs | Yes (docs + scripts history) | P0 |
| Powersports / motorcycles | `powersports-detailing.html` | Specialty | Yes | P1 |
| Fleet | `fleet-services.html` | Commercial | Yes | P1 |
| Multi-vehicle | `multi-vehicle-detailing.html` | Presentation | Bridge | P2 |
| Paint / interior / exterior / maintenance | Mostly package IDs inside car ladder (`maint`, `interior`, `full`, `refresh`, `premium`) — not separate HTML routes | Catalog + homepage | Via `PRICING.cars` | P0 |
| State hubs | `new-jersey-hub.html`, `ny-metro-hub.html`, `connecticut-hub.html`, `pennsylvania-hub.html` | SEO + embedded booking/pricing | **Yes — duplicated PRICING** | P1 |
| County hubs | `bergen-county-hub.html`, `essex-county-hub.html`, `hudson-county-hub.html`, `passaic-county-hub.html` | SEO | Often duplicated PRICING | P1 |
| City pages | `newark-mobile-detailing.html`, `trenton-mobile-detailing.html`, `westchester-mobile-detailing.html`, `template-city.html` | SEO templates | Varies | P2 |
| Generators | `scripts/generate-hub-pages.js`, `inject-service-area-accordions.mjs`, `master-refinement-hubs.js` | Build-time content | Can stamp pricing | P1 |

For each specialty page: hero, features, package ladder copy, gallery, CTA, SEO meta → `PageContent` + media refs. Prices must not be page-owned after cutover.

---

## CATALOG (transactional)

| Item | Location | Format | Consumers | Duplicated? | Affects booking/pricing? | Alters existing booking? | Entity | Priority |
|------|----------|--------|-----------|-------------|--------------------------|--------------------------|--------|----------|
| Packages + base tier prices | `booking-price-catalog.js` `PRICING.*.tiers` | Dollars (number) → converted to cents in calc | submit-booking, payment prep, admin/customer package mutation, AI pricing tests | **Yes** vs `index.html` + hubs | **Yes** | No (ledger/snapshot must freeze) | `Package`, `PackagePrice`, `VehicleClass` | P0 |
| Length pricing | `LENGTH_PRICING` same file + index/hubs | perFt / base+rate | Boats/RVs/fleet quotes | Yes | **Yes** | No if snapshotted | `PackagePrice` (length model) | P0 |
| Package display names | Derived in `package-financial-mutation.js` / HTML package lists | String | Portal + public | Partial | Display + labels on quote items | Snapshot name only | `PackageRevision.name` | P0 |
| Descriptions | `canonical-package-catalog.js` `PACKAGE_DESCRIPTIONS` | String | Customer portal | Specialty page copy differs | Display | No | `PackageRevision.description` | P1 |
| Features included/excluded | Mostly in HTML package cards / specialty pages | HTML lists | Public | High drift | Presentation (unless sold as scope) | No | `PackageFeature` | P1 |
| Vehicle classes / tiers | `PRICING.*.tiers` keys (`small`, `suv2`, …) | Key + label | Booking + portal | Yes | **Yes** | Snapshot `vehicleClassId` | `VehicleClass` | P0 |
| Add-on prices | `PRICING.*.addons` | `{id,price,qty?}` dollars | Booking, portal, payments | Display meta separate | **Yes** | Snapshot add-on prices | `AddOn`, `AddOnPrice` | P0 |
| Add-on names/descriptions | `canonical-addon-catalog.js` | Object map | Portal | Public HTML may differ | Display | Snapshot labels | `AddOnRevision` | P1 |
| Compatibility | Implicit by category membership in `PRICING[cat].addons` | Category lists | Booking validation | — | **Yes** | No | `AddOnCompatibility` | P0 |
| Duration estimates | Not centralized; sparse copy | Text | Marketing | — | Ops-ish | No | `PackageRevision.durationMinutes` (optional) | P3 |
| Active/inactive | Implicit (presence in catalog); `0` prices = unavailable | Number sentinel | Quote logic | — | **Yes** | Deactivate, never delete | `PackageAvailability` / `active` | P0 |
| Featured / display order | Homepage card order; specialty tabs | HTML/JS order | Public | — | Presentation | No | `Package.displayOrder`, `featured` | P1 |
| Service-area availability | `RICH_ZIPS`, service-area accordion, hub routing | Sets + HTML | ZIP gate, hubs | Yes | Ops + presentation | Future bookings | `ServiceArea` + availability | P1 |
| RV type catalog | `netlify/lib/rv-type-catalog.js` | JS | RV booking | — | Pricing path | No | Map into `VehicleClass` metadata | P1 |

**Catalog authority decision (Stage 1):**  
Published Owner Studio catalog release becomes the single authority for prices and package identity. Until `PUBLIC_CONTENT_SOURCE=owner-studio` (future stage), runtime continues to use legacy `booking-price-catalog.js`. Importer maps legacy → draft only.

---

## MEDIA

| Item | Location | Format | Consumers | Booking impact | Entity | Priority |
|------|----------|--------|-----------|----------------|--------|----------|
| Hero / vehicle imagery | `assets/vehicles/**`, specialty assets | WebP/JPG | Public pages, OG | No | `MediaAsset` | P1 |
| Package images | Specialty + homepage | Paths | Public | No | `MediaAsset` + package refs | P2 |
| Galleries | Specialty `specialty-gallery.js`, homepage | Paths + order | Public | No | `Gallery`, `GalleryItem` | P2 |
| Before/after | Recent-work admin/functions (ops) | Blob/DB paths | Marketing/admin | No (ops) | Out of Stage 1 public CMS or Media later | P3 |
| Icons | Inline emoji/icons in pricing tiers (hubs) | Unicode/HTML | Public | No | Prefer media refs later | P3 |
| Logos | `assets/cardetail1-logo.webp` | WebP | Global | No | `MediaAsset` | P1 |
| Social preview | `og:image` → `assets/vehicles/premium/cars-suvs.webp` | URL | SEO | No | `PageSeo.ogImageMediaId` | P1 |
| Alt/captions | HTML `alt` attributes | String | A11y/SEO | No | `MediaAsset.alt`, `caption` | P2 |

---

## SEO AND LOCATION

| Item | Location | Consumers | Booking? | Entity | Priority |
|------|----------|-----------|----------|--------|----------|
| Page title / meta description | Each HTML `<head>` | Crawlers | No | `PageSeo` | P1 |
| Canonical | Mostly absolute `og:url` / page URLs | SEO | No | `PageSeo.canonicalPath` | P2 |
| Headings | `h1` per page | Public | No | `PageContent.heading` | P1 |
| Location descriptions | Hub/city copy | SEO | No | `PageContent` / `ServiceArea.description` | P1 |
| Service-area lists | Footer + `#service-areas` + hubs | Public | Routing-related | `ServiceArea` | P1 |
| Structured data | JSON-LD in `index.html` | SEO | No | Constrained SEO fields | P2 |
| Internal links | Nav/footer/hub grids | Public | No | Navigation/Footer/Page | P1 |
| Sitemap / SEO tests | `tests/seo-sitemap.test.js`, `hub-seo-audit.test.js` | CI | No | Validate published SEO | P2 |

---

## SERVER / ADMIN / TEST CONSUMERS (catalog)

| Consumer | Path | Uses |
|----------|------|------|
| Booking price calc | `booking-price-catalog.js` | Authority today |
| Package mutations | `package-financial-mutation.js` | Prices via catalog |
| Add-on mutations | `addon-financial-mutation.js` | Prices via catalog |
| Customer catalog API serializers | `canonical-*-catalog.js` | Display + cents from catalog |
| Payments / quotes | `payment-service.js`, `canonical-quote.js`, db payment authority | Approved cents from booking ledger/quote |
| Admin ops | `admin-ops.html`, admin package/add-on controls tests | Catalog-backed |
| AI chat pricing | `tests/ai-chat-public-pricing.test.js` | Must stay consistent |
| Checkout parity tests | `tests/checkout-parity.test.js`, `booking-price.test.js` | Detect drift |

---

## DUPLICATION HOTSPOTS (must resolve before cutover)

1. **Dollar prices** in `index.html` `PRICING` vs `netlify/lib/booking-price-catalog.js` vs hub HTML `PRICING` blocks (e.g. some hubs still show car `full: 300/325` while server/index use `285/305/315/325` — **price conflict candidates for importer**).
2. **Package descriptions** in specialty HTML vs `PACKAGE_DESCRIPTIONS`.
3. **Footer** partial vs inlined copies if sync script not run.
4. **RICH_ZIPS** client vs server sets.
5. **Add-on labels** public HTML vs `ADDON_DISPLAY`.

---

## MIGRATION PRIORITY LEGEND

- **P0** — Required for catalog authority / money safety  
- **P1** — Required for Owner Studio MVP content editing  
- **P2** — Important presentation polish  
- **P3** — Deferred  

## Stage 1 non-goals

- No public site wired to Owner Studio reads (`PUBLIC_CONTENT_SOURCE=legacy`).  
- No production DB migration apply.  
- No free-form HTML/CSS/JS page builder fields.
