# Production-safe reorganization & optimization pass

**Verdict: READY FOR INDEPENDENT RE-AUDIT** — not merged, not deployed.

> **Correction round.** An independent audit returned NEEDS CORRECTION on candidate
> `7215e25`. This revision corrects the drift-test architecture, completes the manifest,
> hardens surface discovery, fixes factual inaccuracies, and cleans the worktree. Every
> corrected figure below was re-measured against the git blobs at `bb4cbfd` rather than the
> post-edit working tree, which is what produced the original errors. Corrections are marked
> **[C]**.

---

## A. Baseline

| | |
|---|---|
| Production / `master` SHA | `bb4cbfd` |
| Previous candidate | `7215e25` |
| Branch | `refactor/production-safe-normalization` |
| Worktree | `C:\Projects\Cardetail1\worktrees\normalization` |
| Baseline suite | **2633 total · 2523 pass · 29 fail · 75 cancelled · 6 skipped** |

### Pre-existing failure identities (21 top-level suites, unchanged throughout)

Stage 1 addon financial mutations · Stage 3 Admin add-on controls · vehicle_remove approval
path (server) · Admin package controls — Postgres-authoritative routing · full-balance cash
settlement · PR4 customer/Admin optimistic concurrency · PR4 vehicle and package/add-on
rules · vehicle_remove_request policy + commands · receipt authorization (real middleware,
two customers) · vehicle_add_request then customer projection · Package Stage 1 financial
mutations · portal auto-apply + vehicle coerce · portal change request stability · Release A
— decide applies canonical quote · Release A — cross-store index failure recovery · PR5
fail-closed runtime policy · PR5 templates and consent · PR5 post-commit outbox · PR5 signed
webhooks and STOP/HELP · PR5 source containment · `tests/twilio-readiness-pr5.test.js`

All require PostgreSQL 16, Netlify Blobs or a Twilio fixture. **75 cancellations** are
subtests of those suites. **6 skips** are explicit `DATABASE_URL not configured` /
`CUSTOMER_IDENTITY_TEST_DATABASE_URL not set` guards.

## B. Architecture findings

### B1. Surfaces **[C]**

Classification is **structural**: a file owning `#bk-ov` is a booking surface; if it also
loads `assets/hub-booking-bridge.js` it is fallback, otherwise authoritative.

| Class | Count | Note |
|---|---|---|
| Authoritative customer-visible booking UI | **1** | `index.html` |
| Public fallback surfaces | **11** | hidden at runtime by the bridge |
| Template (not a runtime surface by role) | **1** | `template-city.html` |

**12 runtime/public HTML surfaces + 1 template.** The previous revision said "13 booking
pages" and "12 hub/city pages", conflating the template with a live surface.

| Metric | Value |
|---|---|
| Public HTML on disk | 6,438 KB / 30 files |
| The 13 booking-root files | 5,875 KB |
| Inline JS per file | 227–261 KB |
| Inline CSS per file | 93–174 KB |

### B2. Modal divergence is genuine **[C]**

The modal block hashes to **4 variants**. Re-measured against git blobs with punctuation
(`—`/`–`/`-`, `·`/`•`) and whitespace normalised: **all 4 survive normalisation**, so the
divergence is substantive. Corroborated independently — `bkContinueFromContact()`,
`bkResolveOperationalSlot()` and `renderStep5Summary()` exist on `index.html` only.

### B3. Dead CSS — corrected measurements **[C]**

| | Previous (wrong) | Corrected |
|---|---|---|
| Bytes per file | 1,852 uniform | **1,805 on 8 files · 1,815 on 5 files** |
| Aggregate | 24,076 | **23,515 bytes** |
| Distinct block hashes | "byte-identical" | **2** |

The two hashes differ **only in comment punctuation** — ASCII hyphen vs em-dash in five
comment lines, 10 bytes. Normalising punctuation collapses them to one. The original figure
counted JS string characters after consuming trailing CRLF and reported them as bytes.

`PROVEN DEAD` evidence (unchanged, all re-confirmed):

| Check | Result |
|---|---|
| Static markup `class="…trust-ico--*"` across 30 HTML | 0 |
| Runtime JS injecting these classes | 0 |
| Generator/template scripts emitting them | 0 |
| Keyframe `animation:` usages outside the block | 0 |
| `prefers-reduced-motion` group | all 4 selectors from the dead set |
| Elements matching removed selectors at runtime | 0 on both an authoritative and a fallback surface |

