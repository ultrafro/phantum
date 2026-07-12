# phantum system tray — keeps the server running quietly in the background and
# gives you a right-click menu to open the window, restart, or fully exit.
#
# Launched hidden by phantum.vbs. The server (node server.js) is a separate
# process that survives closing the browser window; only "Stop server & Exit"
# (or stop-phantum.vbs) actually shuts it down — which also ends the Claude
# sessions running inside it.
param([int]$Port = 59333)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ico  = Join-Path $here 'phantum.ico'
$url  = "http://127.0.0.1:$Port"

# Only one tray at a time. A second launch just re-opens the window and exits.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'phantum-tray-singleton', [ref]$createdNew)

function Test-Server {
  try { return (Invoke-WebRequest -UseBasicParsing "$url/api/status" -TimeoutSec 2).StatusCode -eq 200 }
  catch { return $false }
}

function Get-ServerPid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($c) { return ($c | Select-Object -First 1).OwningProcess }
  return $null
}

function Start-Server {
  if (Test-Server) { return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = 'server.js'
  $psi.WorkingDirectory = $here
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = 'Hidden'
  $psi.EnvironmentVariables['PORT'] = "$Port"
  [System.Diagnostics.Process]::Start($psi) | Out-Null
  for ($i = 0; $i -lt 40 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 250 }
}

function Open-Window {
  # Prefer an installed phantum app (its taskbar icon is the ghost).
  foreach ($b in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
                   "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
    if (Test-Path $b) {
      $lnk = Get-ChildItem -Path $b -Filter '*.lnk' -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -match 'phantum' } | Select-Object -First 1
      if ($lnk) { Start-Process $lnk.FullName; return }
    }
  }
  # Otherwise a standalone app window in its own profile.
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
          Where-Object { Test-Path $_ } | Select-Object -First 1
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
              "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
              "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
            Where-Object { Test-Path $_ } | Select-Object -First 1
  $udd = "$env:LOCALAPPDATA\phantum\AppWindow"
  $flags = "--app=$url --user-data-dir=`"$udd`" --no-first-run --no-default-browser-check --window-size=1400,900"
  if ($edge)      { Start-Process -FilePath $edge   -ArgumentList $flags }
  elseif ($chrome){ Start-Process -FilePath $chrome -ArgumentList $flags }
  else            { Start-Process $url }
}

function Stop-Server {
  # Ask the server to shut down gracefully so it kills its child Claude sessions
  # cleanly; fall back to a hard tree-kill if the endpoint doesn't answer.
  try { Invoke-WebRequest -UseBasicParsing "$url/api/shutdown" -Method Post -TimeoutSec 3 | Out-Null } catch {}
  Start-Sleep -Milliseconds 600
  $serverPid = Get-ServerPid
  if ($serverPid) {
    Start-Process taskkill -ArgumentList "/PID $serverPid /T /F" -WindowStyle Hidden -Wait
  }
}

# Second instance: just surface the window and quit.
if (-not $createdNew) { Open-Window; return }

# --- tray icon + menu ---
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-Object System.Drawing.Icon($ico)
$notify.Text = "phantum"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen    = $menu.Items.Add("Open phantum")
$miStatus  = $menu.Items.Add("Server: …"); $miStatus.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miRestart = $menu.Items.Add("Restart server")
$miExit    = $menu.Items.Add("Stop server && Exit")
$notify.ContextMenuStrip = $menu

$miOpen.add_Click({ Open-Window })
$notify.add_MouseDoubleClick({ Open-Window })

$miRestart.add_Click({
  $p = Get-ServerPid
  if ($p) { Start-Process taskkill -ArgumentList "/PID $p /T /F" -WindowStyle Hidden -Wait }
  Start-Server
})

$miExit.add_Click({
  $ans = [System.Windows.Forms.MessageBox]::Show(
    "Stop the phantum server? This also ends every running Claude session.",
    "phantum", 'YesNo', 'Warning')
  if ($ans -ne 'Yes') { return }
  Stop-Server
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

# Keep the tooltip / status line honest about whether the server is up.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if (Test-Server) { $notify.Text = "phantum — running :$Port"; $miStatus.Text = "Server: running (:$Port)" }
  else             { $notify.Text = "phantum — stopped";        $miStatus.Text = "Server: stopped" }
})
$timer.Start()

# Boot: make sure the server is up, then open the window once.
Start-Server
Open-Window

[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
