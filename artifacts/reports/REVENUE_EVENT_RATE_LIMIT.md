# `revenue-event` 429 — read-only investigation

**Status: INVESTIGATION ONLY. No code changed. No limit changed. No function touched.**

Severity: **P1 observability.** Not customer-facing, not financial — but it silently
destroys the funnel data the conversion work depends on.

---

## Reproduction

Two clean loads of `https://cardetail1.com`, days apart, from the same origin:

| Request | Result |
|---|---|
| `GET /.netlify/functions/recent-work` | 200 |
| `GET /.netlify/functions/booking-availability` | 200 |
| `POST /.netlify/functions/revenue-event` | **429** |

One analytics POST per page load. The 429 is reproducible, and it is the *first*
event of a fresh load — meaning the bucket was already exhausted by earlier loads
from the same IP.

## 1. Current implementation

`netlify/lib/public-rate-limit.js`, enforced by 20 public functions. `revenue-event.js`
calls it as:

```js
const rate = await enforcePublicRateLimit(event, 'revenue-event', 'track');
if (!rate.ok) return { statusCode: 429, ... };
```

## 2. Limit and window

`revenue-event:track` → `{ max: 120, windowMs: DEFAULT_WINDOW_MS }`.

For comparison, the funnel-critical buckets in the same table:

| Bucket | max |
|---|---|
| `revenue-event:track` | 120 |
| `submit-booking:draft` | 15 |
| `lookup-booking` | 20 |
| `create-setup-intent` | **10** |
| `submit-booking:finalize` | **8** |

## 3. Identity: IP-only for this endpoint

```js
function deriveRateLimitKey(normalizedIp, endpoint, action, env, subject = '') {
  const material = sub
    ? `${namespace}|${normalizedIp}|${ep}|${act}|${sub}`
    : `${namespace}|${normalizedIp}|${ep}|${act}`;
  ...
}
```

The mechanism **already supports a `subject`**, and a helper `hashRateLimitSubject()`
exists to hash one without storing the raw identifier. `revenue-event` passes none, so
its key is purely `namespace|ip|revenue-event|track`. This matters for §11: the fix is
likely configuration inside an existing mechanism, not new architecture.

## 4–5. Proxy / CDN behaviour and Netlify client IP

`admin-security.clientIp()`:

```js
const platform = h['x-nf-client-connection-ip'] || h['client-ip'];
if (platform) return String(platform).trim();
const fwd = h['x-forwarded-for'];       // only if the platform header is absent
if (fwd) return String(fwd).split(',').[0].trim();
return 'unknown';
```

Correct precedence — the platform-injected header is trusted over the spoofable
`X-Forwarded-For`. Two consequences:

* Behind Netlify's edge, every request carries `x-nf-client-connection-ip`, so the
  bucket keys on the **true TCP peer**, not on the end user.
* If that header were ever missing, all such traffic collapses onto the literal key
  `'unknown'` — a single shared bucket. Not observed, but it is the failure mode.

## 6. CGNAT impact — the likely explanation for "desktop fine, mobile broken"

Mobile carriers place large subscriber populations behind carrier-grade NAT, so many
customers egress from **one public IP**. Home broadband typically does not.

Under an IP-only key that means:

* `revenue-event` at 120/window is shared by every customer on that carrier IP.
* More seriously, `create-setup-intent` at **10** and `submit-booking:finalize` at **8**
  are shared the same way.

The owner reported the booking funnel advancing normally on desktop and failing on
mobile. That is precisely the shape an IP-scoped limit produces on CGNAT. **Not yet
confirmed** — confirming it requires Netlify function logs showing 429 on
`submit-booking` or `create-setup-intent` at the time of a reported failure.

## 7. Are rejected events retried?

No. `assets/revenue-events.js`:

```js
fetch(BACKEND, { ..., keepalive: true }).catch(function () { /* fail safe */ });
```

No queue, no backoff, no replay. The event is discarded.

## 8. Are failures visible?

**No.** The promise resolves on a 429 — only network-level rejection reaches `.catch`.
The response status is never inspected, so the client cannot distinguish an accepted
event from a rejected one. Losses are invisible on both sides: the browser does not
know, and the server records nothing it rejected.

## 9. Which funnel events can be lost

Everything `Cardetail1Revenue.track` carries, including the checkout funnel from
`assets/checkout-analytics.js`: `checkout_opened`, `checkout_step_viewed`,
`checkout_step_completed`, `checkout_step_back`, `checkout_validation_error`,
`checkout_idle_triggered`, `checkout_resumed`.

Because the bucket drains in event order, **losses are biased toward the end of the
funnel** — the later a step, the likelier its event is dropped. Drop-off between the
card step and submission is exactly what the conversion work needs to measure, and it
is the least reliable part of the data. Any funnel numbers taken today should be
treated as a lower bound of unknown tightness.

## 10. Cost / abuse implications of simply raising the limit

`revenue-event` is unauthenticated, `Access-Control-Allow-Origin: *`, and writes to a
Blob store with retention. Raising the ceiling raises write amplification and storage
cost, and the endpoint is a plausible junk-write target. Raising it also does not fix
CGNAT — it moves the threshold without changing the sharing, so a larger carrier
population still collides. **Raising the number alone is the wrong fix.**

## 11. Safer alternatives

Ordered by risk, lowest first. **None implemented.**

1. **Add a `subject` to the analytics key.** Pass a hashed anonymous visitor/session id
   via the existing `subject` parameter so the key becomes
   `ip|revenue-event|track|visitor`. CGNAT neighbours stop sharing a bucket; a single
   abusive client is still capped. Uses `hashRateLimitSubject()`, which already exists
   and never stores the raw value. Smallest change with the largest effect.
2. **Client-side batching.** Coalesce events into one periodic POST so a session costs
   a few requests instead of one per event. Reduces pressure without touching limits.
3. **Make loss observable before tuning anything.** Inspect `res.status` and emit a
   local counter, so the true drop rate is known instead of inferred. This should come
   first — none of the tuning below can be evaluated without it.
4. **Separate the funnel-critical buckets from the analytics bucket** and review whether
   `create-setup-intent` at 10 and `submit-booking:finalize` at 8 are defensible per-IP
   under CGNAT. These protect real money paths, so any change needs its own analysis —
   flagged, not recommended here.

### Recommended sequence

Make loss observable (3) → add the subject key to analytics (1) → measure → decide on
batching (2). Treat (4) as a separate piece of work with its own risk review, because
it touches the booking and card paths.

**Nothing above is authorized or implemented by this pass.**
