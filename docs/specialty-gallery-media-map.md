# Specialty gallery media map

Baseline for this work: `origin/master` @ `137332b1afe4eeb2469cfba6e229cbd20e10c941`  
Reference booking UX: `117484ee1bca78cb9b64a3827be8bef747ddd0ea`

## Operator media audit (read-only)

Primary source audited: operator `pics/` folder (91 files).

| Category folder | Files | Notes |
|---|---:|---|
| boats videos | 3 MP4 | Selected for Boats gallery |
| RVs | 25 media | Verified B/A pairs identified by same unit + comparable framing |
| bikes (powersports) | 18 media | Verified Polaris B/A; Live Photo MOVs rejected |
| cars / new | 51 | Not specialty B/A sources |

## Verified Before/After pairs (`verified_pair`)

Pairs require the same subject, comparable framing, and a clear before vs after state.

### RV / Trailer

| Pair ID | Before source | After source | Evidence |
|---|---|---|---|
| `rockwood-front` | `pics/RVs/IMG_7668.jpeg` | `pics/RVs/IMG_7680.jpeg` | Same Rockwood Signature front; dust/spots → gloss |
| `wingamm-front` | `pics/RVs/IMG_8404.jpeg` | `pics/RVs/IMG_8407.jpeg` | Same Wingamm plate MCK-1987; bugs → clean nose |
| `wingamm-side` | `pics/RVs/IMG_8403.jpeg` | `pics/RVs/IMG_8408.jpeg` | Same Wingamm side; rain streaks → clean panels |
| `vienna-front` | repo `assets/before-after/vienna-rv-front-*` | same | Labeled repo pair |
| `vienna-roof` | repo `assets/before-after/vienna-rv-roof-*` | same | Labeled repo pair |

Derivatives: `assets/images/specialty/rv/{pair}-{before,after}-{480,768,1200}.jpg`

### Powersports

| Pair ID | Before source | After source | Evidence |
|---|---|---|---|
| `polaris-front` | `pics/bikes/IMG_8390.jpeg` | `pics/bikes/IMG_8394.jpeg` | Same blue Polaris Sportsman front; mud/dust → clean |
| `gator-interior` | repo `assets/before-after/gator-interior-*` | same | Labeled repo pair |

Derivatives: `assets/images/specialty/powersports/{pair}-{before,after}-{480,768,1200}.jpg`

### Rejected / not published as B/A

- Jayco Eagle “Dolly” stills (`IMG_7463`–`IMG_7473`) → after-only; no matching dirty before
- Gator exterior/interior stills (`IMG_7481`–`IMG_7493`) → after-only portfolio shots
- Momentum G-Class stills (`IMG_6538` / `IMG_6555`) → after-only
- Nature/corrupt HEIC frames (`IMG_5305`–`IMG_5333`) → unusable
- Live Photo MOV clips under bikes/ → unusable for compare gallery
- Unlabeled motorcycle HEIC rolls without clear dirty/clean pair → insufficient

## Boats videos selected

| ID | Source | Optimized public path | Poster |
|---|---|---|---|
| vkpq0511 | pics/boats videos/VKPQ0511.MP4 | assets/videos/specialty/boats/vkpq0511.mp4 | …/vkpq0511-poster.jpg |
| rwaj3347 | pics/boats videos/RWAJ3347.MP4 | assets/videos/specialty/boats/rwaj3347.mp4 | …/rwaj3347-poster.jpg |
| xats4703 | pics/boats videos/XATS4703.MP4 | assets/videos/specialty/boats/xats4703.mp4 | …/xats4703-poster.jpg |

## Notes

- Media selection is deterministic (explicit markup; no shuffle).
- Original operator files were not modified.
- Public pages do not embed Windows absolute paths.
