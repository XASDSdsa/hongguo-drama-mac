'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
let pending = Promise.resolve();

// Pass paths through the environment so quotes or Unicode filenames never become script text.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$wps = $null
$report = $null
$canQuit = $false
$restoreSettings = $false
$fault = $null
$running = @(Get-Process -Name wps -ErrorAction SilentlyContinue)
try {
  if (![Type]::GetTypeFromProgID('kwps.Application')) { throw 'REPORT_WPS_NOT_REGISTERED' }
  if (@($running | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }).Count) {
    throw 'REPORT_WPS_IN_USE'
  }
  $wps = New-Object -ComObject 'kwps.Application'
  if ($wps.Documents.Count -ne 0 -or ($running.Count -gt 0 -and $wps.Visible)) {
    throw 'REPORT_WPS_IN_USE'
  }
  $canQuit = $running.Count -eq 0
  $priorVisible = $wps.Visible
  $priorAlerts = $wps.DisplayAlerts
  $priorSecurity = $wps.AutomationSecurity
  $restoreSettings = !$canQuit
  $wps.Visible = $false
  $wps.DisplayAlerts = 0
  $wps.AutomationSecurity = 3
  $report = $wps.Documents.Open($env:COST_REPORT_WPS_DOCX, $false, $true, $false)
  # PDF, print quality, all pages, and do not open the result in a viewer.
  $report.ExportAsFixedFormat($env:COST_REPORT_WPS_PDF, 17, $false)
} catch {
  $fault = $_
} finally {
  if ($report) {
    try { $report.Close(0) } catch { if (!$fault) { $fault = $_ } }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($report)
  }
  if ($wps) {
    try {
      if ($canQuit -and $wps.Documents.Count -eq 0) { $wps.Quit(0) }
      elseif ($restoreSettings) {
        $wps.AutomationSecurity = $priorSecurity
        $wps.DisplayAlerts = $priorAlerts
        if ($wps.Documents.Count -eq 0) { $wps.Visible = $priorVisible }
      }
    } catch { if (!$fault) { $fault = $_ } }
    finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wps) }
  }
}
if ($fault) { throw $fault }
`;

async function convert(input, output) {
  const original = await fs.readFile(input);
  const root = process.env.SystemRoot || 'C:/Windows';
  const args = ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script];
  const options = {
    env: { ...process.env, COST_REPORT_WPS_DOCX: input, COST_REPORT_WPS_PDF: output },
    timeout: 60_000,
    windowsHide: true,
  };
  const hosts = process.arch === 'x64' ? ['System32', 'SysWOW64'] : ['System32'];
  for (const host of hosts) {
    const powershell = path.join(root, host, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      await run(powershell, args, options);
      if (!(await fs.readFile(input)).equals(original)) throw new Error('REPORT_WPS_CHANGED_INPUT');
      const pdf = await fs.readFile(output).catch(() => null);
      if (!pdf || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('REPORT_WPS_NO_PDF');
      return pdf;
    } catch (error) {
      const detail = `${error.stderr || ''}\n${error.stdout || ''}`;
      if (error.killed) throw new Error('WPS 后台导出超时。请确认 WPS 已完成首次设置，再重试。');
      if (detail.includes('REPORT_WPS_IN_USE')) throw new Error('WPS 文字正在使用。保存并关闭打开的 WPS 窗口后，再导出 PNG。');
      if (error.code === 'ENOENT' || /REPORT_WPS_NOT_REGISTERED|80040154/i.test(detail)) continue;
      console.warn('[cost-report] WPS PDF export failed', { code: error.code, detail: detail.trim().slice(0, 450) });
      throw new Error('WPS 无法在后台导出这份报告。请确认 WPS 能打开该报告并导出 PDF。');
    }
  }
  throw new Error('未找到支持自动化的 WPS 文字。请确认已安装 Windows 桌面版 WPS。');
}

function renderWpsPdf(input, output) {
  const result = pending.then(() => convert(input, output));
  pending = result.catch(() => {});
  return result;
}

module.exports = { renderWpsPdf };
