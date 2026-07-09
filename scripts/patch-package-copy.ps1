$dir = Join-Path $PSScriptRoot 'pack-updates'
$root = Split-Path $PSScriptRoot -Parent
$pairs = @(
  @('old-maint-em.txt','new-maint-em.txt'),
  @('old-interior-em.txt','new-interior-em.txt'),
  @('old-interior-hy.txt','new-interior-hy.txt'),
  @('old-refresh.txt','new-refresh.txt'),
  @('old-premium.txt','new-premium.txt')
)
$files = Get-ChildItem -Path $root -Filter '*.html' -File | Where-Object {
  Select-String -Path $_.FullName -Pattern "id:'refresh'" -Quiet
}
foreach ($f in $files) {
  $c = [IO.File]::ReadAllText($f.FullName)
  $orig = $c
  foreach ($pair in $pairs) {
    $old = [IO.File]::ReadAllText((Join-Path $dir $pair[0]))
    $new = [IO.File]::ReadAllText((Join-Path $dir $pair[1]))
    if ($c.Contains($old)) { $c = $c.Replace($old, $new) }
  }
  if ($c -ne $orig) {
    [IO.File]::WriteAllText($f.FullName, $c)
    Write-Host "Patched: $($f.Name)"
  }
}
Write-Host 'Done.'
