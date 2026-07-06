$root = Split-Path -Parent $PSScriptRoot
$shortPayBox = @'
        <div class="pay-box">
          <div class="pay-t">Booking Policy · <a href="/terms-conditions" target="_blank" rel="noopener noreferrer" style="color:var(--blue);text-decoration:underline;text-underline-offset:3px;font-size:10px">Read Full Terms →</a></div>
          <ul style="list-style:none;padding:0;margin:0 0 14px">
            <li style="font-size:12.5px;color:var(--mu);margin-bottom:9px;padding-left:14px;position:relative"><span style="position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--blue);display:block"></span><strong style="color:var(--tx)">No charge today</strong> — saving your card secures the booking request only.</li>
            <li style="font-size:12.5px;color:var(--mu);margin-bottom:9px;padding-left:14px;position:relative"><span style="position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--blue);display:block"></span><strong style="color:var(--tx)">Card saved by Stripe</strong> — your card details are encrypted and never stored by Cardetail1.</li>
            <li style="font-size:12.5px;color:var(--mu);margin-bottom:9px;padding-left:14px;position:relative"><span style="position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--blue);display:block"></span><strong style="color:var(--tx)">Late cancellation fee</strong> — cancellations within 24 hours, no-shows, or inaccessible vehicles may incur a fee per our posted policy.</li>
            <li style="font-size:12.5px;color:var(--mu);padding-left:14px;position:relative"><span style="position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--blue);display:block"></span><strong style="color:var(--tx)">Final payment after service</strong> — collected on-site by card or cash, or online if approved in advance.</li>
          </ul>
          <div class="pay-badge">✓ No charge today · Card on file is required for every booking request</div>
        </div>
'@

$hubFiles = @(
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html'
)

$pattern = '(?s)\s*<div class="checkout-terms-wrap">.*?</details>\s*</div>'

foreach ($name in $hubFiles) {
  $path = Join-Path $root $name
  $html = Get-Content -Raw -Path $path
  if ($html -notmatch 'checkout-terms-wrap') { Write-Host "skip $name (no long terms)"; continue }
  $html = [regex]::Replace($html, $pattern, "`n$shortPayBox", 1)
  if ($html -match 'Suggested Booking Terms Summary') { throw "Failed to patch $name" }
  Set-Content -Path $path -Value $html -NoNewline
  Write-Host "patched $name step5 terms"
}
