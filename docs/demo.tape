# README demo: vhs docs/demo.tape (run from the repo root).
# Uses a throwaway profile under %TEMP% and made-up usage from docs/demo-fixture.json; no API is called.

Output docs/demo.gif
Set Shell "powershell"
Set FontSize 16
Set Width 1400
Set Height 900
Set Padding 10
Set Theme "Builtin Dark"
Set TypingSpeed 60ms

Hide
Type `$repo = (Get-Location).Path.Replace('\','/'); $root = Join-Path $env:TEMP 'opencode-usage-demo'; Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue`
Enter
Type `$env:USERPROFILE = Join-Path $root 'home'; $env:HOME = $env:USERPROFILE; foreach ($d in 'config','data','state','cache') { Set-Item "env:XDG_$($d.ToUpper())_HOME" (Join-Path $root $d) }`
Enter
Type `$env:OPENCODE_USAGE_FIXTURE = "$repo/docs/demo-fixture.json"; New-Item -ItemType Directory -Force "$env:XDG_CONFIG_HOME/opencode", "$env:USERPROFILE/demo/acme-api" | Out-Null`
Enter
Type `Set-Content "$env:XDG_CONFIG_HOME/opencode/cli.json" ('{"plugins":["' + $repo + '"]}')`
Enter
Type `cd "$env:USERPROFILE/demo/acme-api"; git init -q; git -c user.name=demo -c user.email=demo@example.com commit -q --allow-empty -m init; Clear-Host; opencode2 --standalone`
Enter
Sleep 7s
Show

Sleep 3s
Type "/usage"
Sleep 800ms
Enter
Sleep 4s

Type "Reply with one word: hello"
Sleep 500ms
Enter
Sleep 11s
