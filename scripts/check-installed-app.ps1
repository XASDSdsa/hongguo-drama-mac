param([string]$ArtifactDir)
$ErrorActionPreference = 'Stop'
$setup = Get-ChildItem $ArtifactDir -Recurse -Filter '*-Setup.exe' | Select-Object -First 1
if (!$setup) { throw 'Complete installer missing' }
$install = Join-Path $env:RUNNER_TEMP 'changeFileName安装测试'
$p = Start-Process $setup.FullName -ArgumentList @('/S', "/D=$install") -PassThru
if (!$p.WaitForExit(300000) -or $p.ExitCode -ne 0) { throw 'Installer failed' }
$exe = Join-Path $install 'changeFileName.exe'
$resources = Join-Path $install 'resources'
$version = (Get-Item $exe).VersionInfo.ProductVersion
if ($version -ne '1.2.48.0') { throw "Unexpected installed version $version" }
foreach ($name in @('app.asar','hongguo-player/player.jar','hongguo-player/runtime/bin/java.exe','bin/ffmpeg.exe','bin/ffprobe.exe','faster-whisper','video-structure','jianying','title-fonts','LibreOffice/program/soffice.com')) {
  if (!(Test-Path (Join-Path $resources $name))) { throw "Installed resource missing: $name" }
}
& (Join-Path $resources 'hongguo-player/runtime/bin/java.exe') -version
if ($LASTEXITCODE -ne 0) { throw 'Installed player runtime failed' }
$probe = Join-Path $env:RUNNER_TEMP 'installed-startup.json'
$env:AI_DRAMA_STARTUP_PROBE = $probe
$p = Start-Process $exe -ArgumentList "--user-data-dir=$env:RUNNER_TEMP/installed-user-data" -PassThru
if (!$p.WaitForExit(60000)) { Stop-Process $p.Id -Force; throw 'Installed app startup timeout' }
Remove-Item Env:AI_DRAMA_STARTUP_PROBE
$startup = Get-Content $probe -Raw | ConvertFrom-Json
if ($startup.activationLoaded -ge 15000 -or $null -eq $startup.activationLoaded -or $null -ne $startup.pageLoaded) { throw 'Activation must precede the main window' }
Write-Host "PASS real NSIS installation, complete resources, version $version and activation gate"
$stage = Join-Path $env:RUNNER_TEMP 'installed-download-stage'
New-Item $stage -ItemType Directory | Out-Null
Copy-Item (Join-Path $resources 'app.asar') $stage
Copy-Item (Join-Path $resources 'hongguo-player') $stage -Recurse
'{"version":"1.2.48"}' | Set-Content (Join-Path $stage 'manifest.json') -Encoding utf8NoBOM
$env:FFMPEG_PATH = Join-Path $resources 'bin/ffmpeg.exe'
$env:PATH = (Join-Path $resources 'bin') + ';' + $env:PATH
node scripts/check-native-download.cjs $stage
if ($LASTEXITCODE -ne 0) { throw 'Installed full episode download/decode failed' }
& ./node_modules/.bin/electron.cmd scripts/check-office-png.cjs (Join-Path $resources 'LibreOffice')
if ($LASTEXITCODE -ne 0) { throw 'Installed report PNG export failed' }
node scripts/check-bundled-transcription.cjs $resources
if ($LASTEXITCODE -ne 0) { throw 'Installed offline subtitle runtime failed' }
$hash = (Get-FileHash $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
@{version=$version; installer=$setup.Name; sha256=$hash; installed=$true; activation=$startup; fullDownload=$true; reportPng=$true; offlineSubtitles=$true} | ConvertTo-Json -Depth 5 | Set-Content dist/installed-acceptance.json
Write-Host 'PASS installed full application acceptance'
