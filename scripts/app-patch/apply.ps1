param([Parameter(Mandatory=$true)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'patch.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$exeName = 'changeFileName.exe'
$lock = $null
$backup = Join-Path $InstallDir '.app-update-transaction'
$targets = @('resources\app.asar', 'resources\app-update.yml', $exeName)

function Hash-File([string]$file) {
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Restore-Previous {
  if (!(Test-Path -LiteralPath (Join-Path $backup 'pending.json'))) { return }
  foreach ($name in $targets) {
    $saved = Join-Path $backup ('original\' + $name)
    if (!(Test-Path -LiteralPath $saved)) { throw 'Incomplete update backup; original files were not overwritten.' }
    Copy-Item -LiteralPath $saved -Destination (Join-Path $InstallDir $name) -Force
  }
  Remove-Item -LiteralPath $backup -Recurse -Force
}

try {
  $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
  $backup = Join-Path $InstallDir '.app-update-transaction'
  $exe = Join-Path $InstallDir $exeName
  foreach ($name in $targets) {
    if (!(Test-Path -LiteralPath (Join-Path $InstallDir $name) -PathType Leaf)) { throw 'The installation is incomplete.' }
  }
  # Wait for the updater's parent application and all its renderers to exit.
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (@(Get-Process -Name changeFileName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'The application has not exited. No files were changed.' }
    Start-Sleep -Milliseconds 500
  }
  try {
    $lock = [IO.File]::Open((Join-Path $InstallDir '.app-update.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [UnauthorizedAccessException] {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw }
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InstallDir `"$InstallDir`""
    $raised = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $raised.ExitCode
  }
  Restore-Previous
  $version = [version]((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion)
  if ($version -lt [version]($manifest.minimumVersion + '.0') -or $version -gt [version]($manifest.version + '.0')) { throw 'This patch does not support the installed version.' }
  if ($manifest.format -ne 1) { throw 'Unsupported patch format.' }
  # Independently verify the unchanged Electron body, including the fuse bytes.
  $bytes = [IO.File]::ReadAllBytes($exe)
  if ($bytes.Length -ne $manifest.exe.size) { throw 'Electron runtime size differs. No files were changed.' }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $offset = 0
    foreach ($part in $manifest.exe.parts) {
      $start = [int]$part.offset; $size = [int]$part.size
      if ($start -lt $offset -or $size -le 0 -or $start + $size -gt $bytes.Length) { throw 'Invalid patch range.' }
      [void]$algorithm.TransformBlock($bytes, $offset, $start - $offset, $bytes, $offset)
      $offset = $start + $size
    }
    [void]$algorithm.TransformFinalBlock($bytes, $offset, $bytes.Length - $offset)
    $invariant = [BitConverter]::ToString($algorithm.Hash).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Dispose() }
  if ($invariant -ne $manifest.exe.immutableSha256) { throw 'Electron runtime differs. No files were changed.' }
  foreach ($part in $manifest.exe.parts) {
    if ($part.file -notmatch '^exe-part-[0-9]+\.bin$') { throw 'Invalid patch filename.' }
    $file = Join-Path $PSScriptRoot $part.file
    if ((Hash-File $file) -ne $part.sha256) { throw 'EXE patch checksum mismatch.' }
    $data = [IO.File]::ReadAllBytes($file)
    if ($data.Length -ne $part.size) { throw 'EXE patch size mismatch.' }
    [Array]::Copy($data, 0, $bytes, [int]$part.offset, $data.Length)
  }
  foreach ($name in @('app.asar', 'app-update.yml')) {
    if ((Hash-File (Join-Path $PSScriptRoot $name)) -ne $manifest.sha256.$name) { throw 'Application checksum mismatch.' }
  }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  [IO.Directory]::CreateDirectory((Join-Path $backup 'staged\resources')) | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $backup ('staged\' + $exeName)), $bytes)
  $bytes = $null
  if ((Hash-File (Join-Path $backup ('staged\' + $exeName))) -ne $manifest.exe.sha256) { throw 'Rebuilt EXE checksum mismatch.' }
  foreach ($name in @('app.asar', 'app-update.yml')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $backup ('staged\resources\' + $name))
  }
  [IO.Directory]::CreateDirectory((Join-Path $backup 'original\resources')) | Out-Null
  foreach ($name in $targets) {
    Copy-Item -LiteralPath (Join-Path $InstallDir $name) -Destination (Join-Path $backup ('original\' + $name))
    if ((Hash-File (Join-Path $backup ('original\' + $name))) -ne (Hash-File (Join-Path $InstallDir $name))) { throw 'Backup checksum mismatch.' }
  }
  # Persist the journal before replacing either half of the EXE/ASAR pair.
  [IO.File]::WriteAllText((Join-Path $backup 'pending.json'), $manifest.version)
  try {
    foreach ($name in $targets) {
      [IO.File]::Replace((Join-Path $backup ('staged\' + $name)), (Join-Path $InstallDir $name), $null, $true)
      # Failure-injection tests replace this comment; production has no test switch.
    }
    if ((Hash-File $exe) -ne $manifest.exe.sha256) { throw 'Installed EXE checksum mismatch.' }
    foreach ($name in @('app.asar', 'app-update.yml')) {
      if ((Hash-File (Join-Path $InstallDir ('resources\' + $name))) -ne $manifest.sha256.$name) { throw 'Installed application checksum mismatch.' }
    }
  } catch {
    Restore-Previous
    throw
  }
  Remove-Item -LiteralPath (Join-Path $backup 'pending.json') -Force
  Remove-Item -LiteralPath $backup -Recurse -Force
  Write-Output "Updated changeFileName to $($manifest.version) without replacing runtimes."
} catch {
  $message = $_.Exception.Message
  $logDir = Join-Path $env:LOCALAPPDATA 'changeFileName\updates'
  [IO.Directory]::CreateDirectory($logDir) | Out-Null
  [IO.File]::WriteAllText((Join-Path $logDir 'last-error.log'), $message)
  Write-Output $message
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
}
