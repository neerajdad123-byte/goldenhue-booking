# Downscale the downloaded photography to web sizes and report the measurements a
# designer would want: aspect ratio and mean colour, which decide the crop and
# whether a duotone wash will sit well on it.
Add-Type -AssemblyName System.Drawing
$dir = (Resolve-Path (Join-Path $PSScriptRoot '../outputs/demo/img')).Path
$maxW = 1800

Get-ChildItem -Path $dir -Filter *.jpg | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  $w = $img.Width; $h = $img.Height

  # mean colour, sampled on a coarse grid
  $bmp = New-Object System.Drawing.Bitmap $img
  $rs = 0; $gs = 0; $bs = 0; $n = 0
  for ($x = 0; $x -lt $w; $x += [Math]::Max(1, [int]($w / 24))) {
    for ($y = 0; $y -lt $h; $y += [Math]::Max(1, [int]($h / 24))) {
      $c = $bmp.GetPixel($x, $y)
      $rs += $c.R; $gs += $c.G; $bs += $c.B; $n++
    }
  }
  $mean = '#{0:x2}{1:x2}{2:x2}' -f [int]($rs / $n), [int]($gs / $n), [int]($bs / $n)
  $luma = [int](0.2126 * ($rs / $n) + 0.7152 * ($gs / $n) + 0.0722 * ($bs / $n))
  "{0,-24} {1,5}x{2,-5} ratio {3,-6:N2} mean {4} luma {5}" -f $_.Name, $w, $h, [Math]::Round($w / $h, 2), $mean, $luma

  if ($w -gt $maxW) {
    $nh = [int]($h * $maxW / $w)
    $new = New-Object System.Drawing.Bitmap $maxW, $nh
    $g = [System.Drawing.Graphics]::FromImage($new)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $maxW, $nh)
    $g.Dispose()
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ps = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 82L)
    $tmp = $_.FullName + '.tmp.jpg'
    $new.Save($tmp, $enc, $ps)
    $new.Dispose()
    $bmp.Dispose()
    $img.Dispose()
    Move-Item -LiteralPath $tmp -Destination $_.FullName -Force
    ""
    "  -> resized to {0}x{1}, now {2}kb" -f $maxW, $nh, [int]((Get-Item $_.FullName).Length / 1024)
  } else {
    $bmp.Dispose(); $img.Dispose()
  }
}
