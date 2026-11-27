# Review solicitation activation checklist

Nothing in this checklist has been done. Each step needs the owner's explicit authorization. Steps 1–3 are legal and compliance decisions; counsel review is recommended. This document is not legal advice.

## 1. Twilio A2P 10DLC campaign (Twilio console, owner)

- [ ] Open the registered campaign for the Cardetail1 Messaging Service. The brand is Detailing Zone L.L.C., DBA Cardetail1.
- [ ] Record its use case, description, message flow (opt-in description) and sample messages. None of these are in the repository today.
- [ ] Confirm that the campaign covers post-service review requests. If the use case is limited to account or customer-care notifications and the samples contain no review request, submit a campaign update:
  - **Description** addition: "After a completed service, one request to leave a review of the service, and at most one reminder."
  - **Sample message:** `Cardetail1: Thanks again for choosing us. If you have a moment, we would appreciate an honest Google review: https://g.page/r/CTJwfJerrQeCEAI/review Reply STOP or HELP`
  - **Message flow:** must reference the updated checkbox text from step 2.
- [ ] Wait for campaign approval. Keep the approval record (date and campaign SID) with the activation ticket.

## 2. Consent wording (booking checkbox), new version

Current text (`cd1-txn-sms-v3-2026-08-28`): "I agree to receive text messages from Cardetail1 about my booking request, appointment updates, reminders, and service-related notifications. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of booking."

Proposed text, as a **new version** (for example `cd1-txn-sms-v4-<date>`), with the change in bold:

> I agree to receive text messages from Cardetail1 about my booking request, appointment updates, reminders, service-related notifications, **and, after my service, a request to review it (at most one reminder)**. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of booking.

- [ ] Owner or counsel approves the wording.
- [ ] Implement it as a code change in its own PR. It must not be part of #432. That PR:
  - updates `BOOKING_CONSENT_TEXT_VERSION` / `BOOKING_CONSENT_COPY` in `netlify/lib/sms-program.js`;
  - adds the new version to `bookingConsentTextVersionRecognized` while keeping v3 and v2 valid for transactional messages;
  - updates the checkbox markup and `data-consent-version` on every booking page (the hub pages and `index.html`);
  - updates the consent tests.
- [ ] **Do not reclassify v3 or v2.** Bookings made under them stay transactional-only. They receive the receipt but no review ask, unless counsel concludes otherwise in writing.

## 3. Terms & Conditions, SMS program section

- [ ] Add to "Message types": "after a completed service, one request to review the service and at most one reminder".
- [ ] Reconcile the sentence "The program does not include promotional or marketing messages". Either confirm with counsel that a neutral, incentive-free review request is not promotional, or reword it.
- [ ] Keep "Consent is not a condition of booking, purchase, or service" and the STOP/HELP language.
- [ ] Publish the Terms only together with, or before, the new consent version. Never after.

## 4. Policy checks (owner)

- [ ] **Neutral wording:** no incentive, discount or gift, and no request for a positive or 5-star rating. The shipped template already meets this.
- [ ] **No selective solicitation:** every eligible completed job is asked the same way, whatever its issue, dispute or satisfaction state. Removing the old exclusion of reported issues is part of #432.
- [ ] **Quiet hours:** 10:00–18:00 America/New_York, Monday–Saturday, are enforced in code. Confirm this covers customers outside NY/NJ/CT/PA too.
- [ ] **STOP / opt-out:** confirm in the Twilio console that the Messaging Service's Advanced Opt-Out is configured. The code also enforces suppression at dispatch.

## 5. Feature activation sequence (production configuration, owner only)

Prerequisites:
- PR #432 merged;
- the consent-version PR (step 2) merged and released;
- Terms published;
- campaign approved.

1. Release #432 through the documented CLI-bundled production procedure; no prebuilt function zips. All switches are still unset.
2. Smoke check: Admin → More → Completed / Review loads, and the status line shows "Blocked until resolved: a2p_campaign_not_verified, review_consent_not_established". Completion receipts arrive without the review link.
3. Set `REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED=true` (production scope).
4. Set `REVIEW_SOLICITATION_CONSENT_VERSIONS=<new version from step 2>`. List only the approved new version, never v3 or v2.
5. Redeploy so that functions pick up the variables. From now on, only completions of bookings made under the new consent text get the initial ask (receipt link or tech-path ask).
6. Optional, after a quiet observation period:
   - `REVIEW_MANUAL_RESEND_ENABLED=true` (shows the Resend button);
   - later, `REVIEW_REMINDER_AUTOMATION_ENABLED=true`.
   - Each needs its own redeploy. Only completions after this point get a reminder (6 h live-completion rule).
7. Watch the first week in the Completed / Review table: Delivered vs Failed, any Opted out, and STOP counts in the Twilio console.

## Rollback

There are three levels; details are in `docs/review-request-lifecycle.md` § Rollback.

1. **Feature deactivation (preferred):** unset the switch(es) and redeploy the same build. To stop every review ask at once, unset `REVIEW_SOLICITATION_CONSENT_VERSIONS`. Receipts continue, without the link.
2. **Corrective roll-forward:** fix, pass CI, and release with the switches unset.
3. **Full deployment rollback (last resort):** a build from before #432 brings back:
   - review asks without the consent gate;
   - possible duplicate asks;
   - Google links in every receipt, Stop and received bookings included;
   - no review observability in Admin.

   Pending reminder rows still fail without sending. The owner must accept these regressions explicitly.
