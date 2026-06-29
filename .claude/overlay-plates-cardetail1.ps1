# Overlay Cardetail1 logo on license plate regions only (no blur)
Add-Type -AssemblyName System.Drawing

function Get-AspectFitRect {
    param([int]$BoxX, [int]$BoxY, [int]$BoxW, [int]$BoxH, [int]$SrcW, [int]$SrcH, [double]$PaddingRatio = 0.06)
    $padX = [Math]::Max(1, [int]($BoxW * $PaddingRatio))
    $padY = [Math]::Max(1, [int]($BoxH * $PaddingRatio))
    $innerX = $BoxX + $padX; $innerY = $BoxY + $padY
    $innerW = [Math]::Max(1, $BoxW - (2 * $padX)); $innerH = [Math]::Max(1, $BoxH - (2 * $padY))
    $scale = [Math]::Min($innerW / [double]$SrcW, $innerH / [double]$SrcH)
    $drawW = [Math]::Max(1, [int]($SrcW * $scale)); $drawH = [Math]::Max(1, [int]($SrcH * $scale))
    $drawX = $innerX + [int](($innerW - $drawW) / 2); $drawY = $innerY + [int](($innerH - $drawH) / 2)
    return [System.Drawing.Rectangle]::new($drawX, $drawY, $drawW, $drawH)
}

function New-RoundedRectPath {
    param([int]$X, [int]$Y, [int]$W, [int]$H, [int]$Radius)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $path.CloseFigure(); return $path
}

function Initialize-PlateLogoAssets {
    param([string]$LogoPath)
    $master = [System.Drawing.Bitmap]::FromFile($LogoPath)
    $mw = $master.Width; $mh = $master.Height
    $wideH = [Math]::Max(1, [int]($mh * 0.82))
    $wide = New-Object System.Drawing.Bitmap $mw, $wideH
    $gw = [System.Drawing.Graphics]::FromImage($wide); $gw.DrawImage($master, 0, 0, $mw, $wideH); $gw.Dispose()
    $shieldW = [Math]::Max(1, [int]($mw * 0.38)); $shieldH = [Math]::Max(1, [int]($mh * 0.78))
    $shield = New-Object System.Drawing.Bitmap $shieldW, $shieldH
    $gs = [System.Drawing.Graphics]::FromImage($shield)
    $gs.DrawImage($master, 0, 0, (New-Object System.Drawing.Rectangle 0, 0, $shieldW, $shieldH), [System.Drawing.GraphicsUnit]::Pixel)
    $gs.Dispose()
    return @{ Master = $master; Wide = $wide; Shield = $shield }
}

function Open-EditableBitmap {
    param([string]$ImagePath)
    $src = [System.Drawing.Image]::FromFile($ImagePath)
    $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($src, 0, 0, $src.Width, $src.Height); $g.Dispose(); $src.Dispose()
    return $bmp
}

function Apply-LogoOverlay {
    param([System.Drawing.Bitmap]$Bitmap, [int]$BoxX, [int]$BoxY, [int]$BoxW, [int]$BoxH, [System.Drawing.Bitmap]$LogoBitmap, [switch]$UseWhiteBacking)
    if ($BoxW -lt 2 -or $BoxH -lt 2) { return }
    $BoxX = [Math]::Max(0, [Math]::Min($BoxX, $Bitmap.Width - 1)); $BoxY = [Math]::Max(0, [Math]::Min($BoxY, $Bitmap.Height - 1))
    $BoxW = [Math]::Min($BoxW, $Bitmap.Width - $BoxX); $BoxH = [Math]::Min($BoxH, $Bitmap.Height - $BoxY)
    if ($BoxW -lt 2 -or $BoxH -lt 2) { return }
    $g = [System.Drawing.Graphics]::FromImage($Bitmap)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    if ($UseWhiteBacking) {
        $radius = [Math]::Max(2, [int]([Math]::Min($BoxW, $BoxH) * 0.12))
        $backPath = New-RoundedRectPath -X $BoxX -Y $BoxY -W $BoxW -H $BoxH -Radius $radius
        $whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 245, 245))
        $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(180, 180, 180)), 1
        $g.FillPath($whiteBrush, $backPath); $g.DrawPath($borderPen, $backPath)
        $whiteBrush.Dispose(); $borderPen.Dispose(); $backPath.Dispose()
    }
    $dest = Get-AspectFitRect -BoxX $BoxX -BoxY $BoxY -BoxW $BoxW -BoxH $BoxH -SrcW $LogoBitmap.Width -SrcH $LogoBitmap.Height
    $g.DrawImage($LogoBitmap, $dest); $g.Dispose()
}

