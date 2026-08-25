/**
 * First-party Cardetail1 review channel.
 *
 * Portal reviews (completed-job, one per booking) are the site's own social
 * proof. Google is an optional outbound listing, not the source of this page.
 *
 * Public homepage cards never include phone, email, address, or booking id.
 */

const REVIEWS_STORE = 'cd1-reviews';
const HOMEPAGE_INDEX_KEY = 'homepage-index';
const MODERATION_QUEUE_KEY = 'moderation-queue';
const MIN_PUBLIC_COMMENT = 12;
const MAX_HOMEPAGE_ITEMS = 24;

function trimText(value, max) {
  return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, max);
}

function publicCommentEligible(comment) {
  return trimText(comment, 2000).length >= MIN_PUBLIC_COMMENT;
}

function publishStatus({ stars, comment } = {}) {
  const rating = Math.round(Number(stars));
  if (rating >= 4 && rating <= 5 && publicCommentEligible(comment)) return 'approved';
  return 'pending_moderation';
}

function displayName(firstName, lastName, fallback) {
  const first = trimText(firstName, 80);
  const last = trimText(lastName, 80);
  if (first && last) return first + ' ' + last.charAt(0).toUpperCase() + '.';
  if (first) return first;
  const full = trimText(fallback, 80);
  if (full) {
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return parts[0] + ' ' + parts[1].charAt(0).toUpperCase() + '.';
    return parts[0];
  }
  return 'Cardetail1 customer';
}

function formatMonthYear(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'America/New_York' }).format(new Date(ms));
  } catch (_) {
    const d = new Date(ms);
    return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  }
}

function serviceLabel(booking) {
  const vehicles = Array.isArray(booking && booking.vehicles) ? booking.vehicles : [];
  const first = vehicles[0] || {};
  return trimText(
    first.pkgName || first.packageName || booking.packageName || booking.package || '',
    80
  ) || 'Mobile Auto Detailing';
}

function locationLabel(booking) {
  const city = trimText(
    (booking && (booking.city || booking.serviceCity || booking.serviceLocation)) || '',
    80
  );
  if (city && city.length >= 3 && !/^\d+$/.test(city)) return city;
  return 'NJ / NY area';
}

function toPublicCard(review) {
  if (!review || !review.id) return null;
  const text = trimText(review.comment || review.text, 2000);
  const rating = Math.round(Number(review.stars != null ? review.stars : review.rating) || 0);
  const name = trimText(review.displayName || review.name, 80);
  if (!name || !publicCommentEligible(text) || rating < 1 || rating > 5) return null;
  return {
    id: String(review.id),
    name,
    rating,
    text,
    location: trimText(review.location, 80) || 'NJ / NY area',
    date: trimText(review.date, 40) || formatMonthYear(review.createdAt) || '',
    service: trimText(review.service, 80) || 'Mobile Auto Detailing',
    source: 'cardetail1',
    createdAt: review.createdAt || '',
  };
}

function isPublicCard(card) {
  return !!(card && card.id && card.name && publicCommentEligible(card.text) && card.rating >= 1 && card.rating <= 5);
}

function normalizeBody(text) {
  return trimText(text, 2000).toLowerCase().replace(/\s+/g, ' ');
}

function mergeHomepageIndex(existing, card) {
  const nextCard = toPublicCard(card) || (isPublicCard(card) ? card : null);
  if (!nextCard) return Array.isArray(existing) ? existing.filter(isPublicCard) : [];
  const body = normalizeBody(nextCard.text);
  const rest = (Array.isArray(existing) ? existing : []).filter((row) => {
    if (!isPublicCard(row)) return false;
    if (String(row.id) === String(nextCard.id)) return false;
    return normalizeBody(row.text) !== body;
  });
  return [nextCard].concat(rest)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, MAX_HOMEPAGE_ITEMS);
}

function removeFromIndex(existing, id) {
  const key = String(id || '');
  return (Array.isArray(existing) ? existing : []).filter((row) => String(row.id) !== key);
}

function mergeQueue(existing, id) {
  const key = String(id || '');
  if (!key) return Array.isArray(existing) ? existing : [];
  const rest = (Array.isArray(existing) ? existing : []).filter((row) => String(row) !== key);
  return [key].concat(rest).slice(0, 200);
}

async function readJsonArray(store, key) {
  if (!store || typeof store.get !== 'function') return [];
  const raw = await store.get(key, { type: 'json' }).catch(() => null);
  return Array.isArray(raw) ? raw : [];
}

async function writeJson(store, key, value) {
  if (!store || typeof store.setJSON !== 'function') return;
  await store.setJSON(key, value);
}

async function readHomepageIndex(store) {
  return (await readJsonArray(store, HOMEPAGE_INDEX_KEY)).filter(isPublicCard);
}

async function publishToHomepage(store, card) {
  const current = await readHomepageIndex(store);
  const next = mergeHomepageIndex(current, card);
  await writeJson(store, HOMEPAGE_INDEX_KEY, next);
  return next;
}

async function hideFromHomepage(store, id) {
  const current = await readHomepageIndex(store);
  const next = removeFromIndex(current, id);
  await writeJson(store, HOMEPAGE_INDEX_KEY, next);
  return next;
}

async function enqueueModeration(store, id) {
  const current = await readJsonArray(store, MODERATION_QUEUE_KEY);
  const next = mergeQueue(current, id);
  await writeJson(store, MODERATION_QUEUE_KEY, next);
  return next;
}

async function dequeueModeration(store, id) {
  const current = await readJsonArray(store, MODERATION_QUEUE_KEY);
  const next = current.filter((row) => String(row) !== String(id || ''));
  await writeJson(store, MODERATION_QUEUE_KEY, next);
  return next;
}

function cardFromBookingReview(review, booking) {
  const createdAt = review.createdAt || new Date().toISOString();
  return toPublicCard({
    id: review.id,
    comment: review.comment,
    stars: review.stars,
    displayName: displayName(booking && booking.firstName, booking && booking.lastName, review.customerName),
    location: locationLabel(booking || {}),
    service: serviceLabel(booking || {}),
    date: formatMonthYear(createdAt),
    createdAt,
  });
}

module.exports = {
  REVIEWS_STORE,
  HOMEPAGE_INDEX_KEY,
  MODERATION_QUEUE_KEY,
  MIN_PUBLIC_COMMENT,
  MAX_HOMEPAGE_ITEMS,
  publicCommentEligible,
  publishStatus,
  displayName,
  formatMonthYear,
  serviceLabel,
  locationLabel,
  toPublicCard,
  isPublicCard,
  mergeHomepageIndex,
  removeFromIndex,
  readHomepageIndex,
  publishToHomepage,
  hideFromHomepage,
  enqueueModeration,
  dequeueModeration,
  cardFromBookingReview,
};
