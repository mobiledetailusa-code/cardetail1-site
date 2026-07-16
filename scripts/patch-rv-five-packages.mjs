#!/usr/bin/env node
import fs from 'fs';

const nlDetect = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

const packages = `<section class="sp-section" id="packages">
  <div class="sp-sec-eye">RV &amp; Trailer Packages</div>
  <h2 class="sp-sec-title">Choose Your Mobile RV &amp; Trailer Detailing Package</h2>
  <p class="sp-sec-copy">Five clear packages. Every card lists the surfaces and tasks included. Most owners choose Premium Complete RV Detail.</p>

  <div class="rv-length-bar" id="rv-length-bar" data-rv-length-control>
    <label class="rv-length-label" for="rv-length-range">RV length</label>
    <div class="rv-length-row">
      <input class="rv-length-range" id="rv-length-range" type="range" min="12" max="45" value="" step="1" aria-valuemin="12" aria-valuemax="45" aria-describedby="rv-length-hint">
      <div class="rv-length-value"><span id="rv-length-val">—</span> ft</div>
    </div>
    <p class="rv-length-hint" id="rv-length-hint">Select your exact RV length to see your estimated total. Package cards show a starting per-foot rate.</p>
  </div>

  <div class="sp-pkg-grid rv-pkg-grid">
    <article class="sp-pkg-card" data-rv-tier="maint" data-per-ft="8" data-min="129">
      <h3 class="sp-pkg-name">Maintenance Wash</h3>
      <p class="sp-pkg-tag">Keep your RV clean, protected and ready for the road.</p>
      <div class="sp-pkg-price" data-rv-price>Starting at $8/ft</div>
      <div class="sp-pkg-basis" data-rv-basis>Select your exact RV length to see your estimated total.</div>
      <div class="sp-pkg-minote">Minimum mobile service charge: $129</div>
      <div class="sp-pkg-time">Service duration depends on RV size, condition and crew assigned.</div>
      <ul class="sp-pkg-feats">
        <li>Exterior hand wash</li>
        <li>Bug and light road-film removal</li>
        <li>Exterior windows and mirrors</li>
        <li>Wheels cleaned</li>
        <li>Tire shine</li>
        <li>Quick machine-applied wax or sealant</li>
        <li>Final exterior inspection</li>
      </ul>
      <p class="sp-pkg-limit">Roof excluded. Heavy black streaks, oxidation and severe water spots are not included.</p>
      <button type="button" class="sp-btn sp-btn-primary sp-btn-block package-booking-cta" data-booking-category="rvs" data-booking-package="maint">Select This RV Package</button>
    </article>

    <article class="sp-pkg-card" data-rv-tier="maint_light" data-per-ft="15" data-min="229">
      <h3 class="sp-pkg-name">Maintenance Wash + Light Interior</h3>
      <p class="sp-pkg-tag">Exterior maintenance plus a quick interior refresh.</p>
      <div class="sp-pkg-price" data-rv-price>Starting at $15/ft</div>
      <div class="sp-pkg-basis" data-rv-basis>Select your exact RV length to see your estimated total.</div>
      <div class="sp-pkg-minote">Minimum mobile service charge: $229</div>
      <div class="sp-pkg-time">Service duration depends on RV size, condition and crew assigned.</div>
      <p class="sp-pkg-why"><strong>Exterior includes:</strong></p>
      <ul class="sp-pkg-feats">
        <li>Exterior hand wash</li>
        <li>Exterior windows and mirrors</li>
        <li>Wheels cleaned</li>
        <li>Tire shine</li>
        <li>Quick machine-applied wax or sealant</li>
      </ul>
      <p class="sp-pkg-why"><strong>Light interior includes:</strong></p>
      <ul class="sp-pkg-feats">
        <li>Vacuum accessible floors and seating areas</li>
        <li>Driver cabin vacuum and wipe-down</li>
        <li>Tables and countertops wiped clean</li>
        <li>Kitchen surfaces and sink wiped clean</li>
        <li>Stove exterior cleaned</li>
        <li>Bathroom surfaces wiped clean</li>
        <li>Interior mirrors and glass</li>
        <li>Accessible trash removal</li>
      </ul>
      <p class="sp-pkg-limit">Not included: upholstery shampoo, carpet extraction, pet hair, odor treatment, refrigerator interior, oven interior, cabinet interiors, bed making, roof cleaning.</p>
      <button type="button" class="sp-btn sp-btn-primary sp-btn-block package-booking-cta" data-booking-category="rvs" data-booking-package="maint_light">Select This RV Package</button>
    </article>

    <article class="sp-pkg-card" data-rv-tier="interior" data-per-ft="20" data-min="249">
      <h3 class="sp-pkg-name">Interior Detail</h3>
      <p class="sp-pkg-tag">A complete interior cleaning from the driver cabin to the living area.</p>
      <div class="sp-pkg-price" data-rv-price>Starting at $20/ft</div>
      <div class="sp-pkg-basis" data-rv-basis>Select your exact RV length to see your estimated total.</div>
      <div class="sp-pkg-minote">Minimum mobile service charge: $249</div>
      <div class="sp-pkg-time">Service duration depends on RV size, condition and crew assigned.</div>
      <ul class="sp-pkg-feats">
        <li>Full interior vacuum</li>
        <li>Carpet and upholstery shampoo</li>
        <li>Driver cabin detailing</li>
        <li>Dashboard and high-touch surfaces</li>
        <li>Tables and countertops</li>
        <li>Leather cleaning and conditioning where applicable</li>
        <li>Kitchen sink and stove cleaning</li>
        <li>Refrigerator interior when empty</li>
        <li>Oven interior when empty and cool</li>
        <li>Bathroom surfaces</li>
        <li>Interior windows and mirrors</li>
        <li>Cabinet exteriors</li>
        <li>Cabinet interiors when completely emptied</li>
        <li>Accessible floor mats</li>
        <li>Bed neatly made when clean linens are provided</li>
        <li>Final interior inspection</li>
      </ul>
      <p class="sp-pkg-limit">Personal belongings must be removed. Refrigerator, oven and cabinet interiors must be empty. Heavy staining, excessive pet hair and strong odors may require Super Interior or separate pricing.</p>
      <button type="button" class="sp-btn sp-btn-primary sp-btn-block package-booking-cta" data-booking-category="rvs" data-booking-package="interior">Select This RV Package</button>
    </article>

    <article class="sp-pkg-card" data-rv-tier="premium" data-per-ft="31" data-min="449">
      <h3 class="sp-pkg-name">Premium Exterior Detail</h3>
      <p class="sp-pkg-tag">One-Step Machine Polish + Premium Protection</p>
      <div class="sp-pkg-price" data-rv-price>Starting at $31/ft</div>
      <div class="sp-pkg-basis" data-rv-basis>Select your exact RV length to see your estimated total.</div>
      <div class="sp-pkg-minote">Minimum mobile service charge: $449</div>
      <div class="sp-pkg-time">Service duration depends on RV size, condition and crew assigned.</div>
      <ul class="sp-pkg-feats">
        <li>Exterior hand wash</li>
        <li>Bug, road-film and light black-streak removal</li>
        <li>Exterior decontamination preparation</li>
        <li>One-step machine polish</li>
        <li>Light oxidation and haze improvement where achievable</li>
        <li>High-quality machine-applied wax or sealant</li>
        <li>Exterior windows and mirrors</li>
        <li>Wheels cleaned</li>
        <li>Tire shine</li>
        <li>Entry-door jambs and accessible tracks</li>
        <li>Final exterior inspection</li>
      </ul>
      <p class="sp-pkg-limit">Roof excluded. A one-step polish improves gloss and reduces light defects. It is not a multi-stage restoration and will not remove every scratch, severe oxidation, damaged decal or permanent water spot.</p>
      <button type="button" class="sp-btn sp-btn-primary sp-btn-block package-booking-cta" data-booking-category="rvs" data-booking-package="premium">Select This RV Package</button>
    </article>

    <article class="sp-pkg-card pop rv-pkg-recommended" data-rv-tier="full" data-per-ft="44" data-min="699">
      <div class="sp-pkg-badge sp-pkg-badge--rec">MOST POPULAR</div>
      <h3 class="sp-pkg-name">Premium Complete RV Detail</h3>
      <p class="sp-pkg-tag">One-Step Exterior Polish + Complete Interior Detail</p>
      <p class="sp-pkg-why">Everything most RV owners need in one appointment. A premium exterior detail combined with a complete interior cleaning—ideal before a long trip, after camping season, before storage or when preparing the RV for sale.</p>
      <div class="sp-pkg-price" data-rv-price>Starting at $44/ft</div>
      <div class="sp-pkg-basis" data-rv-basis>Select your exact RV length to see your estimated total.</div>
      <div class="sp-pkg-minote">Minimum mobile service charge: $699</div>
      <div class="sp-pkg-time">Service duration depends on RV size, condition and crew assigned.</div>
      <p class="sp-pkg-why"><strong>Premium Exterior Detail includes:</strong></p>
      <ul class="sp-pkg-feats">
        <li>Exterior hand wash</li>
        <li>Bug, road-film and light black-streak removal</li>
        <li>Exterior decontamination preparation</li>
        <li>One-step machine polish</li>
        <li>Light oxidation and haze improvement where achievable</li>
        <li>High-quality machine-applied wax or sealant</li>
        <li>Exterior windows and mirrors</li>
        <li>Wheels cleaned</li>
        <li>Tire shine</li>
        <li>Entry-door jambs and accessible tracks</li>
        <li>Final exterior inspection</li>
      </ul>
      <p class="sp-pkg-why"><strong>Interior Detail includes:</strong></p>
      <ul class="sp-pkg-feats">
        <li>Full interior vacuum</li>
        <li>Carpet and upholstery shampoo</li>
        <li>Driver cabin detailing</li>
        <li>Dashboard and high-touch surfaces</li>
        <li>Tables and countertops</li>
        <li>Leather cleaning and conditioning where applicable</li>
        <li>Kitchen sink and stove cleaning</li>
        <li>Refrigerator interior when empty</li>
        <li>Oven interior when empty and cool</li>
        <li>Bathroom surfaces</li>
        <li>Interior windows and mirrors</li>
        <li>Cabinet exteriors</li>
        <li>Cabinet interiors when completely emptied</li>
        <li>Accessible floor mats</li>
        <li>Bed neatly made when clean linens are provided</li>
        <li>Final interior inspection</li>
      </ul>
      <p class="sp-pkg-limit">Roof excluded. This package includes a one-step machine polish. Severe oxidation, deep scratches, damaged decals and multi-stage correction require inspection and separate pricing.</p>
      <button type="button" class="sp-btn sp-btn-primary sp-btn-block package-booking-cta" data-booking-category="rvs" data-booking-package="full">Select Recommended Package</button>
    </article>
  </div>

  <p class="sp-pkg-note">Difficult access, oversized units, severe oxidation, roof membranes, awnings, and multi-stage correction may require inspection before final pricing. Visible mold, suspected contamination, active leaks, or biohazard conditions require separate professional evaluation and may not be serviceable.</p>
</section>`;

