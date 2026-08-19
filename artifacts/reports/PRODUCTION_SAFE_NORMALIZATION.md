# Production-safe reorganization & optimization pass

**Verdict: READY FOR FINAL INDEPENDENT DELTA AUDIT** — not merged, not deployed. **[C4]**

> The last SHA to carry an *independent* verdict is `d67003b`. Everything after it —
> `9dee289`, `9c6501b` and this revision — was written and verified by the same agent. That
> is implementer self-verification, not an audit, and this report does not claim otherwise.
> Each subsequent round was driven by an independent review of the preceding delta, and each
> found real defects that the previous round's green suite had not: a test mutating the
> checkout, a byte prefilter with false negatives, basename-only bridge matching, role
> membership that was never actually proved, and a step-order assertion incapable of failing.

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

Classification is **DOM-structural** **[C3]**: a page that renders an *element* with id
`bk-ov` is a booking surface; it is fallback when one of its real `<script src>` elements
**resolves** to `assets/hub-booking-bridge.js`, otherwise authoritative **[C4]**. Neither
half is decided on raw bytes, and no page is classified by a script's basename — see §C1c.
Which role a fallback page holds (public vs template) is proved against `sitemap.xml` and
the generator's template input, not merely declared — see §C1c-3.

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

At audit time, `revenue-event` returned 429 on every request. **The root-cause record was
corrected** — see `REVENUE_EVENT_RATE_LIMIT.md`. No duplicate network calls occurred on a
clean load. Separate PR #197 later repaired the obsolete caller contract; the historical
observation is retained here rather than rewritten as though it never occurred.

## C. Changes made

| File | Change | Risk |
|---|---|---|
| `index.html` + 12 others (13 files) | −55 lines each: dead trust-stats CSS | LOW |
| `assets/hub-booking-bridge.js` | Header: corrected step count; documents both bridge failure modes **[C]** | NONE — comment only |
| `tests/fixtures/booking-copy.canonical.json` | Rewritten: authoritative/fallback split, 6 step labels + order, entry CTA, card/saved-vs-charged/request-vs-confirmed/water-power/availability/success-state semantics **[C2]** | NONE — not runtime |
| `tests/booking-copy-drift.test.js` | Rewritten on jsdom; anchored copy assertions; recursive publish-root discovery **[C2]**; DOM-structural classification, physical step order, no writes inside the checkout **[C3]**; prefilter removed, path-semantic delegation, live role evidence, deterministic ordering, structural visibility **[C4]** | NONE — test only |

> **[C4] Fourth correction round.** An independent audit of the `9c6501b` delta found six
> blockers: the byte prefilter produced false negatives on DOM-equivalent encodings, bridge
> detection matched on basename alone, role membership was declared rather than proved,
> traversal order was non-deterministic, required copy could sit in self-declared-hidden
> markup, and this report overclaimed on all four. All six are closed below and the
> overclaims are withdrawn in place. Statements corrected in that round are marked **[C4]**.

> **[C3] Third correction round.** An independent audit of the `9dee289` delta found four
> blockers: the suite mutated the checkout, classification was still a raw substring match,
> step order was not physically enforced, and the zero-charge promise was under-pinned. All
> four are closed below. Statements corrected in that round are marked **[C3]**.

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

#### C1a-1. Explicit structural visibility **[C4]**

Anchoring alone still allowed required copy to sit in markup that declares itself hidden.
Every anchored element must now be free of four **structural** markers, on itself or on any
ancestor inside `#bk-ov`: the `hidden` attribute, `aria-hidden="true"`, inline
`display:none`, inline `visibility:hidden`. Mutations E, F, G and G2 apply each shape to a
required anchor and all four fail.

**The boundary, stated honestly.** This is *not* browser computed style. Visibility driven
by an external stylesheet or by a class — including whatever hides `#bk-ov` itself until the
modal opens — is **not modelled** and remains a browser-preview concern. A pass means "this
markup does not declare itself hidden", never "a customer can see this".

Progressive disclosure is handled by declaration rather than exemption-by-silence: an entry
may list `visibility.exemptIndices` with a `revealedBy` selector that **must actually
render**. The declared exemptions must equal the set of elements really hidden, so a stale
exemption fails as loudly as an undeclared hidden element — mutation K, which un-hides
`#bk-alt-fields`, fails on exactly that.

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

#### C1c. DOM-structural classification **[C3]**

The `[C2]` round still decided both halves of the classification on raw bytes —
`read(f).includes('id="bk-ov"')` and `read(page).includes(bridgePath)`. That is wrong in
both directions, and an independent audit called it:

