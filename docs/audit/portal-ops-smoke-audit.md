# Portal ops smoke audit — Admin + Customer

Generated for branch `fix/final-production-readiness` after Jobber-style cleanup + Prisma dual-write.

## Verdict

**READY FOR REAL OPS ON PREVIEW** when Netlify has Stripe test keys + (optional) `DATABASE_URL`.  
Do **not** treat `cardetail1.com` production as verified until this branch is merged.

## Smoke suite

```bash
node --test tests/portal-ops-smoke.test.js tests/booking-prisma-mirror.test.js tests/portal-payment-access-hardening.test.js
npm run audit:pre-deploy
```

## Cleanup shipped in this pass

| Item | Fix |
|------|-----|
| Address applied before admin approve | Submit stores `requestedAddress` only |
| Paid address/reschedule | Always `pendingApproval: true` |
| Requests “Confirm pay link” | Renamed **Copy pay link if present**; hint → Generate Stripe in drawer |
| Manual pay link looked like Checkout | Separate manual reference field; notes-only |
| Invoice close | Admin **PAID / CLOSED**; Generate blocked |

## Safety contracts (must hold)

1. Checkout finalize remains Blob `setJSON` — drafts never mirrored to Prisma.
2. Prisma dual-write is fail-open; missing `DATABASE_URL` = Blobs-only.
3. `set_payment_link` never arms Pay Balance.
4. Webhook `customer_balance` clears `payLink` and sets `payment_succeeded`.

## Env for real ops (preview)

| Env | Required |
|-----|----------|
| `STRIPE_SECRET_KEY` (test) | Yes — pay links |
| `STRIPE_WEBHOOK_SECRET` | Yes — settle invoice |
| `SITE_URL` | Yes — Checkout return URLs |
| Admin auth / Blobs | Yes |
| `DATABASE_URL` | Optional — Prisma mirror + read fallback |

## Manual retest checklist (preview only)

1. Finalize booking with card-on-file → appears in Admin + My Garage.
2. Generate Stripe link → customer pays → Admin shows **PAID / CLOSED** without manual click.
3. Generate link again → blocked.
4. After paid: Change Package disabled; Update Address submits request only (address unchanged until approve).
5. Enter in address field does not navigate to `?newAddress=`.
6. Approve address → address updates.
