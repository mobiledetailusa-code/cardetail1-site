# Conversion Funnel — Safe Repair (P1)

**Status: READY FOR INDEPENDENT REVIEW** — not merged by this work.

> **Update 2026-08-13: shipped.** PR
> [#193](https://github.com/mobiledetailusa-code/cardetail1-site/pull/193) was merged
> into `master` at 14:01Z and Netlify deployed it, so `cardetail1.com` now serves this
> work. Verified against the production origin: "Check Price & Availability",
> "card saved, not charged", "Water access — Optional", and no "holds your slot" /
> "Lock Your Slot" anywhere. Owner confirmed the live funnel tested clean.
>
> *(An earlier revision of this note claimed production was serving an unmerged branch
> and that `master` had diverged. That was wrong — it compared against stale local
> remote-tracking refs instead of fetching first. PR #193 had already landed.)*
>
> Two later commits — the trust-stats removal `f9e04ad` and this report — are **not yet
> in `master`**. See §10.

| | |
|---|---|
| Branch | `fix/conversion-funnel-safe` |
| Base | `efe2d8d` (`origin/master`, production tip) |
| Commit | `f91d833` |
| Worktree | `C:\Projects\Cardetail1\worktrees\conversion-funnel` |
| Scope executed | Phase 0 (map) · Phase 1 (baseline) · Phase 2 A/B/C/D/E |
| Scope deferred | Phase 3 (pre-card lead), Phase 4 (card timing), Phase 5 (analytics gap) |

---

## 1. Executive summary

Six of the eight hypotheses were confirmed against the deployed source; one was
refuted and one partially refuted. The single largest confirmed problem is not
that the card is unexplained — Step 5 explains it well — but that the site makes
**two incompatible promises**: the marketing surface said the card *holds/locks your
slot*, while the terms, the confirm step and the success screen said a submission is
only a *request* that does not guarantee an appointment. Cold traffic met the
reservation promise first and the disclaimer last.

This release makes the public copy say what the system actually does, lowers the
commitment level of cold-entry CTAs without changing where they lead, and removes
the water/power contradiction. **No transaction, scheduling, pricing or persistence
semantics changed.**

### Verified findings

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| 1 | Card demanded too early for cold traffic | **CONFIRMED (structural)** | Card-on-file mandatory at Step 5/6; all three payment preferences required it. Structural fix is Phase 3/4 — deferred. |
| 2 | Card purpose unclear | **PARTIALLY REFUTED** | Step 5 already stated "Charged today $0.00", Stripe custody, fee triggers, policy checkbox. The defect was contradiction, not absence. |
| 3 | Contradictory "holds your slot" vs "request only" | **CONFIRMED** | `index.html` ×5 + `card-gate-title` "Lock Your Slot" ×12 pages + `apply-state-hub-theme.mjs` ×3, against `terms-conditions.html:54` and the `$0.00 — booking request only` confirm row. **FIXED.** |
| 4 | Contact should be a recoverable lead before the card | **CONFIRMED — not fixed** | No server round-trip exists between Step 4 and Step 5. Abandonment after entering name/phone/email/address leaves zero server-side trace. Phase 3. |
| 5 | "Book Now" too high-commitment | **CONFIRMED** | 173 occurrences across 14 pages, no discovery-level CTA anywhere. **FIXED at cold-entry points.** |
| 6 | Availability language misrepresents | **REFUTED** | "typically 3 days out" is truthful: `MIN_ADVANCE_DAYS = 3` (`netlify/lib/operational-availability.js:17`) is enforced server-side by `validateBookingSchedule` and client-side by `bkEarliestBookable()` setting `#f-date.min`. Left unchanged; **now pinned by a test** so copy and constant cannot drift. |
| 7 | Water/electricity contradicts "we bring our own" | **CONFIRMED** | `index.html:2002` markets "We bring the water, the power"; the form asked "Water access"/"Electricity access" bare, next to required fields. **FIXED.** |
| 8 | Admin concepts exposed in the customer interface | **CONFIRMED, mostly benign** | See §5. Defensive fix applied; the real concern is documented, not fixed. |

---

## 2. Before / after — customer journey

| Stage | Before | After |
|---|---|---|
| Google → hero | **"Book Your Detail"** / **"Book Now"** — commitment before any price is known | **"Check Price & Availability"** — same click target, same modal |
| Nav / mobile pill | "Book online" / "Book Now" | "Check Price" |
| ZIP button (hubs) | **"BOOK NOW"** on a button that only checks coverage | "CHECK ZIP" |
| Sticky mobile bar | "Book detail" / "Book Now" | "Check price" |
| Trust badges | "Card holds your slot" | "Card saved, not charged" |
| How-it-works step 2 | "Hold your slot — card holds your slot" | "Send your request — your card is saved on file, not charged. We text you to confirm the appointment." |
| Step 4 utilities | "Water access" / "Electricity access", bare selects | "Water access — Optional" / "Electricity access — Optional" + **"We bring our own water and power — you don't need either."** |
| Step 5 card gate | **"Lock Your Slot"** | **"Save Your Card"** |
| Step 5 pay prefs | "a card on file is still required to **secure the booking**" | "…required to **submit the booking request**" |
| Step 5 policy | "saving your card secures the booking request only" | "saving your card lets us process your booking request. **It does not confirm the appointment; we text you once it is confirmed.**" |
| Steps 1–6, submit, Stripe | — | **identical** |

Lower-funnel CTAs ("Book Your Detail" in the results and phone-CTA blocks) deliberately
keep booking language — that is the second level of the hierarchy.

---

## 3. Files changed (19)

**Public pages — copy only (14)**
`index.html`, `bergen-county-hub.html`, `connecticut-hub.html`, `essex-county-hub.html`,
`hudson-county-hub.html`, `new-jersey-hub.html`, `newark-mobile-detailing.html`,
`ny-metro-hub.html`, `passaic-county-hub.html`, `pennsylvania-hub.html`,
`template-city.html`, `trenton-mobile-detailing.html`, `westchester-mobile-detailing.html`,
`fleet-services.html` (nav CTA only).

**Generator (1)** — `scripts/apply-state-hub-theme.mjs`: same three strings, so regenerating
a state hub cannot reintroduce the slot promise.

**Tests (4)** — new `tests/conversion-funnel-copy.test.js` (14 regressions); one assertion
each updated in `tests/booking-flow.test.js`, `tests/pr-65-public-regression.test.js`,
`tests/hub-booking-conversion.test.js` (they pinned the old strings verbatim).

Replacements were applied as **literal string substitutions** with per-rule hit counts, not
regex, and every rule's total was verified: `card-gate-title` 12, `pay-pref-desc` 36,
`hero-trust-line` 5, `sec-desc-service` 5, `trust-lbl` 5, `policy-bullet` 4, `nav-cta` 8+1,
`nav-book-mobile` 8, `hero-zip-btn` 4, `hero-primary` 8, `sticky-cta` 12, `water-label` 12,
`electric-label` 12, `util-help` 12, `login-staff-hidden` 12.

---

## 3b. Hero proof bar (replaces the removed stats band)

The stats band was removed because its headline figure was fabricated. The trust signals
that were **true** were worth keeping, so they were rebuilt in the hero — earlier in the
page, where cold traffic decides — as `.hero-proof-bar` in `index.html`:

| Tile | Claim | Why it is defensible |
|---|---|---|
| ★★★★★ **5.0 Google** | "Read real reviews" | Links to `#reviews`, the real testimonial carousel — the visitor can check it |
| 📅 **5+ years** | "Serving NJ · NY · CT" | Tenure already claimed on the page |
| 🌤️ **All year** | "Every season, not just summer" | The year-round claim already on the page |
| 🚐 **Water & power** | "We bring our own — no hookup" | Matches the marketing promise *and* the reframed Step 4 question |
| ✓ **$0 today** | "Card saved, not charged" | Word-for-word the promise the card step keeps |

**Deliberately absent: any vehicle count.** A test asserts the bar contains no `k+`-style
figure and no "vehicles/detailed" tally, so the fabricated counter cannot return by a
different name.

Layout: the hero column is capped at 520px, so the bar is a 2-column grid with the
`$0 today` card spanning both as a banner — it is the anti-friction message and earns the
emphasis. Verified at 1280×800 and 375×812.

**Generator fix caught by this work:** `scripts/apply-state-hub-theme.mjs` used
`(function initTrustedStatsCounter()` as a *positional marker* to slice `_updateHomeFromPrices`
out of `index.html`. Deleting that function would have made the next hub regeneration throw
`marker not found`. The marker now points at `(function initTrustSeasonIcon()`, which is
present in `index.html` and all 12 hub pages.

**Not yet propagated:** the proof bar is on `index.html` only. The hub/city heroes have a
different structure and each needs its own placement pass.

## 4. Behavioural changes

**Customer-visible:** the copy above; the two utility selects are labelled Optional (they
were never required — verified against the `bkContinueFromContact` required list).

**Internal:** exactly one — `#login-staff` now carries `style="display:none"` so the staff
credential form cannot paint before `setLoginRole()` runs. `openLogin()` already opened as
`'customer'` and has no callers.

**Nothing else.** No JS logic, no function, no schema, no Stripe call, no scheduling rule,
no price, no field id, no payload key, no route, no redirect.

---

## 5. Customer / Admin separation — documented, not fixed

`index.html` (and each hub) ships, in public HTML:

* `assets/admin-session-client.js` loaded on the customer page (`index.html:2961`);
* a **staff username/password form** posting to `/.netlify/functions/admin-auth` and
  redirecting to `admin-ops.html` (`index.html:~6442`);
* `location.hash === '#admin' → /admin` (`index.html:~5574`);
* an "Open Catalog Manager" link to `/admin/owner-studio/catalog` inside a
  draft-preview failure banner.

**Reachability audit:** `openLogin()` has **zero callers** in `index.html`, the `#ltab-admin`
tab is `display:none`, and `openLogin()` forces the customer role. So no admin UI is
*reachable* through the customer experience today — this is dormant markup, not an exposed
surface. `/admin` and `admin-ops.html` are publicly routable via `netlify.toml` regardless
of this page, so removing the hash shortcut would not add protection.

Correcting it properly means extracting the staff form out of every public page and into
`admin.html` — that is an Admin-authentication change, explicitly out of scope. **Recommended
as a separate, small, independent task.** Risk today: LOW (no credential is exposed; the form
is inert), but it is unnecessary attack surface and unnecessary bytes on every cold visit.

---

## 6. Test report

**Baseline** (`efe2d8d`, before any edit):
`2616 tests · 2506 pass · 29 fail · 75 cancelled · 6 skipped`

**After** (`f91d833`):
`2630 tests · 2520 pass · 29 fail · 75 cancelled · 6 skipped`

Failure sets diffed line-by-line: **zero new failures, zero fixed** — the 29 failures are
identical before and after and are all pre-existing environment failures (PostgreSQL 16 and
Netlify Blobs not configured locally): Twilio PR5 outbox, add-on/package financial mutations,
vehicle-change approval, cash settlement, receipt authorization, portal change-request
stability, price-decision release A. **None of these is attributable to this change.**

**Focused:** `tests/conversion-funnel-copy.test.js` — 14/14 pass. Covers: no source promises
a slot hold (all 13 pages **plus the generator**); the request-only contract is stated on
every booking page; water/power optional + reassurance **and fields/payload preserved**;
neither utility field is required to advance; cold CTAs use discovery language **and still
call `openBooking`**; ZIP button no longer says BOOK NOW; the advance-notice copy equals
`MIN_ADVANCE_DAYS`; staff form hidden by default; `openLogin` opens as customer.

**Build:** `node scripts/generate-deploy-runtime-env.js` → exit 0 (regenerated artifact
reverted; not committed).
**Static validation:** `npm run audit:pre-deploy` → exit 0, all functions `[ok]`.

**Smoke (local static server, `http://localhost:8899`):**

| Surface | Desktop | Mobile 375×812 |
|---|---|---|
| `index.html` hero + CTA | ✔ "Check Price & Availability" on one line | ✔ fits, sticky bar "Check price" fits |
| Booking modal opens from discovery CTA | ✔ 6 tabs intact, Step 01 renders | ✔ |
| Step 4 utilities | ✔ Optional labels + reassurance paragraph render | ✔ |
| Step 5 card gate + policy | ✔ "Save Your Card", new policy bullet renders | ✔ |
| `bergen-county-hub.html` | ✔ | ✔ nav pill "CHECK PRICE" |

Netlify functions are absent in the static smoke, so the Stripe element and ZIP lookup are
inert there by design. **A Netlify branch-preview run is still required before merge.**

---

## 7. Explicitly untouched

Stripe (SetupIntent, Payment Element, webhooks, saved methods) · `submit-booking` ·
`create-setup-intent` · `stripe-webhook` · payment ledger / settlement / PaymentAuthority ·
receipts · Postgres schema and every migration · Prisma · Blob `cd1-bookings` and its CAS ·
`bookingVersion` / `quoteVersion` / `ifSyncVersion` · Customer Portal (`my-garage.html`,
`assets/my-garage.js`) · Admin (`admin-ops.html`, `admin.html`, `admin-ops-jobs`) ·
Owner Studio · packages / add-ons / vehicle pricing / travel fee / taxes / discounts ·
ZIP & service-area logic · scheduling engine and `MIN_ADVANCE_DAYS` · `netlify.toml` ·
all environment variables · all booking, portal and payment links.

No migration was written. No database was contacted. No credential was read or written.
`repository\cardetail1-stage2b`'s uncommitted admin-authority work was left untouched.

---

## 8. Risk assessment

| Change | Risk | Why |
|---|---|---|
| Card/slot copy across 13 pages + generator | **LOW** | Text nodes only; 3 existing tests updated, 14 new tests pin the result. Legal posture moves toward the published terms, not away. |
| CTA relabel at cold-entry points | **LOW** | Same `onclick`, same handler, same flow. Behavioural risk is commercial, not technical: click-through should rise, and per-click intent may fall — measure. |
| ZIP button "BOOK NOW" → "CHECK ZIP" | **LOW** | Corrects a mislabel; the button only checked coverage. |
| Water/power relabel + reassurance | **LOW** | Field ids, options, payload keys and admin-notes rendering unchanged; verified not required for step advance. |
| `#login-staff` default hidden | **LOW** | `setLoginRole()` sets `display` explicitly on both branches, so the default is only the pre-script state. |
| Availability copy | **NONE** | Unchanged. Now test-pinned to the constant. |

Residual risk after merge: **LOW.** No change can alter a booking, a payment, a total, a
receipt or a schedule.

---

## 9. Deferred, with recommendations

**Phase 3 — pre-card lead (confirmed gap).** Steps 1–4 live entirely in client `ST` state;
`create-setup-intent` is the first durable write. Recommended shape: an **additive** `Lead`
model (nullable columns, no FK into `Booking`), written on leaving Step 4, never projected
into Admin's booking lists, never triggering Stripe, invoices or customer notifications.
Requires a migration — none is authorized against Production.

**Phase 4 — card timing.** Option B (request → admin approves → "your appointment is ready,
secure this slot" → card) is the highest-conversion option and is compatible with the current
SetupIntent design, but it moves the card off the submit path, which today is what guarantees
a payment method exists for cancellation/no-show enforcement. It needs its own analysis of
`confirmBookingTransition`, the ledger and webhook reconciliation before anything is built.
**Do not change the card authority model without explicit approval.**

**Phase 5 — analytics.** Infrastructure already exists and does **not** need replacing:
`assets/checkout-analytics.js` emits `checkout_opened` (→ GA `begin_checkout`),
`checkout_step_viewed`, `checkout_step_completed`, `checkout_step_back`,
`checkout_validation_error`, `checkout_idle_triggered`, `checkout_resumed` via
`Cardetail1Revenue.track` and `dataLayer`. Missing for a full drop-off funnel: landing view,
ZIP submitted, card step reached vs **card setup completed**, booking submitted, booking
approved, payment completed. Smallest safe addition: emit the missing events through the
existing `Cardetail1Revenue` channel — no new vendor, no PII, no address, no card data.

**Unrelated defect found, not fixed:** hub/city pages render a mojibake glyph in the sticky
call button (`📍ž Call` instead of `📞 Call`). Pre-existing at `efe2d8d`, present in the
generator family. Out of scope.

---

## 10. Production readiness verdict

### SHIPPED (copy repair) · READY FOR INDEPENDENT REVIEW (stats removal)

| Commit | What | State |
|---|---|---|
| `f91d833` | Trust-copy alignment | **merged via PR #193, live** |
| `02bf00e` | This report | merged via PR #193 |
| `f9e04ad` | Trust-stats band + fabricated counter removed | **pushed, not merged** |
| `8faeb82` + this revision | Report updates | pushed, not merged |

**Outstanding:**

1. Merge `f9e04ad` into `master` so the fabricated "Vehicles detailed" counter stops
   shipping. It is still live on production until then.
2. **Verify on the live origin what the local smoke could not:** the Stripe Payment Element
   mounting at Step 5, the ZIP/service-area lookup, and `create-setup-intent` — all three need
   Netlify functions and were inert in the static smoke. Use Stripe **test fixtures**, never a
   live customer card.

Risk of the outstanding change: LOW — a pure 1077-line deletion with no additions, full suite
unchanged against baseline. Nothing on this branch can alter a booking, payment, total,
receipt or schedule.
