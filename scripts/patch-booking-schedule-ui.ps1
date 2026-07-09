$root = Split-Path -Parent $PSScriptRoot
$pages = @(
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
  'template-city.html'
)

$oldTimeBlock = @'
          <div class="fg"><div class="fl">Preferred Time</div>
            <select class="fsel" id="f-time">
              <option value="">Any available (Mon–Fri 8AM–5PM)</option>
              <option>Morning (8AM – 11AM)</option>
              <option>Midday (11AM – 2PM)</option>
              <option>Afternoon (2PM – 5PM)</option>
            </select>
          </div>
'@

$newTimeBlock = @'
          <div class="fg"><div class="fl">Preferred Time *</div>
            <select class="fsel" id="f-time" required>
              <option value="">Select a time</option>
            </select>
          </div>
          <div class="fg full" id="f-schedule-msg" style="display:none;font-size:12.5px;color:var(--am);line-height:1.55;margin-top:-4px"></div>
'@

$scheduleJs = @'

// ── BOOKING SCHEDULE (Step 4) ───────────────────────────────────────────────
const BK_SLOTS=['8:00 AM','10:00 AM','12:00 PM','2:00 PM'];
const BK_SAT_SLOTS=['8:00 AM','10:00 AM'];
function bkToIso(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return y+'-'+m+'-'+day;}
function bkEaster(y){const a=y%19,b=~~(y/100),c=y%100,d=~~(b/4),e=b%4,f=~~((b+8)/25),g=~~((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=~~(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=~~((a+11*h+22*l)/451);return new Date(y,~~((h+l-7*m+114)/31)-1,((h+l-7*m+114)%31)+1);}
function bkNthWd(y,mi,wd,n){let c=0;for(let d=1;d<=31;d++){const dt=new Date(y,mi,d);if(dt.getMonth()!==mi)break;if(dt.getDay()===wd&&++c===n)return bkToIso(dt);}return null;}
function bkLastWd(y,mi,wd){for(let d=31;d>=1;d--){const dt=new Date(y,mi,d);if(dt.getMonth()!==mi)continue;if(dt.getDay()===wd)return bkToIso(dt);}return null;}
function bkHolidays(y){return new Set([y+'-01-01',bkToIso(bkEaster(y)),bkLastWd(y,4,1),y+'-07-04',bkNthWd(y,8,1,1),bkNthWd(y,10,4,4),y+'-12-24',y+'-12-25',y+'-12-31']);}
function bkIsoParts(iso){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso||'').trim());if(!m)return null;const y=+m[1],mo=+m[2],d=+m[3],dt=new Date(y,mo-1,d);if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d)return null;return{iso:m[1]+'-'+m[2]+'-'+m[3],day:dt.getDay()};}
function bkSlotsFor(iso){const p=bkIsoParts(iso);if(!p)return[];if(p.day===0)return[];if(bkHolidays(+p.iso.slice(0,4)).has(p.iso))return[];return p.day===6?BK_SAT_SLOTS.slice():BK_SLOTS.slice();}
function bkShowScheduleMsg(msg){const el=document.getElementById('f-schedule-msg');if(!el)return;if(msg){el.textContent=msg;el.style.display='block';}else{el.textContent='';el.style.display='none';}}
function bkRefreshTimeSlots(){const dateEl=document.getElementById('f-date');const timeEl=document.getElementById('f-time');if(!dateEl||!timeEl)return;const iso=dateEl.value;const prev=timeEl.value;bkShowScheduleMsg('');timeEl.querySelectorAll('option[data-slot]').forEach(o=>o.remove());if(!iso)return;const p=bkIsoParts(iso);if(!p)return;if(p.day===0){bkShowScheduleMsg('Unavailable — please choose another date.');timeEl.value='';return;}if(bkHolidays(+p.iso.slice(0,4)).has(p.iso)){bkShowScheduleMsg('Closed for the holiday. Please choose another date.');timeEl.value='';return;}const allowed=bkSlotsFor(iso);for(const slot of allowed){const opt=document.createElement('option');opt.value=slot;opt.textContent=slot;opt.dataset.slot='1';timeEl.appendChild(opt);}if(prev&&allowed.includes(prev))timeEl.value=prev;else timeEl.value='';}
function bkValidateScheduleSelection(){const iso=document.getElementById('f-date')?.value||'';const time=document.getElementById('f-time')?.value||'';if(!iso)return{ok:false,message:'Please select a preferred date.'};const p=bkIsoParts(iso);if(!p)return{ok:false,message:'Please select a valid date.'};if(p.day===0)return{ok:false,message:'Unavailable — please choose another date.'};if(bkHolidays(+p.iso.slice(0,4)).has(p.iso))return{ok:false,message:'Closed for the holiday. Please choose another date.'};if(!time)return{ok:false,message:'Please select a preferred time.'};const allowed=bkSlotsFor(iso);if(!allowed.includes(time))return{ok:false,message:'That time is unavailable on the selected date. Please choose another slot.'};return{ok:true};}
function bkInitSchedulePicker(){const dateEl=document.getElementById('f-date');if(!dateEl)return;dateEl.addEventListener('change',bkRefreshTimeSlots);const timeEl=document.getElementById('f-time');if(timeEl)timeEl.addEventListener('change',()=>bkShowScheduleMsg(''));}
'@

foreach ($page in $pages) {
  $path = Join-Path $root $page
  if (-not (Test-Path $path)) { throw "Missing $page" }
  $html = [IO.File]::ReadAllText($path)

  if ($html -notlike "*$($oldTimeBlock.Trim().Substring(0,40))*") {
    throw "Time block not found in $page"
  }
  $html = $html.Replace($oldTimeBlock, $newTimeBlock)

  $marker = '// ── STEP 5: INFO ─'
  if ($html -notlike "*$marker*") { throw "STEP 5 marker not found in $page" }
  if ($html -notlike '*bkInitSchedulePicker*') {
    $html = $html.Replace($marker, ($scheduleJs + "`r`n" + $marker))
  }

  $oldGoTo = @'
function goToPayment(){
  const req=['f-first','f-last','f-phone','f-email','f-addr','f-date'];
  if(req.some(id=>!document.getElementById(id).value.trim())){alert('Please fill in all required fields marked with *');return;}
  bkGoTo(5);
}
'@
  $newGoTo = @'
function goToPayment(){
  const req=['f-first','f-last','f-phone','f-email','f-addr','f-date','f-time'];
  if(req.some(id=>!document.getElementById(id).value.trim())){alert('Please fill in all required fields marked with *');return;}
  const sched=bkValidateScheduleSelection();
  if(!sched.ok){bkShowScheduleMsg(sched.message);return;}
  bkShowScheduleMsg('');
  bkGoTo(5);
}
'@
  $html = $html.Replace($oldGoTo, $newGoTo)

  $html = $html.Replace("const tsel=document.getElementById('f-time').value||'Any available';", "const tsel=document.getElementById('f-time').value;")
  $html = $html.Replace("preferredTime:document.getElementById('f-time').value||'Any available',", "preferredTime:document.getElementById('f-time').value,")

  $oldInit = "document.getElementById('f-date').min=new Date().toISOString().split('T')[0];"
  $newInit = "document.getElementById('f-date').min=new Date().toISOString().split('T')[0];`r`nbkInitSchedulePicker();"
  if ($html -notlike '*bkInitSchedulePicker();*') {
    $html = $html.Replace($oldInit, $newInit)
  }

  [IO.File]::WriteAllText($path, $html)
  Write-Host "Patched $page"
}

Write-Host 'Done.'
