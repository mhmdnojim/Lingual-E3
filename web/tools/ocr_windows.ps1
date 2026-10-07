# Runs the Windows built-in OCR engine (Windows.Media.Ocr, en-US) on every PNG
# in -InputDir and writes one raw JSON file per image to -OutputDir:
#   {"w":..,"h":..,"angle":..,"lines":[{"words":[{"t":"text","x":..,"y":..,"w":..,"h":..}]}]}
param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
if (-not $engine) { throw 'English OCR language is not installed.' }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$files = Get-ChildItem -Path $InputDir -Filter *.png | Sort-Object Name
$n = 0
foreach ($f in $files) {
  $out = Join-Path $OutputDir ($f.BaseName + '.json')
  if (-not $Force -and (Test-Path $out)) { continue }

  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    } finally {
      $stream.Dispose()
    }
  } catch {
    # Unreadable (e.g. still being written): skip; a later run picks it up.
    Write-Output "  skipped $($f.Name): $($_.Exception.Message)"
    continue
  }

  $lines = foreach ($line in $result.Lines) {
    $words = foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      [ordered]@{ t = $w.Text; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    }
    [ordered]@{ words = @($words) }
  }
  $angle = if ($result.TextAngle -ne $null) { [double]$result.TextAngle } else { 0 }
  $doc = [ordered]@{ w = [int]$bitmap.PixelWidth; h = [int]$bitmap.PixelHeight; angle = $angle; lines = @($lines) }
  [System.IO.File]::WriteAllText($out, ($doc | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  $bitmap.Dispose()

  $n++
  if ($n % 25 -eq 0) { Write-Output "  OCR $n pages" }
}
Write-Output "OCR done: $n new pages ($($files.Count) images)"
