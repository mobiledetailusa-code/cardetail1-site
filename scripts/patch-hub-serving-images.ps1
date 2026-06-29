$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$cssBlock = @'
.hub-serving-section{padding:56px 24px 64px}
.hub-serving-wrap{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:minmax(0,280px) minmax(0,1fr);gap:36px;align-items:center}
.hub-serving-visual{margin:0;border-radius:var(--r);overflow:hidden;border:1px solid rgba(77,163,255,.24);background:var(--bg2);aspect-ratio:384/1024;max-height:520px;width:100%;max-width:280px;justify-self:center}
.hub-serving-visual img{width:100%;height:100%;object-fit:cover;object-position:center top;display:block}
.hub-serving-wrap .hub-radius-inner{text-align:left;max-width:none;margin:0}
@media(max-width:820px){.hub-serving-wrap{grid-template-columns:1fr;max-width:640px;gap:28px}.hub-serving-visual{max-width:100%;max-height:360px;aspect-ratio:16/10}.hub-serving-wrap .hub-radius-inner{text-align:center}}
'@

$hubs = @(
    @{
        File = 'bergen-county-hub.html'
        Id = 'serving-bergen-county'
        Label = 'Serving Bergen County'
        Title = 'BERGEN COUNTY'
        Desc = 'Premium mobile detailing across Bergen County — from Palisades Park and Fort Lee to Paramus, Ridgewood, and the Palisades.'
        Img = 'hub-bergen.jpg'
        Alt = 'Atlantic City boardwalk and skyline representing mobile detailing service in Bergen County, New Jersey'
    },
    @{
        File = 'hudson-county-hub.html'
        Id = 'serving-hudson-county'
        Label = 'Serving Hudson County'
        Title = 'HUDSON COUNTY'
        Desc = 'We come to Jersey City, Hoboken, Bayonne, and Union City — waterfront condos, brownstones, and fleet yards across Hudson County.'
        Img = 'hub-hudson.jpg'
        Alt = 'New Jersey coastal skyline representing mobile detailing service in Hudson County'
    },
    @{
        File = 'essex-county-hub.html'
        Id = 'serving-essex-county'
        Label = 'Serving Essex County'
        Title = 'ESSEX COUNTY'
        Desc = 'Mobile detailing for Newark, Montclair, Livingston, and Short Hills — homes, offices, and driveways across Essex County.'
        Img = 'hub-essex.jpg'
        Alt = 'New Jersey shoreline representing mobile detailing service in Essex County'
    },
    @{
        File = 'passaic-county-hub.html'
        Id = 'serving-passaic-county'
        Label = 'Serving Passaic County'
        Title = 'PASSAIC COUNTY'
        Desc = 'Serving Paterson, Wayne, Clifton, and Passaic — professional mobile detailing at your home or business.'
        Img = 'hub-passaic.jpg'
        Alt = 'New Jersey boardwalk scene representing mobile detailing service in Passaic County'
    },
    @{
        File = 'ny-metro-hub.html'
        Id = 'serving-ny-metro'
        Label = 'Serving NY Metro'
        Title = 'NY METRO'
        Desc = 'Manhattan, Brooklyn, Queens, and the greater New York metro — we bring premium mobile detailing to your block or garage.'
        Img = 'hub-ny-metro.jpg'
        Alt = 'Statue of Liberty and New York City skyline representing mobile detailing in the NY Metro area'
    },
    @{
        File = 'connecticut-hub.html'
        Id = 'serving-connecticut'
        Label = 'Serving Connecticut'
        Title = 'CONNECTICUT'
        Desc = 'Serving Waterbury, Hartford, New Haven, and Fairfield County — mobile auto, marine, and RV detailing across Connecticut.'
        Img = 'hub-ct.jpg'
        Alt = 'Connecticut lighthouse on rocky coast representing mobile detailing service in Connecticut'
    },
    @{
        File = 'pennsylvania-hub.html'
        Id = 'serving-pennsylvania'
        Label = 'Serving Pennsylvania'
        Title = 'PENNSYLVANIA'
        Desc = 'Serving Philadelphia, Allentown, King of Prussia, Scranton, and surrounding areas up to 150 miles from our Philadelphia hub.'
        Img = 'hub-pa.jpg'
        Alt = 'Pennsylvania covered bridge and historic building representing mobile detailing service in Pennsylvania'
    }
)

function Get-ServingHtml($h) {
    @"
<!-- SERVING $($h.Title) -->
<section class="hub-radius-section hub-serving-section" id="$($h.Id)" aria-label="$($h.Label)">
  <div class="hub-serving-wrap">
    <figure class="hub-serving-visual">
      <img src="assets/hubs/$($h.Img)" alt="$($h.Alt)" width="384" height="1024" loading="lazy" decoding="async">
    </figure>
    <div class="hub-radius-inner">
      <div class="sec-eye">Service Area</div>
      <div class="sec-title">SERVING<br><span style="color:var(--blue)">$($h.Title)</span></div>
      <p class="hub-radius-desc">$($h.Desc)</p>
    </div>
  </div>
</section>
"@
}

foreach ($h in $hubs) {
    $path = Join-Path $root $h.File
    if (-not (Test-Path $path)) { Write-Warning "Missing $($h.File)"; continue }
    $html = Get-Content $path -Raw -Encoding UTF8

    if ($html -notmatch '\.hub-serving-section\{') {
        $html = $html -replace '(\.hub-radius-note\{[^}]+\})', "`$1`n$cssBlock"
    }

    $servingHtml = Get-ServingHtml $h
    $marker = "<section class=`"hub-radius-section hub-serving-section`" id=`"$($h.Id)`""

    if ($html -match [regex]::Escape($marker)) {
        $pattern = "(?s)<!-- SERVING[^>]*-->.*?<section class=`"hub-radius-section hub-serving-section`" id=`"$($h.Id)`"[^>]*>.*?</section>"
        $html = [regex]::Replace($html, $pattern, $servingHtml.TrimEnd())
        Write-Output "Updated serving section: $($h.File)"
    }
    elseif ($html -match '(?s)(</section>\s*\r?\n\s*<!-- ZIP GATE -->)') {
        $html = $html -replace '(?s)(</section>\s*\r?\n\s*<!-- ZIP GATE -->)', ($servingHtml + "`n`n<!-- ZIP GATE -->")
        Write-Output "Inserted serving section: $($h.File)"
    }
    else {
        Write-Warning "Could not patch $($h.File)"
        continue
    }

    [System.IO.File]::WriteAllText($path, $html, [System.Text.UTF8Encoding]::new($false))
}

Write-Output 'Done.'
