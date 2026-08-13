# Owner Studio — Public Content Parity / Adapter Bridge Review

## 1. VERDICT

**`PUBLIC_CONTENT_CUTOVER_BLOCKED`**

Presentation parity is now implemented and tested. The cutover remains blocked by a
**separate, functional** defect found during verification: the Owner Studio draft
carries **no package features** (`feats = []` for every package), which disables the
client-side guard that stops an add-on already included in a package being offered
again as a paid extra. See §16.

## 2. BASE SHA

`f3d1a743070362b62f91120c82e9104019817208`

## 3. BRANCH / PR

Branch `feat/owner-studio-catalog-parity` — the branch behind **PR #191**.

No new PR: this work is the presentation half of the same parity contract PR #191
opened for money, and belongs in the same review.

**Hygiene defect found in my own earlier work — see §13.** PR #191's branch was cut
from the PR #190 branch rather than from `master`, so #191 already contains #190's
media changes.

## 4. ACTIVE RENDERERS INSPECTED

Only **`index.html`** loads `storefront-preview-adapter.js`. It is the sole consumer
of the adapted DTO. Verified by repository-wide search excluding `node_modules` and
`tests/`.

The hub and city pages (`*-hub.html`, `template-city.html`, `newark-mobile-detailing.html`, …)
carry their **own hardcoded `PRICING` literals** and never load the adapter. They are
therefore unaffected by a cutover of this adapter, and are a separate parity surface
that this work does not address.

Consumers inside `index.html`:

| Consumer | Line | Reads |
|---|---|---|
| Package card grid | `grid.innerHTML=d.packages.map(...)` ~4159 | `id`, `name`, `note`, `popular`, `tag`, `dur` |
| Package detail panel | `renderPkgDetailPanel` ~3210 | `note` (`intro`), `tag` (`bestFor`) |
| Booking summary / icon | ~5488 | `icon` |
| Add-on grid + dedup | ~4561–4576 | `scope`, `feats`, `ext`, `int` |

## 5. FIELD CONSUMPTION MATRIX

| Field | Legacy has | Owner Studio has | Active renderer uses | Resolution |
|---|---|---|---|---|
| `note` | Yes — **2 of 24** packages (`refresh`, `premium`) | No | **Yes** — card subtitle, detail `intro` | Bridged from legacy by stable id |
| `tag` | Yes — all packages | No (`shortDescription` is a different field with different content) | **Yes** — `<div class="pkg-tag">` and detail `bestFor` | Bridged from legacy by stable id |
| `icon` | Yes | No | **Yes** — `ST.pkg.icon \|\| '🚗'` | Bridged from legacy by stable id |
| `dur` | Yes | Partially (`durationMinutes`, different unit and semantics) | **Yes** — `<div class="pkg-time">⏱ ${p.dur}</div>` | Bridged from legacy by stable id (no unit-guessing) |
| `scope` | Yes — `int` / `ext` / `both` | No (`compatibleAddOnIds` exists but is consumed by nothing) | **Yes — FUNCTIONAL** — filters which add-ons a package offers | Bridged from legacy by stable id. **Not decorative** |
| `ext` / `int` | Yes — 5 packages | No | **Yes — FUNCTIONAL** — feed the included-features text behind the double-charge guard | Bridged from legacy by stable id |
| `feats` | Yes | Yes, but **empty in the current draft** | **Yes** — same double-charge guard | **NOT RESOLVED — see §16** |

`icon`, `dur` and `scope` were each verified against active code before any decision,
per the instruction not to assume a legacy field must exist in Owner Studio.
`scope` in particular is **not** `NOT_CURRENT_CUTOVER_BLOCKER`: it is read at
`index.html` ~4567 and drives add-on filtering.

## 6. ROOT CAUSE

`index.html` already contained a normalisation shim, `osApplyPreviewShell`, documented
as *"Homepage decorative shell defaults — kept OUT of the pure adapter … neutral
placeholders so renderers never read undefined fields."* It set:

```js
if(p.icon==null)p.icon='';
if(p.tag==null)p.tag=p.shortDescription||'';
if(p.dur==null)p.dur='';
if(p.scope==null)p.scope='both';
if(!Array.isArray(p.ext))p.ext=[];
if(!Array.isArray(p.int))p.int=[];
if(p.note==null)p.note='';
```

Three separate defects:

1. **`note=''` is falsy**, so `(p.note || 'price set by vehicle size/type')` always took
   the fallback — the reported symptom. Note that this affects only the 2 packages the
   legacy catalog actually notes; the other 22 show that placeholder in production too.
2. **`tag = shortDescription`** is precisely the fake-parity mapping this task forbids.
   The field was non-null and wrong.
3. **`scope='both'` opened every add-on to every package**, and empty `ext`/`int`
   disabled the double-charge guard. These are behavioural, not decorative, and were
   being silently defaulted.

## 7. IMPLEMENTATION

`netlify/lib/owner-studio/legacy-presentation-bridge.js` — a pure, UMD module used by
both Node tests and `index.html`.

