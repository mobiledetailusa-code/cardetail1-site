$root = Split-Path $PSScriptRoot -Parent
$patterns = @(
  @("Restoration',`r`n icon:", "Restoration', icon:"),
  @("Restoration',`n icon:", "Restoration', icon:")
)
Get-ChildItem -Path $root -Filter '*.html' | ForEach-Object {
  $c = [IO.File]::ReadAllText($_.FullName)
  $n = $c
  foreach ($p in $patterns) { $n = $n.Replace($p[0], $p[1]) }
  if ($n -ne $c) {
    [IO.File]::WriteAllText($_.FullName, $n)
    Write-Host "Fixed: $($_.Name)"
  }
}
