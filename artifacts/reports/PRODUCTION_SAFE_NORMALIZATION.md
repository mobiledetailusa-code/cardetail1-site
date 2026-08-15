# Production-safe reorganization & optimization pass

**Verdict: READY FOR FINAL PRE-MERGE REVIEW** — not merged, not deployed. **[C2]**

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
| `tests/fixtures/booking-copy.canonical.json` | Rewritten: authoritative/fallback split, 6 step labels + order, entry CTA, card/saved-vs-charged/request-vs-confirmed/water-power/availability/success-state semantics **[C2]** | NONE — not runtime |
| `tests/booking-copy-drift.test.js` | Rewritten on jsdom; anchored copy assertions; recursive publish-root discovery **[C2]** | NONE — test only |

> **[C2] Second correction round.** A second independent audit of `d67003b` returned
> APPROVE FOR PREVIEW with three bounded follow-ups (B-1 nested surface discovery, B-2
> `audit:pre-deploy` reporting, B-3 hidden-decoy masking and the `$0 today` claim). This
> revision closes all three. Statements corrected in that round are marked **[C2]**.

### C1. Drift test architecture **[C]** **[C2]**

The previous raw-source `.includes()` model could be satisfied by a comment, a script
template or hidden legacy DOM. Corrected:

* **Authoritative** assertions parse `index.html` with jsdom, take `#bk-ov`, remove
  `<script>`, `<style>`, `<template>`, `<noscript>` **and comment nodes**, and assert against
  the resulting DOM and text. Extraction narrows 480,320 raw chars to **8,170 customer-visible
  chars**.
* **Fallback** assertions are explicitly compatibility-only and can never satisfy an
  authoritative assertion.
* **Discovery** is structural (`#bk-ov` + bridge presence), not the literal `card-gate-title`.

#### C1a. Anchored copy assertions **[C2]**

The first correction round still compared 17 of 19 authoritative sentences against the
*aggregate* text of `#bk-ov`. The re-audit demonstrated that this could be defeated: drift
the real element and plant the original wording in a `display:none` decoy elsewhere in the
modal, and the suite stayed green.

Every copy entry is now **anchored**. `anchor` is a CSS selector resolved inside the parsed
`#bk-ov`; the element count must equal the expected text count, compared in document order.
Both decoy directions now fail:

| Attack | Result |
|---|---|
| Decoy does not match the anchor | ignored — the drifted real element fails the text comparison |
| Decoy *does* match the anchor | element count changes → `expected 1 element(s), found 2` |

**Computed CSS visibility is deliberately not used as the filter.** The modal is a wizard:
inactive steps and the three `.pay-choice-desc` panels are `display:none` until the customer
reaches them, so they are real customer-visible copy. A visibility filter would delete that
coverage. Anchoring closes the hole without that cost.

Where no stable class existed, the anchor is derived from a control the runtime already
depends on — `.fg:has(> #f-water) > .fl`, `.fg:has(> #f-electric) > .fl`,
`label.terms-check:has(#terms-ok) > span`, `#bs6 .oc:has(#c-pay-method) > .or:nth-of-type(2) > span`.
**No runtime HTML was modified to make anchoring possible; no identifier was added.**

#### C1b. Recursive publish-root discovery **[C2]**

`netlify.toml` sets `publish = "."`, so a page at *any* depth is served. Discovery used a
root-level `readdirSync`, and the re-audit proved a nested page (`cities/boston-hub.html`)
carrying `#bk-ov` passed every test. The walk is now recursive over the publish root.

Exclusions are structural and role-based, matched against the path **relative to the publish
root** so only the top-level directory of that role is skipped: `node_modules`, `netlify`
(the declared functions root), `prisma`, `scripts`, `shared`, `tests`, `docs`, `artifacts`,
`reports`, `archive`, plus every dot-directory. `assets/` is deliberately **not** excluded —
it is served, so a booking page placed there must still be classified. They are not a list of
known page names.

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
separate compatibility contract — and a new booking surface cannot be added anywhere under
the publish root, at any depth, without being classified. **[C2]**

## F. Test evidence

| | Total | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|---|
| Baseline `bb4cbfd` | 2633 | 2523 | 29 | 75 | 6 |
| Previous candidate `7215e25` | 2638 | 2528 | 29 | 75 | 6 |
| Candidate `d67003b` | 2643 | 2533 | 29 | 75 | 6 |
| **B-1/B-2/B-3 corrections** **[C2]** | **2646** | **2536** | **29** | **75** | **6** |

Failure identities were set-differenced between `d67003b` and this revision: **zero added,
zero removed**. Skip identities are byte-identical. The +3 are the three new guard tests
(nested discovery, hidden-decoy detection, hero zero-charge promise). Failure identities are
listed in §A and are unchanged throughout.

* Focused drift suite: **13 / 13 pass** **[C2]** (was 10).
* Focused related suites (drift · conversion copy · hub public surface · index public
  surface · hub booking conversion · booking flow · PR-65 regression · booking conversion
  readiness): **206 / 206 pass**.

### `audit:pre-deploy` — corrected **[C2]**

The previous revision reported **exit 0**. That is **not reproducible on a clean tree** and
the claim is withdrawn.

