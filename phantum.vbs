' phantum launcher — double-click this file to start the terminal manager.
'
' It starts a hidden system-tray controller (phantum-tray.ps1). The tray runs the
' Node server in the background and opens the app window. Right-click the tray
' icon (near the clock) for Open / Restart server / Stop server & Exit.
'
' Closing the browser window leaves the server — and your Claude sessions —
' running; only the tray's "Stop server & Exit" (or stop-phantum.vbs) shuts it
' down, which also ends those sessions.

Option Explicit

Dim fso, shell, here, nodeCheck, q
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
q = Chr(34)

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

' Launch the hidden tray controller — it starts the server and opens the window.
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
          q & here & "\phantum-tray.ps1" & q, 0, False
