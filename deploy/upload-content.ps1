# Copies the book content (about 1 GB) and your own data to the web host, after setup-server.sh.
#
#     powershell -ExecutionPolicy Bypass -File deploy\upload-content.ps1 -Server root@203.0.113.5
#
# The content is not in the GitHub repository (it is Oxford University Press's), so it goes from
# this computer straight to the server. -SkipContent copies only your data (corrections, MP3s,
# translations) again; -SkipData only the content. Uses ssh and scp, which come with Windows.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [switch]$SkipContent,
  [switch]$SkipData
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tmp = Join-Path $env:TEMP 'aef3-upload'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Send($tar, $target) {
  $size = '{0:N0} MB' -f ((Get-Item $tar).Length / 1MB)
  Write-Output "   sending $size ..."
  scp $tar "${Server}:/tmp/"
  if ($LASTEXITCODE) { throw 'Copying to the server failed.' }
  $name = Split-Path $tar -Leaf
  ssh $Server "mkdir -p $target && tar -xf /tmp/$name -C $target && rm /tmp/$name"
  if ($LASTEXITCODE) { throw 'Unpacking on the server failed.' }
}

if (-not $SkipContent) {
  Write-Output '== Book content: pages, text, videos, audio, answer keys, documents'
  $content = Join-Path $tmp 'content.tar'
  # (The media are compressed already, so the archive is not.)
  tar -cf $content -C $root web/data web/vendor .shared/assets/audio .shared/assets/swf .shared/assets/document .shared/assets/covers .shared/assets/misc
  Send $content /opt/aef3
  Remove-Item $content
}
if (-not $SkipData) {
  Write-Output '== Your data: text corrections, My audio MP3s, translations'
  $data = Join-Path $tmp 'data.tar'
  $dirs = @('edits', 'recordings', 'translations') | Where-Object { Test-Path (Join-Path $root "web\$_") }
  if ($dirs) {
    tar -cf $data -C (Join-Path $root 'web') $dirs
    Send $data /var/lib/aef3
    Remove-Item $data
  }
}
ssh $Server 'chown -R aef:aef /opt/aef3 /var/lib/aef3 && systemctl restart aef3'
Write-Output 'Done.'
