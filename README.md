# FlowPad — WhatsApp-style chat with shared terminals

A small chat app whose **hero feature is sharing a terminal inside a
conversation**: you share a folder, and either person in the chat can run
commands **on the sharer's own machine**, with the command + output streamed
into a live transcript both people see.

This document is the deep explanation of how it works and a **"grill me"
Q&A** to prep for architecture questions. Read [AGENTS.md](AGENTS.md) for the
build/runbook contracts; this file is about *understanding*.

---

## 1. TL;DR of the design

- **Chat** is a thin frame. The interesting part is the **terminal relay**.
- A browser **cannot run local shell commands** (it's sandboxed). So a command
  typed in the browser can't touch a real machine directly.
- Therefore each person who shares a terminal runs a tiny **agent** (a Node
  process) on their own machine. The backend is a **relay**: it routes each
  command to the agent of the terminal's *owner*, that agent runs it locally,
  and the output comes back and is broadcast to everyone in the conversation.
- Execution is **one-shot**: every command is a fresh `child_process.exec` in
  the shared folder. **There is no persistent shell** (no PTY). This is a
  deliberate simplicity trade-off — see §7 and the Q&A.

```
┌──────────────┐   REST /terminals/run    ┌───────────────┐   run (req_id)   ┌───────────────┐
│  Browser B   │ ───────────────────────▶ │   Backend      │ ───────────────▶ │  Agent (owner │
│  (xterm.js)  │                          │  FastAPI relay │                  │  = "alice")   │
│              │ ◀─────────────────────── │  + WS hub      │ ◀─────────────── │  child_process│
└──────────────┘   WS: terminal_output    └───────────────┘   run_result     └───────────────┘
      ▲                                          │                              runs on ALICE's
      │           WS broadcast to the            │                              machine, in the
      └───────────  whole conversation ──────────┘                             shared folder
```

The command runs on **alice's** machine even though **bob** typed it, because
the terminal is owned by alice (`shared_by = "alice"`) and the relay sends the
command to alice's agent.

---

## 2. Components & ports

| Component | Tech | Port | Role |
|-----------|------|------|------|
| Frontend  | Next.js 16 (App Router, Turbopack), React, xterm.js, Tailwind | `3000` | UI; renders the transcript in xterm; talks REST via `/api/*` proxy, WS directly |
| Backend   | FastAPI + Uvicorn, SQLAlchemy, SQLite | `8080` | REST API, WebSocket hub (per-conversation broadcast), **agent relay** |
| Agent     | Node (built-in `WebSocket` + `child_process`), no native deps | — | Runs on each sharer's machine; executes commands locally and returns output |
| DB        | SQLite file `backend/app.db` | — | Durable source of truth: users, conversations, terminals, message/transcript history |

**Frontend → backend wiring** (`frontend/next.config.ts`): the browser calls
relative `/api/*`; Next rewrites strip `/api` and proxy to `BACKEND_URL`
(default `http://127.0.0.1:8080` — a literal IP, because Node can resolve
`localhost` to IPv6 `::1` while uvicorn listens on IPv4 only, which breaks
the proxy with ECONNREFUSED). The **WebSocket is not proxied** (rewrites
don't handle `ws://`), so it connects directly to `NEXT_PUBLIC_WS_URL`
(default `ws://localhost:8080`). That single localhost default is the only
thing that makes this single-machine; point those two env vars + the agent's
`AGENT_WS_URL` at a real host and it's multi-machine (see §8).

---

## 3. Data model (`backend/models.py`)

Four tables:

- **users** — `username` (PK), `created_at`. Login is "type a name, no
  password"; unknown names are created on the fly.
- **conversations** — `id`, `user_a`, `user_b`, unique on the **sorted pair**
  so `(a,b)` and `(b,a)` are the same 1:1 DM.
- **terminals** — `id`, `conversation_id`, **`shared_by`** (owner — *whose
  machine executes*), **`root_folder`** (the folder shared, on the owner's
  machine), `status` (`active`/`revoked`).
- **messages** — one table for **both chat and terminal transcript**,
  discriminated by **`kind`**: `chat` | `terminal_cmd` | `terminal_output`. A
  message belongs to a terminal when `terminal_id` is set. Everything is ordered
  by autoincrement `id`.

Key idea: **the "terminal" is a rendered transcript, not a live TTY.** Its
contents are just `messages` rows with `terminal_id` set. That's why history
survives restarts and why a reconnecting client can rebuild the whole thing by
re-fetching messages.

---

## 4. The request flow, end to end

**Sharing a terminal** (`POST /terminals/share`):
1. Insert a `Terminal` row (`shared_by = me`, `root_folder`). The folder is
   **not validated** server-side — it lives on the sharer's machine, not the
   server; a bad path just fails at run time.
2. Broadcast `terminal_shared` to the conversation room → both clients add a
   `TerminalPanel`.

**Running a command** (`POST /terminals/run`) — the heart of it:
1. Insert a `terminal_cmd` message and **broadcast it immediately** (optimistic
   echo: the command shows up in both transcripts before it has run).
2. `agents.run(owner=term.shared_by, cwd=term.root_folder, command, terminal_id)`:
   - Look up the owner's agent socket in `AgentRegistry`.
   - Create an `asyncio.Future`, key it by a fresh `req_id` (uuid).
   - Send `{type:"run", req_id, command, cwd}` to the agent.
   - `await asyncio.wait_for(future, timeout=30)`.
3. The agent runs `exec(command, {cwd})` locally, replies
   `{type:"run_result", req_id, output}`.
4. The relay's `/agent/ws` loop calls `resolve(req_id, output)`, which sets the
   Future's result → `run()` returns the output.
5. Insert a `terminal_output` message and broadcast it → both transcripts get
   the output.

**Correlation:** one socket per agent is *multiplexed* — many commands in
flight are matched to their replies by `req_id → Future`. If the agent replies
after the 30s timeout, `resolve()` finds no pending Future and safely drops it.

---

## 5. The WebSocket hub (`Hub`)

- Registry: `conversation_id -> set[WebSocket]`.
- **"Notify-only"**: clients never *send* actions over the socket. Every action
  is a REST POST; the socket is a **push channel** the server broadcasts on. The
  server's WS receive loop just drains/keeps the connection alive and detects
  disconnect.
- **Why both DB and WS?** DB = durable history (late joiners, reconnects,
  restarts). WS = instant live push so open clients update without polling.

**Reconnect / recovery** (`frontend/components/ChatApp.tsx`): the hub is
in-memory and the socket has no keep-alive, so a backend restart / sleep /
network blip silently drops clients. On every `onclose` the client re-opens the
socket (rejoining the room) **and re-fetches** messages + terminals, merging by
`id`. That's how it never stays deaf and never misses events sent while it was
down. (This is exactly the "bug 2" scenario — see Q&A — and it recovers.)

---

## 6. The agent (`agent/agent.js`)

- Usage: `node agent.js <username>` — the username **must match** how that
  person logs into the web app. That's how the relay knows which agent owns
  which terminals.
- On connect: sends `{type:"agent_hello", agent: <username>}`; the relay stores
  `username -> socket`.
- On `{type:"run"}`: `exec(command, {cwd: cwd || process.cwd(), timeout:30s,
  maxBuffer:10MB, windowsHide:true})`, concatenates stdout+stderr, replies
  `{type:"run_result", req_id, output}`.
- Auto-reconnects 1s after any close.
- **Stateless per command** → **one agent per person serves all their shared
  folders**, because each request carries its own `cwd`. (Verified: alice shares
  3 folders, one agent, each command lands in the right folder.)

The number of agents = number of **people/machines** sharing, **not** the
number of terminals.

---

## 7. Design decisions & trade-offs (know these cold)

| Decision | Why | Cost / what it gives up |
|----------|-----|-------------------------|
| **One-shot exec, no PTY** | No native deps, no per-terminal process/state, no streaming protocol; demonstrates the *sharing architecture* without terminal plumbing | **No persistent state**: `cd` doesn't stick, no env/venv persistence, no interactive programs (`vim`,`top`), no partial-output streaming |
| **Separate agent process** | Browser is sandboxed — the only way to run on the *user's* machine is a native helper (or a desktop app) | Something extra to launch on the sharer's machine |
| **Backend as pure relay** (doesn't execute) | Keeps "runs on the sharer's machine" honest; server never runs untrusted commands | Adds a network hop + a correlation protocol |
| **Notify-only WS + REST actions** | Single source of truth (DB); socket stays a dumb push channel; trivial reconnect story | Two round-trips (POST then WS event) |
| **One `messages` table for chat + transcript** | Uniform ordering, history, reconnect replay for free | `kind` switch everywhere; transcript coupled to chat storage |
| **Sorted-pair conversations** | Canonical 1:1 key, `(a,b)==(b,a)` | Hard-limited to two people |
| **Poll `/users` every 4s** | No presence system needed to see a peer appear | Not real-time; wasteful; no "online" status |
| **In-memory `Hub` + `AgentRegistry`** | Simplest possible; fine for a single-process demo | **Breaks across multiple backend instances** (see scaling Q&A) |
| **`term.open()` deferred to ResizeObserver** | Fixes the xterm "dimensions" crash under StrictMode double-mount | Slightly indirect boot logic |

---

## 8. Running it

**Single machine (the normal demo):**
```
# backend
cd backend && .venv/Scripts/uvicorn main:app --reload --port 8080
# frontend
cd frontend && npm run dev            # http://localhost:3000
# agent (once per person sharing) — username MUST match the web login
cd agent && node agent.js alice
```
Open two browser tabs, log in as `alice` and `bob`, pick each other as a
contact, share a folder as alice, and run commands. Alice's agent executes them.

**Two machines (LAN):** no logic changes — just point everything at the server's
real address instead of `localhost`. `start-lan-server.ps1` (repo root)
automates the server side: it detects the LAN IP and starts both servers with
the right env. Manually, that means:
- Backend on the "server" PC bound to `0.0.0.0`; note its LAN IP (e.g.
  `192.168.1.20`). Open firewall for `8080`/`3000`.
- Frontend served with host `0.0.0.0` and `NEXT_PUBLIC_WS_URL=ws://192.168.1.20:8080`,
  plus `ALLOWED_DEV_ORIGIN=192.168.1.20` — Next 16's dev server refuses
  `/_next/*` requests from non-localhost origins (403) unless the origin is
  allow-listed via `allowedDevOrigins` (wired to that env in `next.config.ts`).
- Each agent: `AGENT_WS_URL=ws://192.168.1.20:8080/agent/ws node agent.js <name>`
  on **that person's own PC**.

Then alice's commands run on alice's PC and bob's on bob's PC — the relay routes
by terminal owner.

---

## 9. Known limitations (say these before they ask)

1. **No persistent shell** — one-shot; `cd`/env don't carry over (§7).
2. **No sandbox** — a command runs with the agent user's full privileges;
   `root_folder` is just the cwd, not a jail (`cd ..` escapes it).
3. **No real auth** — type-a-username; and the **agent's identity is spoofable**
   (it just claims a name in `agent_hello`; the registry trusts it).
4. **`CORS allow_origins=["*"]`** — fine for a demo, not for production.
5. **Single backend instance only** — in-memory hub/registry don't share across
   processes.
6. **Presence is polled**, not pushed.
7. **1:1 conversations only.**

---

## 10. Likely interview extensions (and how you'd approach each)

- **Persistent PTY** — replace `exec` with `node-pty`; one long-lived shell per
  terminal keyed by `terminal_id`; stream bytes both ways; add resize + Ctrl-C.
  The relay gains a persistent channel instead of req/response.
- **Live streaming output** — agent emits `run_chunk` events as stdout arrives;
  relay forwards each; xterm writes incrementally; add cancel.
- **Group chat** — add a `participants` join table; drop the sorted-pair key; the
  broadcast already fans out to a whole room so that part barely changes.
- **Terminal permissions** — a `mode` (read-only / run) or per-command approval
  handshake; enforce in `run_command`; owner approves.
- **Presence/typing** — a global (not per-conversation) socket carrying
  `online`/`typing`; drop the 4s poll.
- **Scale-out** — externalize the hub to Redis/NATS pub-sub; route agent traffic
  across instances (sticky by username or a shared bus); DB is already shared.

---

## 11. GRILL ME — architecture Q&A

Answer these out loud until they're reflexes.

### Where does execution happen?
**Q: When bob types a command, whose machine runs it?**
The **terminal owner's** (`shared_by`). Bob's browser POSTs to the backend; the
backend relays to the *owner's* agent; the agent runs it locally in the shared
folder. The backend itself never executes anything.

**Q: Why not just run commands on the backend?**
Then "share *your* terminal" would be a lie — it'd run on the server, not the
user's machine, and it'd be arbitrary remote code execution on your server. The
whole point of the agent is to keep execution on the sharer's box.

**Q: Why do you need an agent at all — why can't the browser run it?**
Browsers are sandboxed: no filesystem, no process spawning, no shell. There is
**no browser-only way** to run a local command. Options are (a) a native helper
= the agent, or (b) ship the whole thing as a desktop app (Electron/Tauri). I
chose the smallest one: a ~80-line Node agent.

### One-shot vs PTY
**Q: Does this use a PTY?**
No. Each command is a fresh `child_process.exec`. One-shot, buffered output.

**Q: So what happens if I run `cd foo` then `dir`?**
`dir` lists the **shared root**, not `foo`. The `cd` child process changes its
own cwd and exits; the next command starts over at `root_folder`. **State does
not persist between commands.**

**Q: How would you make `cd` stick?**
Two ways. Cheap hack: track a per-terminal cwd on the server and prepend
`cd <saved> && ...`, updating it from `cd` commands — but that still won't carry
environment variables, activated venvs, or interactive programs. The real fix is
a **persistent PTY** (`node-pty`): one long-lived shell per terminal that you
stream bytes to/from. I chose one-shot deliberately to avoid that complexity for
the prototype; it isolates each command and needs no native deps.

**Q: What can't you do without a PTY?**
Interactive programs (`vim`, `top`, `ssh`), colored/curses UIs that depend on a
TTY, arrow keys/line editing, partial output as it streams, and persistent
`cd`/env.

### The relay protocol
**Q: One agent socket, many concurrent commands — how do replies match
requests?**
Each `run()` mints a `req_id` (uuid) and stores an `asyncio.Future` in
`pending[req_id]`. The message carries the `req_id`; the agent echoes it back in
`run_result`; `resolve(req_id, output)` sets that Future. Classic
request/response multiplexing over one connection.

**Q: What if the agent replies after the 30s timeout?**
`wait_for` already popped the Future and returned a timeout message. The late
`resolve()` finds no pending entry and no-ops — the stray output is dropped
safely. There are two timeout layers: the server's `wait_for(30)` and the
agent's own `exec` timeout that kills the child.

**Q: What if no agent is connected for that owner?**
`agents.run` returns "(no agent connected for 'alice' …)" as the output — the
command still gets a transcript entry, so the UI degrades gracefully instead of
hanging.

**Q: Two people run in the same terminal at the same time — race?**
With one-shot, no shared shell, so no shared state to corrupt: two independent
`req_id`/Future pairs, two independent child processes. Transcript ordering is
by message `id`, so a slow command's output can appear after a later command's
echo — cosmetic interleaving, not corruption. With a PTY this **would** be a
real problem (one shell, interleaved bytes) and you'd need per-writer arbitration
or per-user shells.

### WebSocket / consistency
**Q: Why is the socket "notify-only"?**
Clients act via REST (single source of truth = DB); the socket only *pushes*
server-originated events. This keeps the protocol trivial: no action parsing on
the socket, no client-driven state, and reconnect just means "re-subscribe and
re-fetch."

**Q: Why store in the DB **and** broadcast over WS? Isn't that double work?**
Different jobs. The broadcast updates already-open clients instantly. The DB
row is durable truth for anyone who wasn't listening — late joiners, reconnects,
and restarts all rebuild from it. The WS is an optimization on top of the DB, not
a replacement.

**Q: Backend restarts mid-session. What happens? (This is "bug 2".)**
In-memory `Hub` and `AgentRegistry` are wiped; all sockets drop. Clients'
`onclose` fires → reconnect every 1s → on reconnect they re-fetch messages +
terminals and merge by `id`. Agents' `onclose` → reconnect → re-`agent_hello`.
DB persisted everything, so **nothing is lost** and both sides self-heal. The
"bug" was really the xterm crash (bug 1) making it *look* like B couldn't run.

**Q: A client is offline for 10s and 3 messages are sent. Does it miss them?**
No. It's disconnected so the live broadcasts don't reach it — but on reconnect it
`GET`s the full message history and merges by `id`, picking up all 3. The merge
is idempotent (Map keyed by id), so a message that arrives both via the fetch and
a live event isn't duplicated.

### Frontend / xterm
**Q: What was the "Cannot read properties of undefined (reading 'dimensions')"
crash, and the fix?**
xterm's `term.open()` schedules an internal `syncScrollArea`. If you open a
**0-size** terminal (dynamic import first paint) or React **StrictMode** double-
mounts (mount → dispose → mount in dev), the throwaway instance's scheduled work
runs *after* it's disposed and reads undefined renderer dimensions → throw. Fix:
never call `open()` synchronously — drive it from a **ResizeObserver**, opening
only once the host has nonzero size, and `ro.disconnect()` in cleanup cancels the
discarded instance before its scheduled work can fire.

**Q: Why is `TerminalPanel` a dynamic import with `ssr:false`?**
xterm touches `self`/`window` at module load, which doesn't exist during
server-side rendering. Loading it client-only avoids the SSR crash.

**Q: Why does the REST client go through `/api/*` but the WS connects directly?**
Next.js `rewrites` proxy `/api/*` to the backend (keeps the browser same-origin,
no CORS dance, one host). But rewrites don't proxy `ws://`, so the socket must
hit `NEXT_PUBLIC_WS_URL` directly.

### Security
**Q: What are the security holes?**
(1) **Arbitrary remote code execution by design** — anyone in a conversation can
run anything on the sharer's machine with the agent user's privileges. (2) The
shared folder is **not a jail** — it's only the cwd; `cd ..`/absolute paths
escape it. (3) **No auth** — any name logs in. (4) **Agent identity is
spoofable** — it just claims a username; connect an agent as "alice" and you
receive alice's command traffic. (5) `CORS *`.

**Q: How would you make it safe enough to expose?**
Authenticate users (sessions/JWT) and **agents** (per-user token or mTLS), and
bind the agent's claimed identity to an authenticated session instead of trusting
`agent_hello`. Sandbox execution (container/chroot/allow-list), jail to the
folder, add per-terminal permissions (read-only, or owner-approves-each-command),
and lock down CORS.

### Scaling
**Q: How do you run more than one backend instance?**
Today you can't correctly: `Hub` (rooms) and `AgentRegistry` (agent sockets) are
**per-process in-memory**. A client on instance A won't get events for actions on
B, and an agent connected to A is unreachable from B. Fix: move the room
broadcast to **Redis/NATS pub-sub**, and route agent traffic across instances —
either pin each agent to a known instance and forward run-requests to it over the
bus, or make the correlation (`req_id → Future`) go through the bus with sticky
routing by owner username. The SQLite DB would move to Postgres. The relay logic
stays the same shape; only the two in-memory maps become distributed.

### Model / product
**Q: Why the sorted username pair for a conversation?**
Canonical key so `(alice,bob)` and `(bob,alice)` are one conversation, enforced
by `UniqueConstraint(user_a, user_b)`. It's the simplest 1:1 model — and the
reason group chat needs a schema change (a participants join table).

**Q: One agent — how does it serve three shared folders at once?**
The agent is **stateless per command**; the `cwd` rides on each `run` request,
not on the connection. So a single agent handles every folder that person
shares. Agents scale with *people*, not terminals.

**Q: Why poll `/users` instead of pushing new contacts?**
There's no presence channel, and the users list isn't scoped to a conversation
room (which is the only socket a client has open). Polling every 4s is the cheap
stand-in; a real build would push presence over a global socket.

---

*Reference files: `backend/main.py` (relay + hub + REST), `agent/agent.js`
(executor), `frontend/components/ChatApp.tsx` (WS + reconnect),
`frontend/components/TerminalPanel.tsx` (xterm transcript),
`backend/models.py` (schema).*
