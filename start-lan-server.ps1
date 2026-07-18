# Starts backend + frontend bound to the LAN so another PC can connect.
# Run from the repo root:  .\start-lan-server.ps1
# (One-time, in an ADMIN prompt, open the firewall for the Public profile:
#   netsh advfirewall firewall add rule name="TermChat 8080" dir=in action=allow protocol=TCP localport=8080 profile=any
#   netsh advfirewall firewall add rule name="TermChat 3000" dir=in action=allow protocol=TCP localport=3000 profile=any )
# NOTE: keep this file pure ASCII. PowerShell 5.1 reads BOM-less files as
# ANSI, and non-ASCII characters can decode into curly quotes that end
# strings early and break the whole parse.

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    Select-Object -First 1).IPAddress
if (-not $ip) { Write-Error "No LAN IP found - are you connected to a network?"; exit 1 }

Write-Host "LAN IP: $ip"
Write-Host "Other PC opens:   http://${ip}:3000"
Write-Host "Other PC agent (cmd):        set AGENT_WS_URL=ws://${ip}:8080/agent/ws && node agent.js <username>"
Write-Host "Other PC agent (PowerShell): `$env:AGENT_WS_URL='ws://${ip}:8080/agent/ws'; node agent.js <username>"

# Backend on all interfaces (uvicorn defaults to 127.0.0.1 otherwise).
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$PSScriptRoot\backend'; .venv\Scripts\uvicorn main:app --host 0.0.0.0 --port 8080 --no-use-colors"
)

# Frontend on all interfaces. The browser WebSocket must dial the LAN IP
# (NEXT_PUBLIC_ vars are baked in at startup - rerun this script if the IP
# changes), and ALLOWED_DEV_ORIGIN lets Next 16 serve /_next assets to pages
# opened from that IP.
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$PSScriptRoot\frontend'; `$env:NEXT_PUBLIC_WS_URL='ws://${ip}:8080'; `$env:ALLOWED_DEV_ORIGIN='$ip'; `$env:NO_COLOR='1'; npx next dev -H 0.0.0.0 -p 3000"
)
