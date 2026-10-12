/**
 * Window tint catalog.
 *
 * Demonstration amounts live in DEMO_PRICE_ROWS and are labeled
 * "Demo pricing — not available for booking".
 * Approved commercial values live in COMMERCIAL and COMMERCIAL_PRICE_ROWS.
 * Both stay empty of a sellable offer until someone fills them in and the
 * service is enabled. Vehicle size from detailing is not a price multiplier.
 * A caller-supplied price, package id, or duration is ignored.
 * This module cannot create a booking.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1WindowTintDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SERVICE_FAMILY = 'window_tint';
  var DEMO_PRICE_AUTHORITY = 'window-tinting-demo-catalog';
  var DEMO_PRICE_LABEL = 'Demo pricing — not available for booking';

  var COMMERCIAL = {
    enabled: false,
    priceAuthority: 'window-tint-commercial',
    durationMinutes: null,
    travelFeeCents: null,
    usesDetailingTravelTable: false,
    installLocation: null,
    installerResourceId: null,
    usesDetailingCapacity: false,
    removalAmountCents: null,
    removalRequiresEvaluation: true,
    glassExceptions: [
      { glassId: 'wt_glass_front_sides', status: 'rules_review', amountCents: null },
      { glassId: 'wt_glass_windshield', status: 'specific_evaluation', amountCents: null },
      { glassId: 'wt_glass_roof', status: 'specific_evaluation', amountCents: null },
    ],
  };

  var FILMS = [
    {
      id: 'wt_film_carbon',
      key: 'carbon',
      name: 'Carbon Window Tint',
      summary: 'A color film that changes how dark the glass looks and can soften glare. Heat control is a separate property and is not given as a number here.',
    },
    {
      id: 'wt_film_ceramic',
      key: 'ceramic',
      name: 'Ceramic Window Tint',
      summary: 'A different film from carbon. Shade and heat control are separate, and this film is not a paint coating.',
    },
    {
      id: 'wt_film_help',
      key: 'help',
      name: 'Help me choose',
      summary: 'No film is selected. This preview does not generate a recommendation.',
    },
  ];

  var GLASS = [
    {
      id: 'wt_glass_front_sides',
      label: 'Front side windows',
      confirmation: 'rules_review',
      note: 'Driver and front passenger glass are not treated as allowed at every shade.',
    },
    {
      id: 'wt_glass_rear_sides',
      label: 'Rear side windows',
      confirmation: 'requested',
      note: 'The pair used for two eligible side windows.',
    },
    {
      id: 'wt_glass_rear',
      label: 'Rear window',
      confirmation: 'requested',
      note: 'Included only with sides and rear.',
    },
    {
      id: 'wt_glass_windshield',
      label: 'Windshield',
      confirmation: 'specific_evaluation',
      note: 'Specific evaluation. Asking for it does not confirm windshield film.',
    },
    {
      id: 'wt_glass_roof',
      label: 'Roof glass',
      confirmation: 'specific_evaluation',
      note: 'Specific evaluation. Asking for it does not confirm film on a sunroof or panoramic roof.',
    },
  ];

  var COVERAGES = [
    {
      id: 'wt_cov_two_side',
      label: 'Two eligible side windows',
      summary: 'Rear side windows only. Front side windows, the rear window, the windshield, and roof glass stay out.',
      includedGlassIds: ['wt_glass_rear_sides'],
      excludedGlassIds: ['wt_glass_front_sides', 'wt_glass_rear', 'wt_glass_windshield', 'wt_glass_roof'],
      vehicleScoped: false,
    },
    {
      id: 'wt_cov_sides_rear',
      label: 'Sides + rear',
      summary: 'Rear side windows and the rear window. Front side windows, the windshield, and roof glass stay out.',
      includedGlassIds: ['wt_glass_rear_sides', 'wt_glass_rear'],
      excludedGlassIds: ['wt_glass_front_sides', 'wt_glass_windshield', 'wt_glass_roof'],
      vehicleScoped: true,
    },
    {
      id: 'wt_cov_unsure',
      label: 'Not sure which glass',
      summary: 'The glass still has to be matched.',
      includedGlassIds: [],
      excludedGlassIds: ['wt_glass_front_sides', 'wt_glass_rear_sides', 'wt_glass_rear', 'wt_glass_windshield', 'wt_glass_roof'],
      vehicleScoped: false,
    },
  ];

  var VEHICLE_GROUPS = [
    { id: 'sedan', label: 'standard sedan', tierKeys: ['small'], displayClasses: ['small'] },
    { id: 'suv2', label: 'two-row SUV', tierKeys: ['suv2'], displayClasses: ['suv2'] },
    { id: 'large', label: 'large SUV or minivan', tierKeys: ['suv3'], displayClasses: ['suv3', 'minivan'] },
  ];

  var REMOVAL = [
    { id: 'no', label: 'No existing film' },
    { id: 'yes', label: 'Existing film needs to come off' },
    { id: 'unsure', label: 'Not sure' },
  ];

  var REGISTRATION_STATES = [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
    ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
    ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
    ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
    ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
    ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
    ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
    ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
    ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
    ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
    ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
    ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
    ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ];

  /**
   * Provisional demonstration rows. Change these only for the preview.
   * Approved cents belong in COMMERCIAL_PRICE_ROWS, which stay null.
   */
  var DEMO_PRICE_ROWS = [
    { coverageId: 'wt_cov_two_side', vehicleGroup: 'eligible', label: 'Two eligible side windows', carbonCents: 17900, ceramicCents: 24900 },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'sedan', label: 'Sides + rear — standard sedan', carbonCents: 39900, ceramicCents: 54900 },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'suv2', label: 'Sides + rear — two-row SUV', carbonCents: 44900, ceramicCents: 59900 },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'large', label: 'Sides + rear — large SUV or minivan', carbonCents: 49900, ceramicCents: 64900 },
  ];

  var COMMERCIAL_PRICE_ROWS = [
    { coverageId: 'wt_cov_two_side', vehicleGroup: 'eligible', filmId: 'wt_film_carbon', amountCents: null },
    { coverageId: 'wt_cov_two_side', vehicleGroup: 'eligible', filmId: 'wt_film_ceramic', amountCents: null },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'sedan', filmId: 'wt_film_carbon', amountCents: null },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'sedan', filmId: 'wt_film_ceramic', amountCents: null },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'suv2', filmId: 'wt_film_carbon', amountCents: null },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'suv2', filmId: 'wt_film_ceramic', amountCents: null },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'large', filmId: 'wt_film_carbon', amountCents: null },
    { coverageId: 'wt_cov_sides_rear', vehicleGroup: 'large', filmId: 'wt_film_ceramic', amountCents: null },
  ];

  var DEMO = {
    label: DEMO_PRICE_LABEL,
    bookable: false,
    demoDurationMinutes: 180,
    fictionalWindows: [
      { id: 'wt_demo_am', label: 'Demo only · 9:00 AM – 12:00 PM · not a real opening' },
      { id: 'wt_demo_pm', label: 'Demo only · 1:00 PM – 4:00 PM · not a real opening' },
    ],
    preparedResourceId: 'wt_resource_film_installer',
    usesDetailingCapacity: false,
    rows: DEMO_PRICE_ROWS,
  };

  var URL_PRICE_KEYS = ['price', 'total', 'amount', 'cents', 'pkg', 'pkgid', 'package', 'duration', 'minutes', 'enabled', 'commercialReady', 'bookable', 'compatible'];
  var FILM_PARAM = {
    carbon: 'wt_film_carbon',
    wt_film_carbon: 'wt_film_carbon',
    ceramic: 'wt_film_ceramic',
    wt_film_ceramic: 'wt_film_ceramic',
    help: 'wt_film_help',
    wt_film_help: 'wt_film_help',
  };
  var COVERAGE_PARAM = {
    'two-side': 'wt_cov_two_side',
    two_side: 'wt_cov_two_side',
    sides: 'wt_cov_two_side',
    wt_cov_two_side: 'wt_cov_two_side',
    'sides-rear': 'wt_cov_sides_rear',
    sides_rear: 'wt_cov_sides_rear',
    wt_cov_sides_rear: 'wt_cov_sides_rear',
    unsure: 'wt_cov_unsure',
    wt_cov_unsure: 'wt_cov_unsure',
  };

  function filmById(id) {
    return FILMS.find(function (film) { return film.id === id; }) || null;
  }

  function glassById(id) {
    return GLASS.find(function (glass) { return glass.id === id; }) || null;
  }

  function coverageById(id) {
    return COVERAGES.find(function (coverage) { return coverage.id === id; }) || null;
  }

  function positiveCents(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  function commercialReady() {
    // Caller arguments are ignored. Readiness is this file's configuration.
    if (COMMERCIAL.enabled !== true) return false;
    if (String(COMMERCIAL.installerResourceId || '').indexOf('rwf_') === 0) return false;
    if (!positiveCents(COMMERCIAL.durationMinutes)) return false;
    if (!COMMERCIAL.installerResourceId) return false;
    if (COMMERCIAL.usesDetailingCapacity !== false) return false;
    if (!COMMERCIAL.installLocation) return false;
    var priced = 0;
    for (var i = 0; i < COMMERCIAL_PRICE_ROWS.length; i += 1) {
      var cents = COMMERCIAL_PRICE_ROWS[i].amountCents;
      if (cents == null) continue;
      if (!positiveCents(cents)) return false;
      priced += 1;
    }
    return priced > 0;
  }

  function vehicleGroupFor(input) {
    var src = input || {};
    var display = String(src.displayClass || '');
    var tier = String(src.tierKey || src.pricingClass || '');
    if (display === 'minivan') return 'large';
    for (var i = 0; i < VEHICLE_GROUPS.length; i += 1) {
      var group = VEHICLE_GROUPS[i];
      if (display && group.displayClasses.indexOf(display) !== -1) return group.id;
    }
    for (var j = 0; j < VEHICLE_GROUPS.length; j += 1) {
      if (tier && VEHICLE_GROUPS[j].tierKeys.indexOf(tier) !== -1) return VEHICLE_GROUPS[j].id;
    }
    return null;
  }

  function vehicleGroupLabel(id) {
    var found = VEHICLE_GROUPS.find(function (group) { return group.id === id; });
    return found ? found.label : '';
  }

  function selectionFromSearch(search) {
    var params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    var ignored = [];
    URL_PRICE_KEYS.forEach(function (key) {
      if (params.has(key)) ignored.push(key);
    });
    return {
      filmId: FILM_PARAM[String(params.get('film') || '').toLowerCase()] || '',
      coverageId: COVERAGE_PARAM[String(params.get('coverage') || '').toLowerCase()] || '',
      ignoredPriceKeys: ignored,
    };
  }

  function demoCents(filmId, coverageId, groupId) {
    var row = null;
    for (var i = 0; i < DEMO_PRICE_ROWS.length; i += 1) {
      var candidate = DEMO_PRICE_ROWS[i];
      if (candidate.coverageId !== coverageId) continue;
      if (candidate.vehicleGroup === 'eligible' || candidate.vehicleGroup === groupId) {
        row = candidate;
        break;
      }
    }
    if (!row) return null;
    var cents = filmId === 'wt_film_carbon' ? row.carbonCents : (filmId === 'wt_film_ceramic' ? row.ceramicCents : null);
    return positiveCents(cents);
  }

  function commercialCents(filmId, coverageId, groupId) {
    var wantedGroup = coverageId === 'wt_cov_two_side' ? 'eligible' : groupId;
    for (var i = 0; i < COMMERCIAL_PRICE_ROWS.length; i += 1) {
      var row = COMMERCIAL_PRICE_ROWS[i];
      if (row.filmId === filmId && row.coverageId === coverageId && row.vehicleGroup === wantedGroup) {
        return positiveCents(row.amountCents);
      }
    }
    return null;
  }

  function glassList(ids) {
    return (ids || []).map(glassById).filter(Boolean).map(function (glass) {
      return { id: glass.id, label: glass.label, confirmation: glass.confirmation };
    });
  }

  function exceptionFor(glassId) {
    var list = COMMERCIAL.glassExceptions || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].glassId === glassId) return list[i];
    }
    return null;
  }

  function quote(input) {
    var src = input || {};
    var film = filmById(String(src.filmId || ''));
    var coverage = coverageById(String(src.coverageId || ''));
    var groupId = vehicleGroupFor(src);
    var removal = String(src.removal || '');
    var extraIds = Array.isArray(src.extraGlassIds) ? src.extraGlassIds.map(String) : [];
    var ignoredInputs = [];
    ['price', 'total', 'amountCents', 'durationMinutes', 'pkg', 'pkgId', 'enabled', 'commercialReady', 'bookable', 'compatible'].forEach(function (key) {
      if (src[key] != null && src[key] !== '') ignoredInputs.push(key);
    });

    var reasons = [];
    var pending = [];
    var included = coverage ? glassList(coverage.includedGlassIds) : [];
    var excluded = coverage ? glassList(coverage.excludedGlassIds) : [];

    extraIds.forEach(function (glassId) {
      if (!glassById(glassId)) return;
      var exception = exceptionFor(glassId);
      var approved = exception && exception.status === 'approved' && positiveCents(exception.amountCents);
      if (!approved) {
        pending.push(glassById(glassId));
        reasons.push(glassId);
      }
      excluded = excluded.filter(function (glass) { return glass.id !== glassId; });
      included = included.filter(function (glass) { return glass.id !== glassId; });
    });

    if (!film) reasons.push('film_missing');
    if (film && film.id === 'wt_film_help') reasons.push('film_not_chosen');
    if (!coverage) reasons.push('coverage_missing');
    if (coverage && coverage.id === 'wt_cov_unsure') reasons.push('coverage_not_chosen');
    var attemptedVehicle = !!(String(src.make || '') && String(src.model || '') && String(src.year || ''));
    if (!groupId) reasons.push(attemptedVehicle || src.displayClass || src.tierKey ? 'vehicle_not_eligible' : 'vehicle_missing');
    if (removal === 'yes' || removal === 'unsure') reasons.push('removal_review');

    var usingDemo = !commercialReady();
    var amount = null;
    if (!reasons.length && film && coverage && groupId) {
      amount = usingDemo
        ? demoCents(film.id, coverage.id, groupId)
        : commercialCents(film.id, coverage.id, groupId);
      if (amount == null) reasons.push('price_not_configured');
    }

    var evaluation = reasons.some(function (reason) { return reason !== 'vehicle_missing'; });
    var complete = !evaluation && removal === 'no' && amount != null;
    var rowLabel = '';
    if (coverage && coverage.id === 'wt_cov_two_side') rowLabel = 'Two eligible side windows';
    else if (coverage && coverage.id === 'wt_cov_sides_rear' && groupId) {
      rowLabel = 'Sides + rear — ' + vehicleGroupLabel(groupId);
    } else if (coverage) rowLabel = coverage.label;

    return {
      serviceFamily: SERVICE_FAMILY,
      enabled: COMMERCIAL.enabled === true,
      bookable: false,
      combinesWithDetailing: false,
      priceAuthority: usingDemo ? DEMO_PRICE_AUTHORITY : COMMERCIAL.priceAuthority,
      priceLabel: usingDemo ? DEMO_PRICE_LABEL : '',
      filmId: film ? film.id : '',
      filmName: film ? film.name : '',
      coverageId: coverage ? coverage.id : '',
      coverageLabel: rowLabel,
      vehicleGroup: groupId || '',
      includedGlass: included,
      excludedGlass: excluded,
      pendingGlass: glassList(pending.map(function (glass) { return glass.id; })),
      removal: removal,
      totalCents: evaluation ? null : amount,
      totalStatus: reasons.indexOf('vehicle_missing') !== -1 && !evaluation
        ? 'needs_vehicle'
        : (evaluation || amount == null ? 'evaluation_pending' : 'demo_priced'),
      durationMinutes: COMMERCIAL.durationMinutes,
      demoDurationMinutes: complete && usingDemo ? DEMO.demoDurationMinutes : null,
      scheduleStatus: complete ? 'demo_fictional' : 'evaluation_pending',
      canConfirmTime: false,
      installerResourceId: COMMERCIAL.installerResourceId,
      preparedResourceId: DEMO.preparedResourceId,
      usesDetailingCapacity: false,
      travelFeeCents: null,
      installLocation: COMMERCIAL.installLocation,
      evaluationReasons: reasons,
      ignoredInputs: ignoredInputs,
      fictionalWindows: complete ? DEMO.fictionalWindows.slice() : [],
    };
  }

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.keys(value).forEach(function (key) { freeze(value[key]); });
    Object.freeze(value);
  }
  freeze(COMMERCIAL);
  freeze(COMMERCIAL_PRICE_ROWS);
  freeze(DEMO_PRICE_ROWS);
  freeze(DEMO);

  function formatDollars(cents) {
    var amount = positiveCents(cents);
    if (amount == null) return '';
    return '$' + (amount / 100).toFixed(amount % 100 === 0 ? 0 : 2);
  }

  return {
    SERVICE_FAMILY: SERVICE_FAMILY,
    PRICE_AUTHORITY: DEMO_PRICE_AUTHORITY,
    DEMO_PRICE_LABEL: DEMO_PRICE_LABEL,
    COMMERCIAL: COMMERCIAL,
    COMMERCIAL_PRICE_ROWS: COMMERCIAL_PRICE_ROWS,
    DEMO: DEMO,
    DEMO_PRICE_ROWS: DEMO_PRICE_ROWS,
    FILMS: FILMS,
    GLASS: GLASS,
    COVERAGES: COVERAGES,
    VEHICLE_GROUPS: VEHICLE_GROUPS,
    REMOVAL: REMOVAL,
    REGISTRATION_STATES: REGISTRATION_STATES,
    URL_PRICE_KEYS: URL_PRICE_KEYS,
    filmById: filmById,
    glassById: glassById,
    coverageById: coverageById,
    vehicleGroupFor: vehicleGroupFor,
    selectionFromSearch: selectionFromSearch,
    commercialReady: commercialReady,
    quote: quote,
    formatDollars: formatDollars,
  };
});
