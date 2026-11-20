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
Var dirProvided

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--force-run" $1
  IfErrors +2 0
  StrCpy $restart "1"
  ; Node quotes an entire /D= argument when its path contains spaces. NSIS's
  ; built-in parser expects an unquoted final /D=. Read the OS command line,
  ; as electron-builder's own installer does, and normalize its outer quotes.
  System::Call 'kernel32::GetCommandLineW() w .r0'
  StrLen $1 $0
  StrCpy $2 0
  ${DoWhile} $2 < $1
    StrCpy $3 $0 3 $2
    ${If} $3 == "/D="
    ${OrIf} $3 == "/d="
      StrCpy $dirProvided "1"
      IntOp $2 $2 + 3
      StrCpy $INSTDIR $0 "" $2
      StrCpy $3 $INSTDIR 1
      ${If} $3 == '$\"'
        StrCpy $INSTDIR $INSTDIR "" 1
      ${EndIf}
      StrCpy $3 $INSTDIR 1 -1
      ${If} $3 == '$\"'
        StrCpy $INSTDIR $INSTDIR -1
      ${EndIf}
      ${Break}
    ${EndIf}
    IntOp $2 $2 + 1
  ${Loop}
  ; Manual retry/recovery uses the original installer's registry location.
  ${If} $dirProvided != "1"
    SetRegView 64
    ReadRegStr $INSTDIR HKCU "Software\${APP_GUID}" InstallLocation
    IfFileExists "$INSTDIR\changeFileName.exe" +2 0
    ReadRegStr $INSTDIR HKLM "Software\${APP_GUID}" InstallLocation
  ${EndIf}
FunctionEnd

Section
  CreateDirectory "$LOCALAPPDATA\changeFileName\updates"
  FileOpen $3 "$LOCALAPPDATA\changeFileName\updates\installer.log" w
  FileWriteUTF16LE $3 "Target: $INSTDIR$\r$\n"
  FileClose $3
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
  FileOpen $3 "$LOCALAPPDATA\changeFileName\updates\installer.log" a
  FileWriteUTF16LE $3 "Exit: $0$\r$\n$1$\r$\n"
  FileClose $3
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONSTOP "Update failed. The previous version was kept. Please restart changeFileName and retry."
    SetErrorLevel 1
  ${Else}
    SetErrorLevel 0
  ${EndIf}
  ${If} $restart == "1"
    SetOutPath "$INSTDIR"
    Exec '"$INSTDIR\changeFileName.exe"'
  ${EndIf}
SectionEnd
