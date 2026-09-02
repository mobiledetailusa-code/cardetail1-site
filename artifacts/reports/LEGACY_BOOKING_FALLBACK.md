# Legacy inline booking modal — read-only design note

**Status: DESIGN NOTE ONLY. No runtime change. Nothing removed, rewritten or reduced.**

Classification: **LEGACY COMPATIBILITY / FUTURE ARCHITECTURE WORK**

> **Correction notice.** The first revision described the inline modal as the degradation
> path whenever "the bridge fails". That was imprecise and overstated its protection — see
> §3, which now separates the two distinct failure modes. It also counted surfaces loosely;
> the counts in §1 are corrected.

---

## 1. Surfaces and why the duplication exists

`index.html` is the authoritative booking surface. Twelve further files carry their own
**complete inline copy** of the booking modal, inherited from a period when every landing
page booked independently.

| Class | Count | Files |
|---|---|---|
| Authoritative (customer-visible booking UI) | **1** | `index.html` |
| Public fallback surfaces | **11** | bergen, connecticut, essex, hudson, new-jersey, newark, ny-metro, passaic, pennsylvania, trenton, westchester |
| Template (not a runtime surface by role) | **1** | `template-city.html` |

**12 runtime/public HTML surfaces + 1 template.** (`netlify.toml` sets `publish = "."`, so
`template-city.html` is technically reachable; it is treated as a template because it is the
input to `scripts/generate-hub-pages.js`, not a page the business links to.)

Classification is structural, not by string match: a file owning `#bk-ov` is a booking
surface; if it also loads `assets/hub-booking-bridge.js` it is fallback, otherwise
authoritative. `tests/booking-copy-drift.test.js` enforces exactly this rule over a
**recursive** walk of the publish root, so a new booking page cannot be added at any depth
without being classified.

> **Correction (two rounds).** Discovery originally read only the top level of the repo.
> Since `publish = "."` serves every depth, a page such as `cities/boston-hub.html` carrying
> `#bk-ov` passed the whole suite. The walk is now recursive, with role-based directory
> exclusions matched relative to the publish root; `assets/` is deliberately scanned.
>
> A second round replaced the remaining raw-substring test with **DOM-structural**
> detection. A page is a surface when the parsed document renders an *element* with the
> booking id, and it delegates when a real `<script src>` loads the bridge. Quoting style
> is resolved by the parser; a modal or a bridge path appearing in a comment, in `<script>`
> text or inside `<template>` classifies nothing. The regression tests build synthetic
> publish roots under `fs.mkdtempSync` — **nothing is written inside the checkout**, and
> concurrent runs never share a path.

Measured at `bb4cbfd`:

| Metric | Value |
|---|---|
| Public HTML on disk | 6,438 KB across 30 files |
| The 13 booking-root files | **5,875 KB** |
| Inline JS per file | 227–261 KB |
| Inline CSS per file | 93–174 KB |
| Inline modal markup per file | ~39 KB / ~486 lines |

### The divergence is genuine, not cosmetic

The modal block hashes to **4 distinct variants**. That count was re-measured against the
git blobs at `bb4cbfd` with punctuation (`—`/`–`/`-`, `·`/`•`) and whitespace normalised —
**the 4 variants survive normalisation**, so they differ in substance, not typography.

| Variant | Files |
|---|---|
| bergen, essex, hudson, passaic | 4 |
| connecticut, new-jersey, ny-metro, pennsylvania | 4 |
| newark, template-city, trenton, westchester | 4 |
| **index.html** (authoritative) | 1 |

Independent corroboration: `bkContinueFromContact()`, `bkResolveOperationalSlot()` and
`renderStep5Summary()` exist on `index.html` **only**. The twelve copies run an older
booking implementation.

(For contrast, the dead CSS block removed in this pass hashed to 2 variants that collapsed
to 1 under the same normalisation — that divergence *was* pure comment punctuation. The
modal divergence is not.)

## 2. What the bridge does

`assets/hub-booking-bridge.js` runs on the twelve delegated files. When it takes control it:

1. adds `cd1-hub-booking-delegated` to `<html>`;
2. injects `html.cd1-hub-booking-delegated #bk-ov{display:none!important;visibility:hidden!important;pointer-events:none!important}`;
3. builds `#hub-booking-overlay` containing an `<iframe>` of `index.html` with `allow="payment"`;
4. shows `"We could not load booking. Please try again or call/text 201-555-0177."` in `#hub-booking-error` if the frame fails.

It deliberately bails out — leaving the inline modal visible — when `document.body` carries
`cd1-booking-embed`, when the path is `/` or `index.html`, or when the path is not
`*-hub.html`, `*-mobile-detailing.html` or `template-city.html`.

