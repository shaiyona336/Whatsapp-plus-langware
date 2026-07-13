"use strict";

// Owns the live PTY sessions, keyed by terminalId. One real shell per shared
// terminal, so multiple terminals run fully independent shells at once.
const pty = require("node-pty");

function defaultShell() {
  return process.platform === "win32"
    ? process.env.COMSPEC || "cmd.exe"
    : process.env.SHELL || "bash";
}

class PtyManager {
  /**
   * @param {(terminalId:number, data:string)=>void} onOutput
   * @param {(terminalId:number, exitCode:number)=>void} onExit
   */
  constructor(onOutput, onExit) {
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.sessions = new Map(); // terminalId -> { proc }
  }

  spawn(terminalId, cwd, cols = 80, rows = 24) {
    this.kill(terminalId); // replace any stale session for this id
    const proc = pty.spawn(defaultShell(), [], {
      name: "xterm-color",
      cols,
      rows,
      cwd: cwd || process.cwd(),
      env: process.env,
    });
    proc.onData((data) => this.onOutput(terminalId, data));
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(terminalId);
      this.onExit(terminalId, exitCode);
    });
    this.sessions.set(terminalId, { proc });
    return proc;
  }

  write(terminalId, data) {
    const s = this.sessions.get(terminalId);
    if (s) s.proc.write(data);
  }

  resize(terminalId, cols, rows) {
    const s = this.sessions.get(terminalId);
    if (s) {
      try {
        s.proc.resize(cols, rows);
      } catch {
        /* ignore transient resize errors */
      }
    }
  }

  kill(terminalId) {
    const s = this.sessions.get(terminalId);
    if (s) {
      try {
        s.proc.kill();
      } catch {
        /* already gone */
      }
      this.sessions.delete(terminalId);
    }
  }

  has(terminalId) {
    return this.sessions.has(terminalId);
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager, defaultShell };
