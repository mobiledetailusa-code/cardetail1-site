$root = Split-Path $PSScriptRoot -Parent
$insert = [IO.File]::ReadAllText("$PSScriptRoot\refresh-package-insert.txt")
$anchor = "      {id:'premium',  name:'Signature Interior & Exterior Restoration',"

$tierReplacements = @{
  'full:300, premium:450'  = 'full:300, refresh:375, premium:450'
  'full:325, premium:550'  = 'full:325, refresh:425, premium:550'
  'full:325, premium:635'  = 'full:325, refresh:475, premium:635'
  'full:325, premium:615'  = 'full:325, refresh:465, premium:615'
}

$files = Get-ChildItem -Path $root -Filter '*.html' -File | Where-Object {
  Select-String -Path $_.FullName -Pattern "Signature Interior & Exterior Restoration" -Quiet
}

foreach ($f in $files) {
  $c = [IO.File]::ReadAllText($f.FullName)
  $orig = $c
  if ($c.Contains("id:'refresh'")) { Write-Host "Skip (already patched): $($f.Name)"; continue }
  foreach ($kv in $tierReplacements.GetEnumerator()) {
    $c = $c.Replace($kv.Key, $kv.Value)
  }
  if ($c.Contains($anchor)) {
    $c = $c.Replace($anchor, $insert)
  }
  if ($c -ne $orig) {
    [IO.File]::WriteAllText($f.FullName, $c)
    Write-Host "Patched: $($f.Name)"
  }
}

# customer-catalog.js
$catJs = Join-Path $root 'netlify\lib\customer-catalog.js'
if (Test-Path $catJs) {
  $c = [IO.File]::ReadAllText($catJs)
  if ($c -notmatch "id: 'refresh'") {
    $newEntry = @"
  {
    id: 'refresh',
    name: 'Exterior Refresh & Protect',
    basePrice: 375,
    tag: 'Complete exterior — decontamination, polish, sealant & wheels',
    duration: '~2.5–3h',
    description: 'Complete exterior treatment. Chemical decontamination, light enhancement polish, long-lasting sealant, and wheel detailing.',
    feats: ['Chemical decontamination', 'Light enhancement polish', 'Long-lasting sealant', 'Wheel & lug detailing', 'Exterior glass', 'Tire dressing'],
  },
"@
    $c = $c.Replace("  {
    id: 'premium',", ($newEntry + "  {
    id: 'premium',"))
    $c = $c.Replace(
      "if (/paint|correction|enhancement/i.test(hay)) return CAR_PACKAGES[3];",
      "if (/refresh|exterior refresh/i.test(hay)) return CAR_PACKAGES[3];`n  if (/signature|restoration|paint|correction/i.test(hay)) return CAR_PACKAGES[4];"
    )
    $c = $c.Replace(
      "if (/premium detail|full detail|premium/i.test(hay) && !/paint|correction/i.test(hay)) return CAR_PACKAGES[2];",
      "if (/premium detail|full detail/i.test(hay) && !/paint|correction|signature|refresh/i.test(hay)) return CAR_PACKAGES[2];"
    )
    [IO.File]::WriteAllText($catJs, $c)
    Write-Host 'Patched: customer-catalog.js'
  }
}

Write-Host 'Done.'
