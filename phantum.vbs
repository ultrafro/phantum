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
  Dim edge, chrome, pf, pfx86, la
  pf = shell.ExpandEnvironmentStrings("%ProgramFiles%")
  pfx86 = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
  la = shell.ExpandEnvironmentStrings("%LocalAppData%")

  edge = pfx86 & "\Microsoft\Edge\Application\msedge.exe"
  If Not fso.FileExists(edge) Then edge = pf & "\Microsoft\Edge\Application\msedge.exe"

  chrome = pf & "\Google\Chrome\Application\chrome.exe"
  If Not fso.FileExists(chrome) Then chrome = pfx86 & "\Google\Chrome\Application\chrome.exe"
  If Not fso.FileExists(chrome) Then chrome = la & "\Google\Chrome\Application\chrome.exe"

  If fso.FileExists(edge) Then
    shell.Run """" & edge & """ --app=" & u & " --window-size=1400,900", 1, False
  ElseIf fso.FileExists(chrome) Then
    shell.Run """" & chrome & """ --app=" & u & " --window-size=1400,900", 1, False
  Else
    shell.Run u, 1, False ' fall back to default browser
  End If
End Sub
