# README2 — Interview battle plan (read me first)

This document briefs **a human (Shai) and an AI assistant working live in a
1-hour interview** on this codebase. It contains everything needed to run,
explain, extend, and debug the system fast. Companion docs:

- `README.md` — full architecture write-up and Q&A (long form).
- `most_likely.txt` — ranked predictions of what the interviewer will ask,
  with strategy per item. **Read it.** This file complements it with the
  concrete system knowledge and recipes.
- `two_pcs.txt` — step-by-step guide for the two-machine LAN demo.
- `remote.txt` — fastest path to demo over the INTERNET (interviewer's PC
  anywhere → commands on my machine) with cloudflared quick tunnels.
  cloudflared is already installed and tunnel-tested on the desktop.
- `explain_agent.txt` — deep-dive on how the agent executes commands on the
  owner's PC (the hero mechanism, standalone).
- `CLAUDE.md` — the short contract summary the AI loads automatically.

---

## 1. What this is

**TermChat**: a WhatsApp-style chat where the hero feature is **sharing a
terminal inside a conversation**. One user shares a folder; either person in
the chat can then run commands **on the sharer's machine**, and both see the
command + output in a shared transcript.

The one-sentence pitch of the core design decision:

> Commands execute on the **owner's machine** via a small per-user agent; the
> backend is a **pure relay** that never executes anything; the browser is
> sandboxed and can't execute anything. That's why the agent exists.

```
 laptop (bob)                    desktop (alice = sharer)
 ┌─────────┐   REST /api/*  ┌──────────────┐  agent WS   ┌────────────┐
 │ browser ├───────────────►│ Next.js:3000 │             │ agent.js   │
 │         │                │  (proxy)     │             │ (node,     │
 │         │◄── WS :8080 ─┐ └──────┬───────┘             │  exec)     │
 └─────────┘              │        ▼ HTTP                └─────▲──────┘
                          │ ┌──────────────┐    ws /agent/ws  │
                          └─┤ FastAPI:8080 ├──────────────────┘
                            │ SQLite hub   │  routes run → owner's agent
                            └──────────────┘
```

Three components, no code generators, no migrations, no setup scripts:

| Dir         | What                                                        | Port |
|-------------|-------------------------------------------------------------|------|
| `backend/`  | FastAPI + SQLite (SQLAlchemy): REST, WS hub, agent relay    | 8080 |
| `frontend/` | Next.js 16 (App Router, TS) + Tailwind + xterm.js           | 3000 |
| `agent/`    | Dependency-free Node script; executes commands one-shot     | —    |

---

## 2. How to run

### First time only
```powershell
python -m venv backend/.venv
backend\.venv\Scripts\pip install -r backend/requirements.txt
cd frontend; npm install
```

### Single PC (the likely interview setup — two browser tabs)
Three terminals:
```powershell
cd backend  ; .venv\Scripts\uvicorn main:app --reload --port 8080
cd frontend ; npm run dev
cd agent    ; node agent.js alice     # name MUST match the web login name
```
Open http://localhost:3000 in two tabs, log in as `alice` and `bob`
(any names; login creates the user, no password). None of the LAN/env-var
setup below is needed on a single machine — defaults all point at 127.0.0.1.

### Two PCs on one network (see two_pcs.txt for full detail)
```powershell
.\start-lan-server.ps1      # prints the LAN IP, opens backend+frontend windows
cd agent; node agent.js alice
# other PC: browse http://<IP>:3000, and for its own agent:
#   $env:AGENT_WS_URL='ws://<IP>:8080/agent/ws'; node agent.js bob
```
One-time firewall (admin): allow inbound TCP 8080 and 3000 (`two_pcs.txt` Part 1).

### Verify nothing is broken (run after ANY change)
```powershell
cd backend  ; .venv\Scripts\python smoke.py     # end-to-end hero path
cd frontend ; npx tsc --noEmit                  # typecheck
```

