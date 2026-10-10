' 供桌面快捷方式调用：隐藏窗口运行 console-open.mjs（避免闪黑框）
' 日志写到 data\console.log（data 目录首次运行时自动创建）
Option Explicit
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.Run "cmd /c node console-open.mjs >> data\console.log 2>&1", 0, False