## 3. Degradation behaviour — two distinct failure modes

This is the correction. The inline modal protects against **one** of these, not both.

| Failure mode | What happens | Is the inline modal a fallback? |
|---|---|---|
| **Bridge never executes** — asset 404s, blocked by CSP or an extension, an earlier JS error aborts parsing, or scripts are disabled | The hiding CSS is never injected, `#bk-ov` stays visible, the inline modal handles booking | **YES** — this is the real fallback case |
| **Bridge executes but the iframe fails to load** | `#bk-ov` has *already* been hidden in step 2 before the frame is attached. The customer sees `#hub-booking-error` and the call/text number | **NO** — no booking form is reachable; the inline modal is hidden and stays hidden |

So the inline modal is **not** a general safety net. It covers script-delivery failure only.
It remains genuinely load-bearing for that case, which is why it must not be removed as part
of a normalization pass — but the protection it provides is narrower than the first revision
of this note implied.

## 4. Risks of removing it now

| Risk | Consequence |
|---|---|
| Bridge fails to execute after removal | Booking CTA does nothing on 11 public landing pages — silent, total conversion loss on those pages |
| iframe blocked (privacy browser, embedded webview) | Already unprotected today (see §3); removal does not worsen this case but does remove the script-failure protection |
| Behavioural divergence | The twelve copies run older logic; visitors who currently fall through get a *different but working* flow. Removal changes who sees what during failure |
| Parity tests | `tests/booking-copy-drift.test.js` asserts fallback parity on these files; removal requires rewriting that contract |

Transfer size alone does not justify removing a working fallback.

## 5. Proposed replacement architecture

Target: **one authoritative booking implementation plus one intentionally designed
lightweight fallback**, instead of one authoritative implementation plus twelve stale ones.

```
index.html ──────────────► authoritative 6-step modal (unchanged)
     ▲
     │ iframe (hub-booking-bridge.js, unchanged)
     │
hub/city page ──► bridge does not execute ──► static fallback:
                                              "Book by text/call" + link to
                                              /index.html#book — no inline modal
```

Crucially the static fallback must be **inert markup that needs no JavaScript**, because the
case it covers is precisely the case where JavaScript did not run. It should also be shown
by `#hub-booking-error` when the iframe fails, closing the gap identified in §3.

## 6. Migration and test strategy

1. **Measure first.** Emit a beacon when the bridge fails and when the iframe fails, and
   observe real rates over a full traffic cycle. Blocked by the `revenue-event` defect —
   see `REVENUE_EVENT_RATE_LIMIT.md`; that must be repaired before any measurement is
   trustworthy.

   **Later resolution:** this blocker was subsequently repaired by separate PR #197. The
   statement above records the condition found during this audit; it is not the current
   endpoint state. Frontend delivery/retry reliability remains separate deferred work.
2. Build the static fallback on **one** page. Verify with the bridge script blocked at the
   network layer, not merely disabled in code.
3. Rework the drift contract: assert the *fallback* contract on compatibility files and the
   *full* contract on `index.html`, updating `tests/fixtures/booking-copy.canonical.json`.
4. Roll out file by file, each behind its own preview, comparing production vs preview.
5. Keep `hub-booking-bridge.js` unchanged throughout — it is the working path.

## 7. Estimated payload reduction

Upper bound if all twelve files drop the inline modal and its exclusive JS: **on the order of
2–3 MB** across the public surface, roughly 250–400 KB per hub page load. Precise figures
require separating modal-exclusive JS from page JS, which this read-only pass did not
attempt — treat the range as an estimate, not a measurement.

## 8. Related coupling — do not trip on this

`scripts/apply-state-hub-theme.mjs` uses the literal string `(function initTrustSeasonIcon()`
as a **positional marker** to slice `_updateHomeFromPrices` out of `index.html`.
`initTrustSeasonIcon()` is now a permanent no-op — the element it looks up
(`#trust-stat-season-ico`) no longer exists on any page — but it **must not be removed or
renamed**, or hub regeneration throws `marker not found`. Left intentionally in place.

## 9. Separate hazard — severity HIGH

`scripts/generate-hub-pages.js` regenerates six hubs from `template-city.html`. Run on an
**unmodified** tree at `bb4cbfd` it produces a +2,487 / −4,637 line diff, wiping the
state-hub theme from `connecticut-hub.html` and `ny-metro-hub.html`. It is a stale historical
generator that presents as a live one. **Risk: HIGH.** Recorded as OOS-1.

**Later resolution:** separate PR #196 hard-guarded the generator against destructive
rewrites. The finding and original severity remain here as audit chronology.
