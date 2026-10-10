' Hidden-window launcher for the WorkBuddy proxy (called by the desktop shortcut).
' Server output goes to data\server.log (the data folder is created on first run).
Option Explicit
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.Run "cmd /c node server.mjs >> data\server.log 2>&1", 0, False