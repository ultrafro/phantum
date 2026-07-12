# phantum system tray — keeps the server running quietly in the background and
# gives you a right-click menu to open the window, restart, or fully exit.
#
# Launched hidden by phantum.vbs. The server (node server.js) is a separate
# process that survives closing the browser window; only "Stop server & Exit"
# (or stop-phantum.vbs) actually shuts it down — which also ends the Claude
# sessions running inside it.
#
# -DryRun exercises init (icon, menu, mutex) and exits without showing anything.
param([int]$Port = 59333, [switch]$DryRun)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ico  = Join-Path $here 'phantum.ico'
$url  = "http://127.0.0.1:$Port"
$log  = Join-Path $here 'phantum-tray.log'

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
  foreach ($b in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
                   "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
    if (Test-Path $b) {
      $lnk = Get-ChildItem -Path $b -Filter '*.lnk' -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -match 'phantum' } | Select-Object -First 1
      if ($lnk) { Start-Process $lnk.FullName; return }
    }
  }
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
          Where-Object { Test-Path $_ } | Select-Object -First 1
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
              "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
              "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
            Where-Object { Test-Path $_ } | Select-Object -First 1
  $udd = "$env:LOCALAPPDATA\phantum\AppWindow"
  $flags = "--app=$url --user-data-dir=`"$udd`" --no-first-run --no-default-browser-check --window-size=1400,900"
  if ($edge)       { Start-Process -FilePath $edge   -ArgumentList $flags }
  elseif ($chrome) { Start-Process -FilePath $chrome -ArgumentList $flags }
  else             { Start-Process $url }
}

function Stop-Server {
  try { Invoke-WebRequest -UseBasicParsing "$url/api/shutdown" -Method Post -TimeoutSec 3 | Out-Null } catch {}
  Start-Sleep -Milliseconds 600
  $serverPid = Get-ServerPid
  if ($serverPid) {
    Start-Process taskkill -ArgumentList "/PID $serverPid /T /F" -WindowStyle Hidden -Wait
  }
}

# Everything past here can fail in ways that are invisible under a hidden launch,
# so log any exception to phantum-tray.log for diagnosis.
try {
  # Only one tray at a time. A second launch just re-opens the window and exits.
  $createdNew = $false
  $mutex = New-Object System.Threading.Mutex($true, 'phantum-tray-singleton', [ref]$createdNew)
  if (-not $createdNew) {
    if (-not $DryRun) { Open-Window }
    return
  }

  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = New-Object System.Drawing.Icon($ico)
  $notify.Text = "phantum"
  $notify.Visible = $false

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $miOpen    = $menu.Items.Add("Open phantum")
  $miStatus  = $menu.Items.Add("Server: ...") ; $miStatus.Enabled = $false
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

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 3000
  $timer.add_Tick({
    if (Test-Server) { $notify.Text = "phantum - running :$Port"; $miStatus.Text = "Server: running (:$Port)" }
    else             { $notify.Text = "phantum - stopped";        $miStatus.Text = "Server: stopped" }
  })

  if ($DryRun) {
    $notify.Dispose()
    'DRYRUN OK' | Out-File -FilePath $log -Encoding utf8
    return
  }

  $notify.Visible = $true
  # New tray icons hide in the overflow flyout by default, so announce ourselves
  # once so the icon is discoverable.
  $notify.ShowBalloonTip(5000, "phantum is running",
    "Right-click the ghost icon (under the ^ near the clock) to Open or Exit.",
    [System.Windows.Forms.ToolTipIcon]::Info)
  $timer.Start()
  Start-Server
  Open-Window
  [System.Windows.Forms.Application]::Run()
  $mutex.ReleaseMutex()
}
catch {
  "$(Get-Date -Format o)  $($_.Exception.GetType().Name): $($_.Exception.Message)`n$($_.ScriptStackTrace)" |
    Out-File -FilePath $log -Encoding utf8
  throw
}
