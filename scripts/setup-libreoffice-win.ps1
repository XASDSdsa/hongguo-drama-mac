$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '26.8.2'
$name = "LibreOffice_${version}_Win_x86-64.msi"
$sha256 = 'ff4b911403b67ee9e6249f820f9782c44bb32c94fdaa45b0da53a8e419e5307a'
$repo = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $repo 'build/libreoffice/win32-x64'
$stamp = Join-Path $destination 'runtime-version.txt'
if ((Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $version) -and
    (Test-Path -LiteralPath (Join-Path $destination 'program/soffice.com'))) { return }

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("report-office-" + [guid]::NewGuid())
$extract = Join-Path $temp 'extract'
$msi = Join-Path $temp $name
$staged = "$destination.new"
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $relative = "win/x86_64/$name"
  $urls = @(
    "https://download.documentfoundation.org/libreoffice/stable/$version/$relative",
    "https://downloadarchive.documentfoundation.org/libreoffice/old/$version.2/win/x86_64/LibreOffice_${version}.2_Win_x86-64.msi"
  )
  foreach ($url in $urls) {
    & curl.exe --fail --location --retry 3 --silent --show-error $url --output $msi
    if ($LASTEXITCODE -eq 0) { break }
  }
  if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
    throw 'The LibreOffice installer download or checksum failed.'
  }
  $log = Join-Path $temp 'msi.log'
  $arguments = "/a `"$msi`" /qn TARGETDIR=`"$extract`" /l*v `"$log`""
  $process = Start-Process "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Get-Content -LiteralPath $log -Tail 35
    throw "Could not extract LibreOffice (MSI status $($process.ExitCode))."
  }
  $office = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'soffice.com' -File | Select-Object -First 1
  if (!$office) { throw 'The extracted LibreOffice runtime is missing soffice.com.' }
  $root = $office.Directory.Parent.FullName
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Recurse -Force }
  New-Item -ItemType Directory -Path $staged -Force | Out-Null
  Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Extension -ne '.msi' } |
    Copy-Item -Destination $staged -Recurse -Force
  Set-Content -LiteralPath (Join-Path $staged 'runtime-version.txt') -Value $version -Encoding ascii
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
  Move-Item -LiteralPath $staged -Destination $destination
  Write-Host "LibreOffice $version is ready at $destination"
} finally {
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Recurse -Force }
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
