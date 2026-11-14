Unicode true
Name "changeFileName ${VERSION} update"
OutFile "${OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
CRCCheck force
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "changeFileName"
VIAddVersionKey /LANG=1033 "FileDescription" "changeFileName application update"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "GPL-3.0"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
Var restart

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--force-run" $1
  IfErrors +2 0
  StrCpy $restart "1"
FunctionEnd

Section
  ; The existing updater passes its own installDirectory using standard /D=.
  IfFileExists "$INSTDIR\changeFileName.exe" +4 0
    MessageBox MB_OK|MB_ICONSTOP "This update requires an existing changeFileName installation."
    SetErrorLevel 2
    Quit
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /r "${PAYLOAD}\*"
  ; NSIS is 32-bit; use native 64-bit PowerShell to inspect the x64 app's processes.
  StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$2" +2 0
  StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToStack '"$2" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\apply.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONSTOP "Update failed. The previous version was kept. Please restart changeFileName and retry."
    SetErrorLevel 1
  ${Else}
    SetErrorLevel 0
  ${EndIf}
  ${If} $restart == "1"
    Exec '"$INSTDIR\changeFileName.exe"'
  ${EndIf}
SectionEnd
