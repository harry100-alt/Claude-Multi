param([int]$Size = 512, [string]$OutPath)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($Size, $Size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$fontSize = [int]($Size * 0.65)
$font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = 'Center'
$sf.LineAlignment = 'Center'
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
$rect = New-Object System.Drawing.RectangleF(0, [float]($Size * 0.02), [float]$Size, [float]$Size)
$g.DrawString('M', $font, $brush, $rect, $sf)
$g.Dispose()
$bmp.Save($OutPath)
$bmp.Dispose()
Write-Host "Saved $OutPath"
