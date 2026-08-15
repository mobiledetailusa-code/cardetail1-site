# `revenue-event` 429 — read-only investigation

**Status: INVESTIGATION ONLY. Nothing fixed. No function, limit or client touched.**

Severity: **P1.** The endpoint rejects **every** request, so the funnel analytics the
conversion work depends on has never been recorded.

> **Correction notice.** The first revision of this report named per-IP rate limiting under
> carrier NAT as the likely cause. That was wrong. It was a hypothesis that fitted the
> symptom and was published without testing the caller contract. The verified cause is an
> obsolete caller/helper contract — the request never reaches a rate-limit decision at all.
> CGNAT is retained below only as a generic future consideration.

---

## FACT — verified root cause: obsolete caller contract

The helper's current signature takes an **options object** and returns
`{ blocked, allowed, ... }`. There is no `ok` property.

`netlify/lib/public-rate-limit.js:351`
```js
async function enforcePublicRateLimit(event, {
  endpoint, action = '', cors = false, now = Date.now(), subject = '', ipScoped = true,
} = {}) {
  if (isOptionsRequest(event)) return { blocked: false, allowed: true, bypassed: true };
  const decision = await checkPublicRateLimit(event, { endpoint, action, now, subject, ipScoped });
  if (decision.allowed) return { blocked: false, ...decision };
  return { blocked: true, allowed: false, response: ..., retryAfterSec: ... };
}
```

`netlify/functions/revenue-event.js:20` still calls the **legacy positional form** and tests
a property that no longer exists:

```js
const rate = await enforcePublicRateLimit(event, 'revenue-event', 'track');
if (!rate.ok) { return { statusCode: 429, ... }; }
```

Two independent defects compound:

1. The string `'revenue-event'` is destructured as the options object, so `endpoint` is
   `undefined` and the third argument `'track'` is discarded. The bucket is never the
   intended `revenue-event:track`.
2. The return has no `ok`, so `rate.ok` is `undefined` and `!rate.ok` is **always true**.

**Every call takes the 429 path unconditionally, regardless of traffic, IP or window.**
This explains the observation that made no sense under a 120-per-window budget: the 429
arrived on the *first* event of a clean page load.

A correct caller for comparison — `netlify/functions/booking-availability.js:65`:

```js
const rate = await enforcePublicRateLimit(event, { endpoint: 'booking-availability', cors: true });
if (rate && rate.blocked) return rate.response || safeError(429, 'rate_limited');
```

### The same defect exists in a second function

`netlify/functions/revenue-resume-link.js:16`

```js
const rate = await enforcePublicRateLimit(event, 'revenue-resume-link', 'validate');
```

Same positional form, same `!rate.ok` test. These are the only two occurrences in
`netlify/functions/`. `revenue-resume-link` is a customer-facing recovery path, so this is
not analytics-only. **Not fixed here — out of scope for this branch.**

## FACT — reproduction

Two clean loads of `https://cardetail1.com`, days apart:

| Request | Result |
|---|---|
| `GET /.netlify/functions/recent-work` | 200 |
| `GET /.netlify/functions/booking-availability` | 200 |
| `POST /.netlify/functions/revenue-event` | **429** |

One analytics POST per page load. No duplicate calls: 1 HTML + 30 assets + 3 function calls.

## FACT — the configured limits are never consulted

`revenue-event:track` is configured at `{ max: 120, windowMs: DEFAULT_WINDOW_MS }`. Because
`endpoint` arrives `undefined`, this configuration is not what governs the response. The
number is irrelevant to the current failure and **must not be tuned in response to it**.

## FACT — identity keying

`deriveRateLimitKey(normalizedIp, endpoint, action, env, subject = '')` composes
`namespace|ip|endpoint|action` and appends `subject` when supplied. A `subject` parameter
and a `hashRateLimitSubject()` helper already exist; `revenue-event` supplies neither.
Relevant to future design, not to the current defect.

## FACT — Netlify client IP semantics

`admin-security.clientIp()` prefers `x-nf-client-connection-ip` / `client-ip` over the
spoofable `X-Forwarded-For`, falling back to the literal `'unknown'`. Correct precedence.
If the platform header were ever absent, all such traffic would share one bucket keyed
`'unknown'` — not observed.

## FACT — rejected events are not retried, and failure is invisible

`assets/revenue-events.js`:

```js
fetch(BACKEND, { ..., keepalive: true }).catch(function () { /* fail safe */ });
```

The response status is never inspected. A 429 resolves normally, so only network-level
rejection reaches `.catch`. There is no queue, backoff or replay. The client cannot tell
acceptance from rejection, and the server records nothing it rejected. **This is why a
total outage went unnoticed.**

## FACT — what has been lost

Everything routed through `Cardetail1Revenue.track`, including the checkout funnel from
`assets/checkout-analytics.js`: `checkout_opened`, `checkout_step_viewed`,
`checkout_step_completed`, `checkout_step_back`, `checkout_validation_error`,
`checkout_idle_triggered`, `checkout_resumed`.

Because the rejection is unconditional, the loss is **total, not partial and not biased**.
Any funnel drop-off figure derived from this endpoint is not a lower bound — there is no
data. Client-side GA/`dataLayer` and Clarity paths are separate and unaffected by this
defect.

## HYPOTHESIS — generic future consideration only

Once the caller contract is repaired and the configured limits actually apply, per-IP
buckets will govern behaviour for the first time. At that point it is worth considering that
mobile carriers place many subscribers behind one public IP, so an IP-only key is shared
more widely on mobile than on fixed broadband. **This is a design consideration for the
future, not an explanation of anything observed today,** and no evidence in this
investigation supports or refutes it.

The same consideration would apply to the funnel-critical buckets
(`create-setup-intent` max 10, `submit-booking:finalize` max 8), which use the correct
calling convention and are therefore live today. Whether those ceilings are right is a
separate question this pass did not investigate.

## Abuse and cost, if limits are later raised

`revenue-event` is unauthenticated with `Access-Control-Allow-Origin: *` and writes to a
retained Blob store. Raising any ceiling raises write amplification, storage cost and junk-
write exposure. Nothing about the current failure argues for raising a ceiling.

## Recommended sequence — none implemented

1. **Repair the caller contract** in `revenue-event.js` and `revenue-resume-link.js`: pass
   `{ endpoint, action }` and branch on `rate.blocked`. This alone restores both endpoints.
2. **Make loss observable**: inspect `res.status` client-side and count rejections, so a
   future outage is not silent again.
3. **Add a regression test** that fails when a caller passes a string as the options object,
   or branches on a property the helper does not return. This defect class is invisible in
   review and would otherwise recur.
4. **Then, and only then, measure** real limit behaviour before considering keying or
   ceiling changes.
5. Treat `create-setup-intent` and `submit-booking:finalize` ceilings as separate work with
   their own risk review — they guard money paths.

**None of the above is authorized or implemented in this branch.**