| Tree | Exit |
|---|---|
| `bb4cbfd` (baseline), pristine export | **2** |
| `d67003b` (candidate), pristine export | **2** |
| This revision, pristine export | **2** |

Identical cause at all three:

```
[FAIL] strategy sync check:
[sync] STALE: assets/universal-customer-strategy.generated.js does not match shared config.
[sync] STALE: netlify/lib/universal-customer-strategy-config.json does not match shared config.
```

**This is a pre-existing condition, not a regression from this branch** — the baseline fails
identically. The two committed generated files are stale relative to their shared config.
The check only passes after something regenerates them, which a full `npm test` run does as a
side effect; that is why the earlier run observed exit 0, and it leaves those two files
showing as modified afterwards.

Not repaired here: regenerating those files, or changing the sync/generation behaviour, is
outside B-1/B-2/B-3 scope and touches `netlify/lib/`. Recorded as **OOS-6**.

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

### H1. Second adversarial round — B-1/B-3 **[C2]**

Fourteen mutations, run against a disposable export, tree restored after each. **All 14 were
caught, each by the assertion that should own it.** The two marked ✱ are the gaps the
re-audit found; both were green before this revision.

| # | Mutation | Caught by |
|---|---|---|
| M1 | `Save Your Card` → `Add Your Card` | canonical elements |
| M2 | `Card on File Required` → HTML comment | anchored copy `[card-mandatory]` |
| M3 | new root page with `#bk-ov`, no bridge | discovery — `rogue-booking.html` |
| M4 | swap steps 3 / 4 | six-steps-in-order |
| M5 | `Under Review` → `Confirmed` | anchored copy `[success-status-under-review]` |
| M6 | `PCI-secure` sentence into `<script>` | anchored copy `[pci-note]` |
| M8 | `3 days out` → `9 days out` | anchored copy `[availability-notice]` |
| **M7b ✱** | drift real element **+** `display:none` decoy with old wording | anchored copy `[card-mandatory]` |
| **M9 ✱** | nested booking page `assets/landing/boston-hub.html` | discovery — named the nested path |
| M10 | decoy that *matches the anchor* (extra `#cof-wrap > div.fl`) | anchored copy — `expected 1 element(s), found 2` |
| M11 | sentence dropped from **one** of three `.pay-choice-desc` panels | anchored copy `[card-enables-request]` element 2 of 3 |
| M12 | arrival label drifted in the alternate-date block only | anchored copy `[arrival-window]` |
| M13 | `Card saved, not charged` → `Card charged today` | hero zero-charge promise |
| M14 | confirm row `Charged today` → `Paid today` | anchored copy `[request-only-row]` |

M10, M11 and M12 exist because anchoring introduces its own failure mode: an anchor that is
too loose would let a decoy in through the front door, and a multi-occurrence anchor could
hide a partial drift. Both are closed by comparing the ordered element list, not a set.

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
| **OOS-6** **[C2]** | MEDIUM | `assets/universal-customer-strategy.generated.js`, `netlify/lib/universal-customer-strategy-config.json` | Committed generated files are stale against their shared config, so `audit:pre-deploy` exits 2 on any clean checkout — at baseline too. Running the suite silently regenerates them, which is why the tree then shows two modified files. Pre-existing; not fixed here (touches `netlify/lib/`) |

## K. What `$0 today` is and is not guarded by **[C2]**

The first correction round claimed the manifest covered "`$0`" semantics. That was
overstated and is withdrawn.

* The literal string `$0 today` lives at `index.html:1525`, in the hero proof bar — **outside
  `#bk-ov`**, so it was never inside the authoritative booking contract.
* It is **not** pinned by the manifest and deliberately never will be. `the manifest stays
  presentation-only` rejects any canonical string matching `/\$\d/`, and that guard is
  correct: a commercial amount is the catalog's and the server's authority. Pinning it in a
  copy fixture would move pricing authority into a test file.
* **If the amount ever changes, this suite will not catch it.** That is intentional. Stated
  plainly so no one reads the drift guard as a pricing guard.

What *is* guarded is the promise attached to the amount, which carries no digits:

| Assertion | Anchor | Pins |
|---|---|---|
| `hero-zero-charge-promise` **[C2]** | `.hpb-item--accent .hpb-lbl` | `Card saved, not charged` — the hero saved-vs-charged claim, beside the amount |
| `nothing-collected-today` | `p.bk-charged-copy` | `No payment is collected today.` |
| `card-saved-not-charged` | `#cof-wrap > div:nth-child(2)` | the full no-charge-today / saved-by-Stripe sentence |
| `request-only-row` | `#bs6 .oc:has(#c-pay-method) > .or:nth-of-type(2) > span` | `Charged today` → `booking request only`, as an ordered pair, amount excluded |

Mutation M13 confirms the hero assertion fires: `Card saved, not charged` →
`Card charged today` fails.

## L. Verdict

### READY FOR FINAL PRE-MERGE REVIEW **[C2]**

Not merged. Not deployed. Production database, live Stripe configuration and Netlify
production settings untouched. A Netlify branch preview and customer-visible smoke
validation are still required before merge.
