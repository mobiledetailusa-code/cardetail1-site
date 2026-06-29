/**
 * FLOW & CHECKOUT FIX — bulk patch for HTML pages.
 * - Stripe local preview: pk_test fallback, backend probe, netlify dev hint
 * - Remove auto openBooking() from onHeroZipInput
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const STRIPE_OLD = `const isTestMode = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
const STRIPE_PUBLISHABLE_KEY_LOCAL_TEST = 'pk_test_51TgF1pLbeoH0J6blFE2w7uTu2VIg4Av3JcbmC9I2hOzEWqoP4xVbb7s5P84xaSDFrFeEotfd1gRKiREfzQ8NBR8m00HNbIZZ9L';
const IS_DEPLOY_PREVIEW = /^deploy-preview-\\d+--/.test(location.hostname);
let STRIPE_READY = false;
let stripeConfigPromise = null;

async function loadStripeConfig(){
  if(STRIPE_READY) return true;
  if(!stripeConfigPromise){
    stripeConfigPromise=(async ()=>{
      let key='';
      let mode='';
      try{
        const res=await fetch('/.netlify/functions/stripe-config',{headers:{'Cache-Control':'no-store'}});
        const data=await res.json().catch(()=>({}));
        if(res.ok&&data.ok&&data.publishableKey){
          key=data.publishableKey;
          mode=data.mode||'';
        }
      }catch(_){}
      if(isTestMode){
        if(!key||mode!=='test') key=STRIPE_PUBLISHABLE_KEY_LOCAL_TEST;
      }else if(IS_DEPLOY_PREVIEW&&mode!=='test'){
        key='';
      }
      STRIPE_PUBLISHABLE_KEY=key;
      STRIPE_READY=!!(window.Stripe&&STRIPE_PUBLISHABLE_KEY);
      return STRIPE_READY;
    })();
  }
  return stripeConfigPromise;
}`;

const STRIPE_NEW = `const isLocalPreview = /^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/i.test(window.location.hostname);
const STRIPE_PUBLISHABLE_KEY_LOCAL_TEST = 'pk_test_51TgF1pLbeoH0J6blFE2w7uTu2VIg4Av3JcbmC9I2hOzEWqoP4xVbb7s5P84xaSDFrFeEotfd1gRKiREfzQ8NBR8m00HNbIZZ9L';
const IS_DEPLOY_PREVIEW = /^deploy-preview-\\d+--/.test(location.hostname);
const LOCAL_DEV_FUNCTIONS_HINT = 'Secure card saving needs Netlify Functions (not a plain static file server). In the project folder run: npx netlify dev — then open http://localhost:8888. Add a .env file with STRIPE_SECRET_KEY=sk_test_... and STRIPE_PUBLISHABLE_KEY=pk_test_... from the same Stripe test account.';
let STRIPE_READY = false;
let stripeConfigLoaded = null;

async function waitForStripeGlobal(ms){
  if(typeof window.Stripe==='function') return true;
  const t0=Date.now(); ms=ms||8000;
  while(Date.now()-t0<ms){
    await new Promise(r=>setTimeout(r,50));
    if(typeof window.Stripe==='function') return true;
  }
  return false;
}

async function loadStripeConfig(){
  if(!stripeConfigLoaded){
    stripeConfigLoaded=(async ()=>{
      let key='', mode='', backendOk=false;
      try{
        const res=await fetch(BACKEND_BASE+'/stripe-config',{headers:{'Cache-Control':'no-store'}});
        const ct=(res.headers.get('content-type')||'').toLowerCase();
        if(ct.includes('json')){
          const data=await res.json().catch(()=>({}));
          backendOk=!!(data&&typeof data==='object'&&('ok' in data));
          if(res.ok&&data.ok&&data.publishableKey){
            key=data.publishableKey;
            mode=data.mode||'';
          }
        }
      }catch(_){}
      if(isLocalPreview){
        if(!key||mode!=='test') key=STRIPE_PUBLISHABLE_KEY_LOCAL_TEST;
      }else if(IS_DEPLOY_PREVIEW&&mode!=='test'){
        key='';
      }
      STRIPE_PUBLISHABLE_KEY=key;
      return {key, backendOk};
    })();
  }
  const cfg=await stripeConfigLoaded;
  STRIPE_PUBLISHABLE_KEY=cfg.key||STRIPE_PUBLISHABLE_KEY;
  const stripeJs=await waitForStripeGlobal();
  STRIPE_READY=!!(stripeJs&&STRIPE_PUBLISHABLE_KEY);
  return {ready:STRIPE_READY, backendOk:cfg.backendOk};
}`;

const CARD_INIT_OLD = `    const stripeReady=await loadStripeConfig();
    if(isStale()) return;
    if(!stripeReady){
      document.getElementById('card-container').innerHTML='<div style="padding:14px;font-size:13px;color:#ef4444;line-height:1.5">Secure card saving is temporarily unavailable. A booking request cannot be submitted until card-on-file is available.</div>';
      if(btn) btn.style.display='none'; return;
    }
    if(!ST.draftRegistered){
      const draftPayload=buildBookingPayload();
      draftPayload.isDraft=true;
      draftPayload.acceptedCardOnFilePolicy=true;
      const draftRes=await fetch(BACKEND_BASE+'/submit-booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draftPayload)});
      const draftData=await draftRes.json();
      if(isStale()) return;
      if(!draftData.ok) throw new Error('Could not register booking. Please try again.');
      ST.bookingId=draftData.id; ST.draftRegistered=true;
    }
    destroyStripePaymentUI();
    if(isStale()) return;
    const siRes=await fetch(BACKEND_BASE+'/create-setup-intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingId:ST.bookingId})});
    const siData=await siRes.json();
    if(isStale()) return;
    if(!siData.ok||siData.fallback){
      const errMap={
        stripe_test_mode_required:'Card save is blocked on preview deploys when using live Stripe keys. Use production URL or test keys.',
        booking_not_eligible_for_card_save:'Complete your contact info and payment preference first, then save your card.',
        booking_not_found:'Booking draft not found — go back one step and try again.',
        stripe_not_configured:'Card saving is not configured on the server yet.',
        card_save_unavailable:'Stripe could not start card save. Try again in a moment.',
      };`;

const CARD_INIT_NEW = `    const stripeCfg=await loadStripeConfig();
    if(isStale()) return;
    if(!stripeCfg.ready){
      const why=!STRIPE_PUBLISHABLE_KEY
        ? 'Stripe publishable key is not configured for this environment.'
        : 'Stripe.js did not load — check your network connection or ad blocker, then refresh.';
      document.getElementById('card-container').innerHTML='<div style="padding:14px;font-size:13px;color:#ef4444;line-height:1.5">'+why+'</div>';
      if(btn) btn.style.display='none'; return;
    }
    if(isLocalPreview&&!stripeCfg.backendOk){
      document.getElementById('card-container').innerHTML='<div style="padding:14px;font-size:13px;color:#ef4444;line-height:1.5">'+LOCAL_DEV_FUNCTIONS_HINT.replace(/</g,'&lt;')+'</div>';
      if(btn) btn.style.display='none'; return;
    }
    if(!ST.draftRegistered){
      const draftPayload=buildBookingPayload();
      draftPayload.isDraft=true;
      draftPayload.acceptedCardOnFilePolicy=true;
      const draftRes=await fetch(BACKEND_BASE+'/submit-booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draftPayload)});
      const draftCt=(draftRes.headers.get('content-type')||'').toLowerCase();
      if(!draftCt.includes('json')) throw new Error(isLocalPreview?LOCAL_DEV_FUNCTIONS_HINT:'Booking backend returned an invalid response. Try again.');
      const draftData=await draftRes.json();
      if(isStale()) return;
      if(!draftData.ok) throw new Error('Could not register booking. Please try again.');
      ST.bookingId=draftData.id; ST.draftRegistered=true;
    }
    destroyStripePaymentUI();
    if(isStale()) return;
    const siRes=await fetch(BACKEND_BASE+'/create-setup-intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingId:ST.bookingId})});
    const siCt=(siRes.headers.get('content-type')||'').toLowerCase();
    if(!siCt.includes('json')) throw new Error(isLocalPreview?LOCAL_DEV_FUNCTIONS_HINT:'Secure card saving is temporarily unavailable.');
    const siData=await siRes.json();
    if(isStale()) return;
    if(!siData.ok||siData.fallback){
      const errMap={
        stripe_test_mode_required:'Card save is blocked on preview deploys when using live Stripe keys. Use production URL or test keys.',
        booking_not_eligible_for_card_save:'Complete your contact info and payment preference first, then save your card.',
        booking_not_found:'Booking draft not found — go back one step and try again.',
        stripe_not_configured:'Card saving is not configured on the server yet. Add STRIPE_SECRET_KEY to .env and run netlify dev.',
        booking_store_unavailable:'Booking storage is unavailable locally — run netlify dev (not a static file server).',
        card_save_unavailable:'Stripe could not start card save. Try again in a moment.',
      };`;

const OPEN_BOOKING_AUTO = `  setTimeout(()=>{
    if(typeof openBooking === 'function') openBooking();
  }, 350);
`;

const HTML_FILES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

let stripePatched = 0;
let cardInitPatched = 0;
let openBookingRemoved = 0;

for (const file of HTML_FILES) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) {
    console.warn('Skip missing', file);
    continue;
  }
  let html = fs.readFileSync(fp, 'utf8');
  let changed = false;

  if (html.includes(STRIPE_OLD)) {
    html = html.replace(STRIPE_OLD, STRIPE_NEW);
    stripePatched++;
    changed = true;
  } else if (!html.includes('LOCAL_DEV_FUNCTIONS_HINT')) {
    console.warn('Stripe block not found or already patched:', file);
  }

  if (html.includes(CARD_INIT_OLD)) {
    html = html.replace(CARD_INIT_OLD, CARD_INIT_NEW);
    cardInitPatched++;
    changed = true;
  } else if (!html.includes('stripeCfg=await loadStripeConfig')) {
    console.warn('initCardOnFile block not found or already patched:', file);
  }

  if (html.includes(OPEN_BOOKING_AUTO)) {
    html = html.replace(OPEN_BOOKING_AUTO, '');
    openBookingRemoved++;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(fp, html);
    console.log('Patched', file);
  }
}

console.log(`Done: stripe=${stripePatched}, cardInit=${cardInitPatched}, openBookingRemoved=${openBookingRemoved}`);
