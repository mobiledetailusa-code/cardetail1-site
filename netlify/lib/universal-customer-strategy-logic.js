// Shared strategy logic — config is injected from shared/universal-customer-strategy-config.json

const SPECIALTY_ROUTE_CATEGORIES = new Set([
  'boats', 'boat', 'rvs', 'rv', 'trailers', 'trailer', 'powersports', 'motorcycle', 'atv', 'utv',
]);

function createUniversalStrategy(config, options) {
  const classifyFn = options && typeof options.classifySegment === 'function'
    ? options.classifySegment
    : null;
  const segmentIds = Object.freeze({ ...config.segmentIds });
  const conversionPaths = Object.freeze(
    Object.fromEntries(
      Object.entries(config.conversionPaths).map(([k, v]) => [k, Object.freeze({ ...v })])
    )
  );
  const offerExcluded = new Set(config.offerExcludedSegments || []);

  function getConversionPath(segment) {
    return conversionPaths[segment] || conversionPaths[segmentIds.SINGLE_VEHICLE_NEW];
  }

  function getRoutingControls(segment) {
    const path = getConversionPath(segment);
    return {
      servicePath: path.servicePath,
      catalogVisible: path.catalogVisible === true,
      standardBookingAllowed: path.standardBookingAllowed === true,
      quoteRequired: path.quoteRequired === true,
      manualReviewRequired: path.manualReviewRequired === true,
      discardLead: path.discardLead === true,
    };
  }

  function followUpTier(intentScore, householdValueScore, segment) {
    const intent = Math.max(0, Number(intentScore) || 0);
    const household = Math.max(0, Number(householdValueScore) || 0);
    const path = getConversionPath(segment);
    const boost = path.growthBoost || 0;
    const effective = intent + Math.min(boost, household);
    if (intent >= 70) return 'immediate';
    if (effective >= 55 || intent >= 40) return 'priority';
    if (effective >= 25 || intent >= 20) return 'scheduled';
    return 'nurture';
  }

  function getOfferEligibility(segment, ctx) {
    const path = getConversionPath(segment);
    const enabled = ctx && ctx.offersEnabled;
    if (!enabled || offerExcluded.has(segment)) return [];
    return (path.offerIds || []).slice();
  }

  function assertServiceRouting(segment) {
    return getRoutingControls(segment);
  }

  function buildClassifyInput(ctx) {
    const c = ctx || {};
    const categories = [];
    if (c.category) categories.push(String(c.category).toLowerCase());
    if (Array.isArray(c.assetCategories)) {
      c.assetCategories.forEach((item) => categories.push(String(item).toLowerCase()));
    }
    if (Array.isArray(c.categories)) {
      c.categories.forEach((item) => categories.push(String(item).toLowerCase()));
    }
    const vehicleCount = Math.max(0, Number(c.vehicleCount || c.personalVehicleCount || 0));
    return {
      vehicleCount,
      vehicles: Array.isArray(c.vehicles) ? c.vehicles : [],
      assetCategories: categories,
      categories,
      unsupportedZip: c.unsupportedZip === true,
      unsupportedService: c.unsupportedService === true,
      isCommercial: c.isCommercial === true || String(c.category || '').toLowerCase() === 'fleet'
        || c.ownership === 'business',
      completedServices: Math.max(0, Number(c.completedServices || 0)),
      maintenanceFrequency: c.maintenanceFrequency,
      maintenanceInterest: c.maintenanceInterest,
      ownership: c.ownership,
    };
  }

  function makeRouteResult(route, segment, routing, extra) {
    const path = getConversionPath(segment);
    const out = extra || {};
    return {
      route,
      allowed: out.allowed !== false,
      code: out.code || null,
      reason: out.reason || null,
      segment,
      routing,
      servicePath: path.servicePath,
      message: { headline: path.headline, subline: path.subline },
      altRoute: out.altRoute || null,
    };
  }

  function routeServiceIntent(ctx) {
    const c = ctx || {};
    if (c.securityViolation === true || c.abuseFlag === true || c.invalidRequest === true) {
      const fallbackSeg = segmentIds.SINGLE_VEHICLE_NEW;
      return makeRouteResult('rejected_for_security_only', fallbackSeg, getRoutingControls(fallbackSeg), {
        allowed: false,
        code: 'security_violation',
        reason: 'security_violation',
      });
    }

    const category = String(c.category || '').toLowerCase();
    const segmentResult = classifyFn
      ? classifyFn(buildClassifyInput(c))
      : { segment: segmentIds.SINGLE_VEHICLE_NEW, reasons: ['strategy_fallback'] };
    const segment = segmentResult.segment || segmentIds.SINGLE_VEHICLE_NEW;
    const routing = getRoutingControls(segment);
    const path = getConversionPath(segment);
    const vehicleCount = Math.max(0, Number(c.vehicleCount || 0));

    if (category === 'fleet') {
      return makeRouteResult('fleet_quote', segmentIds.COMMERCIAL_FLEET, getRoutingControls(segmentIds.COMMERCIAL_FLEET), {
        allowed: false,
        code: 'fleet_quote_required',
        reason: 'fleet_category',
      });
    }

    if (!routing.standardBookingAllowed) {
      if (routing.quoteRequired) {
        return makeRouteResult('fleet_quote', segment, routing, {
          allowed: false,
          code: 'fleet_quote_required',
          reason: (segmentResult.reasons && segmentResult.reasons[0]) || 'quote_required',
        });
      }
      if (routing.manualReviewRequired) {
        return makeRouteResult('manual_review', segment, routing, {
          allowed: false,
          code: 'manual_review_required',
          reason: (segmentResult.reasons && segmentResult.reasons[0]) || 'manual_review_required',
        });
      }
      return makeRouteResult('rejected_for_security_only', segment, routing, {
        allowed: false,
        code: 'standard_booking_not_allowed',
        reason: 'routing_blocked',
      });
    }

    if (SPECIALTY_ROUTE_CATEGORIES.has(category) || path.servicePath === 'specialty_booking' && SPECIALTY_ROUTE_CATEGORIES.has(category)) {
      return makeRouteResult('specialty_booking', segment, routing, { allowed: true, code: null });
    }

    if (c.source === 'garage_plan' || c.explicitGaragePlan === true) {
      return makeRouteResult('garage_plan', segment, routing, { allowed: true, code: null });
    }

    if (path.servicePath === 'garage_plan_or_booking' && vehicleCount >= 2) {
      return makeRouteResult('standard_booking', segment, routing, {
        allowed: true,
        code: null,
        altRoute: 'garage_plan',
      });
    }

    return makeRouteResult('standard_booking', segment, routing, { allowed: true, code: null });
  }

  return {
    CONFIG_VERSION: config.version,
    SEGMENTS: segmentIds,
    CONVERSION_PATHS: conversionPaths,
    getConversionPath,
    getRoutingControls,
    followUpTier,
    getOfferEligibility,
    assertServiceRouting,
    routeServiceIntent,
    buildClassifyInput,
  };
}

module.exports = { createUniversalStrategy };
