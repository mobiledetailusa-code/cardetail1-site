# Cardetail1 — Code Map

Architecture reference for the Cardetail1 site. Use this as the "map" when auditing
or onboarding. It explains where things live, how pricing/checkout works, and how the
hub pages are structured.

> **Key architectural facts (important for audits):**
> 1. **There is no separate `style.css` for the main app.** The home page's CSS is
>    **inline** inside the `<style>` block of `index.html`. The only external
>    stylesheet is `assets/hub-styles.css`, loaded **only** by the hub pages.
> 2. **There is no `script.js` / `checkout.js`.** All booking/checkout logic is
>    **inline JavaScript** inside `index.html`.
> 3. **The price never "double-counts."** Total = `base + add-ons + travel fee`.
>    The reported "duplicate price" was a **UI display** issue (a separate
>    "Your Price" box shown next to the "Total"), now unified to show only the Total.

---

## 1. Repository layout

```text
/ (root)
├── index.html            ← Home + entire booking/checkout app, admin dashboard,
│                            customer portal, chat widget. CSS + JS are inline.
├── admin.html            ← Admin login
├── admin-ops.html        ← Admin operations console
├── customer.html         ← Customer portal
├── technician.html       ← Technician portal
├── authorize.html        ← Payment authorization page
├── bid.html              ← Technician job bidding
├── terms-conditions.html
│
├── Service landing pages:
│   ├── fleet-services.html
│   └── rv-detailing.html
│
├── HUB pages (region/state) — each loads assets/hub-styles.css:
│   ├── ny-metro-hub.html          (hero classes: hero--ny hub-ny)
│   ├── bergen-county-hub.html     (hero--nj hub-nj)
│   ├── essex-county-hub.html      (hero--nj hub-nj)
│   ├── hudson-county-hub.html     (hero--nj hub-nj)
│   ├── passaic-county-hub.html    (hero--nj hub-nj)
│   ├── connecticut-hub.html       (hero--ct hub-ct)
│   └── pennsylvania-hub.html      (hero--pa hub-pa)
│
├── CITY pages (do NOT load hub-styles.css):
│   ├── westchester-mobile-detailing.html
│   ├── trenton-mobile-detailing.html
│   ├── newark-mobile-detailing.html
│   └── template-city.html         ← template for new city pages
│
├── assets/
│   ├── hub-styles.css     ← ONLY external CSS (responsive hero backgrounds for hubs)
│   ├── hubs/              ← hero-XX-desktop.webp / hero-XX-mobile.webp + hub-*.jpg
│   ├── vehicles/premium/  ← per-vehicle artwork (sedan, suv, boat, rv, …)
│   └── cardetail1-logo.webp
│
├── netlify/functions/     ← Serverless backend (see §5)
├── tests/                 ← Node test suite (`npm test` → node --test tests/*.test.js)
├── netlify.toml           ← Netlify config + security headers (CSP/HSTS/etc.)
└── package.json
```

---

## 2. Front-end conventions

- **Multi-page static site.** Each page is standalone HTML with its own inline
  `<style>` and `<script>`. Shared visual identity is duplicated per page (CSS vars
  like `--blue`, `--bg0`, fonts Bebas Neue + DM Sans).
- **CSS load order on hubs:** inline `<style>` first, then
  `<link rel="stylesheet" href="assets/hub-styles.css">` near the end of `<head>`,
  so `hub-styles.css` rules win over inline `.hero` rules of equal specificity.
- **Backend base URL:** the front-end calls Netlify Functions at `/.netlify/functions/*`
  (referenced via a `BACKEND_BASE` constant in the inline scripts).

---

## 3. Booking / checkout pricing logic (all inline in `index.html`)

### Flow (6 steps)
1. **Category** (cars / boats / rvs / powersports / fleet) — gated by ZIP.
2. **Package** (per category).
3. **Vehicle** (tier/size, or length for boats/RVs, or unit count for fleet) →
   shows the vehicle card + running **Total** + add-ons.
4. **Info** (customer details).
5. **Terms / Secure booking** (Stripe card-on-file).
6. **Confirm**.

### Data model — `PRICING`
Each category has `tiers` (vehicle size) and `packages`. Base price = `tier[packageId]`.

Example (cars): a Honda Insight = `small` tier; `maint` package = **$175**.

```js
const PRICING = {
  cars: {
    tiers: {
      small: {label:'Small Car', icon:'🚗', desc:'Sedan · Coupe · Hatchback',
              maint:175, interior:225, full:300, premium:450},
      // suv2 / suv3 / truck …
    },
    packages: [
      {id:'maint', name:'Maintenance Detail', icon:'🪣', scope:'both',
       ext:[…], int:[…], feats:[…], miss:[…]},
      // interior / full / premium …
    ],
  },
  // boats / rvs / powersports / fleet …
};
```

