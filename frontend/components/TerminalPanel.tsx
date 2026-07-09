"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Message, Terminal } from "@/lib/types";

// One shared terminal, rendered with xterm.js. The xterm surface is a live
// transcript (commands + one-shot output broadcast over the WebSocket); the
// input row below submits new commands via POST /terminals/run. Anyone in the
// conversation can run; only the owner (shared_by) can revoke.
export function TerminalPanel({
  terminal,
  messages,
  me,
  onRevoked,
}: {
  terminal: Terminal;
  messages: Message[]; // already filtered to this terminal, in order
  me: string;
  onRevoked: (terminalId: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0); // how many transcript messages already painted

  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);

  const active = terminal.status === "active";
  const isOwner = terminal.shared_by === me;

  // Boot the xterm instance once.
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      convertEol: true,
      cursorBlink: false,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#0b141a",
        foreground: "#d1d7db",
        cursor: "#00a884",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try {
      fit.fit();
    } catch {
      /* container may be 0-size on first paint */
    }
    term.writeln(`\x1b[90m# shared by ${terminal.shared_by}`);
    term.writeln(`# cwd: ${terminal.root_folder}\x1b[0m`);

    termRef.current = term;
    fitRef.current = fit;
    writtenRef.current = 0;

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  // Paint any transcript messages we haven't written yet.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    for (let i = writtenRef.current; i < messages.length; i++) {
      const m = messages[i];
      if (m.kind === "terminal_cmd") {
        term.writeln("");
        term.writeln(`\x1b[38;5;42m${m.sender} $\x1b[0m ${m.body}`);
      } else if (m.kind === "terminal_output") {
        term.writeln(`\x1b[38;5;250m${m.body.replace(/\n$/, "")}\x1b[0m`);
      }
    }
    writtenRef.current = messages.length;
  }, [messages]);

  // Note revocation in the transcript.
  useEffect(() => {
    if (!active && termRef.current) {
      termRef.current.writeln("\x1b[31m# terminal revoked\x1b[0m");
    }
  }, [active]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd || running || !active) return;
    setRunning(true);
    setCommand("");
    try {
      await api.runCommand(terminal.id, me, cmd);
    } catch (err) {
      termRef.current?.writeln(
        `\x1b[31m# error: ${(err as Error).message}\x1b[0m`,
      );
    } finally {
      setRunning(false);
    }
  }

  async function revoke() {
    try {
      await api.revokeTerminal(terminal.id, me);
      onRevoked(terminal.id);
    } catch (err) {
      termRef.current?.writeln(
        `\x1b[31m# revoke failed: ${(err as Error).message}\x1b[0m`,
      );
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-[#0b141a] shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              active ? "bg-emerald-500" : "bg-red-500"
            }`}
          />
          <span className="truncate font-mono text-xs text-[#d1d7db]">
            {terminal.root_folder}
          </span>
          <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-[#8696a0]">
            #{terminal.id} · {terminal.shared_by}
          </span>
        </div>
        {isOwner && active && (
          <Button
            size="sm"
            variant="destructive"
            className="h-6 px-2 text-xs"
            onClick={revoke}
          >
            Revoke
          </Button>
        )}
      </div>

      <div ref={hostRef} className="h-56 w-full px-2 py-1" />

      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-white/10 bg-[#111b21] px-2 py-2"
      >
        <span className="pl-1 font-mono text-sm text-emerald-400">$</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={!active || running}
          placeholder={active ? "type a command…" : "terminal revoked"}
          className="flex-1 bg-transparent font-mono text-sm text-[#d1d7db] placeholder:text-[#8696a0] focus:outline-none disabled:opacity-50"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!active || running || !command.trim()}
          className="h-7 bg-emerald-600 px-3 text-xs hover:bg-emerald-500"
        >
          {running ? "…" : "Run"}
        </Button>
      </form>
    </div>
  );
}
