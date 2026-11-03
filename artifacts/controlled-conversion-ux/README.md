# Controlled conversion UX evidence

Captured 2026-11-02. `before` images use the published production site; `after`
images use the isolated branch served locally. No booking request was submitted.

| Region | Before | After |
| --- | --- | --- |
| RV vehicle fields | `rv-vehicle-before-390.png` | `rv-vehicle-after-{320,375,390,430}.png` |
| Ceramic checkout rows | `ceramic-summary-before-{320,390}.png` | `ceramic-summary-after-{320,390}.png` |
| Mobile sticky CTA / chat clearance | `sticky-chat-before-390.png` | `sticky-chat-after-{320,375,390,430}.png` |

The Ceramic images use the exact checkout row markup and the stylesheet loaded
from each target, isolated in a small fixture so label/value wrapping is easy to
compare without creating a booking or payment state.
