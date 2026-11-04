# Booking / mobile UX evidence

Captured 2026-11-03 against local static servers: `before` = `origin/master`
(06e307b), `after` = this branch. Netlify Functions were not running, so no
booking request was submitted and nothing reached production.

| Region | Before | After |
| --- | --- | --- |
| Info step, Cars/SUVs (two stacked bottom bars) | `info-step-cars-before-375.jpg` | `info-step-cars-after-375.jpg` |
| Package step, Cars/SUVs | `package-step-cars-before-375.jpg` | covered by the same rule |
| Package step, Ceramic | `package-step-ceramic-before-375.jpg` | `package-step-ceramic-after-375.jpg` |
| First visit, consent banner, 375x667 | `consent-first-visit-before-375x667.jpg` | `consent-first-visit-after-375x667.jpg` |
| First visit, consent banner, 320x568 | `consent-first-visit-before-320x568.jpg` | `consent-first-visit-after-320x568.jpg` |

First-visit measurements (share of viewport covered by banner + sticky CTA;
whether the hero ZIP field / "Check Price & Availability" button is uncovered):

| Viewport | Before | After |
| --- | --- | --- |
| 320x568 | 49%, field no, button no | 35%, field no, button no (sticky "Check price" visible) |
| 360x640 | 38%, field yes, button no | 29%, field yes, button yes |
| 375x667 | 36%, field yes, button no | 28%, field yes, button yes |
| 390x844 | 29%, yes, yes | 22%, yes, yes |
| 430x932 | 26%, yes, yes | 20%, yes, yes |
| 768x1024 | 10%, yes, yes | 10%, yes, yes (unchanged) |
