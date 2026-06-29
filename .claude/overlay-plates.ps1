# Overlay uniform plate-cover-badge.png on license plate regions only (no blur)
Add-Type -AssemblyName System.Drawing

function Open-EditableBitmap {
    param([string]$Path)
    $src = [System.Drawing.Image]::FromFile($Path)
    $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
    $g.Dispose()
    $src.Dispose()
    return $bmp
}

function Overlay-PlateBadge {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [System.Drawing.Image]$Badge,
        [int]$X, [int]$Y, [int]$W, [int]$H,
        [int]$MarginPx = 2
    )
    if ($W -lt 6 -or $H -lt 6) { return }

    $X = [Math]::Max(0, [Math]::Min($X, $Bitmap.Width - 1))
    $Y = [Math]::Max(0, [Math]::Min($Y, $Bitmap.Height - 1))
    $W = [Math]::Min($W, $Bitmap.Width - $X)
    $H = [Math]::Min($H, $Bitmap.Height - $Y)
    if ($W -lt 6 -or $H -lt 6) { return }

    $innerW = $W - (2 * $MarginPx)
    $innerH = $H - (2 * $MarginPx)
    if ($innerW -lt 4 -or $innerH -lt 4) { return }

    $badgeAspect = $Badge.Width / [double]$Badge.Height
    $boxAspect = $innerW / [double]$innerH

    if ($boxAspect -gt $badgeAspect) {
        $drawH = $innerH
        $drawW = [int][Math]::Round($drawH * $badgeAspect)
    } else {
        $drawW = $innerW
        $drawH = [int][Math]::Round($drawW / $badgeAspect)
    }

    $drawX = $X + $MarginPx + [int][Math]::Round(($innerW - $drawW) / 2.0)
    $drawY = $Y + $MarginPx + [int][Math]::Round(($innerH - $drawH) / 2.0)

    $g = [System.Drawing.Graphics]::FromImage($Bitmap)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($Badge, $drawX, $drawY, $drawW, $drawH)
    $g.Dispose()
}

function Apply-PlateOverlays {
    param(
        [string]$Path,
        [double[]]$FlatRegions,
        [System.Drawing.Image]$Badge,
        [int]$MarginPx = 2,
        [double]$Pad = 0.012
    )
    $bmp = Open-EditableBitmap $Path
    for ($i = 0; $i -lt $FlatRegions.Count; $i += 4) {
        $left = [Math]::Max(0.0, $FlatRegions[$i] - $Pad)
        $top = [Math]::Max(0.0, $FlatRegions[$i + 1] - $Pad)
        $right = [Math]::Min(1.0, $FlatRegions[$i + 2] + $Pad)
        $bottom = [Math]::Min(1.0, $FlatRegions[$i + 3] + $Pad)
        $x = [int]($left * $bmp.Width)
        $y = [int]($top * $bmp.Height)
        $w = [int](($right - $left) * $bmp.Width)
        $h = [int](($bottom - $top) * $bmp.Height)
        Overlay-PlateBadge -Bitmap $bmp -Badge $Badge -X $x -Y $y -W $w -H $h -MarginPx $MarginPx
    }

    $tmp = [System.IO.Path]::GetTempFileName()
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 92L)
    $bmp.Save($tmp, $enc, $ep)
    $bmp.Dispose()
    Copy-Item -Force $tmp $Path
    Remove-Item -Force $tmp
}

if ($MyInvocation.InvocationName -eq '.') { return }

$root = Split-Path $PSScriptRoot -Parent
$badgePath = Join-Path $root 'assets/plate-cover-badge.png'

if (-not (Test-Path $badgePath)) {
    & (Join-Path $PSScriptRoot 'create-plate-cover-badge.ps1')
}

$badge = [System.Drawing.Image]::FromFile($badgePath)

$targets = [ordered]@{
    'assets/before-after/subaru-exterior-after.jpg' = @(0.12, 0.70, 0.20, 0.82)
    'assets/before-after/gmc-exterior-after.jpg' = @(0.68, 0.39, 0.76, 0.54)
    'assets/before-after/gmc-exterior-before.jpg' = @(0.73, 0.30, 0.82, 0.53)
    'assets/before-after/mini-front-after.jpg' = @(0.445, 0.79, 0.565, 0.85)
    'assets/before-after/mini-front-before.jpg' = @(0.47, 0.69, 0.71, 0.80)
    'assets/before-after/mini-side-after.jpg' = @(0.83, 0.47, 0.86, 0.52, 0.14, 0.28, 0.16, 0.30)
    'assets/before-after/mini-side-before.jpg' = @(0.10, 0.54, 0.18, 0.63, 0.85, 0.49, 0.93, 0.58)
    'assets/before-after/mini-rear-after.jpg' = @(0.44, 0.67, 0.54, 0.74)
    'assets/before-after/mini-rear-before.jpg' = @(0.49, 0.70, 0.67, 0.80)
    'assets/before-after/volvo-exterior-after.jpg' = @(0.47, 0.75, 0.61, 0.82)
    'assets/before-after/volvo-exterior-before.jpg' = @(0.43, 0.69, 0.59, 0.80)
    'assets/before-after/defender-exterior-after.jpg' = @(0.91, 0.46, 0.98, 0.52, 0.23, 0.47, 0.28, 0.52)
    'assets/before-after/defender-exterior-before.jpg' = @(0.02, 0.30, 0.18, 0.48, 0.71, 0.04, 0.90, 0.18)
    'assets/before-after/vienna-rv-front-after.jpg' = @(0.39, 0.845, 0.55, 0.905)
    'assets/before-after/gator-interior-after.jpg' = @(0.31, 0.17, 0.40, 0.24)
    'assets/before-after/gator-interior-before.jpg' = @(0.12, 0.11, 0.21, 0.19)
    'assets/before-after/vienna-rv-roof-after.jpg' = @(0.68, 0.04, 0.82, 0.16)
    'assets/before-after/vienna-rv-roof-before.jpg' = @(0.50, 0.30, 0.68, 0.46, 0.02, 0.10, 0.14, 0.24)
    'assets/showcase/luxury-fleet-lineup.jpg' = @(0.13, 0.33, 0.17, 0.37, 0.36, 0.47, 0.41, 0.51)
    'assets/showcase/luxury-porsche-1.jpg' = @(0.145, 0.46, 0.175, 0.48)
}

$processed = @()
foreach ($rel in $targets.Keys) {
    $full = Join-Path $root $rel
    if (-not (Test-Path $full)) {
        Write-Warning "Missing: $rel"
        continue
    }
    Apply-PlateOverlays -Path $full -FlatRegions $targets[$rel] -Badge $badge -MarginPx 2
    $regionCount = $targets[$rel].Count / 4
    $processed += $rel
    Write-Host "Covered: $rel ($regionCount region(s))"
}

$badge.Dispose()
Write-Host "`nProcessed $($processed.Count) files."
$processed | ConvertTo-Json -Compress
