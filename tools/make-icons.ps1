param([string]$OutDir)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

foreach ($size in 16, 32, 48, 128) {
  $S = 512.0
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.ScaleTransform($size / $S, $size / $S)

  # rounded square background (pink gradient)
  $r = 112
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r, $r, 180, 90)
  $path.AddArc($S - $r, 0, $r, $r, 270, 90)
  $path.AddArc($S - $r, $S - $r, $r, $r, 0, 90)
  $path.AddArc(0, $S - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new($S, $S)), ([System.Drawing.Color]::FromArgb(255, 240, 70, 130)), ([System.Drawing.Color]::FromArgb(255, 173, 20, 87))
  $g.FillPath($grad, $path)

  # speaker
  $white = [System.Drawing.Brushes]::White
  $g.FillRectangle($white, 92, 196, 72, 120)
  $pts = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(150, 196), [System.Drawing.PointF]::new(258, 112),
    [System.Drawing.PointF]::new(258, 400), [System.Drawing.PointF]::new(150, 316))
  $g.FillPolygon($white, $pts)

  # sound waves (fewer at small sizes so they stay readable)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 34
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawArc($pen, 226, 186, 140, 140, -45, 90)
  if ($size -ge 32) { $g.DrawArc($pen, 196, 126, 260, 260, -45, 90) }

  $g.Dispose()
  $bmp.Save((Join-Path $OutDir "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Get-ChildItem $OutDir | Select-Object Name, Length
