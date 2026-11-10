param([string]$InstallDir)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$exeName = 'changeFileName.exe'
$targets = [ordered]@{}
foreach ($name in @('FandolFang-Regular.otf', 'FandolSong-Bold.otf', 'Fandol-COPYING.txt', 'Fandol-README.txt')) {
  $targets["fonts/$name"] = "resources\LibreOffice\share\fonts\truetype\$name"
}
$targets['app.asar'] = 'resources\app.asar'
$targets[$exeName] = $exeName

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
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $manifest.sha256.$name
}

function Confirm-Base([string]$exe) {
  $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  if ($version -notin @($manifest.requires, "$($manifest.requires).0")) {
    throw "需要 Windows $($manifest.requires) 完整版。选中的安装版本为 $version。"
  }
}

try {
  Write-Host "changeFileName 快速更新 $($manifest.version)" -ForegroundColor Cyan
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
  $office = Join-Path $InstallDir 'resources\LibreOffice\program'
  foreach ($name in @('soffice.com', 'msvcp140.dll', 'vcruntime140_1.dll')) {
    if (!(Test-Path -LiteralPath (Join-Path $office $name) -PathType Leaf)) {
      throw "安装缺少报告转换组件，请先安装 $($manifest.requires) Windows 完整版。"
    }
  }
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
        $leaf = Split-Path -Leaf $name
        $file = Join-Path $backup "$leaf.new"
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $file
        if (!(Test-Hash $file $name)) { throw "复制后校验失败：$name" }
      }
      foreach ($name in $targets.Keys) {
        $leaf = Split-Path -Leaf $name
        $staged = Join-Path $backup "$leaf.new"
        $destination = Join-Path $InstallDir $targets[$name]
        if (Test-Path -LiteralPath $destination) {
          [IO.File]::Replace($staged, $destination, (Join-Path $backup $leaf), $true)
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
        $saved = Join-Path $backup (Split-Path -Leaf $name)
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