function Overlay-NormalizedRegions {
    param([string]$ImagePath, [double[]]$FlatRegions, [hashtable]$LogoAssets, [double]$Pad = 0.008)
    $bmp = Open-EditableBitmap -ImagePath $ImagePath
    for ($i = 0; $i -lt $FlatRegions.Count; $i += 4) {
        $left = [Math]::Max(0.0, $FlatRegions[$i] - $Pad); $top = [Math]::Max(0.0, $FlatRegions[$i + 1] - $Pad)
        $right = [Math]::Min(1.0, $FlatRegions[$i + 2] + $Pad); $bottom = [Math]::Min(1.0, $FlatRegions[$i + 3] + $Pad)
        $boxX = [int]($left * $bmp.Width); $boxY = [int]($top * $bmp.Height)
        $boxW = [int](($right - $left) * $bmp.Width); $boxH = [int](($bottom - $top) * $bmp.Height)
        $useShield = ($boxW -lt 70) -or ($boxH -lt 30)
        $logoBmp = if ($useShield) { $LogoAssets.Shield } else { $LogoAssets.Wide }
        $useWhite = $useShield -or ($boxW -lt 120)
        Apply-LogoOverlay -Bitmap $bmp -BoxX $boxX -BoxY $boxY -BoxW $boxW -BoxH $boxH -LogoBitmap $logoBmp -UseWhiteBacking:$useWhite
    }
    $tmp = [System.IO.Path]::GetTempFileName()
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 92L)
    $bmp.Save($tmp, $enc, $ep); $bmp.Dispose(); Copy-Item -Force $tmp $ImagePath; Remove-Item -Force $tmp
}

if ($MyInvocation.InvocationName -eq '.') { return }

$root = Split-Path $PSScriptRoot -Parent
$logoPath = Join-Path $root 'assets\plate-cover-logo.png'
if (-not (Test-Path $logoPath)) { & (Join-Path $PSScriptRoot 'prepare-plate-logo.ps1') }
$logoAssets = Initialize-PlateLogoAssets -LogoPath $logoPath

$targets = [ordered]@{
    'assets/before-after/gmc-exterior-after.jpg'       = @(0.668, 0.388, 0.748, 0.545)
    'assets/before-after/gmc-exterior-before.jpg'      = @(0.728, 0.430, 0.778, 0.650)
    'assets/before-after/mini-front-after.jpg'         = @(0.448, 0.792, 0.562, 0.854)
    'assets/before-after/mini-front-before.jpg'        = @(0.502, 0.730, 0.682, 0.772)
    'assets/before-after/mini-rear-after.jpg'          = @(0.458, 0.668, 0.542, 0.712)
    'assets/before-after/mini-rear-before.jpg'         = @(0.505, 0.715, 0.652, 0.778)
    'assets/before-after/volvo-exterior-after.jpg'     = @(0.390, 0.745, 0.495, 0.810)
    'assets/before-after/volvo-exterior-before.jpg'    = @(0.460, 0.720, 0.570, 0.785)
    'assets/before-after/vienna-rv-front-after.jpg'    = @(0.410, 0.860, 0.540, 0.920)
    'assets/before-after/defender-exterior-before.jpg' = @(0.085, 0.612, 0.135, 0.642)
    'assets/before-after/gator-interior-before.jpg'    = @(0.132, 0.182, 0.158, 0.198)
    'assets/before-after/vienna-rv-roof-after.jpg'     = @(0.658, 0.435, 0.672, 0.448)
    'assets/before-after/vienna-rv-roof-before.jpg'    = @(0.826, 0.405, 0.836, 0.415)
    'assets/showcase/luxury-fleet-lineup.jpg'          = @(0.338, 0.140, 0.350, 0.153)
    'assets/showcase/luxury-porsche-1.jpg'             = @(0.154, 0.466, 0.181, 0.482)
}

$processed = @()
foreach ($rel in $targets.Keys) {
    $full = Join-Path $root $rel
    if (-not (Test-Path $full)) { Write-Warning "Missing: $rel"; continue }
    Overlay-NormalizedRegions -ImagePath $full -FlatRegions $targets[$rel] -LogoAssets $logoAssets
    $processed += $rel
    Write-Host "Overlay: $rel"
}
$logoAssets.Master.Dispose(); $logoAssets.Wide.Dispose(); $logoAssets.Shield.Dispose()
Write-Host "Processed $($processed.Count) files."
$processed | ConvertTo-Json -Compress
