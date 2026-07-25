# Owner Studio — Historical Booking Snapshot Contract (Stage 1)

## Invariant

Changing a published package, price, add-on, or catalog release **must never alter** an existing booking’s commercial terms.

Existing booking price and ledger authority remain unchanged. The CMS must not recalculate historical bookings after publication.

## Relationship to current system

Today’s authority for money on a booking is the booking aggregate:

- `ledger.approvedCents` / `settledCents` / entries  
- `quote` / quote version  
- per-vehicle package and add-on selections stored on the aggregate  

Stage 1 **defines** the forward-looking `bookingCatalogSnapshot` contract and compatibility helpers. It does **not** rewrite existing booking aggregates or Postgres quote/ledger rows.

## Immutable snapshot shape

Attached at booking confirmation / quote approval time (future wiring). Minimum fields:

```json
{
  "schemaVersion": 1,
  "siteId": "detailing-zone",
  "packageId": "pkg_maintenance_detail",
  "packageRevisionId": "prev_…",
  "publishedCatalogReleaseId": "rel_…",
  "packageName": "Maintenance Detail",
  "packageShortLabel": "Maintenance",
  "vehicleClassId": "vc_sedan",
  "vehicleClassLabel": "Small Car",
  "basePriceCents": 17500,
  "currency": "usd",
  "selectedAddOns": [
    {
      "addOnId": "addon_pet_hair",
      "addOnRevisionId": "arev_…",
      "name": "Pet Hair Removal",
      "unitPriceCents": 9500,
      "quantity": 1,
      "lineTotalCents": 9500
    }
  ],
  "discounts": [],
  "adjustments": [],
  "approvedTotalCents": 27000,
  "tax": {
    "taxable": false,
    "taxCents": 0,
    "metadata": {}
  },
  "payment": {
    "currency": "usd",
    "notes": "presentation metadata only; ledger remains authority"
  },
  "createdAt": "2026-07-25T00:00:00.000Z"
}
```

### Field requirements

| Field | Rule |
|-------|------|
| `packageId` | Stable ID, not display name |
| `packageRevisionId` | Immutable revision used at booking time |
| `publishedCatalogReleaseId` | Release pointer at booking time |
| Names/labels | Copied strings at booking time |
| Money | Integer cents + explicit currency |
| `approvedTotalCents` | Must match booking ledger/quote authority at snapshot creation |
| `createdAt` | ISO timestamp |

## Compatibility with legacy bookings

Bookings created before Owner Studio cutover may omit `bookingCatalogSnapshot`. Readers must:

1. Prefer `bookingCatalogSnapshot` when present and schema-valid.  
2. Otherwise fall back to existing aggregate fields (`package`, `packageId`/`pkgId`, ledger cents, add-on ids) **without** re-quoting from the live catalog.  
3. Never call published-catalog price calculation to “refresh” a historical booking.

## CMS obligations

- Publish/rollback update only the **current release pointer** and public snapshots.  
- Soft-deactivate catalog rows; never hard-delete packages/add-ons referenced by snapshots or legacy bookings.  
- Media hard-delete forbidden while referenced.  
- No Stage 1 migration rewrites `BookingRecord.payload`, `Quote`, or `LedgerEntry`.

## Future write path (not activated in Stage 1)

When booking confirmation runs with `PUBLIC_CONTENT_SOURCE=owner-studio`:

1. Resolve current `PublishedCatalogRelease`.  
2. Price from that release only.  
3. Persist `bookingCatalogSnapshot` alongside quote/ledger.  
4. Payment prep reads snapshot + ledger, not live draft.

## Test obligations

- Snapshot immutability vs catalog publish  
- Legacy booking regression (ledger unchanged)  
- No garage `CustomerVehicle` reintroduction  
- Payment/booking suites still green with flags off  
