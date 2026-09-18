# A screenshot can be "written" and still be a blank page. Sample each one and
# report its mean colour and spread, so an empty render cannot pass as a result.
Add-Type -AssemblyName System.Drawing
$dir = (Resolve-Path (Join-Path $PSScriptRoot '../outputs/demo-shots')).Path
Get-ChildItem -Path $dir -Filter *.png | Sort-Object Name | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  $bmp = New-Object System.Drawing.Bitmap $img
  $w = $bmp.Width; $h = $bmp.Height
  $vals = New-Object System.Collections.Generic.List[double]
  $rs = 0; $gs = 0; $bs = 0; $n = 0
  $sx = [Math]::Max(1, [int]($w / 60)); $sy = [Math]::Max(1, [int]($h / 60))
  for ($x = 0; $x -lt $w; $x += $sx) {
    for ($y = 0; $y -lt $h; $y += $sy) {
      $c = $bmp.GetPixel($x, $y)
      $rs += $c.R; $gs += $c.G; $bs += $c.B; $n++
      $vals.Add(0.2126 * $c.R + 0.7152 * $c.G + 0.0722 * $c.B)
    }
  }
  $mean = 0.2126 * ($rs / $n) + 0.7152 * ($gs / $n) + 0.0722 * ($bs / $n)
  $var = 0; foreach ($v in $vals) { $var += [Math]::Pow($v - $mean, 2) }
  $sd = [Math]::Sqrt($var / $vals.Count)
  $colours = (($vals | Sort-Object -Unique).Count)
  "{0,-20} {1,5}x{2,-5} meanLuma {3,6:N1}  spread {4,5:N1}  tones {5,5}" -f $_.Name, $w, $h, $mean, $sd, $colours
  $bmp.Dispose(); $img.Dispose()
}
