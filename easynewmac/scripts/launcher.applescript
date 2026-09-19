use scripting additions

on run
	try
		set launcherPath to POSIX path of (path to resource "app-launch.zsh")
		do shell script "/bin/zsh " & quoted form of launcherPath
	on error errorMessage
		display alert "EasyNewMac 无法启动" message errorMessage as critical
	end try
	quit
end run
