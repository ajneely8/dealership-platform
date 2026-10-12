' Runs run-forever.cmd without a console window (used by the DealerIntel scheduled task).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & dir & "\run-forever.cmd""", 0, False