| Input | Old behaviour | Now |
|---|---|---|
| `id='bk-ov'` (single-quoted, valid HTML) | **not** a surface — missed entirely | surface |
| `<!-- <div id="bk-ov"> -->` | surface | not a surface |
| booking root inside `<script>` text or `<template>` | surface | not a surface |
| bridge path inside a comment or a JS string | **fallback** | authoritative (it does not delegate) |

Both halves now read the parsed document: `getElementById(bookingRootId)` for the surface,
and real `script[src]` elements for delegation. Quoting never reaches the decision because
the parser has already resolved it.

#### C1c-1. The byte prefilter is gone **[C4]**

The `[C3]` round kept a byte prefilter and this report called it "a superset only". **That
claim was wrong and is withdrawn.** `read(f).includes('bk-ov')` is not a superset of "renders
an element with that id": `id="bk&#x2d;ov"` and `id="bk&#45;ov"` are the same element after
parsing but contain no literal `bk-ov`, so the prefilter produced **false negatives on valid
HTML** — exactly the class of bug the round was meant to remove.

There is now no prefilter. **Every** published `.html` is parsed. Measured cost: 31 files,
**1.77 s**, finding exactly the 13 known surfaces. Mutation A proves an entity-encoded
nested surface is discovered.

#### C1c-2. Delegation is path-semantic **[C4]**

`[C3]` accepted any script whose **basename** was `hub-booking-bridge.js`. That is not
delegation — it is a filename coincidence. Each `<script src>` is now resolved the way a
browser loading that page would resolve it (relative to the page's own directory, query and
fragment stripped, root-absolute honoured) and must equal the contract path
`assets/hub-booking-bridge.js` exactly.

| src on the page | Delegates? |
|---|---|
| `assets/hub-booking-bridge.js`, `./…`, `/…`, `…?v=3` | yes |
| `js/hub-booking-bridge.js`, `vendor/assets/hub-booking-bridge.js` | **no** — same basename, wrong path |
| `https://cdn.example.com/assets/hub-booking-bridge.js` | **no** — off-site |
| the path inside a comment or a JS string | **no** — not a script element |
| bare `assets/…` on a page in `deep/` | **no** — resolves to `deep/assets/…` |

#### C1c-3. Roles are live, not declared **[C4]**

`[C3]` proved the three roles were disjoint and that their union equalled the discovered
set. **That proves nothing about which page holds which role** — swapping `template-city.html`
with a real public hub satisfies both properties and is still wrong. The claim is withdrawn.

Membership is now proved against two independent pieces of live repository evidence:

| Signal | Public fallback | Template |
|---|---|---|
| `sitemap.xml` | must advertise it | must **not** advertise it |
| `scripts/generate-hub-pages.js` template input (read-only) | must not be it | must **be** it |

Mutation D — swapping `template-city.html` and `bergen-county-hub.html` between the roles —
fails on both signals.

#### C1d. Physical step order **[C3]**

The step test looked each `tabId` up with `getElementById` **in manifest order**. That
imposes the manifest's own order on the result, so swapping two tab elements in the DOM
still compared equal. Steps are now read from `#bprog > .bpt` in document order, and both
the id sequence and the exact count are asserted. Mutations N4 (swap tabs 3/4) and N5 (add a
seventh tab) both fail; N4 failed to fail before this change.

#### C1e. The suite no longer writes inside the checkout **[C3]**

The `[C2]` nested-discovery regression created and deleted `cities/` **in the real repo
root** during `npm test` — a side-effecting test inside a mandatory CI gate. Synthetic
publish roots are now built under `fs.mkdtempSync(os.tmpdir())`, with the root and the
manifest injected into `classifyBookingSurfaces()`. Two concurrent focused runs were
verified to pass simultaneously with zero leaked temp directories and a clean `git status`.

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
| B-1/B-2/B-3 corrections `9dee289` **[C2]** | 2646 | 2536 | 29 | 75 | 6 |
| Independent-audit blockers `9c6501b` **[C3]** | 2648 | 2538 | 29 | 75 | 6 |
| **Delta-audit blockers** **[C4]** | **2651** | **2541** | **29** | **75** | **6** |

Failure identities were set-differenced at every step. Between `d67003b` → `9dee289` → this
revision: **zero added, zero removed**, and skip identities are byte-identical throughout.
The test-count growth is entirely new guard tests — +3 in `[C2]`, +2 in `[C3]` (role
distinctness, physical step reorder); the decoy test was widened from one shape to five
without adding a case. Failure identities are listed in §A and are unchanged.

