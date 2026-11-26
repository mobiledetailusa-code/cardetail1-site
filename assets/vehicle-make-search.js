/**
 * Car make search for the booking vehicle step.
 *
 * Matching only: it never invents a make. Every result is one of the canonical
 * names passed in (the page's MAKES list, projected from the vehicle catalog),
 * so nicknames resolve to existing makes and no duplicate make is created.
 * Vehicle class and price still come from the catalog and the server.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1MakeSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Normalized nickname -> canonical make. Range Rover is a Land Rover model
  // line in the catalog, so it resolves to the Land Rover make.
  var ALIASES = {
    chevy: 'Chevrolet',
    chev: 'Chevrolet',
    vw: 'Volkswagen',
    volkswagon: 'Volkswagen',
    benz: 'Mercedes-Benz',
    mercedes: 'Mercedes-Benz',
    merc: 'Mercedes-Benz',
    mb: 'Mercedes-Benz',
    rangerover: 'Land Rover',
    landrover: 'Land Rover',
    caddy: 'Cadillac',
    caddie: 'Cadillac',
    bimmer: 'BMW',
    beemer: 'BMW',
    infinity: 'INFINITI',
    lambo: 'Lamborghini',
    rollsroyce: 'Rolls-Royce',
    vette: 'Chevrolet',
  };

  // Shown next to the canonical name so the customer sees why it matched.
  var ALIAS_NOTES = {
    rangerover: 'Range Rover',
    vette: 'Corvette',
  };

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  function canonicalIn(makes, name) {
    var key = norm(name);
    for (var i = 0; i < makes.length; i += 1) {
      if (norm(makes[i]) === key) return makes[i];
    }
    return null;
  }

  /** Exact make or exact nickname, else null. */
  function exactMake(query, makes) {
    var q = norm(query);
    if (!q || !Array.isArray(makes)) return null;
    var direct = canonicalIn(makes, q);
    if (direct) return direct;
    if (Object.prototype.hasOwnProperty.call(ALIASES, q)) return canonicalIn(makes, ALIASES[q]);
    return null;
  }

  /**
   * Ranked suggestions: exact match, then names starting with the query, then
   * names containing it. Nicknames match by prefix once 2+ characters are typed.
   * Returns [{ make, note }] with each canonical make at most once.
   */
  function searchMakes(query, makes) {
    var q = norm(query);
    if (!q || !Array.isArray(makes)) return [];
    var seen = {};
    var buckets = [[], [], []];
    function add(rank, make, note) {
      if (!make || seen[make]) return;
      seen[make] = true;
      buckets[rank].push({ make: make, note: note || '' });
    }
    makes.forEach(function (m) {
      var k = norm(m);
      if (!k) return;
      if (k === q) add(0, m);
      else if (k.indexOf(q) === 0) add(1, m);
      else if (k.indexOf(q) > 0) add(2, m);
    });
    if (q.length >= 2) {
      Object.keys(ALIASES).forEach(function (alias) {
        var make = canonicalIn(makes, ALIASES[alias]);
        if (!make) return;
        var note = ALIAS_NOTES[alias] || '';
        if (alias === q) add(0, make, note);
        else if (alias.indexOf(q) === 0) add(1, make, note);
      });
    }
    return buckets[0].concat(buckets[1], buckets[2]);
  }

  return { norm: norm, exactMake: exactMake, searchMakes: searchMakes, ALIASES: ALIASES };
});