**Authority boundary.** Owner Studio remains authoritative for everything it models:
package identity, name, description, prices, the tier matrix, add-on prices,
availability, ordering and `popular`. The bridge writes **only** `note`, `tag`, `icon`,
`dur`, `scope`, `ext`, `int`, and only onto packages Owner Studio already emitted. It
never supplies a price, a total, a discount, or any Stripe amount — a test asserts no
bridged package carries a money-shaped key.

**Matching** is by the stable legacy package `id` only. Never position, display order,
name or price. An id with no match keeps the fields absent so the renderer's own
fallback runs and the gap is visible; a duplicate id is dropped from the match table
entirely rather than resolved arbitrarily. Both are reported.

**Ordering.** The bridge runs *before* `osApplyPreviewShell`, so a default can only ever
fill a gap the legacy catalog also has. The legacy metadata is snapshotted from
`PRICING` while it still holds the shipped catalog, before the adapter's output replaces it.

## 8. FILES CHANGED

| File | Change |
|---|---|
| `netlify/lib/owner-studio/legacy-presentation-bridge.js` | New — the bridge |
| `index.html` | Load the bridge; apply it before the shell defaults; snapshot legacy metadata; remove the fake `tag` mapping and the blanket `scope='both'` |
| `tests/owner-studio-public-presentation-parity.test.js` | New — 16 tests |
| `tests/pre-commit-stabilization.test.js` | Allowlist the new module in the backend-diff guard |

## 9. PRESENTATION PARITY

For every package in every homepage category, each of `note`, `tag`, `icon`, `dur`,
`scope`, `ext`, `int` present in the legacy object survives the bridge with a deep-equal
value. Verified per category (cars, boats, rvs, powersports) against `index.html`'s own
`PRICING` literal, evaluated directly rather than transcribed.

## 10. FINANCIAL PARITY

Unchanged. PR #191's price gate still passes: the import → adapt round trip reproduces
all **90** legacy prices. The bridge cannot affect it — it writes no money-shaped field,
and a test enforces that.

## 11. IDENTITY / MAPPING SAFETY

Three tests: an unmatched id inherits nothing and is reported; a duplicate legacy id is
refused rather than picked; and a package that shares another's position, name and
display order still does not match. Failure is reported through `report.ok === false`,
not swallowed.

## 12. TEST RESULTS

Full deterministic suite, `npm test`:

```
tests 2658
pass  2548
fail  29
skipped 6
todo  0
```

The 29 failures are the PostgreSQL-16-gated integration tests, identical to the
clean-`master` baseline — compared by **test name**, not by file. New failures: **none**.

Focused: presentation parity 16/16; catalog parity, storefront adapter, homepage
preview bootstrap, preview transaction guard and package price parity 52/52.

## 13. REGRESSION DIFFERENTIAL

No test was weakened. No behaviour outside the preview path changed: the bridge only
runs inside `osBootstrapPreview`, which is gated on `?os_preview=1`. Legacy rendering
without that flag is untouched.

**Hygiene defect in my own earlier work.** PR #191's branch was created from PR #190's
branch instead of `master`, so #191 contains #190's media files
(`media/media-references.js`, `schemas.js`, `owner-studio-media-library.test.js`).
Not rewritten here, because #191 may already be under review. **Merging #190 first
makes #191's diff resolve to only its own work.**

## 14. SCHEMA / MIGRATION STATUS

**NO SCHEMA CHANGE**
**NO MIGRATION**

No Prisma model was touched and no migration was created. No column was added for
`note`, `tag`, `icon`, `dur` or `scope`. Production's database remains two Owner Studio
migrations behind `master` — unchanged by this work, and unrelated to it.

## 15. REMAINING TECHNICAL DEBT

`legacy-presentation-bridge.js` is marked in-file as a temporary compatibility layer.

**Removal condition:** delete it once Owner Studio is authoritative for merchandising
metadata (Stage 5 content editing, or explicit catalog fields) *and* for package↔add-on
eligibility. `compatibleAddOnIds` already exists on the Owner Studio package and is
consumed by nothing — wiring it is the real replacement for `scope`.

Until then the legacy object remains authoritative for those seven fields **and for
nothing else**. It is never a source of price.

## 16. CUTOVER STATUS

`PUBLIC_CONTENT_SOURCE=owner-studio` is **NOT** yet eligible, and was not enabled.

The remaining blocker is functional, not cosmetic:

> Every package in the current Owner Studio draft has **`feats = []`**. The add-on grid
> builds `_pkgInclTxt` from `feats + ext + int` and suppresses Rain-X and clay bar when
> the selected package already includes them — the guard the code comment calls
> *"prevents double-charge / confusion"*. The bridge restores `ext`/`int` for the 5
> legacy packages that have them, but the importer never populated `feats`, so packages
> relying on `feats` alone still lose the guard.

`booking-price-catalog.js` already holds the server-side truth
(`PACKAGE_INCLUDED_ADDONS`: cars `full` → claybar; `refresh`/`premium` → claybar, rainx),
so the fix is available without new schema.

## 17. EXACT NEXT ACTION

Populate package features on import, or drive the client dedup from
`PACKAGE_INCLUDED_ADDONS` instead of free-text matching, then re-run the presentation
parity contract with a `feats`-carrying draft and re-classify.
