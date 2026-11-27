# Builds Chrome Web Store images from the screenshots in Screenshots/:
#   store/chrome/screenshot-1.png ... (1280x800, 24-bit, no alpha)
#   store/chrome/promo-tile-440x280.png
# Run from the project folder:  powershell -File tools/make-store-images.ps1
param([string]$Root = (Get-Location).Path)

Add-Type -AssemblyName System.Drawing
$out = Join-Path $Root "store\chrome"
New-Item -ItemType Directory -Force $out | Out-Null

$accent = [System.Drawing.Color]::FromArgb(255, 233, 30, 99)
$white  = [System.Drawing.Color]::White
$muted  = [System.Drawing.Color]::FromArgb(255, 200, 200, 208)

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 24, 24, 28)), ([System.Drawing.Color]::FromArgb(255, 58, 14, 36)), 35
  $g.FillRectangle($bg, $rect)
  return @($bmp, $g)
}

function Get-RoundPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
  $p.AddArc($x + $w - 2*$r, $y, 2*$r, 2*$r, 270, 90)
  $p.AddArc($x + $w - 2*$r, $y + $h - 2*$r, 2*$r, 2*$r, 0, 90)
  $p.AddArc($x, $y + $h - 2*$r, 2*$r, 2*$r, 90, 90)
  $p.CloseFigure()
  return $p
}

# Pixelate a region of an image (used to hide a chat line with a curse word).
function Hide-Region($img, [int]$x, [int]$y, [int]$w, [int]$h, [int]$block = 9) {
  $g = [System.Drawing.Graphics]::FromImage($img)
  for ($by = $y; $by -lt $y + $h; $by += $block) {
    for ($bx = $x; $bx -lt $x + $w; $bx += $block) {
      $c = $img.GetPixel([Math]::Min($bx + 2, $img.Width - 1), [Math]::Min($by + 2, $img.Height - 1))
      $brush = New-Object System.Drawing.SolidBrush $c
      $g.FillRectangle($brush, $bx, $by, $block, $block)
      $brush.Dispose()
    }
  }
  $g.Dispose()
}

function Draw-Shot($g, $img, [float]$bx, [float]$by, [float]$bw, [float]$bh) {
  $scale = [Math]::Min($bw / $img.Width, $bh / $img.Height)
  $w = $img.Width * $scale; $h = $img.Height * $scale
  $x = $bx + ($bw - $w) / 2; $y = $by + ($bh - $h) / 2
  # soft shadow
  for ($i = 6; $i -ge 1; $i--) {
    $sh = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(14, 0, 0, 0))
    $g.FillPath($sh, (Get-RoundPath ($x - $i * 2) ($y - $i * 2 + 6) ($w + $i * 4) ($h + $i * 4) 14))
  }
  $clip = Get-RoundPath $x $y $w $h 12
  $g.SetClip($clip)
  $g.DrawImage($img, [float]$x, [float]$y, [float]$w, [float]$h)
  $g.ResetClip()
}

function Draw-Text($g, [string]$title, [string]$body, [float]$x, [float]$y, [float]$w, [float]$titleSize) {
  $tf = New-Object System.Drawing.Font "Segoe UI Semibold", $titleSize, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $bf = New-Object System.Drawing.Font "Segoe UI", ([Math]::Round($titleSize * 0.5)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), $x, $y, 56, 6)
  $tRect = New-Object System.Drawing.RectangleF $x, ($y + 24), $w, 200
  $g.DrawString($title, $tf, (New-Object System.Drawing.SolidBrush $white), $tRect)
  $tSize = $g.MeasureString($title, $tf, [int]$w)
  $bRect = New-Object System.Drawing.RectangleF $x, ($y + 40 + $tSize.Height), $w, 400
  $g.DrawString($body, $bf, (New-Object System.Drawing.SolidBrush $muted), $bRect)
}

$shots = @(
  @{ file = "004.jpg"; title = "Read any page aloud";
     body = "Paragraph by paragraph. Click any paragraph to jump there, pause, or go back and forward." },
  @{ file = "006.jpg"; title = "Live Twitch & YouTube chat";
     body = "Pick the chat and hear new messages as they arrive. In fast chats, a backlog keeps you up to date.";
     hide = @(40, 448, 300, 26) },
  @{ file = "005.jpg"; title = "Local voices only";
     body = "Uses the voices installed on your device. Choose voice, speed and volume. Nothing you read is sent anywhere." }
)

$n = 0
foreach ($s in $shots) {
  $n++
  $src = [System.Drawing.Image]::FromFile((Join-Path $Root "Screenshots\$($s.file)"))
  $img = New-Object System.Drawing.Bitmap $src
  $src.Dispose()
  if ($s.hide) { Hide-Region $img $s.hide[0] $s.hide[1] $s.hide[2] $s.hide[3] }

  $canvas = New-Canvas 1280 800
  $bmp = $canvas[0]; $g = $canvas[1]
  if ($img.Width / $img.Height -gt 1.2) {
    # wide screenshot: caption on top, screenshot below
    Draw-Text $g $s.title $s.body 80 50 1120 44
    Draw-Shot $g $img 80 220 1120 540
  } else {
    # tall screenshot: caption left, screenshot right
    Draw-Text $g $s.title $s.body 80 250 520 48
    Draw-Shot $g $img 640 40 580 720
  }
  $path = Join-Path $out "screenshot-$n.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  Write-Output "wrote $path"
}

# Promo tile 440x280
$canvas = New-Canvas 440 280
$bmp = $canvas[0]; $g = $canvas[1]
$icon = [System.Drawing.Image]::FromFile((Join-Path $Root "icons\icon-128.png"))
$g.DrawImage($icon, 36, 76, 128, 128)
$icon.Dispose()
$tf = New-Object System.Drawing.Font "Segoe UI Semibold", 30, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$bf = New-Object System.Drawing.Font "Segoe UI", 15, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Local TTS`nReader", $tf, (New-Object System.Drawing.SolidBrush $white), (New-Object System.Drawing.RectangleF 186, 78, 240, 90))
$g.DrawString("Pages & live chat read aloud with local voices", $bf, (New-Object System.Drawing.SolidBrush $muted), (New-Object System.Drawing.RectangleF 188, 160, 230, 60))
$path = Join-Path $out "promo-tile-440x280.png"
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "wrote $path"
