# Renders the phantum ghost as PNG icons for the web app manifest.
# Edge/Chrome app-mode windows (phantum.vbs launches with --app=) use the
# manifest's PNG icons for the taskbar + window — an SVG-emoji favicon isn't
# enough, which is why the taskbar otherwise shows the generic browser icon.
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\public')
)

Add-Type -AssemblyName System.Drawing

function New-GhostBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  $sc = $size / 256.0
  function S([double]$v) { return [single]($v * $sc) }

  # rounded gradient background tile
  $inset = S 6
  $rectF = New-Object System.Drawing.RectangleF $inset, $inset, ([single]($size - 2 * $inset)), ([single]($size - 2 * $inset))
  $rad = S 52
  $d = [single]($rad * 2)
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bg.AddArc($rectF.X, $rectF.Y, $d, $d, 180, 90)
  $bg.AddArc([single]($rectF.Right - $d), $rectF.Y, $d, $d, 270, 90)
  $bg.AddArc([single]($rectF.Right - $d), [single]($rectF.Bottom - $d), $d, $d, 0, 90)
  $bg.AddArc($rectF.X, [single]($rectF.Bottom - $d), $d, $d, 90, 90)
  $bg.CloseFigure()
  $c1 = [System.Drawing.Color]::FromArgb(140, 165, 255)
  $c2 = [System.Drawing.Color]::FromArgb(88, 120, 255)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rectF, $c1, $c2, ([single]90)
  $g.FillPath($grad, $bg)

  # ghost body
  $ghost = New-Object System.Drawing.Drawing2D.GraphicsPath
  $ghost.AddArc((S 64), (S 54), (S 128), (S 128), 180, 180)
  $ghost.AddLine((S 192), (S 118), (S 192), (S 186))
  $r = 21.333
  $cy = 186.0
  $centers = @(170.667, 128.0, 85.333)
  foreach ($cx in $centers) {
    $ghost.AddArc((S ($cx - $r)), (S ($cy - $r)), (S ($r * 2)), (S ($r * 2)), 0, 180)
  }
  $ghost.AddLine((S 64), (S 186), (S 64), (S 118))
  $ghost.CloseFigure()
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(246, 248, 255))
  $g.FillPath($white, $ghost)

  # eyes
  $eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 24, 36))
  $g.FillEllipse($eye, (S 103), (S 100), (S 19), (S 27))
  $g.FillEllipse($eye, (S 134), (S 100), (S 19), (S 27))

  $g.Dispose()
  return $bmp
}

foreach ($s in 512, 192, 32) {
  $b = New-GhostBitmap $s
  $out = Join-Path $OutDir "icon-$s.png"
  $b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  Write-Output "wrote $out"
}
