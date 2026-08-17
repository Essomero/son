-- Son launcher: starts the bot (if it isn't already up) in a Terminal
-- window, waits for :7860 to answer, then opens the page in the default
-- browser. Regenerate the .app with scripts/make_son_app.sh.
--
-- __REPO__ and __UV__ are substituted by make_son_app.sh.

on run
	set repoPath to "__REPO__"
	set uvPath to "__UV__"

	if serverUp() then
		-- Already running — just open the page.
		open location "http://localhost:7860"
		return
	end if

	tell application "Terminal"
		activate
		do script "cd " & quoted form of repoPath & " && exec " & quoted form of uvPath & " run python son.py"
	end tell

	-- Wait up to 90s for the server to answer.
	repeat 90 times
		if serverUp() then exit repeat
		delay 1
	end repeat

	open location "http://localhost:7860"
end run

on serverUp()
	try
		do shell script "curl -s -o /dev/null -w '%{http_code}' http://localhost:7860/models"
		return result is "200"
	on error
		return false
	end try
end serverUp