### Environment variables (all optional, sane defaults)
| Var | Used by | Meaning |
|---|---|---|
| `BACKEND_URL` | next.config.ts | proxy target, default `http://127.0.0.1:8080` |
| `NEXT_PUBLIC_WS_URL` | browser | WS base, default `ws://localhost:8080` (baked at dev-server start) |
| `ALLOWED_DEV_ORIGIN` | next.config.ts | LAN IP allow-list for /_next assets |
| `AGENT_WS_URL` | agent.js | default `ws://127.0.0.1:8080/agent/ws` |
| `AGENT_USER` | agent.js | alternative to the CLI arg |
| `DB_PATH` / `DATABASE_URL` | db.py | default `backend/app.db` |
| `SHARED_ROOT` | main.py | fallback workspace when a share folder is blank |

---

## 3. The hero flow — trace of one command

Bob types `dir` in alice's shared terminal. Follow the code:

1. **`frontend/components/TerminalPanel.tsx`** `submit()` →
   `api.runCommand(terminal.id, me, cmd)`.
2. **`frontend/lib/api.ts`** POSTs `/api/terminals/run` (relative URL, always).
3. **`frontend/next.config.ts`** rewrite strips `/api` and proxies to the
   backend root (`http://127.0.0.1:8080/terminals/run`).
