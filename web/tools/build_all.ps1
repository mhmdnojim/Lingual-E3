# Rebuilds everything in web\data (and web\vendor\ruffle) from the original app files in .shared.
# Safe to re-run: finished pages and videos are skipped.
#   powershell -ExecutionPolicy Bypass -File web\tools\build_all.ps1
# Needs: Windows 10/11 with the English OCR language, Python 3, Node.js (only to download Ruffle).
$ErrorActionPreference = 'Stop'
$tools = $PSScriptRoot
$web = Split-Path $tools -Parent
$build = Join-Path $web '_build'
$png = Join-Path $build 'ocr_png'
$raw = Join-Path $build 'ocr_raw'

Write-Output '1/6 Checking Python packages...'
python -c "import PIL, imageio_ffmpeg, edge_tts" 2>$null
if ($LASTEXITCODE) { python -m pip install --quiet pillow imageio-ffmpeg edge-tts }

$ruffle = Join-Path $web 'vendor\ruffle'
if (-not (Test-Path (Join-Path $ruffle 'ruffle.js'))) {
  Write-Output '   Downloading the Ruffle Flash emulator (for the answer keys)...'
  $tmp = Join-Path $env:TEMP ('ruffle_' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Push-Location $tmp
  npm pack '@ruffle-rs/ruffle' --silent | Out-Null
  $tgz = Get-ChildItem -Filter *.tgz | Select-Object -First 1
  tar -xzf $tgz.FullName
  Pop-Location
  New-Item -ItemType Directory -Force -Path $ruffle | Out-Null
  Copy-Item (Join-Path $tmp 'package\*') $ruffle -Recurse -Force
  Remove-Item -Recurse -Force $tmp
}

Write-Output '2/6 Joining page tiles into page images...'
python "$tools\stitch_pages.py" --ocr-dir $png --raw-dir $raw
if ($LASTEXITCODE) { throw 'stitch_pages.py failed' }

Write-Output '3/6 Reading the text on each page (Windows OCR)...'
if (Test-Path $png) {
  powershell -NoProfile -ExecutionPolicy Bypass -File "$tools\ocr_windows.ps1" -InputDir $png -OutputDir $raw
  if ($LASTEXITCODE) { throw 'ocr_windows.ps1 failed' }
}

Write-Output '4/6 Splitting text into sentences and clauses...'
python "$tools\segment_text.py" --raw-dir $raw
if ($LASTEXITCODE) { throw 'segment_text.py failed' }

Write-Output '5/6 Converting videos to MP4...'
python "$tools\convert_videos.py"
if ($LASTEXITCODE) { throw 'convert_videos.py failed' }

Write-Output '6/6 Building the book index and transcripts...'
python "$tools\build_data.py"
if ($LASTEXITCODE) { throw 'build_data.py failed' }

# The lossless page copies are only needed for OCR.
if (Test-Path $png) { Remove-Item -Recurse -Force $png }
Write-Output 'Done.'
