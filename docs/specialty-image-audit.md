# Specialty image audit

**Source:** `C:\Users\magno\Desktop\dz project\pics` (read-only; originals not modified)  
**Date:** 2026-07-14  
**Hotfix branch:** `fix/specialty-images-booking-garageplan`

## Folder map

| Local folder | Mapped category | Usable stills |
|---|---|---|
| `boats videos/` | Boats / marine | 3 MP4s (no stills) — frames extracted for gallery |
| `RVs/` | RV / motorhome / trailer | JPEG stills |
| `bikes/` | Powersports (motorcycle / UTV) | JPEG + HEIC |
| `new/` | Mixed: RV service jobs, ATV, cars | Selective use |
| `cars/` | Cars only | Rejected for specialty pages |

## Selected (committed optimized derivatives)

### Boats
- `boat-mastercraft-side.jpg` — MasterCraft on trailer (frame from `RWAJ3347.MP4`) — gallery / section
- `boat-cockpit-detail.jpg` — cockpit/deck (frame from `VKPQ0511.MP4`) — gallery
- Existing on-site MP4s retained for video section (`RWAJ3347`, `VKPQ0511`, `XATS4703`, `IMG_8389`, `IMG_8390`)

### RV
- `momentum-gclass-side.jpeg` — Momentum fifth-wheel mid-service — hero/gallery
- `momentum-gclass-front.jpeg` — fifth-wheel front — gallery
- `rockwood-signature-front.jpeg` — travel trailer — gallery
- `jayco-eagle-front.jpeg` — Jayco Eagle front — gallery
- `wingamm-side.jpeg` — Wingamm motorhome — gallery

### Powersports
- `motorcycle-road-glide.jpg` — Harley touring (from HEIC) — package + gallery
- `motorcycle-touring-side.jpg` — motorcycle side — gallery
- `polaris-atv-front.jpeg` / `polaris-atv-angle.jpeg` — Polaris ATV — gallery
- `IMG_7482.jpeg` / `IMG_7492.jpeg` — John Deere UTV — package + gallery
- `utv-interior-detail.jpg` — UTV interior — gallery

## Rejected

| Asset / class | Why |
|---|---|
| `yacht-cruise.jpg` / `yacht-speed-cruise` | Intrusive lifestyle yacht stock — removed |
| Car JPEGs under `pics/cars` and wrongly stored in powersports gallery | Wrong category |
| HEIC-renamed “.jpeg” motorcycle blobs (`IMG_6736` etc. as tracked) | Corrupt / non-JPEG payload |
| Giant multi-MB unoptimized duplicates in gallery | Over size limit; replaced with ≤ ~500KB derivatives |
| Boat frame of RV scratch / non-boat surface | Category mismatch |
| Low-res dirty-cockpit “before” frames | Poor marketing quality |
| `IMG_8393.MP4` | Broken stub (135 bytes / missing moov) |
| Fleet-only car lineups | Out of specialty scope |

## Classification summary

- **Hero candidates:** Momentum RV service shot; MasterCraft boat; motorcycle Road Glide  
- **Section/gallery:** Jayco, Wingamm, Rockwood, UTV, ATV, boat cockpit  
- **Thumbnail only:** none retained as thumb-only  
- **Reject:** cars, lifestyle yachts, corrupt HEIC-as-JPEG, broken video stub
