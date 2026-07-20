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
const { exec, spawn } = require("child_process");
const crypto = require("crypto");

// 127.0.0.1 (not "localhost"): Node can resolve localhost to IPv6 ::1, which
// uvicorn isn't listening on — the agent would silently retry forever.
const SERVER_WS = process.env.AGENT_WS_URL || "ws://127.0.0.1:8080/agent/ws";
const USER = (process.argv[2] || process.env.AGENT_USER || "").trim();
const CMD_TIMEOUT_MS = 30000;
const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB

// Execution sandbox. Default ("none") runs the command directly on the host,
// as the agent's own user — the original behavior. Set AGENT_SANDBOX=docker to
// run each command inside a throwaway container with ONLY the shared folder
// bind-mounted, no network, and resource limits, so a command can't reach
// anything outside that folder. Docker mode uses a Linux image, so the
// commands are Linux (`ls`, not `dir`).
const SANDBOX = (process.env.AGENT_SANDBOX || "none").toLowerCase();
const SANDBOX_IMAGE = process.env.AGENT_SANDBOX_IMAGE || "alpine";

if (!USER) {
  console.error("Usage: node agent.js <username>  (the name you log in as)");
  process.exit(1);
}

console.log(
  `[agent] sandbox: ${SANDBOX}` +
    (SANDBOX === "docker" ? ` (image "${SANDBOX_IMAGE}")` : ""),
);

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

// Dispatch each command to the configured executor.
function runCommand(command, cwd) {
  return SANDBOX === "docker"
    ? runInDocker(command, cwd)
    : runOnHost(command, cwd);
}

// Host executor (default): run the command directly in the shared folder as
// the agent's own user. Simple, but the command has that user's full access to
// the machine (see the README security notes).
function runOnHost(command, cwd) {
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

// Sandboxed executor: run the command inside a throwaway container with only
// the shared folder mounted at /work. Uses spawn with an args ARRAY and passes
// the user's command as a single argument to `sh -c`, so it can't break out of
// the docker invocation on the host. A per-run --name lets the timeout kill the
// container deterministically.
function runInDocker(command, cwd) {
  return new Promise((resolve) => {
    const name = "termchat_" + crypto.randomBytes(6).toString("hex");
    const args = [
      "run", "--rm", "--name", name,
      "--network", "none", // no exfiltration / downloads
      "--memory", "256m", "--cpus", "1", "--pids-limit", "128", // fork-bomb cap
      "--cap-drop", "ALL",
      "--read-only", "--tmpfs", "/tmp", // only the mount is writable
    ];
    if (cwd) {
      args.push("-v", `${cwd}:/work`, "-w", "/work");
    } else {
      // No folder shared: an empty writable scratch dir, so the command still
      // runs but sees nothing of the host.
      args.push("--tmpfs", "/work", "-w", "/work");
    }
    args.push(SANDBOX_IMAGE, "sh", "-c", command);

    const child = spawn("docker", args, { windowsHide: true });

    let out = "";
    let truncated = false;
    let timedOut = false;
    const cap = (buf) => {
      if (truncated) return;
      out += buf.toString();
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + "\n(output truncated at 10 MB)";
        truncated = true;
      }
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);

    const timer = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["kill", name], { windowsHide: true }); // ends docker run
    }, CMD_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`(sandbox error: ${e.message} — is Docker installed and running?)`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) out += `\n(timed out after ${CMD_TIMEOUT_MS / 1000}s)`;
      resolve(out || "(no output)");
    });
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