Length-priced categories (boats, RVs) use `LENGTH_PRICING`.

### Price computation (single source of truth)

```js
// 1) Base = tier × package, scaled by premium-area multiplier
function applyRichPrice(base){ return base ? Math.round(base * richMultiplier) : 0; }
ST.basePrice = applyRichPrice(raw);

// 2) Running Total shown in the UI (#ah-total) = base + add-ons + travel fee
function updateTotal(){
  const fee = getTravelFeeAmount();
  const total = ST.basePrice + ST.addonTotal + fee;
  ST.zoneSurcharge = fee;
  document.getElementById('ah-total').textContent = total ? '$'+total : 'Estimate';
}

// 3) Per-vehicle subtotal (cart)
function buildCurrentVehicleItem(){
  const subtotal = ST.basePrice + ST.addonTotal;  // travel fee added once at booking level
  return { …, basePrice: ST.basePrice, addonTotal: ST.addonTotal, subtotal };
}

// 4) Whole-booking total (drives the Stripe deposit %)
function bookingTotalCents(){
  const base = vehicles.reduce((s,v)=>s+(v.subtotal||0),0);
  const fee  = getTravelFeeAmount();
  return Math.round((base + fee) * 100);
}
```

`travelFee` comes from the ZIP/zone resolution (`getTravelFeeAmount()` returns
`ST.travelFee || 0`). The server (`netlify/functions/submit-booking.js`) recomputes
the total server-side so the client cannot inflate it.

### The "duplicate price" — cause & fix
- **Cause (display only):** Step 3's vehicle card had a `vc-price` box labeled
  **"Your Price"** showing `ST.basePrice` (e.g. `$175`), while the add-on header
  showed the **"Total"** `#ah-total` (e.g. `$200` = base + add-on/fee). Two numbers
  for effectively the same thing → confusing.
- **Fix:** removed the `vc-price` box and the static tier labels (`vc-tier-lbl`,
  `vc-badge`) from the card; the **Total (`#ah-total`)** is now the only price shown.
  Removed the leftover `vc-price` DOM write in `setBasePrice()` and replaced
  removed-element assignments with a null-safe `setVcName()` helper.

---

## 4. Hub page structure (e.g. `pennsylvania-hub.html`)

All hubs share the same skeleton:

```text
<head>: meta/SEO + JSON-LD + inline <style> + <link href="assets/hub-styles.css">
<nav>
<section class="hero hero--XX hub-XX">      ← region hero with state artwork
  <div class="hero-bg-desktop"></div>        ← desktop image layer  (CSS bg-image)
  <div class="hero-bg-mobile"></div>         ← mobile image layer   (CSS bg-image)
  <div> logo · hero-badge · <h1> · hero-sub · hero-proof </div>
<section id="zip-section">                    ← ZIP gate (NOT inside .hero)
<section class="hub-radius-section">          ← mobile service radius
<section> location carousel · before/after · visual proof
<section> services · how it works · trust · reviews · CTA
<footer> + login modals (admin / customer)
```

The state class (`hub-ny`, `hub-nj`, `hub-ct`, `hub-pa`) selects which background
image is loaded. See §6 for the CSS.

---

## 5. Backend — Netlify Functions (`netlify/functions/`)

Shared helper: **`_security.js`** (CORS, timing-safe compare `safeEq`, `requireAdmin`,
IP `rateLimit`, input cleaners `cleanText/cleanEmail/cleanBookingId`, `normalizePhone`,
`phonesMatchExact`, `clampNumber`, `safeHttpUrl`, secure JSON responses).

