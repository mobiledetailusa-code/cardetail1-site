#!/usr/bin/env node
/**
 * Add optional Trim / Edition field to cars booking on all booking pages.
 * Label-only — does not affect pricing.
 *
 *   node scripts/patch-cars-trim-edition.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const TRIM_HTML = `
          <div class="sel-g" id="trim-wrap" style="margin-top:10px">
            <div class="sel-l">Trim / Edition <span style="font-weight:400;color:var(--mu)">(optional)</span></div>
            <input class="sel-s" id="trim-in" type="text" maxlength="80" placeholder="e.g. Special Edition, Anniversary, Interceptor…" autocomplete="off" disabled>
          </div>`;

function patchHtml(html) {
  let out = html;
  let n = 0;

  // Insert trim field inside make-search-wrap after model/year row, once.
  if (!out.includes('id="trim-in"')) {
    const re = /(id="make-search-wrap"[\s\S]*?<div class="sel-row">[\s\S]*?<\/div>\s*)(\n\s*<\/div>)/;
    if (!re.test(out)) throw new Error('make-search-wrap sel-row block not found');
    out = out.replace(re, `$1${TRIM_HTML}$2`);
    n += 1;
  }

  // Reset ST.trim alongside make/model/year clears.
  if (!out.includes("ST.trim=''") && !out.includes('ST.trim=""')) {
    const a = "ST.make=''; ST.model=''; ST.year=''; ST.classNeedsConfirm=false; ST._priceResolveFailed=false;";
    const b = "ST.make=''; ST.model=''; ST.year=''; ST.trim=''; ST.classNeedsConfirm=false; ST._priceResolveFailed=false;";
    if (!out.includes(a)) throw new Error('selectCategory ST.make/model/year reset not found');
    out = out.replace(a, b);
    n += 1;
  }

  // Clear trim input in resetVehicleEntryFields.
  if (!out.includes("getElementById('trim-in')")) {
    const needle = `  const yearSel=document.getElementById('year-sel');
  if(makeIn) makeIn.value='';`;
    const insert = `  const yearSel=document.getElementById('year-sel');
  const trimIn=document.getElementById('trim-in');
  if(makeIn) makeIn.value='';`;
    if (!out.includes(needle)) throw new Error('resetVehicleEntryFields yearSel block not found');
    out = out.replace(needle, insert);

    // After yearSel disable block, clear/disable trim.
    const yearDisableVariants = [
      `  if(yearSel){
    yearSel.innerHTML='<option value="">— select model —</option>';
    yearSel.disabled=true;
  }`,
      `  if(yearSel){
    yearSel.innerHTML='<option value="">- select model -</option>';
    yearSel.disabled=true;
  }`,
    ];
    let replaced = false;
    for (const y of yearDisableVariants) {
      if (out.includes(y)) {
        out = out.replace(
          y,
          y + `\n  if(trimIn){ trimIn.value=''; trimIn.disabled=true; }`
        );
        replaced = true;
        break;
      }
    }
    if (!replaced) throw new Error('yearSel disable block not found for trim reset');
    n += 1;
  }

  // Helper + applyCarsVehicleLabel before CAR SEARCH section if missing.
  if (!out.includes('function buildCarsVehicleLabel')) {
    const helper = `
function buildCarsVehicleLabel(){
  const trim=(document.getElementById('trim-in')?.value||ST.trim||'').trim();
  ST.trim=trim;
  if(window.CD1BookingVehicleSummary&&CD1BookingVehicleSummary.formatCarsVehicleLabel){
    return CD1BookingVehicleSummary.formatCarsVehicleLabel(ST.year,ST.make,ST.model,trim);
  }
  const base=[ST.year,ST.make,ST.model].filter(Boolean).join(' ').replace(/\\s+/g,' ').trim();
  return trim?(base?base+' · '+trim:trim):base;
}
function applyCarsVehicleLabel(){
  if(ST.cat!=='cars'||!ST.year||!ST.make||!ST.model) return;
  ST.vehicleLabel=buildCarsVehicleLabel();
  const suffix=ST.classNeedsConfirm?' · Vehicle size needs confirmation':(ST.displayLabel?' · '+ST.displayLabel:'');
  setVcName(ST.vehicleLabel+suffix);
}

`;
    const marker = '// ── CAR SEARCH';
    const idx = out.indexOf(marker);
    if (idx < 0) throw new Error('CAR SEARCH marker not found');
    out = out.slice(0, idx) + helper + out.slice(idx);
    n += 1;
  }

  // selectMake: enable/clear trim when make chosen.
  if (!out.includes("getElementById('trim-in')") || !out.includes('trimIn.disabled=false')) {
    // Already may have getElementById from reset — check selectMake specifically.
  }
  {
    const old = `  ST.model=''; ST.year=''; ST.tierKey=''; ST.tier=null; ST.displayLabel=''; ST.body=null; ST.classNeedsConfirm=false; ST.vehicleLabel='';
  document.getElementById('vc').classList.remove('show'); document.getElementById('next3').disabled=true;
  typeof syncTierChipsVisibility==='function'&&syncTierChipsVisibility();
}

document.getElementById('model-sel').addEventListener('change',function(){`;
    const neu = `  ST.model=''; ST.year=''; ST.trim=''; ST.tierKey=''; ST.tier=null; ST.displayLabel=''; ST.body=null; ST.classNeedsConfirm=false; ST.vehicleLabel='';
  const trimIn=document.getElementById('trim-in');
  if(trimIn){ trimIn.value=''; trimIn.disabled=true; }
  document.getElementById('vc').classList.remove('show'); document.getElementById('next3').disabled=true;
  typeof syncTierChipsVisibility==='function'&&syncTierChipsVisibility();
}

document.getElementById('model-sel').addEventListener('change',function(){`;
    if (!out.includes(old)) throw new Error('selectMake tail not found');
    if (!out.includes("ST.trim=''; ST.tierKey=''")) {
      out = out.replace(old, neu);
      n += 1;
    }
  }

  // model-sel change: enable trim after model selected; clear year path keeps trim editable.
  {
    const old = `  ys.disabled=false; ST.year=''; ST.tierKey=''; ST.tier=null; ST.displayLabel=''; ST.body=null; ST.classNeedsConfirm=false; ST.vehicleLabel='';
  document.getElementById('vc').classList.remove('show'); document.getElementById('next3').disabled=true;
  typeof syncTierChipsVisibility==='function'&&syncTierChipsVisibility();
});

document.getElementById('year-sel').addEventListener('change',function(){`;
    const neu = `  ys.disabled=false; ST.year=''; ST.tierKey=''; ST.tier=null; ST.displayLabel=''; ST.body=null; ST.classNeedsConfirm=false; ST.vehicleLabel='';
  const trimIn=document.getElementById('trim-in');
  if(trimIn){ trimIn.disabled=false; }
  document.getElementById('vc').classList.remove('show'); document.getElementById('next3').disabled=true;
  typeof syncTierChipsVisibility==='function'&&syncTierChipsVisibility();
});

document.getElementById('year-sel').addEventListener('change',function(){`;
    if (!out.includes(old)) throw new Error('model-sel change tail not found');
    if (!out.includes('trimIn.disabled=false')) {
      out = out.replace(old, neu);
      n += 1;
    }
  }

  // year-sel: use buildCarsVehicleLabel instead of bare template.
  const labelPatterns = [
    "ST.vehicleLabel=`${ST.year} ${ST.make} ${ST.model}`.replace(/\\s+/g,' ').trim();",
    'ST.vehicleLabel=`${ST.year} ${ST.make} ${ST.model}`;',
  ];
  let labelHit = false;
  for (const p of labelPatterns) {
    if (out.includes(p)) {
      // Only replace the first occurrence inside year-sel handler context — replace all cars year paths is fine (one per page).
      out = out.replace(p, 'ST.vehicleLabel=buildCarsVehicleLabel();');
      labelHit = true;
      break;
    }
  }
  if (!labelHit && !out.includes('ST.vehicleLabel=buildCarsVehicleLabel()')) {
    throw new Error('cars vehicleLabel assignment not found');
  }
  if (labelHit) n += 1;

  // Trim input listeners after year-sel handler closing.
  if (!out.includes("getElementById('trim-in').addEventListener")) {
    const afterYear = `  // No auto-advance: user clicks "Choose Add-Ons →" after reviewing the vehicle.
});

// ── STEP 4: ADD-ONS`;
    const afterYearAlt = afterYear.replace('—', '-');
    const listener = `  // No auto-advance: user clicks "Choose Add-Ons →" after reviewing the vehicle.
});

(function bindCarsTrimInput(){
  const el=document.getElementById('trim-in');
  if(!el||el.dataset.boundTrim) return;
  el.dataset.boundTrim='1';
  el.addEventListener('input',function(){
    ST.trim=this.value.trim();
    if(ST.cat==='cars'&&ST.year&&ST.make&&ST.model) applyCarsVehicleLabel();
  });
})();

// ── STEP 4: ADD-ONS`;
    if (out.includes(afterYear)) {
      out = out.replace(afterYear, listener);
    } else if (out.includes(afterYearAlt)) {
      out = out.replace(afterYearAlt, listener.replace('—', '-'));
    } else {
      // Broader: find year-sel listener end before STEP 4
      const step4 = out.indexOf('// ── STEP 4: ADD-ONS');
      if (step4 < 0) throw new Error('STEP 4 marker not found');
      if (!out.slice(Math.max(0, step4 - 400), step4).includes('No auto-advance')) {
        throw new Error('year-sel end marker not found before STEP 4');
      }
      out =
        out.slice(0, step4) +
        `(function bindCarsTrimInput(){
  const el=document.getElementById('trim-in');
  if(!el||el.dataset.boundTrim) return;
  el.dataset.boundTrim='1';
  el.addEventListener('input',function(){
    ST.trim=this.value.trim();
    if(ST.cat==='cars'&&ST.year&&ST.make&&ST.model) applyCarsVehicleLabel();
  });
})();

` +
        out.slice(step4);
    }
    n += 1;
  }

  // Persist trim on cart item.
  if (!out.includes('vehicleTrim:')) {
    const itemNeedle = `    vehicleLabel: ST.vehicleLabel,
    tierLabel:`;
    const itemRep = `    vehicleLabel: ST.vehicleLabel,
    vehicleTrim: ST.trim || '',
    tierLabel:`;
    if (!out.includes(itemNeedle)) throw new Error('buildCurrentVehicleItem vehicleLabel not found');
    out = out.replace(itemNeedle, itemRep);
    n += 1;
  }

  return { out, n };
}

let total = 0;
for (const page of PAGES) {
  const fp = path.join(ROOT, page);
  const html = fs.readFileSync(fp, 'utf8');
  const { out, n } = patchHtml(html);
  if (out !== html) {
    fs.writeFileSync(fp, out);
    console.log(`patched ${page} (${n} edits)`);
    total += 1;
  } else {
    console.log(`unchanged ${page}`);
  }
}
console.log(`done: ${total}/${PAGES.length} pages updated`);
