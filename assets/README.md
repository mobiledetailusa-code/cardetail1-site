# Cardetail1 — Real Job Photo Guide

This folder holds all real customer job photos used in the "Real Results" section
of cardetail1.com. Read every rule below before adding any photo.

---

## Folder structure

```
assets/
└── results/
    ├── interior/          # Interior detail, steam cleaning, cabin restore
    ├── exterior/          # Exterior wash, clay bar, hand wash, tire shine
    ├── paint-enhancement/ # Paint correction, ceramic coating, swirl removal
    ├── premium/           # Full-service combo (interior + exterior + sealant)
    ├── rv-boat/           # Marine, RV, powersports, trailer, fleet
    └── logos/             # Brand logos only — not customer job photos
```

---

## Rules — read before uploading

### What qualifies as a real job photo
- Photos taken by you or your technician during or after an actual Cardetail1 job
- Photos taken at the real job site (customer's home, driveway, marina, etc.)
- Before/after pairs where BOTH the before AND the after were taken at the same job

### What is NOT allowed
- AI-generated images of vehicles (even if they look realistic)
- Stock photos from Unsplash, Shutterstock, Google, or any other stock source
- Photos from other detailing companies or other people's social media
- A single "after" photo labeled as "Before & After" (no before = no B&A label)
- Photos that make unfinished work look like completed work

### Privacy — protect the customer
- **Blur or crop out license plates** before uploading any exterior photo
- **Never include the customer's street address** in the photo or in the gallery entry
- Use a general area label only: "Bergen County, NJ" or "Fort Lee, NJ" — never "123 Main St"
- Do not include the customer's name anywhere in the image or the gallery entry
- If the customer's face or personal items are visible, blur or crop them

### Image quality and performance
- Minimum resolution: 800 × 600px (landscape)
- Maximum file size: **500 KB per image** (compress before upload)
- Format: JPEG (.jpg) preferred for photos; PNG only if transparency is needed
- Recommended tools: Squoosh (squoosh.app), TinyJPG, or ImageOptim
- File names: use lowercase, hyphens, no spaces — e.g. `interior-steam-clean-01.jpg`

---

## How to add a photo to the gallery

### Step 1 — Prepare the photo
1. Open the photo in any image editor
2. Blur or crop out license plates and faces
3. Crop out any visible street address (signs, mailboxes, etc.)
4. Compress to under 500 KB
5. Rename: `<short-description>-<sequence>.jpg` — e.g. `leather-restore-01.jpg`

### Step 2 — Place the file
Put the file in the correct subfolder:

| Service type | Folder |
|---|---|
| Interior clean, steam, leather, fabric | `assets/results/interior/` |
| Exterior wash, clay bar, decontamination | `assets/results/exterior/` |
| Paint correction, swirl removal, coating | `assets/results/paint-enhancement/` |
| Full detail combo (interior + exterior) | `assets/results/premium/` |
| Marine, RV, powersports, trailer | `assets/results/rv-boat/` |

### Step 3 — Update the gallery data in index.html

Find the `GALLERY_ITEMS` array in `index.html` (search for `GALLERY_ITEMS`).
Add a new entry following this template:

```javascript
{
  category: 'interior',                              // matches folder name
  title: 'Interior Deep Clean',                      // short display title
  service: 'Interior Detail',                        // package name as displayed
  img: 'assets/results/interior/leather-restore-01.jpg', // path from site root
  imgBefore: null,                                   // null if no before photo
  imgAfter: null,                                    // null if no after photo
  alt: 'Car interior after full steam cleaning and leather conditioning, Bergen County NJ',
  location: 'Bergen County, NJ',                     // general area only — never an address
},
```

**For before/after pairs** — only use this if you have BOTH photos from the same job:

```javascript
{
  category: 'exterior',
  title: 'Full Exterior Detail',
  service: 'Exterior Detail',
  img: null,                                         // leave null when using imgBefore/imgAfter
  imgBefore: 'assets/results/exterior/suv-before-01.jpg',
  imgAfter:  'assets/results/exterior/suv-after-01.jpg',
  alt: 'SUV exterior before and after full detail — clay bar and hand wash, Bergen County NJ',
  location: 'Ridgewood, NJ',
},
```

### Step 4 — Verify before committing
- Open the site locally and confirm the image loads without errors
- Confirm no license plate, address, or face is visible
- Confirm the card label is correct:
  - Both `imgBefore` AND `imgAfter` set → card shows **"Before & After"**
  - Only `img` set → card shows **"Recent Result"**
- Run: `git diff --stat` and confirm only `index.html` and the new image changed

---

## Do NOT do these things

| Never | Why |
|---|---|
| Use a stock photo | Misleads customers about real work quality |
| Use an AI-generated vehicle image | Not a real customer job |
| Label a single after photo as "Before & After" | Dishonest |
| Include a customer's name in the gallery | Privacy |
| Include a license plate in a photo | Privacy |
| Include a street address in a photo | Privacy |
| Upload uncompressed photos over 500 KB | Slows mobile loading |
| Add fake customer testimonials alongside the photo | Against site policy |

---

*Last updated: 2026-06-14*
