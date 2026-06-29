# Create uniform plate-cover-badge.png (2.5:1 US plate aspect, charcoal + eagle shield)
Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath {
    param(
        [float]$X, [float]$Y, [float]$W, [float]$H, [float]$Radius
    )
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

$root = Split-Path $PSScriptRoot -Parent
$outPath = Join-Path $root 'assets/plate-cover-badge.png'
$logoPath = Join-Path $root 'assets/plate-cover-logo.png'

$badgeW = 625
$badgeH = 250
$radius = 14

$bmp = New-Object System.Drawing.Bitmap $badgeW, $badgeH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

$bg = [System.Drawing.Color]::FromArgb(255, 0x1a, 0x1a, 0x1a)
$borderOuter = [System.Drawing.Color]::FromArgb(255, 0x2e, 0x3a, 0x48)
$borderInner = [System.Drawing.Color]::FromArgb(90, 0x5a, 0x9a, 0xd4)

$bodyPath = New-RoundedRectPath -X 1 -Y 1 -W ($badgeW - 2) -H ($badgeH - 2) -Radius $radius
$bgBrush = New-Object System.Drawing.SolidBrush $bg
$g.FillPath($bgBrush, $bodyPath)
$bgBrush.Dispose()

$borderPen = New-Object System.Drawing.Pen $borderOuter, 2
$g.DrawPath($borderPen, $bodyPath)
$borderPen.Dispose()

$innerPath = New-RoundedRectPath -X 5 -Y 5 -W ($badgeW - 10) -H ($badgeH - 10) -Radius ($radius - 3)
$innerPen = New-Object System.Drawing.Pen $borderInner, 1
$g.DrawPath($innerPen, $innerPath)
$innerPen.Dispose()
$bodyPath.Dispose()
$innerPath.Dispose()

if (Test-Path $logoPath) {
    $logo = [System.Drawing.Image]::FromFile($logoPath)
    $cropW = [Math]::Max(1, [int]($logo.Width * 0.24))
    $cropH = [Math]::Max(1, [int]($logo.Height * 0.88))
    $shield = New-Object System.Drawing.Bitmap $cropW, $cropH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $sg = [System.Drawing.Graphics]::FromImage($shield)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($logo, 0, 0, [System.Drawing.Rectangle]::new(0, 0, $cropW, $cropH), [System.Drawing.GraphicsUnit]::Pixel)
    $sg.Dispose()
    $logo.Dispose()

    $maxShieldH = [int]($badgeH * 0.52)
    $maxShieldW = [int]($badgeW * 0.22)
    $scale = [Math]::Min($maxShieldW / $shield.Width, $maxShieldH / $shield.Height)
    $drawW = [Math]::Max(1, [int]($shield.Width * $scale))
    $drawH = [Math]::Max(1, [int]($shield.Height * $scale))
    $drawX = [int](($badgeW - $drawW) / 2)
    $drawY = [int](($badgeH * 0.38) - ($drawH / 2))
    $g.DrawImage($shield, $drawX, $drawY, $drawW, $drawH)
    $shield.Dispose()
}

$fontMain = New-Object System.Drawing.Font 'Segoe UI', 46, ([System.Drawing.FontStyle]::Bold)
$fontOne = New-Object System.Drawing.Font 'Segoe UI', 46, ([System.Drawing.FontStyle]::Bold)
$brushMain = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0xe8, 0xee, 0xf4))
$brushOne = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x5a, 0xc8, 0xff))
$textY = [int]($badgeH * 0.58)
$g.DrawString('CD', $fontMain, $brushMain, 228, $textY)
$g.DrawString('1', $fontOne, $brushOne, 318, $textY)
$fontMain.Dispose()
$fontOne.Dispose()
$brushMain.Dispose()
$brushOne.Dispose()

$g.Dispose()
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Created $outPath"
