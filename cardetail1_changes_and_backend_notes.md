# Cardetail1 — Functional Optimization Notes

## What changed

1. Booking submit no longer treats `localStorage` as a real backend.
   - If `BACKEND_URL` is configured, the form sends JSON to that endpoint.
   - If `BACKEND_URL` is blank, the form prepares the booking text and shows Text Request, Email Request, and Copy Request actions.
   - Local storage remains only as a browser-side operator preview, not as the source of truth.

2. Automotive packages were simplified to four core offers:
   - Maintenance Pack — from $175, 1.5–2 labor hours
   - Interior Complete — from $225, 2.5–4 labor hours
   - Premium Detail — from $285, 3–4 labor hours
   - One-Step Correction + Interior — from $450, 6–9 labor hours

3. Commercial/fleet was simplified:
   - Commercial Van / Sprinter — from $225
   - Box Truck / Work Truck — from $350
   - Fleet Maintenance — quote required
   - Semis, buses, trailers, cargo restoration, grease/oil/chemical contamination and heavy commercial jobs are quote-only.

4. Vehicle condition review was added:
   - Light / maintained
   - Average daily use
   - Heavy dirt or stains
   - Pet hair
   - Smoke or odor
   - Mold / biohazard
   - Construction dust or heavy contamination

   Risk conditions trigger manual review language in the payload.

5. Performance cleanup:
   - Removed embedded base64 images from the HTML.
   - Replaced image-heavy branding with text branding.
   - Reduced file weight from roughly 1.1 MB to roughly 228 KB.

## To make automatic booking fully production-ready

Replace this line:

```js
const BACKEND_URL = '';
```

with a real endpoint, for example:

```js
const BACKEND_URL = 'https://formspree.io/f/YOUR_FORM_ID';
```

or use a Make/Zapier webhook, Supabase Edge Function, Firebase Function, Vercel API route, or Google Apps Script endpoint.

## Important warning

A static HTML file cannot silently send SMS or email by itself. Without a backend endpoint, the browser can only open SMS/email/copy actions for the customer. That is why the fallback says "Request Prepared" instead of pretending the appointment was received.