const addons = `<section class="sp-section" id="addons">
  <div class="sp-sec-eye">Add-ons</div>
  <h2 class="sp-sec-title">Useful Upgrades When You Book</h2>
  <p class="sp-sec-copy">Select add-ons in the normal booking flow. Super Interior is $135 and Sanitize is $75.</p>
  <div class="rv-addon-grid">
    <article class="rv-addon-card rv-addon-card--feature">
      <h3>Super Interior · $135</h3>
      <ul class="sp-pkg-feats">
        <li>Additional upholstery or carpet shampoo pass</li>
        <li>Up to two total shampoo/extraction passes where needed</li>
        <li>Moderate pet hair removal</li>
        <li>Odor-neutralizing treatment</li>
        <li>Detailed floor-mat cleaning</li>
        <li>Additional attention to high-use interior areas</li>
        <li>Extended interior labor</li>
      </ul>
      <p class="rv-addon-note">Severe pet hair, smoke, sewage, mold, biological contamination or deeply embedded odors may require inspection and separate pricing.</p>
      <a class="sp-btn sp-btn-primary" href="index.html?book=rvs&amp;pkg=interior" data-booking-category="rvs" data-booking-package="interior">Book Interior &amp; Add in Checkout</a>
    </article>
    <article class="rv-addon-card rv-addon-card--feature">
      <h3>Sanitize · $75</h3>
      <ul class="sp-pkg-feats">
        <li>Sanitizing treatment after normal cleaning</li>
        <li>Steering wheel and driver controls</li>
        <li>Door handles</li>
        <li>Tables and countertops</li>
        <li>Kitchen touch points</li>
        <li>Bathroom touch points</li>
        <li>Switches and frequently handled surfaces</li>
      </ul>
      <p class="rv-addon-note">Sanitize is a treatment after cleaning — not sterilization.</p>
      <a class="sp-btn sp-btn-outline" href="index.html?book=rvs&amp;pkg=interior" data-booking-category="rvs" data-booking-package="interior">Add in Checkout</a>
    </article>
    <article class="rv-addon-card">
      <h3>Also available at booking</h3>
      <ul class="sp-pkg-feats">
        <li>Roof surface cleaning</li>
        <li>Awning cleaning</li>
        <li>Front cap deep clean</li>
        <li>Pet hair removal</li>
        <li>Odor treatment</li>
        <li>Polymer / carnauba protection upgrades</li>
      </ul>
    </article>
  </div>
</section>`;

