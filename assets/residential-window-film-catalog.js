/**
 * Residential window film catalog.
 *
 * Separate from automotive window tint. This preview calculates glass area
 * only. It has no price, no compatibility verdict, and no duration.
 * Approved commercial values stay empty until they are filled in.
 * A caller-supplied price, switch, or duration is ignored.
 * This module cannot create a booking.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1ResidentialWindowFilm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SERVICE_FAMILY = 'residential_window_film';
  var NIGHT_PRIVACY_NOTE = 'During the day, privacy film can make it harder to see into a room from outside. At night, when the lights are on inside, people outside can still see in. This film is not a lock and it is not protection against intrusion.';

  var COMMERCIAL = {
    enabled: false,
    priceAuthority: 'residential-window-film-commercial',
    durationMinutes: null,
    installerResourceId: null,
    usesDetailingCapacity: false,
    usesAutomotiveResource: false,
    installLocation: null,
  };

  var COMMERCIAL_PRICE_ROWS = [];

  var FILMS = [
    {
      id: 'rwf_film_solar',
      key: 'solar',
      name: 'Solar control',
      summary: 'A film chosen for heat and glare. This preview does not give a heat number, a brand, or a warranty.',
      nightPrivacy: false,
    },
    {
      id: 'rwf_film_privacy',
      key: 'privacy',
      name: 'Privacy',
      summary: 'A darker film that can change how easily someone sees into a room. The nighttime limit is explained beside it.',
      nightPrivacy: true,
    },
    {
      id: 'rwf_film_decorative',
      key: 'decorative',
      name: 'Decorative / frosted',
      summary: 'A frosted or patterned film that changes the look of the glass and can soften a clear view. It is not protection against intrusion.',
      nightPrivacy: false,
    },
  ];

  var GLASS_TYPES = [
    { id: 'rwf_glass_single', label: 'Single pane' },
    { id: 'rwf_glass_double', label: 'Double pane' },
    { id: 'rwf_glass_tempered', label: 'Tempered' },
    { id: 'rwf_glass_laminated', label: 'Laminated' },
    { id: 'rwf_glass_unknown', label: "I don't know" },
  ];

  var UNITS = [
    { id: 'in', label: 'Inches', short: 'in' },
    { id: 'ft', label: 'Feet', short: 'ft' },
  ];

  var DEMO = {
    bookable: false,
    demoDurationMinutes: null,
    fictionalWindows: [],
    preparedResourceId: 'rwf_resource_residential',
    usesDetailingCapacity: false,
    usesAutomotiveResource: false,
  };

  var URL_OFFER_KEYS = ['price', 'total', 'amount', 'cents', 'pkg', 'pkgid', 'package', 'duration', 'minutes', 'enabled', 'commercialReady', 'bookable', 'compatible'];
  var FILM_PARAM = {
    solar: 'rwf_film_solar',
    rwf_film_solar: 'rwf_film_solar',
    privacy: 'rwf_film_privacy',
    rwf_film_privacy: 'rwf_film_privacy',
    decorative: 'rwf_film_decorative',
    frosted: 'rwf_film_decorative',
    rwf_film_decorative: 'rwf_film_decorative',
  };

  function filmById(id) {
    return FILMS.find(function (film) { return film.id === id; }) || null;
  }

  function glassById(id) {
    return GLASS_TYPES.find(function (glass) { return glass.id === id; }) || null;
  }

  function unitById(id) {
    return UNITS.find(function (unit) { return unit.id === id; }) || null;
  }

  function positiveCents(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  function commercialReady() {
    // Caller arguments are ignored. Readiness is this file's configuration.
    if (COMMERCIAL.enabled !== true) return false;
    if (!positiveCents(COMMERCIAL.durationMinutes)) return false;
    if (!COMMERCIAL.installerResourceId) return false;
    if (String(COMMERCIAL.installerResourceId).indexOf('wt_') === 0) return false;
    if (COMMERCIAL.usesDetailingCapacity !== false) return false;
    if (COMMERCIAL.usesAutomotiveResource !== false) return false;
    if (!COMMERCIAL.installLocation) return false;
    var priced = 0;
    for (var i = 0; i < COMMERCIAL_PRICE_ROWS.length; i += 1) {
      var cents = COMMERCIAL_PRICE_ROWS[i] && COMMERCIAL_PRICE_ROWS[i].amountCents;
      if (cents == null) continue;
      if (!positiveCents(cents)) return false;
      priced += 1;
    }
    return priced > 0;
  }

  function selectionFromSearch(search) {
    var params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    var ignored = [];
    URL_OFFER_KEYS.forEach(function (key) {
      if (params.has(key)) ignored.push(key);
    });
    return {
      filmId: FILM_PARAM[String(params.get('film') || '').toLowerCase()] || '',
      ignoredOfferKeys: ignored,
    };
  }

  function rowQuantity(value) {
    var qty = Number(value);
    if (!Number.isInteger(qty) || qty < 1 || qty > 500) return null;
    return qty;
  }

  function rowLength(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > 1000) return null;
    return number;
  }

  function roundArea(value) {
    return Math.round(value * 100) / 100;
  }

  function measureRow(row) {
    var src = row || {};
    var qty = rowQuantity(src.quantity);
    var width = rowLength(src.width);
    var height = rowLength(src.height);
    var unit = unitById(String(src.unit || ''));
    if (qty == null || width == null || height == null || !unit) return null;
    var area = unit.id === 'in' ? (width * height * qty) / 144 : width * height * qty;
    if (!Number.isFinite(area) || area <= 0) return null;
    return {
      quantity: qty,
      width: width,
      height: height,
      unit: unit.id,
      unitLabel: unit.label,
      unitShort: unit.short,
      areaSqFt: roundArea(area),
    };
  }

  function formatArea(sqFt) {
    if (typeof sqFt !== 'number' || !Number.isFinite(sqFt) || sqFt <= 0) return '';
    var rounded = roundArea(sqFt);
    var text = rounded.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    return text + ' sq ft';
  }

  function measure(input) {
    var src = input || {};
    var film = filmById(String(src.filmId || ''));
    var glass = glassById(String(src.glassTypeId || ''));
    var ignoredInputs = [];
    ['price', 'total', 'amountCents', 'durationMinutes', 'pkg', 'pkgId', 'enabled', 'commercialReady', 'bookable', 'compatible', 'compatibility'].forEach(function (key) {
      if (src[key] != null && src[key] !== '') ignoredInputs.push(key);
    });
    var sourceRows = Array.isArray(src.rows) ? src.rows : [];
    var rows = [];
    var invalid = sourceRows.length === 0;
    sourceRows.forEach(function (row) {
      var measured = measureRow(row);
      if (!measured) invalid = true;
      else rows.push(measured);
    });
    var panes = 0;
    var area = 0;
    rows.forEach(function (row) {
      panes += row.quantity;
      area += row.areaSqFt;
    });
    var ready = !invalid && !!film && !!glass && rows.length === sourceRows.length;
    return {
      serviceFamily: SERVICE_FAMILY,
      enabled: COMMERCIAL.enabled === true,
      bookable: false,
      combinesWithDetailing: false,
      combinesWithAutomotiveTint: false,
      priceCents: null,
      totalCents: null,
      compatibility: null,
      filmId: film ? film.id : '',
      filmName: film ? film.name : '',
      glassTypeId: glass ? glass.id : '',
      glassTypeLabel: glass ? glass.label : '',
      glassTypeKnown: !!(glass && glass.id !== 'rwf_glass_unknown'),
      floor: String(src.floor || '').trim(),
      access: String(src.access || '').trim(),
      rows: ready ? rows : rows,
      paneCount: ready ? panes : null,
      areaSqFt: ready ? roundArea(area) : null,
      areaStatus: ready ? 'area_only' : 'measurement_needed',
      nightPrivacy: !!(film && film.nightPrivacy),
      nightPrivacyNote: film && film.nightPrivacy ? NIGHT_PRIVACY_NOTE : '',
      durationMinutes: COMMERCIAL.durationMinutes,
      demoDurationMinutes: null,
      canConfirmTime: false,
      installerResourceId: COMMERCIAL.installerResourceId,
      preparedResourceId: DEMO.preparedResourceId,
      usesDetailingCapacity: false,
      usesAutomotiveResource: false,
      installLocation: COMMERCIAL.installLocation,
      ignoredInputs: ignoredInputs,
    };
  }

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.keys(value).forEach(function (key) { freeze(value[key]); });
    Object.freeze(value);
  }
  freeze(COMMERCIAL);
  freeze(COMMERCIAL_PRICE_ROWS);
  freeze(DEMO);
  freeze(FILMS);
  freeze(GLASS_TYPES);

  return {
    SERVICE_FAMILY: SERVICE_FAMILY,
    NIGHT_PRIVACY_NOTE: NIGHT_PRIVACY_NOTE,
    COMMERCIAL: COMMERCIAL,
    COMMERCIAL_PRICE_ROWS: COMMERCIAL_PRICE_ROWS,
    DEMO: DEMO,
    FILMS: FILMS,
    GLASS_TYPES: GLASS_TYPES,
    UNITS: UNITS,
    URL_OFFER_KEYS: URL_OFFER_KEYS,
    filmById: filmById,
    glassById: glassById,
    selectionFromSearch: selectionFromSearch,
    commercialReady: commercialReady,
    measure: measure,
    formatArea: formatArea,
  };
});
