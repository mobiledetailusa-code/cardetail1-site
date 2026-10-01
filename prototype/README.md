# Cardetail1 — Portal UI Prototype

**Design prototype** with optional **live data on Netlify Preview** when authenticated.

## Recommended path: Customer PWA

Instead of a native App Store rewrite, the **installable web app** wraps My Garage:

| | |
|--|--|
| **URL** | `/portal-app` → `/prototype/pwa/` |
| **What it is** | App shell (tabs + install + offline chrome) over the same customer flows |
| **What it is not** | Native iOS/Android rewrite, monthly store reviews, new Stripe/Twilio stack |
| **Data** | Mock only (same `mock-data.js`) — production APIs stay on My Garage |

Files: `prototype/pwa/` (`index.html`, `app.css`, `app.js`, `manifest.webmanifest`, `sw.js`).

## Quick links (Deploy Preview)

| Portal | URL |
|--------|-----|
| **📲 Customer PWA** | `/portal-app` or `/prototype/pwa/` |
| **📱 Mobile hub** | `/portal-prototype` |
| Customer UI | `/prototype/customer.html` |
| Technician | `/prototype/technician.html` |
| Admin | `/prototype/admin.html` |

Short URL: `/portal-prototype` → mobile hub · `/portal-app` → PWA prototype.

## Mock vs Live mode

| Mode | When | Data |
|------|------|------|
| **Mock** | No session, or `?mode=mock` | `mock-data.js` (fixed demo jobs) |
| **Live** | Netlify Preview + logged in | Real APIs (`admin-ops-jobs`, `tech-jobs`, `customer-portal-data`) |

### How to use Live mode on Preview

1. Open the deploy preview URL (not production)
2. Log in on the **same domain**:
   - Admin → `/admin` then open `/prototype/admin.html`
   - Technician → `/technician` then `/prototype/technician.html`
   - Customer → `/my-garage` then `/prototype/customer.html`
3. Banner turns **🟢 LIVE PREVIEW** when connected

Force modes: `?mode=mock` or `?mode=live`

## Local development

```bash
# Static mock only
npm run preview:prototype
# → http://localhost:3456/preview.html
# → http://localhost:3456/pwa/   (customer PWA prototype)

# Full Netlify dev (functions + live APIs)
npm run preview:prototype:live
# → http://localhost:8888/prototype/preview.html
# → http://localhost:8888/prototype/pwa/
```

## Key design rules

### Customer portal
- Shows **contracted service total only** — no travel/fee breakdown
- Live mode: pay/reschedule redirect to production My Garage actions

### Admin portal
- Drawer: confirm, decline, reschedule, assign tech, cash payment, customer links
- Live mode: real mutations via `admin-ops-jobs` + `tech-assignment`
- Package change in live → use Admin Ops Jobs Board

### Technician portal
- Live mode: `tech-jobs` GET/POST for status updates

## Next steps roadmap

### ✅ Done (this PR)
- [x] Visual prototype (3 portals + mobile hub)
- [x] Netlify Preview deploy + `/portal-prototype` shortcut
- [x] Mobile CSS (safe areas, tap targets, phone frame)
- [x] Live API layer on deploy preview when authenticated

### Phase 2 — Integrate into production portals
- [ ] Add **Day View** tab to `admin-ops.html` (reuse `shared.css` + calendar)
- [ ] Port hero card + timeline to `assets/my-garage.js`
- [ ] Upgrade `technician.html` dashboard layout (keep existing API calls)

### Phase 3 — Production cutover
- [ ] Remove mock-data fallback in production builds
- [ ] Feature flag: `?dayview=1` or settings toggle
- [ ] E2E tests for calendar + drawer mutations

### Phase 4 — Premium features
- [ ] Live tech GPS tracking on map
- [ ] Push notifications
- [ ] In-app chat FAB

### Phase 5 — Customer PWA (this folder)
- [x] Installable shell (`manifest` + service worker)
- [x] Bottom tabs: Home / Bookings / Garage / Account
- [x] Install / Add to Home Screen prompt (Chrome + iOS hint)
- [x] Offline chrome (shell cache only — no API caching)
- [ ] Wire live customer session (same as `customer.html` live mode)
- [ ] Optional Web Push after SMS consent path is stable

## Files

```
prototype/
├── preview.html          # Mobile entry (start here on phone)
├── preview-config.js     # Environment detection
├── preview-api.js        # Live API adapters
├── admin.html + admin.js
├── technician.html + technician.js
├── customer.html + customer.js
├── pwa/                  # Installable customer app prototype
│   ├── index.html
│   ├── app.css + app.js
│   ├── manifest.webmanifest
│   └── sw.js
├── shared.css, calendar.js, ui.js, mock-data.js
└── _redirects            # /prototype root → preview.html
```

## Production files (unchanged)

This prototype does **not** modify production portal logic — only adds `prototype/` folder and `/portal-prototype` redirect.