* Focused drift suite: **18 / 18 pass** **[C4]** (10 → 13 → 15 → 18).
* Focused related suites (drift · conversion copy · hub public surface · index public
  surface · hub booking conversion): **132 / 132 pass**.
* Two focused suites run **concurrently**: 18/18 and 87/87, **0** leaked `cd1-drift-*`
  directories, `git status` empty. **[C4]**

### `audit:pre-deploy` — corrected **[C2]**

The previous revision reported **exit 0**. That is **not reproducible on a clean tree** and
the claim is withdrawn.

| Tree | Exit |
|---|---|
| `bb4cbfd` (baseline), pristine export | **2** |
| `d67003b` (candidate), pristine export | **2** |
| `9dee289`, pristine export | **2** |
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

### H2. Third adversarial round — the independent-audit blockers **[C3]**

Thirteen mutations against a disposable export of the working tree, tree restored after
each. **All 13 caught.** N4 is the one that did **not** fail before this round.

| # | Mutation | Caught by |
|---|---|---|
| N1 | nested rogue surface using **single-quoted** `id='bk-ov'` | discovery — `assets/landing/boston-hub.html` |
| N2 | real fallback page: its bridge `<script src>` turned into a **comment** | misclassification — "does not load … as a `<script src>`, so it is authoritative" |
| N3 | booking root id renamed on a declared surface | "manifest lists surfaces that no longer render the booking root" |
| **N4** | **physical swap of step tabs 3 and 4** (elements moved, labels travel with them) | physical DOM order + the dedicated reorder test |
| N5 | a seventh step tab added | exact step count and order |
| N6 | drift + `display:none` decoy | anchored `[card-mandatory]` |
| N7 | drift + `hidden` attribute decoy | anchored `[card-mandatory]` |
| N8 | drift + `<script>` decoy | anchored `[card-mandatory]` |
| N9 | drift + HTML comment decoy | anchored `[card-mandatory]` |
| N10 | drift + decoy that **matches the anchor** | anchored — `expected 1 element(s), found 2` |
| N11 | `$0 today` → `$49 today` | zero-charge promise — "must render as zero" |
| N12 | `Card saved, not charged` → `Card charged today` | zero-charge promise — label drift |
| N13 | `$0 today` → `$0` | zero-charge promise — "must still say when" |

N1–N3 run against the **real** recursive walk over the checkout, not a synthetic root, so
they exercise the same code path the guard uses in CI.

**Isolation, verified rather than asserted:** two focused runs executed concurrently against
the same worktree — both 15/15, **0** leaked `cd1-drift-*` temp directories, `git status`
empty, no `cities/` anywhere in the checkout.

### H3. Fourth adversarial round — the delta-audit blockers **[C4]**

Twelve mutations against a disposable export, tree restored after each. **All 12 caught.**
A, B, C, D and K did **not** fail before this round.

| # | Mutation | Caught by |
|---|---|---|
| **A** | nested surface with entity-encoded `id="bk&#x2d;ov"` | discovery — the prefilter used to miss this entirely |
| **B** | fallback page's bridge src → `js/hub-booking-bridge.js` (same basename, wrong dir) | delegation — "does not load … as a resolved `<script src>`" |
| **C** | bridge tag → comment + JS string literal | delegation |
| **D** | `template-city.html` ⇄ `bergen-county-hub.html` swapped between roles | live role evidence — "sitemap.xml does not advertise it — it is not public" |
| **E** | required anchor given `hidden` | structural visibility |
| **F** | required anchor given `aria-hidden="true"` | structural visibility |
| **G** | required anchor given inline `display:none` | structural visibility |
| **G2** | required anchor given inline `visibility:hidden` | structural visibility |
| H | physical swap of step tabs 3 / 4 | physical DOM order |
| I | `$0 today` → `$49 today` | zero-charge promise |
| J | nested rogue authoritative surface (plain id) | discovery |
| **K** | `#bk-alt-fields` un-hidden, making a declared exemption stale | visibility exemption drift |

K is the check on the check: an exemption that is no longer needed is itself drift, so the
fixture cannot quietly accumulate permissions.

## I. Remaining risks

| Risk | Level |
|---|---|
| The manifest goes stale — a legitimate copy change is "fixed" by editing the manifest without thought | MEDIUM — process risk; every entry carries a `why` |
| `generate-hub-pages.js` run by someone unaware | **HIGH** **[C]** when found; later hard-guarded by separate PR #196 |
| jsdom parse cost on a 480 KB page | LOW — drift suite runs in ~5 s |
| No Netlify preview yet | — required before merge |

## J. Out-of-scope findings

