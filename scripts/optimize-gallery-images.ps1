# Resize JPEG gallery sources for web (max width 1400px, ~85% quality).
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Dest,
  [int]$MaxWidth = 1400,
  [int]$Quality = 85
)

Add-Type -AssemblyName System.Drawing
$srcPath = Resolve-Path $Source
$destPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dest)
$destDir = Split-Path $destPath -Parent
if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }

$img = [System.Drawing.Image]::FromFile($srcPath)
try {
  # Respect EXIF orientation when present.
  if ($img.PropertyIdList -contains 274) {
    $orientation = $img.GetPropertyItem(274).Value[0]
    switch ($orientation) {
      2 { $img.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipX) }
      3 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
      4 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipX) }
      5 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipX) }
      6 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
      7 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipX) }
      8 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
    }
  }

  $scale = if ($img.Width -gt $MaxWidth) { $MaxWidth / $img.Width } else { 1.0 }
  $newW = [int][Math]::Round($img.Width * $scale)
  $newH = [int][Math]::Round($img.Height * $scale)

  $bmp = New-Object System.Drawing.Bitmap $newW, $newH
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $newW, $newH)
  $g.Dispose()

  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
  $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), [long]$Quality
  $bmp.Save($destPath, $codec, $encParams)
  $bmp.Dispose()
  Write-Output "OK $destPath (${newW}x${newH})"
}
finally {
  $img.Dispose()
}