### B4. Performance

`revenue-event` returns 429 on every request. **Root cause corrected** — see
`REVENUE_EVENT_RATE_LIMIT.md`. No duplicate network calls on a clean load.

## C. Changes made

| File | Change | Risk |
|---|---|---|
| `index.html` + 12 others (13 files) | −55 lines each: dead trust-stats CSS | LOW |
| `assets/hub-booking-bridge.js` | Header: corrected step count; documents both bridge failure modes **[C]** | NONE — comment only |
| `tests/fixtures/booking-copy.canonical.json` | Rewritten: authoritative/fallback split, 6 step labels + order, entry CTA, card/`$0`/saved-vs-charged/request-vs-confirmed/water-power/availability/success-state semantics **[C]** | NONE — not runtime |
| `tests/booking-copy-drift.test.js` | Rewritten on jsdom **[C]** | NONE — test only |

### C1. Drift test architecture **[C]**

The previous raw-source `.includes()` model could be satisfied by a comment, a script
template or hidden legacy DOM. Corrected:

* **Authoritative** assertions parse `index.html` with jsdom, take `#bk-ov`, remove
  `<script>`, `<style>`, `<template>`, `<noscript>` **and comment nodes**, and assert against
  the resulting DOM and text. Extraction narrows 480,320 raw chars to **8,170 customer-visible
  chars**.
* **Fallback** assertions are explicitly compatibility-only and can never satisfy an
  authoritative assertion.
* **Discovery** is structural (`#bk-ov` + bridge presence), not the literal `card-gate-title`.

Negative control — identifiers present in raw source, absent from customer-visible text:

| Probe | In raw source | Customer-visible |
|---|---|---|
| `bkEarliestBookable`, `confirmSetupIntent`, `BK_VISIBLE_STEPS`, `draftSaveToken` | yes | **no** |
| `STEP 6: CONFIRM`, `BK_DETAILS_FORM_START` (comment-only) | yes | **no** |
| `A card on file is still required to submit the booking request.` | yes | **yes** (positive control) |

### C2. Canonical source (S3 condition) — unchanged conclusion

`apply-state-hub-theme.mjs` slices `index.html` 1293–1443; the block is at 481–535, outside
every slice. `generate-hub-pages.js` on an unmodified tree produces +2,487 / −4,637 lines and
wipes the state-hub theme from two files. No usable canonical generator; the files own the
CSS. `template-city.html` was cleaned too.

### C3. S4 — not modified, as instructed

`initTrustSeasonIcon()` is a permanent no-op but is the positional marker
`apply-state-hub-theme.mjs` slices on. Untouched.

## D. Explicitly untouched

Stripe authority · Payment Element · `create-setup-intent` · `stripe-webhook` · payment
ledger · settlement · reconciliation · idempotency · receipts · booking ownership ·
`bookingVersion` / `quoteVersion` · booking persistence · customer identity and isolation ·
Prisma schema and migrations · all pricing · ZIP/service-area · scheduling engine and
`MIN_ADVANCE_DAYS` · Customer Portal · Admin · Owner Studio · `netlify.toml` · environment
variables · **`revenue-event`, `revenue-resume-link`, `public-rate-limit`** · **the legacy
inline modal and bridge runtime behaviour** · `generate-hub-pages.js`.

Files changed under `netlify/`: **0**. `prisma/`: **0**. `package.json`: **0**.

## E. Before vs after

Structurally the site is unchanged; what changed is what guards it. Before, 13 independent
copies with nothing comparing them. After, one manifest defines the authoritative
customer-visible contract, validated against parsed DOM, with the fallback held to a
separate compatibility contract — and a new booking surface cannot be added without being
classified.

## F. Test evidence

| | Total | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|---|
| Baseline `bb4cbfd` | 2633 | 2523 | 29 | 75 | 6 |
| Previous candidate `7215e25` | 2638 | 2528 | 29 | 75 | 6 |
| **Corrected candidate** | **2643** | **2533** | **29** | **75** | **6** |

