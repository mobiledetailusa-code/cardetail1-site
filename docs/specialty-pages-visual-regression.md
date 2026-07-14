# Specialty Pages Visual Regression

Date: 2026-07-14  
Baseline master: `9bcc5963ad88505510b56880451d26263957b865`  
Branch: `fix/specialty-pages-visual-regression`

## Production defects reproduced

On https://cardetail1.com/boats-detailing at desktop width ~1905px:

| Item | Observation |
|------|-------------|
| Intrusive gallery image | `#boat-gallery img` → `assets/media/boats/gallery/yacht-cruise.jpg` |
| Natural size | **301×168** |
| Rendered size | **~1078×800** (severe upscale) |
| Package cards | Repeated dramatic yacht/marine webp art; large empty vertical gaps |
| Structure | Inconsistent with RV/Powersports; gold-accent boats CSS diverged from shared navy/blue brand |
| Video bloat | Six loosely labeled video cards after the upscaled yacht |

RV and Powersports suffered from divergent templates (different CSS tokens, RV `object-fit: contain` sparse cards, dense powersports 5-column gallery) rather than a single specialty system.

## Root cause

**Primary:** Commit `2be7a3b` (*fix: repair Garage Plan submit and refresh specialty page media*) introduced `yacht-cruise.jpg` and a “Luxury Motor Yacht” gallery block into `boats-detailing.html`. The asset is a low-resolution lifestyle yacht photo presented as “recent work,” then stretched by CSS (`width:100%` / `aspect-ratio:16/10` / `object-fit:cover`) into a large mid-page distraction.

**Contributing:** Specialty pages never shared one category layout CSS. PR #99 / My Garage surface sync (`sync-public-surface.mjs`) correctly maintained footers/BTT but did not cause the yacht; it left divergent page-local styles in place. After Production cutover to `9bcc596`, the boats yacht regression remained live.

Classification: **D** unbounded/upscaled image dimensions + **A/B**-style template drift (inconsistent specialty HTML/CSS), not a Stripe/ZIP/price change.

## Repair actions

1. Delete tracked `assets/media/boats/gallery/yacht-cruise.jpg`.
2. Remove `#boat-gallery` lifestyle yacht section from Boats markup.
3. Introduce shared `assets/specialty-category.css` and rebuild Boats / RV / Powersports on one structure: header → hero → trust → packages → pricing → included → process → proof → FAQ → CTA → footer.
4. Cap Boats proof to three real on-site videos with constrained frames; trim RV/Powersports galleries to legitimate category media only.
5. Preserve package IDs and listed “From $…” prices; keep `data-booking-category` preselection and specialty booking bridge.
6. Keep SEO uniqueness (titles, descriptions, canonicals, Service schema).

## Sync notes

`scripts/sync-public-surface.mjs` continues to inject shared footer/BTT/public-surface.css only. Specialty category content is page-owned and must not be overwritten by homepage fragments. Idempotent sync verified under tests.