4. **`backend/main.py`** `run_command()`:
   a. loads the `Terminal` row, 404/409 checks;
   b. inserts a `terminal_cmd` message and **broadcasts it immediately**
      (that's why the command echoes on both screens before output exists);
   c. calls `agents.run(term.shared_by, ...)` — routes by the terminal's
      **owner**, not the sender. This line is the whole product.
5. **`AgentRegistry.run()`**: looks up the owner's agent socket, generates a
   `req_id` (uuid), parks an `asyncio.Future` in `self.pending[req_id]`,
   sends `{type:"run", req_id, command, cwd}` over the agent WS, awaits the
   future with a **35s** timeout. No agent → returns a friendly string
   instead of failing (graceful degradation — smoke.py asserts this).
6. **`agent/agent.js`**: receives `run`, executes with `child_process.exec`
   (cwd = the shared folder, **30s kill**, 10MB max output, stdout+stderr
   merged), replies `{type:"run_result", req_id, output}`.
7. Backend `agent_ws` handler → `agents.resolve(req_id, output)` → the parked
   future resolves → `run_command` inserts a `terminal_output` message and
   broadcasts it.
8. Both browsers' `ChatApp.handleEvent` append the message by id;
   `TerminalPanel` paints any not-yet-written transcript rows into xterm.

Key properties to say out loud: the request/response over ONE agent socket is
multiplexed by `req_id`→Future; late replies after a timeout are dropped
safely (resolve finds no pending future); everything lands in one `messages`
table so the transcript is durable and replayable.

---

## 4. File map (where to make changes)

```
backend/
  main.py      ALL endpoints + Hub (chat WS rooms) + AgentRegistry (relay)
  models.py    SQLAlchemy tables: users, conversations, terminals, messages
  schemas.py   Pydantic request/response models + WsEvent envelope
  db.py        engine/session/init (SQLite, check_same_thread=False)
  smoke.py     end-to-end test via TestClient (no server needed)
agent/
  agent.js     the whole agent: connect, hello, run, reply, reconnect
frontend/
  lib/api.ts        REST client (req<T> helper) + connectWs()
  lib/types.ts      TS mirror of schemas.py — keep in sync
  components/ChatApp.tsx        state, WS lifecycle + reconnect, handleEvent
  components/TerminalPanel.tsx  xterm transcript + command input + revoke
  components/Login.tsx          username-only login
  next.config.ts    /api rewrite, allowedDevOrigins, proxyTimeout: 60s
```

### The four DB tables (models.py)
- `users(username PK, created_at)`
- `conversations(id, user_a, user_b, created_at)` — **sorted pair**, unique;
  1:1 DMs only (group chat = the classic extension ask).
- `terminals(id, conversation_id, shared_by, root_folder, status)` —
  status `active|revoked`; `shared_by` decides whose machine executes.
- `messages(id, conversation_id, terminal_id?, sender, kind, body,
  created_at)` — **one table for chat AND transcript**, discriminated by
  `kind` = `chat | terminal_cmd | terminal_output`. `terminal_id` set ⇒
  belongs to that terminal's transcript.

### The WS event envelope
`{type, conversation_id, payload}` with type ∈
`message | terminal_shared | terminal_cmd | terminal_output |
terminal_revoked`. Defined twice: `schemas.py` and `lib/types.ts`.

---

## 5. Contracts — do not break these

1. **Three-way schema sync**: `models.py` ⇄ `schemas.py` ⇄ `lib/types.ts`.
   Any shape change touches all three.
2. **The WebSocket is notify-only.** Clients never send over it; every action
   is REST; the socket only pushes server events. Reconnect = reopen socket +
   re-fetch + **merge by id** (see `ChatApp` `reconnect()` — idempotent Map).
   If a new feature wants client→server WS traffic (typing indicators!),
   flag it as a deliberate pattern change or keep it REST+broadcast.
3. **SQLite has no migrations.** `Base.metadata.create_all` creates missing
   *tables* but never alters existing ones. Adding a column live: **stop the
   backend, delete `backend/app.db`, restart** (demo data is throwaway —
   say this out loud rather than debugging a phantom "no such column").
4. Ports are fixed: frontend 3000, backend 8080. Browser code only calls
   relative `/api/*` — never hardcode a backend host in frontend code.
5. **Timeout cascade — keep the ordering**: agent kills a command at **30s**
   (and still replies "timed out") < backend relay wait **35s**
   (`AgentRegistry.run`) < Next proxy **60s** (`proxyTimeout` in
   next.config.ts). If any inner layer outlasts an outer one, users get bare
   500s instead of graceful messages (this was a real bug — see §7).

---

## 6. Design decisions and how to defend them

- **Why an agent instead of executing on the server?** Otherwise commands run
  on the server's machine — that's both wrong (not the sharer's files) and
  RCE-on-my-server. The relay never executes; each person's agent executes
  only their own terminals' commands.
- **Why one-shot `exec`, no PTY?** Deliberate scope: no native deps
  (node-pty needs compilation), no per-terminal shell processes to babysit,
  no streaming protocol — and it still demonstrates the sharing
  architecture. Cost, stated honestly: `cd`/env don't persist between
  commands, no interactive programs, output arrives as one blob. Upgrade
  path: node-pty + one live shell per terminal + byte streaming.
- **Why SQLite + SQLAlchemy?** Zero-setup, single file, perfect for a demo;
  the ORM layer means Postgres is a connection-string swap away. Known
  limits: single writer, `check_same_thread=False` shares the connection
  with FastAPI's threadpool.
- **Known holes (say them before they're found):** no auth (type a username),
  agent identity is spoofable (`agent_hello` is trusted — anyone can claim
  "alice"; fix = agent auth tokens/mTLS), the shared folder is a cwd not a
  jail (`cd ..`, absolute paths escape; fix = sandbox/allow-list), CORS `*`,
  Hub + AgentRegistry are in-memory so it's single-instance (fix =
  Redis/NATS pub-sub + sticky agent routing + Postgres).

---

## 7. War stories — real bugs found and fixed here (great "hardest bug" answers)

1. **IPv6 localhost trap (hit twice).** Node resolves `localhost` → `::1`
   but uvicorn on `0.0.0.0`/`127.0.0.1` is IPv4-only → `ECONNREFUSED`.
   Broke both the Next proxy (`BACKEND_URL`) and the agent's default WS URL.
   Fix: default to `127.0.0.1` explicitly, never "localhost", in server-side
   Node code.
2. **Agent process silently exited (code 0).** Node's built-in WebSocket
   (undici) doesn't hold the event loop open during connect/reconnect, so
   the agent could just... end. Fix: a `setInterval` keep-alive pins the
   loop (see comment in agent.js).
3. **Agent never reconnected after backend restart.** A *refused* connection
   attempt fires only `error` — **no `close` event** — and the retry was
   scheduled only in `onclose`, so the retry chain died on the first attempt
   while the backend was down, leaving a healthy-looking zombie process.
   Fix: `scheduleReconnect()` from both `error` and `close`, deduped by a
   timer guard.
4. **"Internal Server Error" on slow/hung agents.** The Next dev rewrite
   proxy aborts upstream requests at 30s by default and returns a bare 500 —
   exactly tying the backend's 30s agent wait, so the proxy always won the
   race and the graceful "(no response from the agent)" message was lost.
   Fix: the 30 < 35 < 60 cascade in §5, plus registry self-healing
   (`agent_ws` unregisters in `finally`; `run()` unregisters a socket that
   fails a send).
5. **xterm "reading 'dimensions'" crash.** Opening a 0-size terminal +
   React StrictMode double-mount made a discarded xterm instance schedule
   internal work after dispose. Fix: `term.open()` only fires from a
   ResizeObserver once the host has real size; `ro.disconnect()` cancels the
   discarded instance. (All in TerminalPanel.tsx comments.)

---

## 8. Feature recipes (the likely asks — see most_likely.txt for ranking)

For each: files to touch, gotchas. Follow the same shape as existing code.

**`cd` persistence (the #1 predicted ask).**
Server-side minimal version: keep `cwd_by_terminal: dict[int, str]` next to
`AgentRegistry` (or a `current_dir` column — remember §5.3: delete app.db).
In `run_command`: `cwd = cwd_by_terminal.get(term.id, term.root_folder)`;
if the command starts with `cd `, resolve the new path against the current
cwd (`ntpath.normpath(ntpath.join(cwd, arg))`), store it, and return a
confirmation message without calling the agent; else pass `cwd` to
`agents.run`. Say honestly: env vars/venvs still won't persist — that needs
the PTY upgrade path.

**Command history (up-arrow) — the fast, safe win.**
Frontend-only, TerminalPanel.tsx: `historyRef` array + index state; push on
submit; `onKeyDown` on the Input handles ArrowUp/ArrowDown to set `command`.
~10 minutes, zero backend risk.

**Streaming output.**
Agent: replace `exec` with `spawn`, send `{type:"run_chunk", req_id, data}`
per stdout chunk, then the final `run_result`. Backend: on `run_chunk`,
broadcast a new WS event (e.g. `terminal_chunk`, no DB row per chunk); still
insert the full output as the durable `terminal_output` at the end. Frontend:
add the event to `WsEventType` (both definitions), a `handleEvent` case, and
write chunks straight into xterm. Flag the transcript-vs-live-bytes tension:
reconnecting clients replay from `messages`, so chunks are ephemeral.

**Read-only / permissioned terminals.**
`Terminal.mode` (`'run' | 'read_only'`) in models+schemas+types (delete
app.db!), enforce in `run_command` (`403 if mode=='read_only' and sender !=
term.shared_by`), hide the input row in TerminalPanel for non-owners.

**Typing indicator / presence.**
Keep the notify-only pattern: `POST /typing {conversation_id, sender}` that
only broadcasts an ephemeral `typing` event (no DB row); frontend throttles
sends (e.g. every 2s while typing) and clears the indicator on a 3s timer.
Mention: presence done properly would replace the 4s `/users` poll.

**Delete / edit message.**
Endpoint + `deleted` flag (or edited body) + a `message_updated` WS event;
`handleEvent` updates the message by id instead of appending.

**Pagination / search.**
`GET .../messages?before_id=&limit=` cursor; ChatApp loads older on scroll
top. Point out the current code loads the whole history on open.

**Group chat.**
Design answer first: replace the sorted-pair columns with a
`participants(conversation_id, username)` join table; the Hub broadcast is
already N-way, so live delivery barely changes. Only code it if asked —
schema + open-conversation endpoint is the 1-hour scope.

### Cookbook: adding a new endpoint end-to-end
1. `schemas.py`: request `...In` / response `...Out` models.
2. `main.py`: endpoint; if it mutates shared state, insert the DB row first,
   then `await hub.broadcast(cid, event)` (follow `send_message`).
3. `lib/api.ts`: one method on the `api` object.
4. `lib/types.ts`: mirror any new shapes / event types.
5. Consumer component; live updates arrive through `handleEvent`.

---

## 9. Troubleshooting (fast lookup)

| Symptom | Cause → fix |
|---|---|
| `EADDRINUSE` port 3000/8080 | Orphan process holds the port: `Get-NetTCPConnection -LocalPort 3000 -State Listen` → `Stop-Process -Id <pid> -Force` |
| "(no agent connected for 'X')" | Agent not running, or started with a name ≠ the web login. Restart with the matching name. |
| Commands hang ~35s then "(no response from the agent...)" | Agent process frozen or half-dead. **#1 suspect on Windows: someone clicked inside the agent's console window — QuickEdit select mode freezes the process. Press Esc/Enter in that window.** |
| `Manifest file is empty` / `Unexpected end of JSON input` / GET / 500 | Corrupted `.next` cache (e.g. a dev server was force-killed mid-write). Stop the frontend, delete `frontend/.next`, restart. First start after that is slow — that's the rebuild. |
| Proxy 500 `ECONNREFUSED 127.0.0.1:8080` in the frontend log | Backend isn't running. Start it. |
| `←[32m` garbage in server windows | Raw ANSI color codes in classic conhost — cosmetic. The LAN script already sets `--no-use-colors` / `NO_COLOR=1`. |
| `no such column` after adding a model field | §5.3 — delete `backend/app.db`, restart backend. |
| Laptop can't reach the app at all | Wrong/stale hotspot IP (re-run `start-lan-server.ps1`), firewall, or client isolation — full ladder in `two_pcs.txt` Part 5. |
| `UnicodeEncodeError` printing from Python | Windows cp1252 console — no emoji/fancy chars in `print()`. |
| PowerShell script parse errors with mojibake (`â€”`) | Non-ASCII in a `.ps1` (PS 5.1 reads BOM-less files as ANSI). Keep `.ps1` files pure ASCII. |

---

## 10. Working rules for the AI assistant

1. Read this file, then `most_likely.txt`, before touching code. `README.md`
   has the long-form rationale if a design question goes deep.
2. Small, surgical diffs in the existing style. The codebase is deliberately
   simple — don't introduce new libraries, layers, or patterns mid-interview.
3. After every change run **both**: `backend\.venv\Scripts\python smoke.py`
   (from `backend/`) and `npx tsc --noEmit` (from `frontend/`).
4. Respect §5 contracts, especially the three-way schema sync and the
   notify-only WebSocket. Schema change ⇒ delete `backend/app.db`.
5. Never start a second `next dev` against `frontend/` (they share `.next`
   and force-kills corrupt it). Test the backend directly with TestClient
   (like smoke.py) or on a spare port with `DB_PATH` pointed at a temp file.
6. Windows specifics: PowerShell 5.1 (no `&&` chaining), `.ps1` files pure
   ASCII, no emoji in Python prints, prefer `127.0.0.1` over `localhost` in
   any server-side URL.
7. When something fails, check the three windows in order: backend (uvicorn
   log / traceback), frontend (`Failed to proxy` lines), agent (`[agent]`
   lines). The failing layer is almost always obvious from which log went
   quiet.
