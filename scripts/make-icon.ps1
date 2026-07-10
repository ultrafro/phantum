# Generates phantum.ico (a ghost mark) — no external assets or tools needed.
# Draws a vector ghost on a rounded gradient tile, then packs multiple PNG
# sizes into a single multi-resolution .ico so it stays crisp everywhere.
param(
  [string]$OutIco = (Join-Path $PSScriptRoot '..\phantum.ico'),
  [string]$OutPng = ''   # optional PNG preview
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

  # --- rounded gradient background tile ---
  $inset = S 6
  $rectF = New-Object System.Drawing.RectangleF $inset, $inset, ([single]($size - 2*$inset)), ([single]($size - 2*$inset))
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

  # --- ghost body ---
  $ghost = New-Object System.Drawing.Drawing2D.GraphicsPath
  $ghost.AddArc((S 64), (S 54), (S 128), (S 128), 180, 180)   # domed head
  $ghost.AddLine((S 192), (S 118), (S 192), (S 186))          # right side
  $r = 21.333
  $cy = 186.0
  $centers = @(170.667, 128.0, 85.333)                        # 3 scalloped feet
  foreach ($cx in $centers) {
    $ghost.AddArc((S ($cx - $r)), (S ($cy - $r)), (S ($r*2)), (S ($r*2)), 0, 180)
  }
  $ghost.AddLine((S 64), (S 186), (S 64), (S 118))            # left side
  $ghost.CloseFigure()
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(246, 248, 255))
  $g.FillPath($white, $ghost)

  # --- eyes ---
  $eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 24, 36))
  $g.FillEllipse($eye, (S 103), (S 100), (S 19), (S 27))
  $g.FillEllipse($eye, (S 134), (S 100), (S 19), (S 27))

  $g.Dispose()
  return $bmp
}

# Master render + optional preview
$master = New-GhostBitmap 256
if ($OutPng) { $master.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png) }

# Build PNGs at each icon size (re-render vector for crispness)
$sizes = 256, 128, 64, 48, 32, 16
$pngs = @()
foreach ($s in $sizes) {
  $b = New-GhostBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , ($ms.ToArray())
  $ms.Dispose(); $b.Dispose()
}

# Assemble the .ico container
$fs = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $data = $pngs[$i]
  $dim = [byte]($(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write($dim); $bw.Write($dim)
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
  $offset += $data.Length
}
foreach ($data in $pngs) { $bw.Write($data) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($OutIco, $fs.ToArray())
$bw.Dispose(); $fs.Dispose()
Write-Output "wrote $OutIco ($([System.IO.FileInfo]::new($OutIco).Length) bytes)"