| id | Severity | Location | Action |
|---|---|---|---|
| **OOS-1** | **HIGH** | `scripts/generate-hub-pages.js` | Found during this audit: stale generator produced +2,487/−4,637 on an unmodified tree. Later resolved by the hard guard in separate PR #196 |
| **OOS-2** | **P1** | `revenue-event.js`, `revenue-resume-link.js` | Found during this audit: obsolete positional caller + `!rate.ok` caused unconditional 429 in both functions. Later resolved by the bounded server fix and regression guard in separate PR #197 |
| **OOS-3** | MEDIUM | 12 fallback files | ~5.9 MB divergent duplication; fallback covers script-delivery failure only |
| **OOS-4** | LOW | hub/city files | Mojibake in the sticky call button |
| **OOS-5** | LOW | `scripts/` | ~33 one-shot historical patch scripts with no applied-state manifest |
| **OOS-6** **[C2]** | MEDIUM | `assets/universal-customer-strategy.generated.js`, `netlify/lib/universal-customer-strategy-config.json` | Committed generated files are stale against their shared config, so `audit:pre-deploy` exits 2 on any clean checkout — at baseline too. Running the suite silently regenerates them, which is why the tree then shows two modified files. Pre-existing; not fixed here (touches `netlify/lib/`) |

## K. The zero-charge promise — what is guarded, and what is not **[C3]**

Two earlier claims are withdrawn. The `[C]` round said the manifest covered "`$0`"
semantics — it did not. The `[C2]` round pinned only the adjacent label and stated plainly
that a change to the amount would go undetected. That gap is now closed, without putting a
price in the fixture.

`index.html:1523-1526` renders the promise as three elements. The invariant is asserted on
the **rendered DOM**, and the fixture stores no amount and no currency symbol:

| Fixture field | Value | |
|---|---|---|
| `anchor` | `.hpb-item--accent` | must resolve to exactly one element |
| `valueSelector` | `.hpb-val` | its digits must parse to **zero** — derived from the DOM, never stated here |
| `valueMustMatch` | `today` | the promise must keep its timeframe |
| `labelSelector` / `label` | `.hpb-lbl` / `Card saved, not charged` | the saved-vs-charged claim |

**What this proves:** the amount cannot become non-zero, cannot lose its timeframe, and
cannot be separated from the saved-vs-charged label. Mutations N11 (`$0 today` → `$49 today`),
N12 (label → `Card charged today`) and N13 (`$0 today` → `$0`) all fail.

**What this does not do, stated so no one reads more into it:** it does not define, approve
or pin any price. It asserts one property — *zero* — of one presentation element. Every
commercial amount remains the catalog's and the server's authority. `the manifest stays
presentation-only` still rejects any canonical string matching `/\$\d/`, and now also any
decimal money value, so the fixture cannot acquire pricing authority by drift.

The corresponding in-modal statements are pinned separately by the anchored entries
`nothing-collected-today`, `card-saved-not-charged` and `request-only-row`.

## K1. Limits of this suite — what it does NOT prove **[C3]**

Stated explicitly, because the earlier revisions of this report claimed more than the tests
supported:

* **Nothing is verified in a browser.** Every assertion runs in jsdom. Computed CSS,
  layout, paint and real event behaviour are unverified. The Netlify Preview smoke test
  remains the only evidence for those, and it has not been run.
* **Visibility is structural only** **[C4]**. The suite rejects four markers the markup
  declares about itself — `hidden`, `aria-hidden="true"`, inline `display:none`, inline
  `visibility:hidden`. It does **not** evaluate computed style, so anything hidden by an
  external stylesheet or by a class is invisible to it. "Customer-visible" here means "in
  the customer-visible DOM subtree and not self-declared hidden", never "on screen".
* **Role evidence is only as good as its two sources** **[C4]**. Public/template membership
  is proved against `sitemap.xml` and the generator's template input. A page absent from
  both — or a stale sitemap — would not be caught by this mechanism.
* **Copy outside the manifest is unguarded.** The suite pins the listed entries and nothing
  else. Silence is not coverage.
* **`audit:pre-deploy` is not a gate** and exits 2 here and at baseline (OOS-6). See §F.
* **The suite guards presentation only.** No pricing, ledger, Stripe, persistence or
  booking-state property is asserted anywhere in it.

## L. Verdict

### READY FOR FINAL INDEPENDENT DELTA AUDIT **[C4]**

Not merged. Not deployed. Production database, live Stripe configuration and Netlify
production settings untouched. A Netlify branch preview and customer-visible smoke
validation are still required before merge.
