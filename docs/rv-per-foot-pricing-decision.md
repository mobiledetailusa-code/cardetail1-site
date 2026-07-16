# RV Per-Foot Pricing Decision

**Baseline:** `1aba446`  
**Reduction target:** ≥15% and ≤20% on rates; former 24-ft floor packages may show larger cuts at short lengths (documented).

## Final LENGTH_PRICING.rvs

| ID | perFt | min | Rate cut | Notes |
|----|-------|-----|----------|-------|
| maint | 8 | 129 | 20% | Floor ends ~16 ft |
| exterior | 13 | 199 | 18.75% | Floor ends ~15 ft |
| interior | 20 | 249 | 16.67% | Living-space min |
| premium | 31 | 449 | 22.5%* | *Override so 24-ft clears 15% vs old $899 floor |
| full | 44 | 699 | 18.5% | Complete care |
| correction | 42 | 649 | 19.2% | One-step exterior |
| correction_int | 50 | 799 | 19.4% | Correction + interior |

`defaultFt` for booking slider when no length passed: **20** (not 24).

## Hierarchy @20 / @24 / @40

| Length | maint | exterior | interior | premium | full | correction | correction_int |
|--------|-------|----------|----------|---------|------|------------|----------------|
| 20 | 160 | 260 | 400 | 620 | 880 | 840 | 1000 |
| 24 | 192 | 312 | 480 | 744 | 1056 | 1008 | 1200 |
| 40 | 320 | 520 | 800 | 1240 | 1760 | 1680 | 2000 |

Super Interior remains **$135**. Travel/tolls unchanged.
