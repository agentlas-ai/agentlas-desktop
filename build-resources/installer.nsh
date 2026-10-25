; Agentlas Windows uninstaller additions (electron-builder nsis.include).
;
; First real Windows run (1.3.88, Win11 ARM64, 2026-10-24): uninstalling left about 3 GB and an
; agentlas:// handler pointing at the deleted Agentlas.exe:
;   HKCU\Software\Classes\agentlas                 registered at runtime (app.setAsDefaultProtocolClient)
;   %LOCALAPPDATA%\agentlas-desktop-updater         downloaded update installer (626 MB)
;   %LOCALAPPDATA%\Agentlas\native-cli              CLIs Agentlas installed for itself (758 MB)
;   ~\.agentlas                                     CLI installs 1.1 GB, runtime 413 MB, plus the person's work
;   %APPDATA%\Agentlas                              Desktop data (conversations, settings, logs)
;
; What this file does on a real uninstall (never on an update: the new installer runs the old
; uninstaller with --updated, and an update must keep everything):
;   - always: removes the protocol key when it still opens this installation, and the caches only
;     Agentlas Desktop uses and can download again (updater cache, Desktop-installed CLIs, Desktop's
;     Node/uv/MCP copies);
;   - always: removes Agentlas's own login autostart (the HKCU Run value cloud.agentlas.daemon.* that
;     starts this installation, and the Startup-folder .cmd that releases before 2026-10-24 wrote).
;     Left behind, Windows showed "cannot find ...\Agentlas.exe" at every sign-in (Windows audit fs.md #9);
;   - only when the person ticks it on the uninstaller's components page (both unticked by default):
;     Desktop data (%APPDATA%\Agentlas) and the whole shared ~\.agentlas folder. ~\.agentlas also
;     holds what Agentlas Terminal and the plugins use (projects, agents, memory, the engine runtime
;     in runtime\current), so it is never removed without that choice.
;
; Contract gate: scripts/test-windows-uninstall-cleanup.cjs (source assertions; makensis runs in the
; Windows release build with -WX, so a warning here fails the build).

; Uninstaller strings. One LangString per language electron-builder loads (its bundled list, since
; nsis.installerLanguages is not set) - English text except Korean. The gate pins this list to
; electron-builder's so a language added there cannot leave a string unset.
!macro agentlasUninstallString NAME EN KO
  LangString ${NAME} 1033 "${EN}"
  LangString ${NAME} 1031 "${EN}"
  LangString ${NAME} 1036 "${EN}"
  LangString ${NAME} 3082 "${EN}"
  LangString ${NAME} 2052 "${EN}"
  LangString ${NAME} 1028 "${EN}"
  LangString ${NAME} 1041 "${EN}"
  LangString ${NAME} 1042 "${KO}"
  LangString ${NAME} 1040 "${EN}"
  LangString ${NAME} 1043 "${EN}"
  LangString ${NAME} 1030 "${EN}"
  LangString ${NAME} 1053 "${EN}"
  LangString ${NAME} 1044 "${EN}"
  LangString ${NAME} 1035 "${EN}"
  LangString ${NAME} 1049 "${EN}"
  LangString ${NAME} 2070 "${EN}"
  LangString ${NAME} 1046 "${EN}"
  LangString ${NAME} 1045 "${EN}"
  LangString ${NAME} 1058 "${EN}"
  LangString ${NAME} 1029 "${EN}"
  LangString ${NAME} 1051 "${EN}"
  LangString ${NAME} 1038 "${EN}"
  LangString ${NAME} 1025 "${EN}"
  LangString ${NAME} 1055 "${EN}"
  LangString ${NAME} 1054 "${EN}"
  LangString ${NAME} 1066 "${EN}"
!macroend

; Short labels: the uninstaller's component list cuts anything past ~50 characters (seen on Windows 11, 2026-10-24).
!insertmacro agentlasUninstallString agentlasRemoveDesktopData "Delete my app data (chats, settings, logs)" "내 앱 데이터 삭제 (대화·설정·로그)"
!insertmacro agentlasUninstallString agentlasRemoveSharedFolder "Delete shared .agentlas folder (Terminal too)" "공유 .agentlas 폴더 삭제 (Terminal 공용)"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    ; agentlas:// - only when the handler still opens this installation (another install keeps its own).
    ; Electron writes the command as "<exe>" "%1"; StrCmp is case-insensitive, like Windows paths.
    StrCpy $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    ClearErrors
    ReadRegStr $0 HKCU "Software\Classes\agentlas\shell\open\command" ""
    ${ifNot} ${Errors}
      ${if} $0 == $1
        DeleteRegKey HKCU "Software\Classes\agentlas"
      ${endif}
    ${endif}
    ClearErrors

    ; Login autostart (daemon/autostart.ts windows-run-key): only values named cloud.agentlas.daemon.* whose
    ; command starts this installation's exe with --agentlas-daemon-autostart. Deleting shifts the index, so
    ; the loop re-reads the same index after a delete.
    StrCpy $2 0
    agentlasRunLoop:
      ClearErrors
      EnumRegValue $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $2
      IfErrors agentlasRunDone
      StrCmp $0 "" agentlasRunDone
      StrCpy $1 $0 22
      ${if} $1 == "cloud.agentlas.daemon."
        ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $0
        StrCpy $3 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --agentlas-daemon-autostart'
        StrLen $4 $3
        StrCpy $1 $1 $4
        ${if} $1 == $3
          DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $0
          DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" $0
          Goto agentlasRunLoop
        ${endif}
      ${endif}
      IntOp $2 $2 + 1
      Goto agentlasRunLoop
    agentlasRunDone:
    ClearErrors
    ; The retired Startup .cmd (names are ours alone: cloud.agentlas.daemon.<digest>.cmd).
    ${if} $APPDATA != ""
      Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\cloud.agentlas.daemon.*.cmd"
      Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\cloud.agentlas.daemon.*.cmd.suspended"
    ${endif}

    ; Caches only Agentlas Desktop uses; each is downloaded again when needed.
    ${if} $LOCALAPPDATA != ""
      RMDir /r "$LOCALAPPDATA\agentlas-desktop-updater"
      RMDir /r "$LOCALAPPDATA\Agentlas\native-cli"
      RMDir /r "$LOCALAPPDATA\Agentlas\runtime\node"
      RMDir "$LOCALAPPDATA\Agentlas\runtime"
      RMDir "$LOCALAPPDATA\Agentlas"
    ${endif}
    ${if} $PROFILE != ""
      RMDir /r "$PROFILE\.agentlas\npm"
      RMDir /r "$PROFILE\.agentlas\uv"
      RMDir /r "$PROFILE\.agentlas\mcp-builtins"
      RMDir /r "$PROFILE\.agentlas\runtime\node"
      RMDir /r "$PROFILE\.agentlas\runtime\npm-bootstrap-bin"
      Delete "$PROFILE\.agentlas\runtime\cli-install-trail.json"
      Delete "$PROFILE\.agentlas\runtime\node-materialize-fallback.json"
      RMDir "$PROFILE\.agentlas\runtime"
      RMDir "$PROFILE\.agentlas"
    ${endif}

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${endif}
!macroend

; Optional removals - unticked (/o) by default, so a silent uninstall (/S) and every update keep them.
!macro customUnInstallSection
  Section /o "un.$(agentlasRemoveDesktopData)"
    ${ifNot} ${isUpdated}
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      ${if} $APPDATA != ""
        RMDir /r "$APPDATA\${APP_FILENAME}"
        ; RMDir /r leaves paths over 260 characters and read-only files (Windows audit fs.md #20, #23);
        ; rd /s on the \\?\ path removes both (an already-removed folder only fails quietly).
        ; nsExec leaves its exit code on the stack: popped into $0, then $0 is restored.
        Push $0
        nsExec::Exec 'cmd.exe /d /c rd /s /q "\\?\$APPDATA\${APP_FILENAME}"'
        Pop $0
        Pop $0
      ${endif}
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    ${endif}
  SectionEnd

  Section /o "un.$(agentlasRemoveSharedFolder)"
    ${ifNot} ${isUpdated}
      ${if} $PROFILE != ""
        RMDir /r "$PROFILE\.agentlas"
        Push $0
        nsExec::Exec 'cmd.exe /d /c rd /s /q "\\?\$PROFILE\.agentlas"'
        Pop $0
        Pop $0
      ${endif}
    ${endif}
  SectionEnd
!macroend