| Function | Purpose |
|----------|---------|
| `stripe-config.js` | Returns Stripe **publishable** key to the client |
| `submit-booking.js` | Creates a booking; **recomputes total server-side** |
| `create-setup-intent.js` | Stripe SetupIntent (card-on-file); requires phone proof |
| `booking-card-status.js` | Polls whether the card was saved; requires phone proof |
| `create-payment-intent.js` | Stripe PaymentIntent; requires phone proof |
| `capture-payment.js` | Captures a PaymentIntent (**admin-only**) |
| `create-payment.js` / `create-payment-link.js` | Payment / Stripe payment link (admin-only) |
| `submit-authorization.js` | Processes signed payment authorization |
| `stripe-webhook.js` | Stripe webhook receiver (signature-verified) |
| `lookup-booking.js` | Customer booking lookup (generic errors, rate-limited) |
| `list-bookings.js` | Admin booking list (admin-only) |
| `update-booking.js` | Edit booking (admin-only; `payLink` validated to Stripe HTTPS) |
| `tag-booking.js` | Tag/label a booking (admin-only) |
| `request-cancellation.js` | Customer cancellation request (exact phone match) |
| `submit-customer-action.js` | Customer-initiated reschedule/address change |
| `customer-bookings.js` | Customer portal booking data |
| `customer-subscription-checkout.js` / `subscriptions-ops.js` | Subscription checkout / ops |
| `submit-inquiry.js` | Contact/inquiry form (rate-limited, sanitized) |
| `submit-review.js` | Customer review submission |
| `ai-chat.js` | AI chat assistant (rate-limited) |
| `admin-auth.js` | Admin password validation (timing-safe, rate-limited) |
| `admin-ops-jobs.js` / `ops-settings.js` | Admin operations: jobs + settings |
| `auction.js` / `tech-auctions.js` | Technician job auctions |
| `techs.js` / `tech-accounts.js` / `tech-auth.js` / `tech-profile.js` | Technician roster, accounts, auth, profile |
| `tech-jobs.js` / `tech-assignment.js` / `tech-complete-job.js` | Technician job assignment & completion |
| `tech-job-photos.js` / `job-photo-image.js` | Before/after job photos |
| `recent-work.js` / `recent-work-admin.js` / `recent-work-upload.js` / `recent-work-image.js` | Recent-work gallery (public read, admin manage/upload) |
| `upload.ts` / `upload.mts` | Generic upload handlers |

Persistence uses **Netlify Blobs** (`@netlify/blobs`). Security headers
(CSP, HSTS, Permissions-Policy) are configured in `netlify.toml`.

---

## 6. Hub hero CSS (`assets/hub-styles.css`)

Responsive hero backgrounds for the hub pages (home page is unaffected — it does not
load this file).

```css
.hero { position: relative; overflow: hidden; min-height: 60vh; }

.hero-bg-desktop, .hero-bg-mobile {
  position: absolute; inset: 0; z-index: 0;
  background-size: cover; background-position: center center;
  background-repeat: no-repeat; background-attachment: scroll;
  pointer-events: none;
  filter: brightness(1.1) contrast(1.05);   /* subtle lift, no heavy blur */
}
.hero-bg-desktop::after, .hero-bg-mobile::after {
  content:''; position:absolute; inset:0;
  background: linear-gradient(rgba(0,0,0,.4), rgba(0,0,0,.4));  /* legibility scrim */
}
.hero-bg-mobile { display: none; }
.hero > *:not(.hero-bg-desktop):not(.hero-bg-mobile) { position: relative; z-index: 1; }

/* keep white hero copy readable over artwork */
.hero h1, .hero .hero-sub, .hero .hero-badge, .hero .hero-year-round {
  text-shadow: 1px 1px 3px rgba(0,0,0,.8);
}

@media (max-width: 768px) {
  .hero { min-height: 40vh; }
  .hero-bg-desktop { display: none; }
  .hero-bg-mobile {
    display: block;
    background-size: contain;          /* show whole state artwork, no crop/zoom */
    background-position: top center;
    background-attachment: scroll;
  }
}

/* per-state artwork */
.hub-nj .hero-bg-desktop, .hero--nj .hero-bg-desktop { background-image:url('hubs/hero-nj-desktop.webp'); }
.hub-nj .hero-bg-mobile,  .hero--nj .hero-bg-mobile  { background-image:url('hubs/hero-nj-mobile.webp'); }
.hub-ny .hero-bg-desktop, .hero--ny .hero-bg-desktop { background-image:url('hubs/hero-ny-desktop.webp'); }
.hub-ny .hero-bg-mobile,  .hero--ny .hero-bg-mobile  { background-image:url('hubs/hero-ny-mobile.webp'); }
.hub-ct .hero-bg-desktop, .hero--ct .hero-bg-desktop { background-image:url('hubs/hero-ct-desktop.webp'); }
.hub-ct .hero-bg-mobile,  .hero--ct .hero-bg-mobile  { background-image:url('hubs/hero-ct-mobile.webp'); }
.hub-pa .hero-bg-desktop, .hero--pa .hero-bg-desktop { background-image:url('hubs/hero-pa-desktop.webp'); }
.hub-pa .hero-bg-mobile,  .hero--pa .hero-bg-mobile  { background-image:url('hubs/hero-pa-mobile.webp'); }
```

---

## 7. Tests

`npm test` runs `node --test tests/*.test.js`. Coverage includes booking flow,
booking price, travel fee, card-on-file hardening, admin security, dispatch/ops,
customer catalog, subscription checkout, ZIP hub routing, and tech job photos.
