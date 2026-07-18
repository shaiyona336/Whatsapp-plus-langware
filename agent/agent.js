"use strict";

// One-shot command agent. Runs on the SHARER's machine, logged in as a
// username that matches how they log into the web app. It connects to the
// FastAPI relay and, whenever a command is run in one of that user's shared
// terminals, runs it locally in the shared folder and returns the output.
//
//   Usage:  node agent.js <username>
//           (or set AGENT_USER; AGENT_WS_URL overrides the server address)
//
// One agent per person handles all of that person's shared folders — each
// command arrives with its own folder, so there is no per-terminal state.
const { exec } = require("child_process");

// 127.0.0.1 (not "localhost"): Node can resolve localhost to IPv6 ::1, which
// uvicorn isn't listening on — the agent would silently retry forever.
const SERVER_WS = process.env.AGENT_WS_URL || "ws://127.0.0.1:8080/agent/ws";
const USER = (process.argv[2] || process.env.AGENT_USER || "").trim();
const CMD_TIMEOUT_MS = 30000;
const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB

if (!USER) {
  console.error("Usage: node agent.js <username>  (the name you log in as)");
  process.exit(1);
}

let ws = null;
let reconnectTimer = null;

// Node's built-in WebSocket (undici) doesn't always hold the event loop open
// while a connection is in progress, so the process could exit code 0 mid-
// handshake or between reconnect retries. A live interval pins the loop.
setInterval(() => {}, 60_000);

// A socket that dies after connecting fires 'close'; one whose CONNECTION
// ATTEMPT is refused (server down) fires only 'error' — never 'close'. Both
// paths must reschedule, and the guard dedupes when both fire for one socket.
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function runCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: cwd || process.cwd(), // blank folder => wherever the agent runs
        timeout: CMD_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT,
      },
      (err, stdout, stderr) => {
        let out = (stdout || "") + (stderr || "");
        if (err) {
          if (err.killed) out += `\n(timed out after ${CMD_TIMEOUT_MS / 1000}s)`;
          else if (!out) out = `(error: ${err.message})`;
        }
        resolve(out || "(no output)");
      },
    );
  });
}

function connect() {
  ws = new WebSocket(SERVER_WS);

  ws.addEventListener("open", () => {
    console.log(`[agent] connected to ${SERVER_WS} as "${USER}"`);
    send({ type: "agent_hello", agent: USER });
  });

  ws.addEventListener("message", async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "run") {
      console.log(`[agent] run in ${msg.cwd || "(default)"}: ${msg.command}`);
      const output = await runCommand(msg.command, msg.cwd);
      send({ type: "run_result", req_id: msg.req_id, output });
    }
  });

  ws.addEventListener("close", () => {
    console.log("[agent] disconnected; retrying in 1s");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    scheduleReconnect();
  });
}

connect();
