; Inno Setup script for privacy-screen — a simple double-click Windows installer.
;
; Produces a per-user setup.exe (no admin / UAC prompt) that installs the
; standalone privacy-screen server binary, creates Start Menu + optional Desktop
; shortcuts that launch the app and open the browser, and warns if the required
; `claude` CLI is not on PATH.
;
; Build (from repo root, after `bun scripts/build-release.ts` has produced
; dist/privacy-screen-win32-x64.exe):
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" ^
;       /DMyAppVersion=1.0.0 installers\windows\privacy-screen.iss
;
; The build-release.ts script invokes this automatically when ISCC is present.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

; Path to the compiled server binary, relative to this .iss file.
#ifndef SourceExe
  #define SourceExe "..\..\dist\privacy-screen-win32-x64.exe"
#endif

; Where the installer is written.
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

#define MyAppName "privacy-screen"
#define MyAppPublisher "privacy-screen"
#define MyAppURL "https://github.com/adamcongdon/privacy-screen"
#define MyAppExeName "privacy-screen.exe"

[Setup]
AppId={{8E9A2C4D-3F1B-4A6E-9C2D-7B5E1F0A8D33}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; Per-user install: no admin rights, no UAC prompt — true double-click experience.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=privacy-screen-setup-win32-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName} {#MyAppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Rename the platform-suffixed build artifact to a clean exe name on install.
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion

[Icons]
; Shortcuts launch with --open so the server starts AND the browser opens to the UI.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--open"; Comment: "Start privacy-screen and open the UI"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--open"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--open"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[Code]
{ Check whether the required `claude` CLI is reachable on PATH. The server
  refuses to start without it, so warn the user up front (non-blocking). }
function ClaudeOnPath(): Boolean;
var
  ResultCode: Integer;
begin
  { `where` exits 0 if it finds the command on PATH. Run hidden. }
  Result := Exec(ExpandConstant('{cmd}'), '/C where claude', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not ClaudeOnPath() then
  begin
    MsgBox(
      'privacy-screen needs the Claude Code CLI (`claude`) on your PATH to run.' + #13#10 + #13#10 +
      'It was not detected. You can still install now, but before launching the app:' + #13#10 +
      '  1. Install Claude Code from https://docs.claude.com/en/docs/claude-code' + #13#10 +
      '  2. Run `claude login`' + #13#10 + #13#10 +
      'Then start privacy-screen from the Start Menu.',
      mbInformation, MB_OK);
  end;
end;
