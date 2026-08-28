# Cardetail1 — Portal UI Prototype

**Design-only prototype.** No API calls, no database changes, no deploy to production.

## What's inside

| Page | File | Description |
|------|------|-------------|
| Hub | `index.html` | Links to all three portal concepts |
| Admin Day View | `admin.html` | Calendar + job cards + management drawer |
| Technician | `technician.html` | Field tech mobile dashboard |
| Customer (My Garage) | `customer.html` | Customer view — **service total only** |

## Key design rules

### Customer portal
- Shows **contracted service total** (`serviceTotal`) only
- Does **not** show travel fee, admin fee split, or internal pricing breakdown
- Balance due button appears only when `amountDue > 0` (same as production logic)

### Admin portal
Drawer simulates existing `admin-ops.html` functions:
- Confirm / Decline appointment
- Reschedule (date + time window)
- Change package
- Assign technician
- Record cash payment / send pay link
- Generate customer portal link

All actions show a toast — no backend.

### Technician portal
- Week calendar filtered to assigned jobs
- En route → Arrived → Complete status flow
- Map embed per job address

## Preview locally

```bash
# From repo root
npx serve prototype
# Open http://localhost:3000
```

Or open `prototype/index.html` directly in a browser.

## Mock data

Edit `mock-data.js` to change jobs, dates, customers, and packages. Anchor date is **2026-08-28** (Friday).

## Production files (unchanged)

This prototype does **not** modify:
- `admin-ops.html`
- `technician.html`
- `my-garage.html`
- Any Netlify functions or database

## Next steps (when ready for production)

1. Port `shared.css` calendar + card components into existing portals
2. Wire admin drawer actions to existing `admin-ops-jobs` API
3. Add `Day View` tab to `admin-ops.html` alongside Jobs Board
4. Customer portal: reuse hero card + timeline in `assets/my-garage.js`
