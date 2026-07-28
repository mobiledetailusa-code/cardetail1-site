# Billing decision model — Customer Lifecycle Stage

## Four distinct models (do not conflate)

| Model | What customer pays | What they get | Stripe in this stage |
|-------|--------------------|---------------|----------------------|
| **Membership access fee** | Periodic fee (proposed $9.99/mo) | Priority / early access benefits | **Config only** — no Product/Price/Subscription |
| **Service subscription** | Recurring fee for an included detailing entitlement | Discounted/included service packs | Existing code path; **hard-denied** when flag off or production |
| **Prepaid bundle** | Upfront for N future services | Entitlement balance | Not implemented |
| **Maintenance pricing** | Per-service price tier | Lower labor assumption after recent completed detail | Eligibility engine only; no auto-grant from membership |

## Hard rules

1. Active membership **must not** automatically grant maintenance pricing.
2. Customer Portal **never** submits authoritative prices.
3. No live recurring billing in production in this stage.
4. `PUBLIC_CONTENT_SOURCE` remains `legacy`.
5. Owner Studio Customer Lifecycle module is **draft-only** (no publish).

## Initial staging proposal

```json
{
  "planType": "priority_membership",
  "billingModel": "access_fee",
  "interval": "month",
  "priceCents": 999,
  "currency": "USD",
  "includedDetailingCount": 0,
  "automaticMaintenancePricing": false,
  "priorityScheduling": true,
  "earlyAccess": true,
  "cancellationWaitlistPriority": true,
  "guaranteedSameDay": false
}
```
