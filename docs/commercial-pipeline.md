# Commercial Pipeline

## Stages

1. Anonymous Visitor
2. Engaged Visitor
3. Lead Captured
4. Qualified Lead
5. Multi-Vehicle Opportunity
6. High-Intent Opportunity
7. Quote Required
8. Quote Sent
9. Booking Started
10. Booking Requested
11. Awaiting Confirmation
12. Confirmed
13. Completed
14. Maintenance Opportunity
15. Rebooking Opportunity
16. Lost

## Opportunity record

Each opportunity includes: `opportunity_id`, `household_id`, `lead_id`, segment, vehicle count band, asset categories, package/category selection, estimated value, source/campaign, booking step, intent/household/commercial priority scores, consent status, next action, assignment, lost reason, timestamps.

## Lost reasons (structured)

`price`, `distance`, `date_unavailable`, `no_response`, `payment_friction`, `service_unavailable`, `unsafe_access`, `selected_competitor`, `out_of_service_area`, `research_only`, `duplicate`, `cancelled`, `other`

## Admin visibility

Revenue Ops tab in `admin-ops.html` — priority queue, funnel counts, manual win/loss/contact actions. Customer identity visible only to authenticated admins.

## Manual sales queue

High-intent leads, multi-vehicle opportunities, payment-step abandonments, and maintenance due items surface in **Needs Attention Now**. Actions require deliberate admin clicks — no auto-send on dashboard load.
