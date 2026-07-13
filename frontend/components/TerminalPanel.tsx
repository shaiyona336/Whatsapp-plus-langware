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
  const [ready, setReady] = useState(false); // xterm is sized & safe to write to

  const active = terminal.status === "active";
  const isOwner = terminal.shared_by === me;

  // Boot the xterm instance once, but don't OPEN it (attach to the DOM), fit,
  // or write to it until the host element actually has a nonzero size. Opening
  // a 0-size terminal (which happens with the dynamic import + first paint, and
  // StrictMode's mount/remount in dev) makes xterm schedule an internal
  // syncScrollArea that reads undefined renderer dimensions and throws
  // "Cannot read properties of undefined (reading 'dimensions')". A
  // ResizeObserver drives the first open/fit and every later resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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

    termRef.current = term;
    fitRef.current = fit;
    writtenRef.current = 0;

    let disposed = false;
    let opened = false;

    const safeFit = () => {
      if (disposed || !opened || !host.offsetWidth || !host.offsetHeight) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };

    // Attach to the DOM (term.open) only once the container has a real size,
    // then fit + write the header. Deferring open is what actually prevents the
    // "reading 'dimensions'" crash — it fires from inside term.open() itself.
    const openWhenSized = () => {
      if (opened || disposed || !host.offsetWidth || !host.offsetHeight) return;
      opened = true;
      term.open(host);
      safeFit();
      term.writeln(`\x1b[90m# shared by ${terminal.shared_by}`);
      term.writeln(`# cwd: ${terminal.root_folder}\x1b[0m`);
      setReady(true); // unblocks the transcript-paint effect below
    };

    const ro = new ResizeObserver(() => {
      openWhenSized();
      safeFit();
    });
    ro.observe(host);
    openWhenSized(); // in case the host is already laid out on mount

    return () => {
      disposed = true;
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  // Paint any transcript messages we haven't written yet. Gated on `ready` so
  // we never write before the terminal has been sized (see boot effect above).
  useEffect(() => {
    const term = termRef.current;
    if (!term || !ready) return;
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
  }, [messages, ready]);

  // Note revocation in the transcript.
  useEffect(() => {
    if (!active && ready && termRef.current) {
      termRef.current.writeln("\x1b[31m# terminal revoked\x1b[0m");
    }
  }, [active, ready]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd || running || !active) return;
    setRunning(true);
    setCommand("");
    try {
      console.log(`[run] POST terminal=${terminal.id} sender=${me} cmd=${cmd}`);
      const res = await api.runCommand(terminal.id, me, cmd);
      console.log(`[run] server responded msg id=${res.id} kind=${res.kind}`);
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
