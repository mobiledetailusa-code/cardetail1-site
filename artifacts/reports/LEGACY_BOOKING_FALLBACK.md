# Legacy inline booking modal — read-only design note

**Status: DESIGN NOTE ONLY. No runtime change. Nothing removed, rewritten or reduced.**

Classification: **LEGACY COMPATIBILITY / FUTURE ARCHITECTURE WORK**

---

## 1. Why the duplication exists

`index.html` is the authoritative booking surface. Twelve hub/city pages each carry
their own **complete inline copy** of the booking modal — markup, styles and driving
JavaScript — inherited from a period when every landing page booked independently.

Measured at `bb4cbfd`:

| Metric | Value |
|---|---|
| Public HTML on disk | 6,438 KB across 30 files |
| The 13 booking-modal pages | **5,875 KB** |
| Inline JS per page | 227–261 KB |
| Inline CSS per page | 93–174 KB |
| Inline modal markup per page | ~39 KB / ~486 lines |

The copies have **diverged into 4 distinct variants**:

| Variant | Pages |
|---|---|
| `6a023377` | bergen, essex, hudson, passaic |
| `0d47aa0a` | connecticut, new-jersey, ny-metro, pennsylvania |
| `fa788803` | newark, template-city, trenton, westchester |
| `7457597a` | **index.html** (authoritative) |

Divergence is structural, not cosmetic. `bkContinueFromContact()`,
`bkResolveOperationalSlot()` and `renderStep5Summary()` exist on **index.html only** —
the twelve copies run an older booking implementation.

## 2. Current degradation behaviour

`assets/hub-booking-bridge.js` runs on the twelve delegated pages. When it takes control it:

1. adds `cd1-hub-booking-delegated` to `<html>`;
2. injects `html.cd1-hub-booking-delegated #bk-ov{display:none!important;visibility:hidden!important;pointer-events:none!important}`;
3. builds `#hub-booking-overlay` containing an `<iframe>` of `index.html` with `allow="payment"`;
4. shows `"We could not load booking. Please try again or call/text 551-313-2956."` if the frame fails.

It deliberately bails out — leaving the inline modal visible — when:

* `document.body` carries `cd1-booking-embed` (the page is itself the embedded frame);
* the path is `/` or `index.html`;
* the path is not `*-hub.html`, `*-mobile-detailing.html` or `template-city.html`.

## 3. Exact dependency

The inline modal is hidden **only** by CSS that this script injects at runtime. Therefore
`#bk-ov` remains visible and functional whenever the script does not execute:

* the asset 404s or is blocked;
* a CSP or extension blocks it;
* a JS error earlier on the page aborts parsing;
* the browser does not run the script at all.

**This is why it is not dead code.** It is an unplanned but real degradation path: if the
bridge fails, the visitor still gets a booking form rather than a dead button.

## 4. Risks of removing it now

| Risk | Consequence |
|---|---|
| Bridge fails after removal | Booking CTA does nothing on 12 landing pages — total conversion loss on those pages, silently |
| iframe blocked (privacy browser, embedded webview) | No fallback path remains |
| Behavioural divergence | The 12 copies run older logic; visitors who currently fall through get a *different but working* flow. Removal changes who sees what during failure |
| Parity tests | Several suites assert booking strings on all 13 pages; removal requires reworking them, weakening the drift guard added in this pass |

Transfer size alone does not justify removing a working fallback.

## 5. Proposed replacement architecture

Target: **one authoritative booking implementation plus one intentionally designed
lightweight fallback** — instead of one authoritative implementation plus twelve stale
full ones.

```
index.html ──────────────► authoritative 6-step modal (unchanged)
     ▲
     │ iframe (hub-booking-bridge.js, unchanged)
     │
hub/city page ──► on bridge failure ──► <noscript>-safe static fallback:
                                        "Book by text/call" + a link to
                                        /index.html#book, no inline modal
```

The fallback becomes a deliberate, tiny, testable artifact rather than 39 KB of drifting
duplicate. Estimated saving: ~39 KB markup plus the majority of 227–261 KB inline JS per
page, on 12 pages.

## 6. Migration and test strategy

1. **Make the fallback observable first.** Emit an analytics event when the bridge fails,
   and measure the real rate over a full traffic cycle. If it is non-zero the fallback is
   load-bearing and the design must serve those users properly.
2. Build the static fallback on **one** page. Verify with the bridge force-disabled.
3. Rework the parity suites to assert the *fallback* contract on compatibility pages and
   the *full copy* contract on `index.html`. Update
   `tests/fixtures/booking-copy.canonical.json` surfaces accordingly.
4. Roll out page by page, each behind its own preview, comparing production vs preview.
5. Keep `hub-booking-bridge.js` unchanged throughout — it is the working path.

## 7. Estimated payload reduction

Upper bound if all twelve pages drop the inline modal and its exclusive JS: **on the order
of 2–3 MB** across the public surface, and roughly 250–400 KB per hub page load. Precise
figures require separating modal-exclusive JS from page JS, which this read-only pass did
not attempt.

## 8. Related coupling — do not trip on this

`scripts/apply-state-hub-theme.mjs` uses the literal string
`(function initTrustSeasonIcon()` as a **positional marker** to slice
`_updateHomeFromPrices` out of `index.html`. `initTrustSeasonIcon()` is now a permanent
no-op — the element it looks up (`#trust-stat-season-ico`) no longer exists on any page —
but **it must not be removed or renamed**, or hub regeneration throws
`marker not found`. Left intentionally in place; see the S4 decision in
`PRODUCTION_SAFE_NORMALIZATION.md`.

## 9. Separate hazard discovered

`scripts/generate-hub-pages.js` regenerates six hubs from `template-city.html`. Run on an
**unmodified** tree at `bb4cbfd` it produces a 2,487-insertion / 4,637-deletion diff,
wiping the state-hub theme from `connecticut-hub.html` and `ny-metro-hub.html`. It is a
stale historical generator and **must not be run**. Recorded in the out-of-scope findings.
