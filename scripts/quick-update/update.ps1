# AI短剧助手 快速更新：只换软件代码（app.asar 和剪映草稿脚本），运行库（FFmpeg、剪映运行时、模型）不动。
# 用法：双击同一文件夹里的 update.cmd。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -LiteralPath (Join-Path $here 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$exeName = 'AI短剧助手.exe'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
  Say ''
  Say "更新没有完成：$text" 'Red'
  Say '软件没有被改动，可以继续用原来的版本。' 'Yellow'
  Read-Host '按回车关闭' | Out-Null
  exit 1
}

function Test-Install($dir) {
  if (-not $dir) { return $false }
  $dir = $dir.Trim('"').TrimEnd('\')
  return (Test-Path -LiteralPath (Join-Path $dir 'resources\app.asar')) -and (Test-Path -LiteralPath (Join-Path $dir $exeName))
}

function Find-Install {
  # 1. 软件正开着：就是它
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.EndsWith($exeName) })) {
    $dir = Split-Path -Parent $p.Path
    if (Test-Install $dir) { return $dir }
  }
  # 2. 安装时登记的位置
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $keys) {
    foreach ($item in @(Get-ItemProperty $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'AI短剧助手*' })) {
      foreach ($dir in @($item.InstallLocation, ($(if ($item.DisplayIcon) { Split-Path -Parent ($item.DisplayIcon -replace '"', '' -replace ',\d+$', '') })), ($(if ($item.UninstallString) { Split-Path -Parent ($item.UninstallString -replace '^"([^"]+)".*$', '$1') })))) {
        if (Test-Install $dir) { return $dir.Trim('"').TrimEnd('\') }
      }
    }
  }
  # 3. 默认安装位置
  foreach ($dir in @("$env:LOCALAPPDATA\Programs\ai-drama-assistant", "$env:LOCALAPPDATA\Programs\AI短剧助手", "$env:ProgramFiles\AI短剧助手", "${env:ProgramFiles(x86)}\AI短剧助手")) {
    if (Test-Install $dir) { return $dir }
  }
  return $null
}

Say "AI短剧助手 快速更新 → $($manifest.version)" 'Cyan'
Say "（只换软件代码，运行库不动；需要先装过 $($manifest.requires) 或更新的完整版）"
Say ''

$install = Find-Install
while (-not $install) {
  Say '没找到软件的安装位置。' 'Yellow'
  $typed = Read-Host '请把软件安装文件夹（里面有 AI短剧助手.exe）拖到这个窗口里，再按回车；直接回车退出'
  if (-not $typed) { Fail '没有找到安装位置' }
  if (Test-Install $typed) { $install = $typed.Trim('"').TrimEnd('\') } else { Say '这个文件夹里没有 AI短剧助手.exe 和 resources\app.asar，请重新选择。' 'Yellow' }
}
$resources = Join-Path $install 'resources'
Say "安装位置：$install"
if (-not (Test-Path -LiteralPath (Join-Path $resources 'jianying'))) {
  Fail '这个安装缺少运行库（不是完整版），请先下载安装完整版安装包，再用快速更新'
}

# 软件开着时 app.asar 被占用，换不了：等用户关掉。
while (@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($install) }).Count -gt 0) {
  Say ''
  Say '软件还开着（正在处理的任务请先等它做完或停止）。' 'Yellow'
  $answer = Read-Host '请关掉软件后按回车继续；输入 Q 退出'
  if ($answer -match '^[qQ]') { Fail '软件还开着' }
}

# 装在 Program Files 里时要管理员权限：自动以管理员身份重新运行。
$probe = Join-Path $resources ".quick-update-$PID.tmp"
try {
  [IO.File]::WriteAllText($probe, 'ok')
  Remove-Item -LiteralPath $probe -Force
} catch {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) { Fail "没有权限写入 $resources" }
  Say '需要管理员权限，正在请求……' 'Yellow'
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
  exit 0
}

$newAsar = Join-Path $here 'app.asar'
if ((Get-FileHash -LiteralPath $newAsar -Algorithm SHA256).Hash.ToLower() -ne $manifest.sha256.ToLower()) {
  Fail '更新包不完整（校验不通过），请重新下载'
}

# 先备份一份旧的，新的有问题可以手动换回来。
$backup = Join-Path $resources 'quick-update-backup'
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath (Join-Path $resources 'app.asar') -Destination (Join-Path $backup 'app.asar') -Force
if (Test-Path -LiteralPath (Join-Path $resources 'workflow')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $backup 'workflow') | Out-Null
  Copy-Item -Path (Join-Path $resources 'workflow\*') -Destination (Join-Path $backup 'workflow') -Force
}

try {
  Copy-Item -LiteralPath $newAsar -Destination (Join-Path $resources 'app.asar') -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $resources 'workflow') | Out-Null
  Copy-Item -Path (Join-Path $here 'workflow\*') -Destination (Join-Path $resources 'workflow') -Force
  if ((Get-FileHash -LiteralPath (Join-Path $resources 'app.asar') -Algorithm SHA256).Hash.ToLower() -ne $manifest.sha256.ToLower()) {
    throw '写入后校验不通过'
  }
} catch {
  # 换到一半出错：放回旧的。
  Copy-Item -LiteralPath (Join-Path $backup 'app.asar') -Destination (Join-Path $resources 'app.asar') -Force
  if (Test-Path -LiteralPath (Join-Path $backup 'workflow')) {
    Copy-Item -Path (Join-Path $backup 'workflow\*') -Destination (Join-Path $resources 'workflow') -Force
  }
  Fail "$($_.Exception.Message)（已换回原来的版本）"
}

Say ''
Say "已更新到 $($manifest.version)。" 'Green'
Say "旧版本备份在：$backup"
$open = Read-Host '按回车打开软件；输入 N 不打开'
if ($open -notmatch '^[nN]') { Start-Process -FilePath (Join-Path $install $exeName) }
