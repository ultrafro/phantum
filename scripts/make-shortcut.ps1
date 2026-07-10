# Creates a "phantum" desktop shortcut with the ghost icon.
# Resolves the *real* Desktop folder (handles OneDrive redirection) and points
# the shortcut at phantum.vbs so double-clicking launches the app window.
param(
  [switch]$AllDesktops   # also drop a copy on the classic %USERPROFILE%\Desktop
)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $proj 'phantum.vbs'
$ico = Join-Path $proj 'phantum.ico'

if (-not (Test-Path $ico)) {
  Write-Output 'phantum.ico missing — generating it first...'
  & (Join-Path $PSScriptRoot 'make-icon.ps1') | Out-Null
}

$targets = @([Environment]::GetFolderPath('Desktop'))
if ($AllDesktops) { $targets += "$env:USERPROFILE\Desktop" }
$targets = $targets | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$wsh = New-Object -ComObject WScript.Shell
foreach ($desk in $targets) {
  $lnkPath = Join-Path $desk 'phantum.lnk'
  $lnk = $wsh.CreateShortcut($lnkPath)
  $lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $lnk.Arguments = '"' + $vbs + '"'
  $lnk.WorkingDirectory = $proj
  $lnk.IconLocation = "$ico,0"
  $lnk.Description = 'phantum — Claude Code terminal manager'
  $lnk.WindowStyle = 1
  $lnk.Save()
  Write-Output "created $lnkPath"
}