Failure sets compared line by line: **124 failure lines in baseline, 124 in candidate, zero
new**. Failure identities are listed in §A and are identical.

* Focused drift suite: **10 / 10 pass**.
* Focused related suites (drift · conversion copy · hub public surface · index public
  surface · hub booking conversion · booking flow · PR-65 regression · booking conversion
  readiness): **206 / 206 pass**.
* `npm run audit:pre-deploy`: **exit 0**.

### Build **[C]**

**There is no `build` script in `package.json`.** Its scripts are: `test`,
`test:owner-studio`, `test:owner-studio-staging-guard`, `test:owner-studio-catalog`,
`test:owner-studio-catalog-e2e`, `owner-studio:import`, `owner-studio:staging:*`,
`audit:pre-deploy`, `financial:preflight`, `postinstall`, `prisma:*`.

`netlify.toml` sets `command = "node scripts/generate-deploy-runtime-env.js"`, which bakes
deploy identity into a generated file. It is **not a compile/bundle step**. The previous
revision called running it "build result: exit 0" — that was a surrogate and is withdrawn.
No formal build exists to report.

## G. Production / preview comparison

`bb4cbfd` is this branch's base, so `git show bb4cbfd:<file>` **is** the deployed content.
The complete delta is the 55-line CSS block × 13, the bridge header, and two test files.

Runtime verification against a local serve:

| Surface | Result |
|---|---|
| `index.html` (authoritative) | 0 elements match any removed selector · live `.trust-row` intact (flex, 16px radius, 5 items, padding preserved) · `BK_VISIBLE_STEPS = 6` |
| `bergen-county-hub.html` (fallback) | 0 orphaned selectors · bridge delegation active · inline modal present and `display:none` · card gate reads "Save Your Card" |
| Brace balance, all 13 files | identical before and after |

Screenshot capture was unavailable (browser pane not compositing); DOM and computed-style
assertions were used. **A Netlify branch preview is still required** — no Netlify CLI is
installed, so the URL must come from the owner.

## H. Adversarial re-review of the corrected implementation **[C]**

Mutation tests against the corrected guard, each reverted immediately:

| Mutation | Expected | Result |
|---|---|---|
| `Save Your Card` → `Add Your Card` in the card gate | fail, naming the element | **FAILED correctly** — reported expected/actual/why |
| `Card on File Required` moved into an HTML comment | fail — a comment must not satisfy a visible assertion | **FAILED correctly** — `[card-mandatory]` |
| New page with `#bk-ov` and no bridge | fail — unclassified customer-visible surface | **FAILED correctly** — named `rogue-booking.html` |

Also checked: no runtime file imports the manifest; no circular dependency; the test resolves
paths via `path.resolve(__dirname, '..')` consistent with existing suites; fallback parity
cannot substitute for authoritative assertions (separate code paths, separate data).

## I. Remaining risks

| Risk | Level |
|---|---|
| The manifest goes stale — a legitimate copy change is "fixed" by editing the manifest without thought | MEDIUM — process risk; every entry carries a `why` |
| `generate-hub-pages.js` run by someone unaware | **HIGH** **[C]** — was understated as MEDIUM |
| jsdom parse cost on a 480 KB page | LOW — drift suite runs in ~5 s |
| No Netlify preview yet | — required before merge |

## J. Out-of-scope findings

| id | Severity | Location | Action |
|---|---|---|---|
| **OOS-1** | **HIGH** | `scripts/generate-hub-pages.js` | Stale generator; +2,487/−4,637 on an unmodified tree. Delete or hard-guard |
| **OOS-2** | **P1** | `revenue-event.js`, `revenue-resume-link.js` | Obsolete positional caller + `!rate.ok` on a helper returning `allowed/blocked` → unconditional 429. **Both** affected. Not fixed here |
| **OOS-3** | MEDIUM | 12 fallback files | ~5.9 MB divergent duplication; fallback covers script-delivery failure only |
| **OOS-4** | LOW | hub/city files | Mojibake in the sticky call button |
| **OOS-5** | LOW | `scripts/` | ~33 one-shot historical patch scripts with no applied-state manifest |

## K. Verdict

### READY FOR INDEPENDENT RE-AUDIT

Not merged. Not deployed. Production database, live Stripe configuration and Netlify
production settings untouched.
