param([string]$InstallDir)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$exeName = 'changeFileName.exe'
$targets = [ordered]@{ 'app.asar' = 'resources\app.asar'; 'changeFileName.exe' = 'changeFileName.exe' }
$required = $manifest.requires -join ' 或 '

function Test-Install([string]$dir) {
  return $dir -and (Test-Path -LiteralPath (Join-Path $dir $exeName) -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $dir 'resources\app.asar') -PathType Leaf)
}

function Find-Install {
  foreach ($p in @(Get-Process -Name changeFileName -ErrorAction SilentlyContinue)) {
    if ($p.Path -and (Test-Install (Split-Path -Parent $p.Path))) { return (Split-Path -Parent $p.Path) }
  }
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($item in @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'changeFileName*' })) {
    $icon = ($item.DisplayIcon -replace '"' -replace ',\d+$')
    $uninstaller = ($item.UninstallString -replace '^"([^"]+)".*$', '$1')
    foreach ($dir in @($item.InstallLocation, $(if ($icon) { Split-Path -Parent $icon }), $(if ($uninstaller) { Split-Path -Parent $uninstaller }))) {
      if (Test-Install $dir) { return $dir }
    }
  }
  foreach ($dir in @("$env:LOCALAPPDATA\Programs\changeFileName", "$env:LOCALAPPDATA\Programs\ai-drama-assistant", "$env:ProgramFiles\changeFileName")) {
    if (Test-Install $dir) { return $dir }
  }
}

function Test-Hash([string]$file, [string]$name) {
  $stream = [IO.File]::OpenRead($file)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    return $digest -eq $manifest.sha256.$name
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Confirm-Base([string]$exe) {
  $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  if (($version -replace '^(\d+\.\d+\.\d+)\.0$', '$1') -notin $manifest.requires) {
    throw "需要 Windows $required。选中的安装版本为 $version。"
  }
}

try {
  Write-Host "changeFileName 快速更新 $($manifest.version)" -ForegroundColor Cyan
  foreach ($item in $manifest.sha256.PSObject.Properties) {
    $name = [string]$item.Name
    if ($targets.Contains($name)) { continue }
    if ($name -notmatch '^hongguo-player/([A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+$' -or
        ($name.Split('/') -contains '..') -or ($name.Split('/') -contains '.')) {
      throw '更新文件路径无效'
    }
    $targets[$name] = 'resources\' + $name.Replace('/', '\')
  }
  foreach ($name in $targets.Keys) {
    if (!(Test-Hash (Join-Path $PSScriptRoot $name) $name)) { throw '更新文件校验失败，请重新下载完整 ZIP。' }
  }
  if (!$InstallDir) { $InstallDir = Find-Install }
  while (!(Test-Install $InstallDir)) {
    $typed = Read-Host '请把包含 changeFileName.exe 的文件夹拖进来，按回车确认。直接回车退出'
    if (!$typed) { return }
    $InstallDir = $typed.Trim().Trim('"')
  }
  $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
  Write-Host "安装位置 $InstallDir"
  $exe = Join-Path $InstallDir $exeName
  Confirm-Base $exe
  while (@(Get-Process -Name changeFileName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count) {
    if ((Read-Host '请退出 changeFileName 后按回车。输入 Q 取消') -eq 'Q') { return }
  }

  $lockPath = Join-Path $InstallDir '.quick-update.lock'
  try {
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [UnauthorizedAccessException] {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw }
    $elevatedArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InstallDir `"$InstallDir`""
    $raised = Start-Process powershell.exe -Verb RunAs -ArgumentList $elevatedArguments -Wait -PassThru
    exit $raised.ExitCode
  }
  try {
    Confirm-Base $exe
    $backup = Join-Path $InstallDir ("resources\quick-update-backup-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    $replaced = @()
    try {
      foreach ($name in $targets.Keys) {
        $file = Join-Path $backup ('staged\' + $name.Replace('/', '\'))
        [IO.Directory]::CreateDirectory((Split-Path -Parent $file)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $file
        if (!(Test-Hash $file $name)) { throw "复制后校验失败：$name" }
      }
      foreach ($name in $targets.Keys) {
        $staged = Join-Path $backup ('staged\' + $name.Replace('/', '\'))
        $saved = Join-Path $backup ('original\' + $name.Replace('/', '\'))
        [IO.Directory]::CreateDirectory((Split-Path -Parent $saved)) | Out-Null
        $destination = Join-Path $InstallDir $targets[$name]
        if (Test-Path -LiteralPath $destination) {
          [IO.File]::Replace($staged, $destination, $saved, $true)
        } else {
          [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
          [IO.File]::Move($staged, $destination)
        }
        $replaced += $name
      }
      foreach ($name in $targets.Keys) {
        if (!(Test-Hash (Join-Path $InstallDir $targets[$name]) $name)) { throw "写入后校验失败：$name" }
      }
    } catch {
      $failure = $_
      foreach ($name in $replaced) {
        $saved = Join-Path $backup ('original\' + $name.Replace('/', '\'))
        $destination = Join-Path $InstallDir $targets[$name]
        if (Test-Path -LiteralPath $saved) {
          Copy-Item -LiteralPath $saved -Destination $destination -Force
        } else {
          Remove-Item -LiteralPath $destination -Force
        }
      }
      throw $failure
    }
    Write-Host "已更新至 $($manifest.version)。现在可以正常打开软件。" -ForegroundColor Green
    Write-Host "旧版备份位于 $backup"
  } finally {
    $lock.Dispose()
  }
} catch {
  Write-Host "更新失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