let html = fs.readFileSync('rv-detailing.html', 'utf8');
const nl = nlDetect(html);
const pkgStart = html.indexOf('<section class="sp-section" id="packages">');
const addStart = html.indexOf('<section class="sp-section" id="addons">');
const memStart = html.indexOf('<section class="sp-section" id="membership"');
if (pkgStart < 0 || addStart < 0 || memStart < 0) {
  throw new Error(`section markers missing: ${pkgStart} ${addStart} ${memStart}`);
}

html = html.slice(0, pkgStart)
  + packages.replace(/\n/g, nl)
  + nl + nl
  + addons.replace(/\n/g, nl)
  + nl + nl
  + html.slice(memStart);

html = html.replace(
  /content="Mobile RV, travel trailer[\s\S]*?priced by exact length\."/,
  'content="Mobile RV detailing in NJ — Maintenance Wash, Light Interior, Interior Detail, Premium Exterior, and Premium Complete RV Detail, priced by exact length."'
);
html = html.replace(
  /property="og:description" content="[^"]+"/,
  'property="og:description" content="Five clear RV packages with explicit surfaces and tasks — priced by exact length at your driveway or storage lot."'
);
html = html.replace(/Book Premium Complete(?! RV)/, 'Book Premium Complete RV Detail');
html = html.replace(
  /priceEl\.textContent = 'From \$' \+ perFt \+ '\/ft';/,
  "priceEl.textContent = 'Starting at $' + perFt + '/ft';"
);

for (const re of [
  /full interior scope/i,
  /full restoration/i,
  /complete restoration/i,
  /living-area restoration/i,
  /rejuvenation/i,
  /highest ticket/i,
  /Mold Treatment/i,
]) {
  if (re.test(html)) throw new Error(`banned phrase still present: ${re}`);
}

fs.writeFileSync('rv-detailing.html', html);
console.log('patched rv-detailing.html five-package model');
