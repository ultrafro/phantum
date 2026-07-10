' Stops the phantum server (kills the hidden node process running server.js).
Option Explicit
Dim shell, out
Set shell = CreateObject("WScript.Shell")

' Kill any node process whose command line runs server.js in this folder.
Dim fso, here
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

Dim cmd
cmd = "cmd /c wmic process where ""name='node.exe' and CommandLine like '%server.js%'"" call terminate"
shell.Run cmd, 0, True

MsgBox "phantum server stopped.", vbInformation, "phantum"
