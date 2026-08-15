# Production-safe reorganization & optimization pass

**Verdict: READY FOR INDEPENDENT REVIEW** — not merged, not deployed.

---

## A. Baseline

| | |
|---|---|
| Production / `master` SHA | `bb4cbfd` (Merge PR #194) |
| Branch | `refactor/production-safe-normalization` |
| Worktree | `C:\Projects\Cardetail1\worktrees\normalization` |
| Baseline suite | **2633 total · 2523 pass · 29 fail · 75 cancelled · 6 skipped** |
| Pre-existing failures | 29, all environment: PostgreSQL 16 and Netlify Blobs not configured locally (Twilio PR5 outbox, add-on/package financial mutations, vehicle-change approval, cash settlement, receipt authorization, portal change-request stability, price-decision Release A) |

## B. Architecture findings

### B1. Duplication (the dominant finding)

`index.html` is authoritative. Twelve hub/city pages each carry a **complete inline copy**
of the booking modal.

| Metric | Value |
|---|---|
| Public HTML on disk | 6,438 KB / 30 files |
| The 13 booking-modal pages | **5,875 KB** |
| Inline JS per page | 227–261 KB |
| Inline CSS per page | 93–174 KB |
| Inline modal markup per page | ~39 KB / ~486 lines |
| **Distinct modal variants** | **4** |

Divergence is structural: `bkContinueFromContact()`, `bkResolveOperationalSlot()` and
`renderStep5Summary()` exist on `index.html` **only**. 19 customer-facing booking strings
are physically repeated on 13 pages with nothing enforcing agreement.

Full analysis: `LEGACY_BOOKING_FALLBACK.md`. **No runtime change made** — see D.

### B2. Copy drift mechanism

Nothing in the repo compared the 13 copies. The `card holds your slot` contradiction fixed
in PR #193 had to be applied 13 times by hand. That gap is what S1 closes.

### B3. Dead code

`PROVEN DEAD` — the "Trust stats row (#reviews)" CSS block, 55 lines / 1,852 bytes,
**byte-identical on all 13 pages**. Evidence gathered before removal:

| Check | Result |
|---|---|
| Static markup (`class="…trust-ico--*"`) across 30 HTML | **0** |
| Runtime JS injecting these classes (`assets/*.js`, `netlify/`) | **0** |
| Generator/template scripts emitting them (`scripts/`) | **0** |
| Keyframe `animation:` usages outside the block | **0** (1 each, all inside) |
| Responsive/`prefers-reduced-motion` selectors | all 4 grouped selectors are from the dead set |
| Tests referencing them | only `doesNotMatch` assertions |
| Season-icon target `#trust-stat-season-ico` in markup | **0** (JS lookup only — S4) |

The live `.trust-row` / `.trust-item` / `.trust-ico` / `.trust-val` / `.trust-lbl` rules sit
**above** the block header and were not touched.

### B4. Performance

`revenue-event` returns **429 reproducibly** on clean production loads. Investigated
read-only in `REVENUE_EVENT_RATE_LIMIT.md`. **No fix implemented.**

Correction to an earlier claim in this session: there are **no duplicate network calls** on
a clean load (1 HTML + 30 assets + 3 function calls). The earlier "9 events per load"
observation came from a doubled navigation in one tab, not from the page.

## C. Changes made

| File | Change | Reason | Risk |
|---|---|---|---|
| `index.html` + 12 hub/city pages (13 files) | −55 lines each: the dead trust-stats CSS block | Removes 23.5 KB of CSS every visitor downloads and no browser can apply | **LOW** — proven dead by 7 independent checks |
| `assets/hub-booking-bridge.js` | Header corrected: documented a *four-step* modal, the flow has **six**. Added the fallback contract and a pointer to the design note | The stale count actively misleads anyone touching the bridge | **NONE** — comment only |
| `tests/fixtures/booking-copy.canonical.json` | **new** — 17 canonical strings, 5 forbidden patterns, surface lists, flow shape | Single place defining what the booking surface says | **NONE** — not runtime |
| `tests/booking-copy-drift.test.js` | **new** — 5 tests | Fails with the exact page + string id that drifted | **NONE** — test only |

### Canonical source (S3 condition)

Authorization required removal at the canonical source if one exists. Investigated:

* `scripts/apply-state-hub-theme.mjs` generates 4 state hubs from `index.html`, but its CSS
  slices span `index.html` lines 1293–1443. The dead block is at 481–535 — **outside every
  slice**, so it does not propagate.
* `scripts/generate-hub-pages.js` builds 6 hubs from `template-city.html`. **Run on an
  unmodified tree it produces +2,487 / −4,637 lines**, wiping the state-hub theme from
  `connecticut-hub.html` and `ny-metro-hub.html`. It is a stale historical generator and was
  reverted immediately. It must not be run. → out-of-scope finding OOS-1.
* No script anywhere emits the dead selectors.

Conclusion: **no usable canonical generating source.** The 13 pages own this CSS
independently. `template-city.html` — the notional template for `generate-hub-pages.js` —
was cleaned too, so even an ill-advised future run cannot reintroduce it.

### S4 — not modified, as instructed

`initTrustSeasonIcon()` is now a permanent no-op (its target element no longer exists on any
page), **but it is the positional marker** `scripts/apply-state-hub-theme.mjs` uses to slice
`_updateHomeFromPrices` out of `index.html`. Removing or renaming it makes hub regeneration
throw `marker not found`. Left exactly as-is; coupling documented here and in the design note.

## D. Explicitly untouched

Stripe authority · Payment Element · `create-setup-intent` · `stripe-webhook` · payment
ledger · settlement · reconciliation · payment idempotency · receipts and receipt financial
authority · booking ownership · `bookingVersion` / `quoteVersion` · booking persistence
(Blob CAS + Postgres mirror) · customer identity and isolation · Prisma schema and every
migration · package / vehicle / add-on / travel / tax / discount pricing · ZIP and
service-area logic · the scheduling engine and `MIN_ADVANCE_DAYS` · Customer Portal ·
Admin · Owner Studio · `netlify.toml` · all environment variables · **the legacy inline
booking modal and `hub-booking-bridge.js` runtime behaviour**.

Files changed under `netlify/`: **0**. Under `prisma/`: **0**. `package.json`: **0**.

## E. Before vs after

Structurally the site is unchanged. What changed is what *guards* it:

* **Before** — 13 independent copies of the booking copy, nothing comparing them; a fix on
  one page could silently miss twelve.
* **After** — one manifest names every canonical string and every forbidden contradiction,
  and a test fails with the exact page and string id when any surface drifts. It also covers
  `scripts/apply-state-hub-theme.mjs`, so a regenerated hub cannot reintroduce a contradiction.
* Every visitor stops downloading 1,852 bytes of inapplicable CSS per page.
* Anyone opening the bridge now reads the true step count and the real fallback contract.

## F. Test evidence

| | Total | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|---|
| Baseline `bb4cbfd` | 2633 | 2523 | 29 | 75 | 6 |
| After | **2638** | **2528** | **29** | **75** | 6 |

Failure sets compared line by line: **124 failure lines before, 124 after, zero new**.
The +5 are the new drift tests.

Focused run (drift · conversion copy · hub public surface · index public surface · hub
booking conversion · booking flow · PR-65 regression): **144 / 144 pass**.

Build `node scripts/generate-deploy-runtime-env.js` → exit 0 (regenerated artifact reverted,
not committed). `npm run audit:pre-deploy` → exit 0, no unbalanced-tag findings.

## G. Production / preview comparison

Production is `bb4cbfd`, which is this branch's base, so `git show HEAD:<file>` **is** the
deployed content. The complete delta between production and this branch is: the 55-line CSS
block × 13, the bridge comment, and two new test files. Nothing else — verified by
`git diff --name-only`.

Runtime verification against a local serve of the branch:

| Surface | Result |
|---|---|
| `index.html` | 0 elements match any removed selector · live `.trust-row` intact (flex, 16px radius, 5 items, padding preserved) · hero proof bar 5 tiles · `BK_VISIBLE_STEPS = 6` |
| `bergen-county-hub.html` (compatibility) | 0 orphaned selectors · **bridge delegation active** (`cd1-hub-booking-delegated` set, style injected) · inline modal present and `display:none` · card gate reads "Save Your Card" |
| Brace balance, all 13 pages | identical before and after (the `-3` on three city pages is pre-existing, from braces inside JS strings) |

Screenshot capture was unavailable in this session (browser pane not compositing); DOM and
computed-style assertions were used instead, which for a pure CSS deletion are the decisive
check. **A Netlify branch preview is still required before merge** — the URL must come from
the owner, as no Netlify CLI is installed on this machine.

## H. Remaining risks

| Risk | Level | Note |
|---|---|---|
| The manifest itself goes stale — a legitimate copy change fails the test and gets "fixed" by editing the manifest without thought | **MEDIUM** | Mitigated by a `why` on every entry. This is a process risk, not a code risk |
| A page could add the card gate without being added to the manifest | LOW | Guarded: the test enumerates every page rendering `card-gate-title` and fails if one is uncovered |
| Removed CSS was somehow reachable via a path not checked | LOW | 7 independent checks, plus 0 matching elements at runtime on both an authoritative and a compatibility surface |
| `generate-hub-pages.js` run by someone unaware | **MEDIUM** | Pre-existing hazard, not introduced here. OOS-1 |
| Preview not yet built | — | Required before merge |

## I. Out-of-scope findings

| id | Severity | Location | Evidence | Recommended action |
|---|---|---|---|---|
| **OOS-1** | **HIGH** | `scripts/generate-hub-pages.js` | Run on an unmodified tree at `bb4cbfd` → +2,487 / −4,637 lines, wipes the state-hub theme from `connecticut-hub.html` and `ny-metro-hub.html` | Delete it, or add a hard guard/`README` marking it historical. It looks like a live generator and is a loaded gun |
| **OOS-2** | **P1** | `netlify/functions/revenue-event.js` + `assets/revenue-events.js` | Reproducible 429; client never inspects response status, no retry | See `REVENUE_EVENT_RATE_LIMIT.md`. Not fixed here |
| **OOS-3** | MEDIUM | 12 hub/city pages | ~5.9 MB of divergent duplicate booking implementations acting as an unplanned fallback | See `LEGACY_BOOKING_FALLBACK.md`. Not changed here |
| **OOS-4** | LOW | hub/city pages | Mojibake in the sticky call button (`📍ž Call` instead of `📞 Call`) | Pre-existing at `efe2d8d`; present in the generator family |
| **OOS-5** | LOW | `scripts/` | ~33 one-shot historical patch scripts with no manifest of what has been applied | Archive under `scripts/historical/` with a README |

## J. Verdict

### READY FOR INDEPENDENT REVIEW

Not merged. Not deployed. Production database, live Stripe configuration and Netlify
production settings untouched.
