/*!
 * Cardetail1 — canonical Powersports physical-family metadata.
 *
 * This is the single source of truth for the 336 model rows exposed by the
 * booking surfaces.  Classification is exact make + model data, never a
 * substring guess.  Package names, package contents and dollar values do not
 * live in this module.
 *
 * UMD: browser booking pages and the Netlify pricing validator share the same
 * records and service-class → frozen-price-tier mapping.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1PowersportsCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SERVICE_CLASSES = Object.freeze({
    motorcycle: Object.freeze({
      label: 'Motorcycle',
      description: 'Standard, sport, adventure or dirt motorcycle',
      priceTier: 'motorcycle',
      bookable: true,
    }),
    motorcycle_large: Object.freeze({
      label: 'Large Motorcycle',
      description: 'Large cruiser, touring or bagger motorcycle',
      priceTier: 'motorcycle',
      bookable: true,
    }),
    motorcycle_trike: Object.freeze({
      label: 'Trike / 3-Wheel Motorcycle',
      description: 'Factory three-wheel motorcycle',
      priceTier: null,
      bookable: false,
      contactReason: 'Online Trike pricing is awaiting owner approval.',
    }),
    atv: Object.freeze({
      label: 'ATV / Quad',
      description: 'Straddle-seat all-terrain vehicle or quad',
      priceTier: 'atv',
      bookable: true,
    }),
    utv_standard: Object.freeze({
      label: 'Side-by-Side / UTV',
      description: 'Standard or non-crew side-by-side / utility vehicle',
      priceTier: 'utv',
      bookable: true,
    }),
    utv_large: Object.freeze({
      label: 'Large / Crew Side-by-Side / UTV',
      description: 'Explicit Crew, MAX, 4-seat or extended configuration',
      priceTier: 'utv',
      bookable: true,
    }),
  });

  // [make, physicalFamily, serviceClass, displaySubtype, defaultConfiguration,
  //  publicStatus, models]. A model may be [name, configuration] when its
  //  configuration is known more precisely than the group default.
  var GROUPS = [
    ['Aprilia', 'motorcycle', 'motorcycle', 'Sport motorcycle', null, 'bookable', ['RS 660', 'RSV4', 'Tuono 660', 'Tuono V4']],
    ['Arctic Cat', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['Alterra 300', 'Alterra 600', 'Alterra 700']],
    ['Arctic Cat', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Prowler Pro', 'Wildcat XX']],

    ['BMW Motorrad', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['C 400 GT', 'F 750 GS', 'F 850 GS', 'F 900 R', 'G 310 GS', 'R 1250 GS', 'R 1300 GS', 'S 1000 R', 'S 1000 RR']],
    ['BMW Motorrad', 'motorcycle', 'motorcycle_large', 'Touring motorcycle', null, 'bookable', ['K 1600']],

    ['Bobcat', 'utv', 'utv_standard', 'Utility vehicle', null, 'bookable', ['UW56', 'UW53', '3400', '3450', '3600', '3650', 'UV34']],
    ['Bobcat', 'equipment', null, 'Tractor / Equipment', null, 'contact', ['S70 Skid Steer', 'S590 Skid Steer', 'T66 Compact Track', 'CT2025 Compact Tractor', 'CT2035 Compact Tractor']],

    ['Can-Am', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Commander', 'Defender', 'Maverick R', 'Maverick X3']],
    ['Can-Am', 'utv', 'utv_large', 'Large / Crew Side-by-Side / UTV', null, 'bookable', [['Commander MAX', 'MAX'], ['Defender MAX', 'MAX']]],
    ['Can-Am', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['Outlander', 'Outlander MAX', 'Renegade']],
    ['Can-Am', 'motorcycle_trike', 'motorcycle_trike', 'Trike / 3-Wheel Motorcycle', '3-wheel', 'price_review', ['Ryker', 'Spyder F3', 'Spyder RT']],

    ['CFMOTO', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['300NK', '450SS', '650NK', '800MT']],
    ['CFMOTO', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['CForce 400', 'CForce 600', 'CForce 800']],
    ['CFMOTO', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['UForce 600', 'UForce 1000', 'ZForce 800', 'ZForce 950']],

    ['Club Car', 'golfcart', null, 'Golf Cart', null, 'contact', ['Onward', 'Precedent', 'Tempo', 'Carryall 500', 'Carryall 700', 'Villager 2', 'Villager 4', 'Villager 6']],
    ['Cub Cadet', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Challenger 400', 'Challenger 500', 'Challenger 750', 'Challenger 1000']],
    ['Cushman', 'golfcart', null, 'Golf Cart', null, 'contact', ['Hauler 800', 'Hauler 1200', 'Hauler PRO', 'Shuttle 2', 'Shuttle 6']],

    ['Ducati', 'motorcycle', 'motorcycle_large', 'Large cruiser motorcycle', null, 'bookable', ['Diavel']],
    ['Ducati', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['DesertX', 'Monster', 'Multistrada V2', 'Multistrada V4', 'Panigale V2', 'Panigale V4', 'Scrambler', 'Streetfighter V2', 'Streetfighter V4']],

    ['E-Z-GO', 'golfcart', null, 'Golf Cart', null, 'contact', ['Freedom RXV', 'Freedom TXT', 'Express S4', 'Express L6', 'Valor', 'Liberty']],
    ['Evolution', 'golfcart', null, 'Golf Cart', null, 'contact', ['D5 Maverick', 'D5 Ranger', 'Classic 4', 'Turfman 200']],

    ['Harley-Davidson', 'motorcycle', 'motorcycle_large', 'Large cruiser / touring / bagger motorcycle', null, 'bookable', ['Breakout', 'Fat Bob', 'Fat Boy', 'Heritage Classic', 'Iron 883', 'Low Rider S', 'Nightster', 'Road Glide', 'Road King', 'Softail Standard', 'Sport Glide', 'Street Bob', 'Street Glide', 'Ultra Limited']],
    ['Harley-Davidson', 'motorcycle', 'motorcycle', 'Adventure motorcycle', null, 'bookable', ['Pan America']],

    ['Hisun', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Sector 750', 'Sector 1000', 'Strike 1000', 'Tactic 750', 'HS 500', 'HS 700']],

    ['Honda', 'motorcycle', 'motorcycle', 'Adventure motorcycle', null, 'bookable', ['Africa Twin']],
    ['Honda', 'motorcycle', 'motorcycle', 'Naked / standard motorcycle', null, 'bookable', ['CB500F', 'CB650R']],
    ['Honda', 'motorcycle', 'motorcycle', 'Sport motorcycle', null, 'bookable', ['CBR500R', 'CBR600RR', 'CBR1000RR']],
    ['Honda', 'motorcycle', 'motorcycle', 'Dirt / dual-sport motorcycle', null, 'bookable', ['CRF110F', 'CRF250F', 'CRF300L', 'CRF450R']],
    ['Honda', 'motorcycle', 'motorcycle', 'Cruiser', null, 'bookable', ['Rebel 300', 'Rebel 500']],
    ['Honda', 'motorcycle', 'motorcycle_large', 'Touring motorcycle', null, 'bookable', ['Gold Wing']],
    ['Honda', 'motorcycle', 'motorcycle_large', 'Cruiser', null, 'bookable', ['Rebel 1100']],
    ['Honda', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['FourTrax Foreman', 'FourTrax Rancher', 'Rincon', 'TRX250X']],
    ['Honda', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Pioneer 500', 'Pioneer 700', 'Pioneer 1000', 'Talon 1000']],

    ['Husqvarna', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['701 Enduro', '701 Supermoto', 'FC 250', 'FC 450', 'FE 350', 'FE 501', 'Norden 901', 'Svartpilen', 'Vitpilen']],
    ['Icon EV', 'golfcart', null, 'Golf Cart', null, 'contact', ['i40', 'i40L', 'i60', 'i60L', 'i80']],

    ['Intimidator', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['GC1K', '750', '1000']],
    ['Intimidator', 'utv', 'utv_large', 'Large / Crew Side-by-Side / UTV', 'Crew', 'bookable', ['GC1K Crew']],

    ['John Deere', 'utv', 'utv_standard', 'Utility vehicle', null, 'bookable', ['Gator HPX', 'Gator TH', 'Gator TS', 'Gator TX', 'Gator XUV560', 'Gator XUV590', 'Gator XUV835', 'Gator XUV835M', 'Gator XUV865', 'Gator RSX860']],

    ['Indian Motorcycle', 'motorcycle', 'motorcycle_large', 'Large cruiser / touring / bagger motorcycle', null, 'bookable', ['Challenger', 'Chief', 'Chieftain', 'Pursuit', 'Roadmaster', 'Springfield']],
    ['Indian Motorcycle', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['FTR', 'Scout']],

    ['Kawasaki', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['Brute Force 300', 'Brute Force 750']],
    ['Kawasaki', 'motorcycle', 'motorcycle_large', 'Large touring motorcycle', null, 'bookable', ['Concours 14']],
    ['Kawasaki', 'pwc', null, 'Jet Ski / PWC', null, 'route_boats', ['Jet Ski STX 160', 'Jet Ski SX-R', 'Jet Ski Ultra 160', 'Jet Ski Ultra 310']],
    ['Kawasaki', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['KLR650', 'KX250', 'KX450', 'Ninja 400', 'Ninja 500', 'Ninja 650', 'Ninja ZX-6R', 'Ninja ZX-10R', 'Versys 650', 'Vulcan S', 'Z650', 'Z900']],
    ['Kawasaki', 'utv', 'utv_large', 'Large / Crew Side-by-Side / UTV', 'Trans Cab / extended', 'bookable', ['Mule Pro-DXT', 'Mule Pro-FXT']],
    ['Kawasaki', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Teryx', 'Teryx KRX 1000']],

    ['KTM', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['250 SX-F', '300 XC-W', '350 EXC-F', '450 SX-F', '690 Enduro R', '790 Adventure', '890 Adventure', '1290 Super Adventure', 'Duke 390', 'Duke 790', 'Duke 890', 'RC 390']],

    ['Kubota', 'utv', 'utv_standard', 'Utility vehicle', null, 'bookable', ['RTV-X900', 'RTV-X1100C', 'RTV520', 'Sidekick']],
    ['Kubota', 'utv', 'utv_large', 'Large / Crew Side-by-Side / UTV', '4-seat convertible', 'bookable', ['RTV-X1140']],
    ['Kubota', 'equipment', null, 'Tractor / Equipment', null, 'contact', ['BX1880', 'BX2380', 'LX2610', 'L2501', 'L3301']],

    ['Mahindra', 'utv', 'utv_standard', 'Utility vehicle', null, 'bookable', ['mPact XTV 750S', 'Retriever 1000']],
    ['Mahindra', 'utv', 'utv_large', 'Large / Crew Side-by-Side / UTV', '4-seat', 'bookable', ['mPact XTV 750S-4']],

    ['Massimo', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['T-Boss 550', 'T-Boss 750', 'T-Boss 1000']],
    ['Massimo', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['MSA 550', 'MSA 750']],

    ['Polaris', 'atv', 'atv', 'ATV / Quad', null, 'bookable', [['ACE', 'single-seat'], 'Scrambler 850', 'Sportsman 450', 'Sportsman 570', 'Sportsman 850', 'Sportsman XP 1000']],
    ['Polaris', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['General 1000', 'Ranger 500', 'Ranger 570', 'Ranger 1000', 'RZR 200', 'RZR Trail', 'RZR XP', 'RZR Pro R', 'RZR Turbo R']],
    ['Polaris', 'utv', 'utv_large', 'Large / Crew Side-by-Side / UTV', null, 'bookable', [['General XP 4', '4-seat'], ['Ranger Crew', 'Crew']]],
    ['Polaris', 'motorcycle_trike', 'motorcycle_trike', 'Trike / 3-Wheel Motorcycle', '3-wheel', 'price_review', ['Slingshot']],

    ['Sea-Doo', 'pwc', null, 'Jet Ski / PWC', null, 'route_boats', ['Explorer Pro', 'FishPro Scout', 'FishPro Sport', 'FishPro Trophy', 'GTR', 'GTR-X', 'GTI', 'GTI SE', 'GTX', 'GTX Limited', 'RXP-X', 'RXT-X', 'Spark', 'Spark Trixx', 'Wake', 'Wake Pro']],
    ['Sea-Doo', 'boat', null, 'Pontoon boat', 'pontoon', 'route_boats', ['Switch', 'Switch Cruise']],

    ['Segway', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Villain SX10', 'Villain SX8', 'Fugleman UT10', 'Fugleman UT10 X']],
    ['Segway', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['Snarler AT6']],

    ['Suzuki', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['Boulevard C50', 'DR-Z400', 'GSX-8R', 'GSX-R600', 'GSX-R750', 'GSX-R1000', 'Hayabusa', 'V-Strom 650', 'V-Strom 800', 'V-Strom 1050']],
    ['Suzuki', 'motorcycle', 'motorcycle_large', 'Large cruiser motorcycle', null, 'bookable', ['Boulevard M109R']],
    ['Suzuki', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['KingQuad 400', 'KingQuad 500', 'KingQuad 750']],

    ['Tracker Off Road', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['300']],
    ['Tracker Off Road', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['500', '800SX']],
    ['Tracker Off Road', 'utv', 'utv_large', 'Large / Crew Side-by-Side / UTV', 'Crew', 'bookable', ['800SX Crew']],

    ['Triumph', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['Bonneville', 'Daytona 660', 'Scrambler 1200', 'Speed Triple', 'Street Triple', 'Tiger 660', 'Tiger 900', 'Tiger 1200', 'Trident 660']],
    ['Triumph', 'motorcycle', 'motorcycle_large', 'Large cruiser motorcycle', null, 'bookable', ['Rocket 3']],
    ['Vespa', 'motorcycle', 'motorcycle', 'Scooter', null, 'bookable', ['GTS', 'GTV', 'Primavera', 'Sprint']],

    ['Yamaha', 'motorcycle', 'motorcycle', 'Motorcycle', null, 'bookable', ['Bolt', 'MT-03', 'MT-07', 'MT-09', 'MT-10', 'Tenere 700', 'WR250F', 'YZ250F', 'YZ450F', 'YZF-R3', 'YZF-R6', 'YZF-R7', 'YZF-R1']],
    ['Yamaha', 'motorcycle', 'motorcycle_large', 'Large touring motorcycle', null, 'bookable', ['FJR1300', 'Star Venture']],
    ['Yamaha', 'atv', 'atv', 'ATV / Quad', null, 'bookable', ['Grizzly 90', 'Grizzly EPS', 'Kodiak 450', 'Kodiak 700', 'Raptor 700R']],
    ['Yamaha', 'pwc', null, 'Jet Ski / PWC', null, 'route_boats', ['WaveRunner EX', 'WaveRunner FX', 'WaveRunner GP HO', 'WaveRunner GP SVHO', 'WaveRunner JetBlaster', 'WaveRunner VX']],
    ['Yamaha', 'utv', 'utv_standard', 'Side-by-Side / UTV', null, 'bookable', ['Viking', 'Wolverine', 'Wolverine RMAX']],

    ['Yamaha Golf', 'golfcart', null, 'Golf Cart', null, 'contact', ['Drive2', 'Drive2 PTV', 'Adventurer Sport', 'The Drive']],
    ['Zero Motorcycles', 'motorcycle', 'motorcycle', 'Electric motorcycle', null, 'bookable', ['DS', 'DSR/X', 'FX', 'FXE', 'S', 'SR/F', 'SR/S']],
  ];

  function key(make, model) {
    return String(make || '').trim().toLowerCase() + '\u0000' + String(model || '').trim().toLowerCase();
  }

  var records = [];
  var byKey = Object.create(null);
  GROUPS.forEach(function (group) {
    var make = group[0];
    var physicalFamily = group[1];
    var serviceClass = group[2];
    var displaySubtype = group[3];
    var defaultConfiguration = group[4];
    var publicStatus = group[5];
    group[6].forEach(function (entry) {
      var model = Array.isArray(entry) ? entry[0] : entry;
      var configuration = Array.isArray(entry) ? entry[1] : defaultConfiguration;
      var record = Object.freeze({
        make: make,
        model: model,
        physicalFamily: physicalFamily,
        serviceClass: serviceClass,
        displaySubtype: displaySubtype,
        configuration: configuration || null,
        publicStatus: publicStatus,
      });
      var recordKey = key(make, model);
      if (byKey[recordKey]) throw new Error('Duplicate Powersports model metadata: ' + make + ' ' + model);
      byKey[recordKey] = record;
      records.push(record);
    });
  });
  records = Object.freeze(records);

  if (records.length !== 336) {
    throw new Error('Powersports catalog must contain exactly 336 explicit rows; found ' + records.length);
  }

  function resolve(make, model) {
    return byKey[key(make, model)] || null;
  }

  function classDefinition(serviceClass) {
    return SERVICE_CLASSES[String(serviceClass || '')] || null;
  }

  function priceTierForServiceClass(serviceClass) {
    var def = classDefinition(serviceClass);
    return def && def.bookable ? def.priceTier : null;
  }

  function isPublicBookableServiceClass(serviceClass) {
    var def = classDefinition(serviceClass);
    return !!(def && def.bookable && def.priceTier);
  }

  function toModelsByMake(filter) {
    var out = {};
    records.forEach(function (record) {
      if (filter && !filter(record)) return;
      if (!out[record.make]) out[record.make] = [];
      out[record.make].push(record.model);
    });
    return out;
  }

  function powersportsModelsByMake() {
    return toModelsByMake(function (record) {
      return record.publicStatus !== 'route_boats';
    });
  }

  function pwcModelsByMake() {
    return toModelsByMake(function (record) { return record.physicalFamily === 'pwc'; });
  }

  function pontoonModelsByMake() {
    return toModelsByMake(function (record) { return record.physicalFamily === 'boat'; });
  }

  function fallbackOptions() {
    return Object.keys(SERVICE_CLASSES).map(function (serviceClass) {
      var def = SERVICE_CLASSES[serviceClass];
      return Object.freeze({
        serviceClass: serviceClass,
        label: def.label,
        description: def.description,
        priceTier: def.priceTier,
        bookable: def.bookable,
      });
    });
  }

  function counts() {
    var out = { total: records.length };
    records.forEach(function (record) {
      var bucket = record.serviceClass || record.physicalFamily;
      out[bucket] = (out[bucket] || 0) + 1;
    });
    return out;
  }

  return Object.freeze({
    records: records,
    serviceClasses: SERVICE_CLASSES,
    resolve: resolve,
    classDefinition: classDefinition,
    priceTierForServiceClass: priceTierForServiceClass,
    isPublicBookableServiceClass: isPublicBookableServiceClass,
    powersportsModelsByMake: powersportsModelsByMake,
    pwcModelsByMake: pwcModelsByMake,
    pontoonModelsByMake: pontoonModelsByMake,
    allModelsByMake: function () { return toModelsByMake(); },
    fallbackOptions: fallbackOptions,
    counts: counts,
  });
});
