# CLAUDE.md

TermChat — a WhatsApp-style chat prototype whose hero feature is **sharing a
terminal inside a conversation**: one user shares a folder, and either person
in the chat can run commands **on the sharer's machine**, with the command and
output streamed into a transcript both people see.

Read [README.md](README.md) for the full architecture, design trade-offs, and
Q&A. There is no code generator, migration tool, or setup script — the three
components below are the whole system.

## Components

- `backend/` — FastAPI + SQLite (SQLAlchemy). REST API, WebSocket hub
  (per-conversation broadcast), and the **agent relay** that routes each
  command to the agent of the terminal's owner. Port **8080**.
- `frontend/` — Next.js 16 (App Router, TypeScript) + Tailwind + xterm.js.
  Port **3000**. Browser code fetches relative `/api/*` only — a rewrite in
  `next.config.ts` strips `/api` and proxies to the backend root. Never
  hardcode the backend host in frontend code. The WebSocket is **not**
  proxied; it connects directly via `NEXT_PUBLIC_WS_URL`.
- `agent/` — dependency-free Node script (`node agent.js <username>`) run on
  each sharer's machine; executes commands locally (one-shot
  `child_process.exec`, no PTY — deliberate) and returns the output. The
  username must match how that person logs into the web app.

## Run (Windows)

```
cd backend  && .venv\Scripts\uvicorn main:app --reload --port 8080
cd frontend && npm run dev
cd agent    && node agent.js <username>
```

First time: `python -m venv backend/.venv`, then
`backend\.venv\Scripts\pip install -r backend/requirements.txt`, and
`npm install` in `frontend/`. Two-machine LAN demo: run
`start-lan-server.ps1` from the repo root (see README §8).

## Contracts to preserve

- The DB schema is `backend/models.py`; `backend/schemas.py` (Pydantic) and
  `frontend/lib/types.ts` (TypeScript) mirror it — keep all three in sync.
- One `messages` table holds both chat and terminal transcript, discriminated
  by `kind` (`chat` | `terminal_cmd` | `terminal_output`).
- The WebSocket is **notify-only**: clients act via REST; the socket only
  pushes server events. Reconnect = re-open socket + re-fetch + merge by id.
- SQLite `backend/app.db` is created on startup and is not committed.
- Ports: frontend 3000, backend 8080.
