// netlify/functions/proof-cards.js
// Admin CRUD for Service Proof Cards. Stored in Netlify Blobs (cd1-proof-cards).
// Public read for approved cards only.
//
// Auth: x-admin-token or x-admin-key for admin actions.
// No auth needed for public read of approved cards.
//
// POST (admin):
//   { action:'create', ...fields }     → { ok, card }
//   { action:'update', cardId, ...}    → { ok, card }
//   { action:'list' }                  → { ok, cards }
//   { action:'delete', cardId }        → { ok }
//   { action:'generate_drafts', cardId } → { ok, gbpDraft, instagramCaption, followUpText, qrLinks }
//
// GET ?id=<cardId>  (public, approved only) → { ok, card }
// GET ?list=public  (public, approved only) → { ok, cards }

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

async function getStore(name) {
  const { getStore: gs } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? gs({ name, siteID, token }) : gs(name);
}

async function verifyAdmin(headers) {
  const h = headers || {};
  const token = (h['x-admin-token'] || h['X-Admin-Token'] || '').trim();
  if (token && token.length >= 32) {
    const sessionStore = await getStore('cd1-admin-sessions');
    const key = 'sess-' + token.slice(0, 16);
    const s = await sessionStore.get(key, { type: 'json' }).catch(() => null);
    if (s && Date.now() <= s.expiresAt) {
      return crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token));
    }
  }
  const adminKey = (h['x-admin-key'] || h['X-Admin-Key'] || '').trim();
  const expected = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!adminKey || !expected) return false;
  const a = Buffer.from(adminKey);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateCardId() {
  return 'PC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// Strip PII from public card view
function publicCard(c) {
  return {
    id: c.id,
    slug: c.slug,
    vehicleYear: c.vehicleYear || '',
    vehicleMake: c.vehicleMake || '',
    vehicleModel: c.vehicleModel || '',
    vehicleClass: c.vehicleClass || '',
    servicePackage: c.servicePackage || '',
    addons: c.addons || '',
    cityArea: c.cityArea || '',
    caption: c.caption || '',
    photoUrl: c.photoUrl || '',
    beforePhotoUrl: c.beforePhotoUrl || '',
    afterPhotoUrl: c.afterPhotoUrl || '',
    seoTitle: c.seoTitle || '',
    seoDescription: c.seoDescription || '',
    seoAltText: c.seoAltText || '',
    createdAt: c.createdAt || '',
  };
}

// ── Marketing draft generators ──────────────────────────────────────────────

function generateGBPDraft(c) {
  const vehicle = [c.vehicleYear, c.vehicleMake, c.vehicleModel].filter(Boolean).join(' ');
  const svc = c.servicePackage || 'detailing service';
  const city = c.cityArea || 'your area';
  return [
    `Just completed a ${svc.toLowerCase()} on a ${vehicle} in ${city}.`,
    '',
    c.caption || `Another vehicle looking its best after our mobile detailing service.`,
    '',
    `Book your detail: cardetail1.netlify.app`,
    `Call/text: 551-313-2956`,
    '',
    `#MobileDetailing #${city.replace(/[^a-zA-Z]/g, '')} #Cardetail1`,
  ].join('\n');
}

function generateInstagramCaption(c) {
  const vehicle = [c.vehicleYear, c.vehicleMake, c.vehicleModel].filter(Boolean).join(' ');
  const svc = c.servicePackage || 'Detail';
  const city = c.cityArea || 'NJ';
  const cityTag = city.replace(/[^a-zA-Z]/g, '');
  const lines = [];
  if (c.beforePhotoUrl && c.afterPhotoUrl) {
    lines.push(`Before ➜ After on this ${vehicle}.`);
  } else {
    lines.push(`${vehicle} — ${svc.toLowerCase()} complete.`);
  }
  if (c.caption) lines.push('', c.caption);
  lines.push(
    '',
    `📍 ${city}`,
    `📲 Book yours: link in bio or call 551-313-2956`,
    '',
    '#Cardetail1 #MobileDetailing #MobileDetailingNJ',
    `#${cityTag} #${cityTag}Detailing #NorthJerseyDetailing`,
    '#BergenCountyDetailing #AutoDetailing #CarCare',
    `#${(c.vehicleMake || 'Car').replace(/\s/g, '')}Detailing`,
  );
  return lines.join('\n');
}

function generateFollowUpText(c) {
  const reviewLink = process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/YOUR_GOOGLE_REVIEW_LINK';
  return [
    'Thank you for choosing Cardetail1! Your service is complete.',
    '',
    'If everything looks good, your honest review helps other local customers find us.',
    `You can leave a Google review here: ${reviewLink}`,
    '',
    'If anything needs attention, reply to this message and we\'ll review it right away.',
    '',
    'Cardetail1 Mobile Detailing',
    '551-313-2956',
  ].join('\n');
}

function generateQRLinks() {
  const base = process.env.URL || 'https://cardetail1.netlify.app';
  const reviewLink = process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/YOUR_GOOGLE_REVIEW_LINK';
  return {
    bookAgain: base,
    myBooking: base + '/customer.html',
    leaveReview: reviewLink,
    contactUs: 'tel:5513132956',
    recentWork: base + '/#recent-work',
  };
}

function generateSEO(c) {
  const vehicle = [c.vehicleYear, c.vehicleMake, c.vehicleModel].filter(Boolean).join(' ');
  const svc = c.servicePackage || 'Mobile Detail';
  const city = c.cityArea || 'NJ';
  const vClass = c.vehicleClass || 'Vehicle';
  return {
    title: `${vehicle || vClass} ${svc} in ${city}`,
    description: `Mobile ${svc.toLowerCase()} on a ${vehicle || vClass.toLowerCase()} in ${city}. Professional results, at your location. Book Cardetail1 today.`,
    altText: `${vehicle || vClass} after ${svc.toLowerCase()} by Cardetail1 in ${city}`,
    cityServicePhrase: `${svc} near ${city}`,
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const store = await getStore('cd1-proof-cards');

  // ── PUBLIC GET ────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};

    if (params.list === 'public') {
      const listing = await store.list().catch(() => ({ blobs: [] }));
      const blobs = (listing && listing.blobs) || [];
      const cards = [];
      for (const b of blobs) {
        if (!b.key.startsWith('card-')) continue;
        const c = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (c && c.approvedForPublic) cards.push(publicCard(c));
      }
      cards.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return json(200, { ok: true, cards });
    }

    if (params.id) {
      const c = await store.get('card-' + params.id, { type: 'json' }).catch(() => null);
      if (!c || !c.approvedForPublic) return json(404, { ok: false, error: 'not_found' });
      return json(200, { ok: true, card: publicCard(c) });
    }

    if (params.slug) {
      const listing = await store.list().catch(() => ({ blobs: [] }));
      for (const b of ((listing && listing.blobs) || [])) {
        if (!b.key.startsWith('card-')) continue;
        const c = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (c && c.approvedForPublic && c.slug === params.slug) {
          return json(200, { ok: true, card: publicCard(c) });
        }
      }
      return json(404, { ok: false, error: 'not_found' });
    }

    return json(400, { ok: false, error: 'missing_id_or_list_param' });
  }

  // ── ADMIN POST ────────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  if (!(await verifyAdmin(event.headers))) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '');

  // ── LIST (admin — includes non-approved) ──────────────────────────────
  if (action === 'list') {
    const listing = await store.list().catch(() => ({ blobs: [] }));
    const blobs = (listing && listing.blobs) || [];
    const cards = [];
    for (const b of blobs) {
      if (!b.key.startsWith('card-')) continue;
      const c = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (c) cards.push(c);
    }
    cards.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return json(200, { ok: true, cards });
  }

  // ── CREATE ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const id = generateCardId();
    const seo = generateSEO(body);
    const vehicleStr = [body.vehicleYear, body.vehicleMake, body.vehicleModel].filter(Boolean).join(' ');
    const svcStr = body.servicePackage || 'detail';
    const cityStr = body.cityArea || '';
    const slug = slugify([cityStr, vehicleStr, svcStr, id.slice(-6)].filter(Boolean).join(' '));

    const card = {
      id,
      slug,
      vehicleYear: String(body.vehicleYear || '').slice(0, 4),
      vehicleMake: String(body.vehicleMake || '').slice(0, 50),
      vehicleModel: String(body.vehicleModel || '').slice(0, 50),
      vehicleClass: String(body.vehicleClass || '').slice(0, 50),
      servicePackage: String(body.servicePackage || '').slice(0, 100),
      addons: String(body.addons || '').slice(0, 300),
      cityArea: String(body.cityArea || '').slice(0, 100),
      photoUrl: String(body.photoUrl || '').slice(0, 2000),
      beforePhotoUrl: String(body.beforePhotoUrl || '').slice(0, 2000),
      afterPhotoUrl: String(body.afterPhotoUrl || '').slice(0, 2000),
      caption: String(body.caption || '').slice(0, 500),
      technicianName: String(body.technicianName || '').slice(0, 100),
      showCustomerFirstName: !!body.showCustomerFirstName,
      customerFirstName: body.showCustomerFirstName ? String(body.customerFirstName || '').slice(0, 50) : '',
      approvedForPublic: !!body.approvedForPublic,
      approvedForGooglePost: !!body.approvedForGooglePost,
      approvedForInstagram: !!body.approvedForInstagram,
      bookingId: String(body.bookingId || '').slice(0, 48),
      seoTitle: seo.title,
      seoDescription: seo.description,
      seoAltText: seo.altText,
      cityServicePhrase: seo.cityServicePhrase,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.setJSON('card-' + id, card);
    return json(200, { ok: true, card });
  }

  // ── UPDATE ────────────────────────────────────────────────────────────
  if (action === 'update') {
    const cardId = String(body.cardId || '').trim();
    if (!cardId) return json(400, { ok: false, error: 'cardId_required' });

    const existing = await store.get('card-' + cardId, { type: 'json' }).catch(() => null);
    if (!existing) return json(404, { ok: false, error: 'not_found' });

    const ALLOWED = [
      'vehicleYear', 'vehicleMake', 'vehicleModel', 'vehicleClass',
      'servicePackage', 'addons', 'cityArea', 'photoUrl', 'beforePhotoUrl',
      'afterPhotoUrl', 'caption', 'technicianName', 'showCustomerFirstName',
      'customerFirstName', 'approvedForPublic', 'approvedForGooglePost',
      'approvedForInstagram',
    ];
    const updates = body.updates || {};
    for (const [k, v] of Object.entries(updates)) {
      if (!ALLOWED.includes(k)) continue;
      if (typeof v === 'boolean') existing[k] = v;
      else existing[k] = String(v).slice(0, 2000);
    }
    if (!existing.showCustomerFirstName) existing.customerFirstName = '';

    // Regenerate SEO
    const seo = generateSEO(existing);
    existing.seoTitle = seo.title;
    existing.seoDescription = seo.description;
    existing.seoAltText = seo.altText;
    existing.cityServicePhrase = seo.cityServicePhrase;

    // Regenerate slug
    const vehicleStr = [existing.vehicleYear, existing.vehicleMake, existing.vehicleModel].filter(Boolean).join(' ');
    existing.slug = slugify([existing.cityArea, vehicleStr, existing.servicePackage, existing.id.slice(-6)].filter(Boolean).join(' '));
    existing.updatedAt = new Date().toISOString();

    await store.setJSON('card-' + cardId, existing);
    return json(200, { ok: true, card: existing });
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const cardId = String(body.cardId || '').trim();
    if (!cardId) return json(400, { ok: false, error: 'cardId_required' });
    try { await store.delete('card-' + cardId); } catch (_) {}
    return json(200, { ok: true });
  }

  // ── GENERATE DRAFTS ───────────────────────────────────────────────────
  if (action === 'generate_drafts') {
    const cardId = String(body.cardId || '').trim();
    if (!cardId) return json(400, { ok: false, error: 'cardId_required' });

    const card = await store.get('card-' + cardId, { type: 'json' }).catch(() => null);
    if (!card) return json(404, { ok: false, error: 'not_found' });

    return json(200, {
      ok: true,
      gbpDraft: generateGBPDraft(card),
      instagramCaption: generateInstagramCaption(card),
      followUpText: generateFollowUpText(card),
      qrLinks: generateQRLinks(),
      seo: generateSEO(card),
    });
  }

  return json(400, { ok: false, error: 'unknown_action' });
};
