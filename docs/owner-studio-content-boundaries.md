# Owner Studio — Content Boundaries (Stage 1)

Every editable value maps to **exactly one** category. Owner Studio Stage 1 only exposes categories A and B (plus read-only visibility of C where needed for publish validation). Category D is never editable through Owner Studio.

## A. PRESENTATION CONTENT

Owner-editable marketing and UX copy/media that does **not** change quote math.

Examples in scope:

- Headings, descriptions, trust statements, FAQ entries  
- CTA labels (not payment rules)  
- Navigation and footer link labels/hrefs (public paths only)  
- Gallery order, alt text, captions  
- Basic SEO title/description/OG image references  
- Package/add-on **display** descriptions and feature bullets (non-priced)  
- Logo and brand display strings  

Storage: structured `PageContent`, `Navigation`, `Footer`, `Gallery`, `FaqEntry`, `MediaAsset`, and revision fields on catalog display metadata.

**Must not** share a generic key-value bag with transactional prices.

## B. TRANSACTIONAL CATALOG

Authoritative commercial definitions that drive booking price calculation, admin review, appointment display, payment preparation, and future Book Again.

Examples:

- Stable `packageId` / `addOnId` / `vehicleClassId`  
- Package and add-on prices (integer cents + currency)  
- Vehicle-class price rows and length-based price models  
- Compatibility and availability  
- Active/inactive, featured, display order when it affects selectable catalog  
- Duration estimates used in scheduling promises (when enforced)  
- Taxable / payment-relevant flags  

Storage: `Package`, `PackageRevision`, `PackagePrice`, `AddOn*`, `VehicleClass`, `PackageAvailability`, published via `PublishedCatalogRelease`.

Changing B **must** create a new revision/release and **must not** mutate historical booking snapshots.

## C. OPERATIONAL CONFIGURATION

Business rules that are not free marketing copy and not pure catalog SKUs.

Examples:

- Service-area routing rules and ZIP gates (`RICH_ZIPS`, hub routing)  
- Lead-time / scheduling constraints  
- Deposit policy, cancellation policy, payment requirements  
- Ops settings currently in `ops-settings` / blobs  

Stage 1: document and validate references; do **not** build a full ops editor. Some service-area **lists** for marketing may live in A while enforcement rules remain C until a later stage with explicit dual modeling.

## D. SECRETS / INFRASTRUCTURE

Never Owner Studio editable. Never in published snapshots.

Examples:

- Stripe / Resend / Twilio keys  
- `DATABASE_URL`, `DIRECT_URL`, session secrets  
- Netlify tokens, QA smoke secrets  
- Admin passwords / session signing secrets  

Configuration remains environment / Netlify / vault only.

## Boundary rules

1. **No mixed KV table** for A+B.  
2. **Presentation cannot override price authority.**  
3. **Ops policy text in A does not change enforcement in C** unless an explicit dual-write contract exists (out of Stage 1).  
4. **Unknown fields rejected** by server schemas.  
5. **No raw HTML/JS/CSS** in A or B content fields.  
6. **Category D access attempts** → hard deny + audit.

## Classification quick reference

| Value | Category |
|-------|----------|
| Hero title | A |
| Package card blurb | A |
| Package price cents | B |
| Add-on compatibility | B |
| FAQ answer | A |
| Deposit percent enforced at checkout | C |
| Stripe secret key | D |
| Footer Instagram URL | A |
| `RICH_ZIPS` fee logic | C |
| Service-area marketing list | A (list) / C (enforcement) |
| Session secret | D |
