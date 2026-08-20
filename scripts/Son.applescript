-- Son launcher: starts the whole local stack — the whisper STT servers
-- (whisper.cpp on :8081, the OpenAI-compat shim on :8083) and the bot
-- itself (:7860) — each only if it isn't already listening, waits for
-- :7860 to answer, then opens the page in the default browser.
-- Regenerate the .app with scripts/make_son_app.sh.
--
-- __REPO__, __UV__, and __WHISPER__ are substituted by make_son_app.sh.

on run
	set repoPath to "__REPO__"
	set uvPath to "__UV__"
	set whisperPath to "__WHISPER__"

	if serverUp() then
		-- Already running — just open the page.
		open location "http://localhost:7860"
		return
	end if

	-- Local voice STT (whisper-small-son). whisper.cpp transcribes on
	-- Metal but only speaks its own /inference dialect; the shim bridges
	-- it to the OpenAI protocol pipecat sends. Skipped when the binary or
	-- model is missing (fresh machine) or the port already answers.
	if (not portUp(8081)) and whisperReady() then
		tell application "Terminal"
			activate
			do script "cd " & quoted form of whisperPath & " && exec " & quoted form of whisperPath & "/build/bin/whisper-server -m models/ggml-whisper-small-son.bin --host 127.0.0.1 --port 8081 --threads 8"
		end tell
		-- Metal shader JIT takes ~15 s before the port opens; give it time.
		repeat 30 times
			if portUp(8081) then exit repeat
			delay 1
		end repeat
	end if
	if not portUp(8083) then
		tell application "Terminal"
			activate
			do script "cd " & quoted form of repoPath & " && exec " & quoted form of uvPath & " run python whisper_local.py"
		end tell
		delay 1
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
		do shell script "curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:7860/models"
		return result is "200"
	on error
		return false
	end try
end serverUp

-- A service is "up" when its TCP port accepts a connection. Plain nc -z,
-- deliberately NOT an HTTP probe: whisper-server handles one connection
-- at a time and an empty POST wedges its accept loop until the client
-- hangs up, which would read as "down" and spawn a duplicate server.
on portUp(portNum)
	try
		do shell script "nc -z -G 2 127.0.0.1 " & portNum
		return true
	on error
		return false
	end try
end portUp

-- The fine-tuned model lives outside the repo (~/.cache/son/whisper.cpp)
-- and may be absent on a fresh machine — never block the launcher on it.
on whisperReady()
	try
		do shell script "test -x " & quoted form of (whisperPath & "/build/bin/whisper-server") & " && test -f " & quoted form of (whisperPath & "/models/ggml-whisper-small-son.bin")
		return true
	on error
		return false
	end try
end whisperReady
