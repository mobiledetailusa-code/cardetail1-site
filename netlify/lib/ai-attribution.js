// AI-assistant source classification — pure, no I/O.
//
// A visit is attributed to an AI assistant only when the stored attribution
// names one: a referring domain of the assistant, or a utm_source the assistant
// or the site owner put on the link. Nothing is inferred when both are absent.
//
// Not detectable and therefore never classified as AI:
// - Google AI Overviews / AI Mode: the referrer is google.com, the same as
//   organic search. gemini.google.com is the Gemini app, not search.
// - Copilot answers inside bing.com search: the referrer is bing.com.
// - Typed URLs, phone calls, and links copied out of an assistant.
//
// assets/revenue-events.js keeps an identical copy of AI_ASSISTANTS (the browser
// cannot require this file). tests/ai-attribution.test.js fails if they differ.

const AI_ASSISTANTS = Object.freeze([
  {
    key: 'chatgpt',
    label: 'ChatGPT',
    // ChatGPT search appends utm_source=chatgpt.com to outbound links.
    domains: ['chatgpt.com', 'chat.openai.com'],
    utmSources: ['chatgpt.com', 'chatgpt', 'chat.openai.com', 'openai'],
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    domains: ['perplexity.ai'],
    utmSources: ['perplexity.ai', 'perplexity'],
  },
  {
    key: 'gemini',
    label: 'Gemini',
    domains: ['gemini.google.com', 'bard.google.com'],
    utmSources: ['gemini.google.com', 'gemini', 'bard'],
  },
  {
    key: 'copilot',
    label: 'Copilot',
    domains: ['copilot.microsoft.com'],
    utmSources: ['copilot.microsoft.com', 'copilot'],
  },
  {
    key: 'claude',
    label: 'Claude',
    domains: ['claude.ai'],
    utmSources: ['claude.ai', 'claude'],
  },
  {
    key: 'other_ai',
    label: 'Other AI assistant',
    domains: ['chat.mistral.ai', 'meta.ai', 'grok.com', 'chat.deepseek.com', 'poe.com', 'you.com', 'phind.com'],
    utmSources: ['mistral', 'meta.ai', 'grok', 'deepseek', 'poe', 'you.com', 'phind'],
  },
]);

const AI_SOURCE_KEYS = Object.freeze(AI_ASSISTANTS.map((a) => a.key));
const PAID_MEDIUMS = Object.freeze(['cpc', 'ppc', 'paid', 'paid_social']);

function normalizeHost(value) {
  let s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (/^[a-z]+:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch { return ''; }
  }
  return s.replace(/\.$/, '').replace(/^www\./, '');
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The assistant a referring host belongs to, or null. google.com and bing.com never match. */
function assistantForReferrer(referrer) {
  const host = normalizeHost(referrer);
  if (!host) return null;
  return AI_ASSISTANTS.find((a) => a.domains.some((d) => hostMatches(host, d))) || null;
}

/** The assistant a utm_source names, or null. Exact match after trim/lowercase. */
function assistantForUtmSource(utmSource) {
  const s = String(utmSource || '').trim().toLowerCase();
  if (!s) return null;
  return AI_ASSISTANTS.find((a) => a.utmSources.includes(s)) || null;
}

/**
 * Classify one touch. Returns { key, label, matchedBy, value } or null.
 * 1. A referrer on an assistant's domain is direct evidence of the navigation.
 * 2. Otherwise a utm_source naming an assistant counts, unless the medium is
 *    paid: paid campaigns are never relabelled. The paid check applies only to
 *    the UTM path because stored utm_* can be a sticky older campaign while the
 *    referrer belongs to the newest visit.
 */
function classifyTouch({ utmSource, utmMedium, referrer } = {}) {
  const byRef = assistantForReferrer(referrer);
  if (byRef) return { key: byRef.key, label: byRef.label, matchedBy: 'referrer', value: normalizeHost(referrer).slice(0, 64) };
  if (PAID_MEDIUMS.includes(String(utmMedium || '').trim().toLowerCase())) return null;
  const byUtm = assistantForUtmSource(utmSource);
  if (byUtm) return { key: byUtm.key, label: byUtm.label, matchedBy: 'utm_source', value: String(utmSource).trim().toLowerCase().slice(0, 64) };
  return null;
}

/**
 * First- and last-touch AI attribution for stored event properties, using only
 * fields the event already carries (works for historical rows, rewrites nothing).
 * first: first_utm_source + referrer_domain (the first external referrer).
 * last:  utm_source (latest campaign) + last_referrer_domain.
 */
function classifyEventAttribution(properties = {}) {
  const p = properties && typeof properties === 'object' ? properties : {};
  const first = classifyTouch({
    utmSource: p.first_utm_source,
    utmMedium: p.first_utm_medium,
    referrer: p.referrer_domain,
  });
  const last = classifyTouch({
    utmSource: p.utm_source,
    utmMedium: p.utm_medium,
    referrer: p.last_referrer_domain,
  });
  const primary = last || first;
  return {
    isAi: !!primary,
    sourceKey: primary ? primary.key : null,
    firstTouch: first,
    lastTouch: last,
  };
}

function labelFor(key) {
  const a = AI_ASSISTANTS.find((x) => x.key === key);
  return a ? a.label : null;
}

module.exports = {
  AI_ASSISTANTS,
  AI_SOURCE_KEYS,
  PAID_MEDIUMS,
  normalizeHost,
  assistantForReferrer,
  assistantForUtmSource,
  classifyTouch,
  classifyEventAttribution,
  labelFor,
};
