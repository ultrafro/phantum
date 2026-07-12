' phantum launcher — double-click this file to start the terminal manager.
'
' It runs the Node server hidden (no console window), waits for it to come up,
' then opens phantum in an app-mode browser window (Edge/Chrome if available,
' otherwise your default browser). Close the browser window to stop using it;
' run stop-phantum.vbs (or Ctrl+C in a manual run) to actually shut the server.

Option Explicit

Dim fso, shell, here, port, url, npmCmd, nodeCheck
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
port = "59333"
url = "http://127.0.0.1:" & port

shell.CurrentDirectory = here

' Verify Node is available.
On Error Resume Next
nodeCheck = shell.Run("cmd /c node --version", 0, True)
On Error Goto 0
If nodeCheck <> 0 Then
  MsgBox "Node.js was not found on PATH." & vbCrLf & vbCrLf & _
         "Install it from https://nodejs.org and try again.", vbCritical, "phantum"
  WScript.Quit 1
End If

' First run: install dependencies (shows a console window so you can see progress).
If Not fso.FolderExists(fso.BuildPath(here, "node_modules")) Then
  MsgBox "First launch: installing dependencies (this happens once).", _
         vbInformation, "phantum"
  shell.Run "cmd /c cd /d """ & here & """ && npm install", 1, True
End If

' Start the server hidden. A marker in the title lets stop-phantum find it.
shell.Run "cmd /c cd /d """ & here & """ && set PORT=" & port & _
          " && node server.js", 0, False

' Wait for the port to answer before opening the browser.
Dim tries, ok
ok = False
For tries = 1 To 40
  If PortOpen(port) Then
    ok = True
    Exit For
  End If
  WScript.Sleep 300
Next

If Not ok Then
  MsgBox "phantum server did not start in time. Try running:" & vbCrLf & _
         "  node server.js" & vbCrLf & "in this folder to see the error.", _
         vbExclamation, "phantum"
  WScript.Quit 1
End If

OpenApp url

' ---- helpers ----

Function PortOpen(p)
  Dim http, res
  PortOpen = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:" & p & "/api/status", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then PortOpen = True
  On Error Goto 0
End Function

Sub OpenApp(u)
  Dim edge, chrome, pf, pfx86, la, q, udd, flags, appLnk
  q = Chr(34)
  pf = shell.ExpandEnvironmentStrings("%ProgramFiles%")
  pfx86 = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
  la = shell.ExpandEnvironmentStrings("%LocalAppData%")

  ' Prefer an *installed* phantum app if one exists. Installing the site as an
  ' app (browser menu > Apps > Install phantum) is the only thing that reliably
  ' gives the taskbar the ghost icon — a plain --app window always borrows the
  ' browser's own icon. Once installed, we launch that shortcut so the server is
  ' running AND the icon is correct.
  appLnk = FindInstalledApp()
  If appLnk <> "" Then
    shell.Run q & appLnk & q, 1, False
    Exit Sub
  End If

  edge = pfx86 & "\Microsoft\Edge\Application\msedge.exe"
  If Not fso.FileExists(edge) Then edge = pf & "\Microsoft\Edge\Application\msedge.exe"

  chrome = pf & "\Google\Chrome\Application\chrome.exe"
  If Not fso.FileExists(chrome) Then chrome = pfx86 & "\Google\Chrome\Application\chrome.exe"
  If Not fso.FileExists(chrome) Then chrome = la & "\Google\Chrome\Application\chrome.exe"

  ' Not installed yet: open a standalone app window in its own profile. The
  ' window content is phantum, but the taskbar icon stays the browser's until
  ' you install it as an app (see above).
  udd = la & "\phantum\AppWindow"
  flags = " --app=" & u & " --user-data-dir=" & q & udd & q & _
          " --no-first-run --no-default-browser-check --window-size=1400,900"

  If fso.FileExists(edge) Then
    shell.Run q & edge & q & flags, 1, False
  ElseIf fso.FileExists(chrome) Then
    shell.Run q & chrome & q & flags, 1, False
  Else
    shell.Run u, 1, False ' fall back to default browser (no custom icon possible)
  End If
End Sub

' Look for a phantum app installed via the browser (Apps > Install). Edge/Chrome
' drop a shortcut in the Start Menu Programs folder named after the app.
Function FindInstalledApp()
  FindInstalledApp = ""
  Dim bases, base, f
  bases = Array( _
    shell.ExpandEnvironmentStrings("%APPDATA%") & "\Microsoft\Windows\Start Menu\Programs", _
    shell.ExpandEnvironmentStrings("%ProgramData%") & "\Microsoft\Windows\Start Menu\Programs")
  Dim i
  For i = 0 To UBound(bases)
    base = bases(i)
    If fso.FolderExists(base) Then
      For Each f In fso.GetFolder(base).Files
        If LCase(fso.GetExtensionName(f.Name)) = "lnk" Then
          If InStr(LCase(f.Name), "phantum") > 0 Then
            FindInstalledApp = f.Path
            Exit Function
          End If
        End If
      Next
    End If
  Next
End Function
