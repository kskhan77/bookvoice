Add-Type -AssemblyName System.Drawing

function New-Icon([int]$s, [string]$out) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # Rounded blue square background
    $r = [float]($s * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($s - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($s - $r * 2, $s - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $s - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point($s, $s)),
        [System.Drawing.Color]::FromArgb(255, 91, 133, 255),
        [System.Drawing.Color]::FromArgb(255, 59, 95, 224))
    $g.FillPath($brush, $path)

    # White open book
    $white = [System.Drawing.Brushes]::White
    function P([double]$x, [double]$y) {
        New-Object System.Drawing.PointF([float]$x, [float]$y)
    }
    [System.Drawing.PointF[]]$leftPage = @(
        (P ($s * 0.18) ($s * 0.30)),
        (P ($s * 0.47) ($s * 0.38)),
        (P ($s * 0.47) ($s * 0.76)),
        (P ($s * 0.18) ($s * 0.68))
    )
    [System.Drawing.PointF[]]$rightPage = @(
        (P ($s * 0.82) ($s * 0.30)),
        (P ($s * 0.53) ($s * 0.38)),
        (P ($s * 0.53) ($s * 0.76)),
        (P ($s * 0.82) ($s * 0.68))
    )
    $g.FillPolygon($white, $leftPage)
    $g.FillPolygon($white, $rightPage)

    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "wrote $out"
}

$dir = "C:\Users\KhurramShafique\Desktop\text-speech\extension\icons"
New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($size in 16, 32, 48, 128) {
    New-Icon $size "$dir\icon$size.png"
}
