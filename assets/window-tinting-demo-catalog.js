/**
 * Window tint demonstration catalog.
 *
 * Kept apart from the production price catalog, paint-coating packages,
 * booking submission, and the schedule. Amounts stay empty until a reviewed
 * commercial table is supplied in this file. Vehicle size never changes the
 * total. URL prices are ignored. This module cannot create a booking.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1WindowTintDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SERVICE_FAMILY = 'window_tint';
  var PRICE_AUTHORITY = 'window-tinting-demo-catalog';

  var FILMS = [
    {
      id: 'wt_film_carbon',
      name: 'Carbon Window Tint',
      summary: 'A color film that changes how dark the glass looks and can soften glare. Heat control is a separate property and is not given as a number here.',
    },
    {
      id: 'wt_film_ceramic',
      name: 'Ceramic Window Tint',
      summary: 'A different film from carbon. Shade and heat control are separate, and this film is not ceramic coating for paint.',
    },
    {
      id: 'wt_film_help',
      name: 'Help me choose',
      summary: 'No film is selected. This preview does not generate a recommendation.',
    },
  ];

  var GLASS = [
    {
      id: 'wt_glass_front_sides',
      label: 'Front side windows',
      confirmation: 'rules_review',
      note: 'Driver and front passenger glass are not treated as allowed at every shade. The registration state has to be reviewed before this can be confirmed.',
    },
    {
      id: 'wt_glass_rear_sides',
      label: 'Rear side windows',
      confirmation: 'requested',
      note: 'Requested coverage only. A shade is not chosen here, and this is not a booked install.',
    },
    {
      id: 'wt_glass_rear',
      label: 'Rear window',
      confirmation: 'requested',
      note: 'Requested coverage only. A shade is not chosen here, and this is not a booked install.',
    },
    {
      id: 'wt_glass_windshield',
      label: 'Windshield',
      confirmation: 'specific_evaluation',
      note: 'Specific evaluation. Checking this does not confirm windshield film.',
    },
    {
      id: 'wt_glass_roof',
      label: 'Roof glass',
      confirmation: 'specific_evaluation',
      note: 'Specific evaluation. Checking this does not confirm film on a sunroof or panoramic roof.',
    },
    {
      id: 'wt_glass_unsure',
      label: 'Not sure which glass',
      confirmation: 'needs_choice',
      note: 'The glass still has to be matched. This preview does not choose it for you.',
    },
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

  var URL_PRICE_KEYS = ['price', 'total', 'amount', 'cents', 'pkg', 'pkgid', 'package', 'duration', 'minutes'];

  function filmById(id) {
    return FILMS.find(function (film) { return film.id === id; }) || null;
  }

  function glassById(id) {
    return GLASS.find(function (glass) { return glass.id === id; }) || null;
  }

  /**
   * Demonstration price rows. amountCents is null on purpose.
   * No commercial price sheet is in the repository, so this preview
   * does not invent one. summable is true only for ordinary requested
   * glass, and even those rows have no amount.
   */
  var DEMO_PRICE_TABLE = (function () {
    var rows = [];
    FILMS.forEach(function (film) {
      if (film.id === 'wt_film_help') return;
      GLASS.forEach(function (glass) {
        if (glass.id === 'wt_glass_unsure') return;
        rows.push(Object.freeze({
          filmId: film.id,
          glassId: glass.id,
          amountCents: null,
          currency: 'usd',
          summable: glass.confirmation === 'requested',
          confirmation: glass.confirmation,
          source: 'demo_table_unpriced',
        }));
      });
    });
    return Object.freeze(rows);
  })();

  function selectionFromSearch(search) {
    var params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    var raw = String(params.get('film') || '').toLowerCase();
    var map = {
      carbon: 'wt_film_carbon',
      wt_film_carbon: 'wt_film_carbon',
      ceramic: 'wt_film_ceramic',
      wt_film_ceramic: 'wt_film_ceramic',
      help: 'wt_film_help',
      wt_film_help: 'wt_film_help',
    };
    var ignored = [];
    URL_PRICE_KEYS.forEach(function (key) {
      if (params.has(key)) ignored.push(key);
    });
    return {
      filmId: map[raw] || '',
      ignoredPriceKeys: ignored,
    };
  }

  function totalCentsForLines(lines) {
    var summable = (lines || []).filter(function (line) { return line && line.summable === true; });
    if (!summable.length) return { totalCents: null, status: 'unpriced' };
    var sum = 0;
    for (var i = 0; i < summable.length; i += 1) {
      var cents = summable[i].amountCents;
      if (!Number.isInteger(cents) || cents < 0) return { totalCents: null, status: 'unpriced' };
      sum += cents;
    }
    return { totalCents: sum, status: 'demo_sum' };
  }

  function quote(input, options) {
    var src = input || {};
    var table = (options && options.table) || DEMO_PRICE_TABLE;
    var film = filmById(String(src.filmId || ''));
    var glassIds = Array.isArray(src.glassIds) ? src.glassIds.map(String) : [];
    var lines = [];
    var ignoredInputs = [];
    ['price', 'total', 'amountCents', 'durationMinutes', 'pkg', 'pkgId', 'tierKey'].forEach(function (key) {
      if (src[key] != null && src[key] !== '') ignoredInputs.push(key);
    });

    if (film && film.id !== 'wt_film_help') {
      glassIds.forEach(function (glassId) {
        var glass = glassById(glassId);
        if (!glass || glass.id === 'wt_glass_unsure') {
          if (glass && glass.id === 'wt_glass_unsure') {
            lines.push({
              id: film.id + ':' + glass.id,
              filmId: film.id,
              glassId: glass.id,
              label: glass.label,
              confirmation: glass.confirmation,
              summable: false,
              amountCents: null,
            });
          }
          return;
        }
        var row = null;
        for (var i = 0; i < table.length; i += 1) {
          if (table[i].filmId === film.id && table[i].glassId === glass.id) {
            row = table[i];
            break;
          }
        }
        var summable = glass.confirmation === 'requested' && !!(row && row.summable === true);
        lines.push({
          id: film.id + ':' + glass.id,
          filmId: film.id,
          glassId: glass.id,
          label: film.name + ' — ' + glass.label,
          confirmation: glass.confirmation,
          summable: summable,
          amountCents: summable ? row.amountCents : null,
        });
      });
    } else if (film) {
      lines.push({
        id: 'wt_film_help',
        filmId: film.id,
        glassId: '',
        label: 'Help me choose',
        confirmation: 'needs_choice',
        summable: false,
        amountCents: null,
      });
      glassIds.forEach(function (glassId) {
        var glass = glassById(glassId);
        if (!glass) return;
        lines.push({
          id: 'help:' + glass.id,
          filmId: film.id,
          glassId: glass.id,
          label: glass.label,
          confirmation: glass.confirmation,
          summable: false,
          amountCents: null,
        });
      });
    }

    var removal = String(src.removal || '');
    if (removal === 'yes') {
      lines.push({
        id: 'wt_removal_yes',
        filmId: film ? film.id : '',
        glassId: '',
        label: 'Remove existing film',
        confirmation: 'specific_evaluation',
        summable: false,
        amountCents: null,
      });
    }

    var total = totalCentsForLines(lines);
    return {
      serviceFamily: SERVICE_FAMILY,
      priceAuthority: PRICE_AUTHORITY,
      bookable: false,
      combinesWithDetailing: false,
      durationMinutes: null,
      installerResourceId: null,
      scheduleStatus: 'installer_capacity_unknown',
      filmId: film ? film.id : '',
      lines: lines,
      totalCents: total.totalCents,
      totalStatus: total.status,
      ignoredInputs: ignoredInputs,
    };
  }

  return {
    SERVICE_FAMILY: SERVICE_FAMILY,
    PRICE_AUTHORITY: PRICE_AUTHORITY,
    FILMS: FILMS,
    GLASS: GLASS,
    REMOVAL: REMOVAL,
    REGISTRATION_STATES: REGISTRATION_STATES,
    DEMO_PRICE_TABLE: DEMO_PRICE_TABLE,
    URL_PRICE_KEYS: URL_PRICE_KEYS,
    filmById: filmById,
    glassById: glassById,
    selectionFromSearch: selectionFromSearch,
    totalCentsForLines: totalCentsForLines,
    quote: quote,
  };
});
