# Specialty gallery media map

Baseline for this work: `origin/master` @ `fdae313e7071dd31c270f66809e0bac4da61da83`  
Reference booking UX: `117484ee1bca78cb9b64a3827be8bef747ddd0ea`

## Operator media audit (read-only)

Primary source audited: operator `pics/` folder (91 files).

| Category folder | Files | Notes |
|---|---:|---|
| boats videos | 3 MP4 | Selected for Boats gallery |
| RVs | 21 images | No Before/After labels or folders |
| bikes | 16 media | No Before/After labels; Live Photo MOVs rejected |
| cars / new | 51 | Not specialty B/A sources |

Additional Desktop media folders were scanned for labeled Before/After evidence; none contained `before`/`after` folder names or filenames.

## Verified Before/After pairs used in production assets

Only previously labeled repository pairs (`assets/before-after/*-before.jpg` / `*-after.jpg`) qualify as `verified_pair`.

### RV / Trailer (`verified_pair`)

1. `vienna-front` — Renegade Vienna front cap  
2. `vienna-roof` — Renegade Vienna roof / solar  

Derivatives: `assets/images/specialty/rv/vienna-*-{before,after}-{480,768,1200}.jpg`

### Powersports (`verified_pair`)

1. `gator-interior` — John Deere Gator XUV835M interior  

Derivatives: `assets/images/specialty/powersports/gator-interior-{before,after}-{480,768,1200}.jpg`

### Rejected from automatic pair publication

- All unlabeled consecutive iPhone rolls under RVs/ and bikes/ → `insufficient` evidence (not fabricated)
- Live Photo MOV clips under bikes/ → `unusable` for gallery video
- Car B/A pairs in `assets/before-after` → wrong specialty category

## Boats videos selected

| ID | Source (operator / repo) | Optimized public path | Poster |
|---|---|---|---|
| vkpq0511 | pics/boats videos/VKPQ0511.MP4 | assets/videos/specialty/boats/vkpq0511.mp4 | …/vkpq0511-poster.jpg |
| rwaj3347 | pics/boats videos/RWAJ3347.MP4 | assets/videos/specialty/boats/rwaj3347.mp4 | …/rwaj3347-poster.jpg |
| xats4703 | pics/boats videos/XATS4703.MP4 | assets/videos/specialty/boats/xats4703.mp4 | …/xats4703-poster.jpg |

Rejected: none beyond missing inventory (only 3 boat videos present). Duplicate IMG_* boat stills kept out of the video gallery (no image carousel).

## Notes

- Media selection is deterministic (explicit markup; no shuffle).
- Original operator files were not modified.
- Public pages do not embed Windows absolute paths.
