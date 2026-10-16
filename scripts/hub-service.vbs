' Launch the gateway keep-alive loop with no visible console window.
' Scheduled Task "OpenCodeProxyHub" runs this at logon; wscript owns no console
' of its own, and the cmd it spawns is started with window style 0 (hidden).
Option Explicit

Dim fso, shell, baseDir, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /c """ & baseDir & "\hub-service.cmd"""

shell.Run command, 0, False
