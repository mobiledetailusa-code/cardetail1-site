$root = Split-Path $PSScriptRoot -Parent
$oldHy = [IO.File]::ReadAllText("$PSScriptRoot\old-premium-hyphen.txt")
$oldEm = [IO.File]::ReadAllText("$PSScriptRoot\old-premium-emdash.txt")
$newPkg = [IO.File]::ReadAllText("$PSScriptRoot\new-premium.txt")

$vcHtmlOld = @"
          <div class="vc-price">
            <div class="vc-price-lbl">Your Price</div>
            <div class="vc-price-val" id="vc-price">-</div>
            <div class="vc-price-note"></div>
          </div>
"@
$vcHtmlNew = @"
          <div class="vc-price" id="vc-price-wrap" style="display:none">
            <div class="vc-price-lbl" id="vc-price-lbl">Complete package</div>
            <div class="vc-price-val" id="vc-price">-</div>
            <div class="vc-urgency" id="vc-urgency"></div>
          </div>
"@

$setBaseOld = @"
  ST.basePrice = applyRichPrice(raw);
  // Update vc price display if visible
  const vcPrice=document.getElementById('vc-price');
  if(vcPrice&&ST.basePrice)vcPrice.textContent='$'+ST.basePrice;
  updateTotal();
}
"@

$setBaseNew = @"
  ST.basePrice = applyRichPrice(raw);
  updateVcPriceDisplay();
  updateTotal();
}
"@

$fnInsert = @"

function updateVcPriceDisplay(){
  const wrap=document.getElementById('vc-price-wrap');
  const priceEl=document.getElementById('vc-price');
  const urgEl=document.getElementById('vc-urgency');
  if(!priceEl) return;
  const isSignature=ST.cat==='cars'&&ST.pkgId==='premium'&&ST.basePrice>0;
  if(isSignature){
    const complete=ST.basePrice+getTravelFeeAmount();
    priceEl.textContent='$'+complete;
    if(wrap) wrap.style.display='';
    if(urgEl){
      urgEl.textContent='Limited availability for this premium service. Our technicians give exclusive attention to every panel of your vehicle.';
      urgEl.style.display='block';
    }
  }else{
    if(wrap) wrap.style.display='none';
    if(urgEl) urgEl.style.display='none';
  }
}
"@

$files = Get-ChildItem -Path $root -Filter '*.html' -File | Where-Object {
  (Select-String -Path $_.FullName -Pattern 'Paint Correction / Enhancement' -Quiet) -or
  (Select-String -Path $_.FullName -Pattern 'Your Price' -Quiet)
}

foreach ($f in $files) {
  if ($f.Name -eq 'index.html') { continue }
  $c = [IO.File]::ReadAllText($f.FullName)
  $orig = $c
  if ($c.Contains($oldHy)) { $c = $c.Replace($oldHy, $newPkg) }
  elseif ($c.Contains($oldEm)) { $c = $c.Replace($oldEm, $newPkg) }
  if ($c.Contains($vcHtmlOld)) { $c = $c.Replace($vcHtmlOld, $vcHtmlNew) }
  if ($c.Contains($setBaseOld)) { $c = $c.Replace($setBaseOld, $setBaseNew) }
  if ($c.Contains('function updateVcPriceDisplay') -eq $false -and $c.Contains("const makeIn=document.getElementById('make-in')")) {
    $c = $c.Replace("const makeIn=document.getElementById('make-in')", ($fnInsert + "`nconst makeIn=document.getElementById('make-in')"))
  }
  $c = $c -replace "document\.getElementById\('vc-price'\)\.textContent='\$'\+ST\.basePrice;", 'updateVcPriceDisplay();'
  $c = $c -replace "document\.getElementById\('vc-price'\)\.textContent=ST\.pkgId==='custom'\?'Estimate':'\$'\+ST\.basePrice;", 'updateVcPriceDisplay();'
  $c = $c -replace "document\.getElementById\('vc-price'\)\.textContent=needsEstimate\?'Estimate':'\$'\+ST\.basePrice;", 'updateVcPriceDisplay();'
  if ($c -ne $orig) {
    [IO.File]::WriteAllText($f.FullName, $c)
    Write-Host "Patched: $($f.Name)"
  }
}

# customer-catalog.js
$catJs = Join-Path $root 'netlify\lib\customer-catalog.js'
if (Test-Path $catJs) {
  $c = [IO.File]::ReadAllText($catJs)
  $c2 = $c.Replace('Paint Correction / Enhancement', 'Signature Interior & Exterior Restoration')
  if ($c2 -ne $c) { [IO.File]::WriteAllText($catJs, $c2); Write-Host 'Patched: customer-catalog.js' }
}

Write-Host 'Done.'
