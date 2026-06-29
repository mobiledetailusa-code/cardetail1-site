Set-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
$root = "C:\Users\magno\Desktop\dz project"
Set-Location $root

$files = @(
  'assets/before-after/defender-exterior-after.jpg',
  'assets/before-after/defender-exterior-before.jpg',
  'assets/before-after/gator-interior-after.jpg',
  'assets/before-after/gator-interior-before.jpg',
  'assets/before-after/gmc-exterior-after.jpg',
  'assets/before-after/gmc-exterior-before.jpg',
  'assets/before-after/mini-front-after.jpg',
  'assets/before-after/mini-front-before.jpg',
  'assets/before-after/mini-rear-after.jpg',
  'assets/before-after/mini-rear-before.jpg',
  'assets/before-after/mini-side-after.jpg',
  'assets/before-after/mini-side-before.jpg',
  'assets/before-after/subaru-exterior-after.jpg',
  'assets/before-after/vienna-rv-front-after.jpg',
  'assets/before-after/vienna-rv-roof-after.jpg',
  'assets/before-after/vienna-rv-roof-before.jpg',
  'assets/before-after/volvo-exterior-after.jpg',
  'assets/before-after/volvo-exterior-before.jpg',
  'assets/showcase/luxury-fleet-lineup.jpg',
  'assets/showcase/luxury-porsche-1.jpg'
)

foreach ($f in $files) {
  git checkout 00f3b37 -- $f
  Write-Host "Restored $f"
}
