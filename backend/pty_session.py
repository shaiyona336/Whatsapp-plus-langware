"""Persistent PTY sessions — one live shell per shared terminal.

Each `PtySession` runs a real shell (ConPTY on Windows via pywinpty) in the
terminal's root folder. Output is a raw VT/ANSI stream forwarded verbatim to
xterm.js; input (keystrokes) is forwarded verbatim to the shell. pywinpty reads
block, so each session owns a reader thread that hands output chunks back to the
asyncio world via `run_coroutine_threadsafe`.

Sessions are keyed by `terminal_id`, so multiple shared terminals run fully
independent shells at the same time.
"""
import asyncio
import os
import sys
import threading
import time
from typing import Awaitable, Callable, Optional

from winpty import PtyProcess

OutputCb = Callable[[int, str], Awaitable[None]]


def default_shell() -> list[str]:
    if sys.platform == "win32":
        return [os.environ.get("COMSPEC", "cmd.exe")]
    return [os.environ.get("SHELL", "/bin/bash")]


class PtySession:
    def __init__(
        self,
        terminal_id: int,
        cwd: str,
        on_output: OutputCb,
        loop: asyncio.AbstractEventLoop,
        cols: int = 80,
        rows: int = 24,
        shell: Optional[list[str]] = None,
    ) -> None:
        self.terminal_id = terminal_id
        self._on_output = on_output
        self._loop = loop
        self._alive = True
        self._proc = PtyProcess.spawn(
            shell or default_shell(),
            cwd=cwd or None,
            dimensions=(rows, cols),
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        while self._alive:
            try:
                data = self._proc.read(4096)
            except EOFError:
                break
            except Exception:
                break
            if not data:
                time.sleep(0.01)  # yield the GIL; busy-spinning starves output
                continue
            # Forward this chunk into the event loop. Ordering is preserved
            # because this reader is the only producer and submits in order.
            asyncio.run_coroutine_threadsafe(
                self._on_output(self.terminal_id, data), self._loop
            )
        self._alive = False
        # notify EOF (shell exited) as an empty-string sentinel is avoided;
        # callers check `alive` / rely on close broadcast instead.

    def write(self, data: str) -> None:
        if not self._alive:
            return
        try:
            self._proc.write(data)
        except Exception:
            self._alive = False

    def resize(self, cols: int, rows: int) -> None:
        if not self._alive:
            return
        try:
            self._proc.setwinsize(rows, cols)
        except Exception:
            pass

    def close(self) -> None:
        self._alive = False
        try:
            self._proc.terminate(force=True)
        except Exception:
            pass

    @property
    def alive(self) -> bool:
        try:
            return self._alive and self._proc.isalive()
        except Exception:
            return False


class PtyManager:
    """Registry of live PTY sessions, keyed by terminal_id."""

    def __init__(self) -> None:
        self._sessions: dict[int, PtySession] = {}

    def get_or_create(
        self,
        terminal_id: int,
        cwd: str,
        on_output: OutputCb,
        loop: asyncio.AbstractEventLoop,
        cols: int = 80,
        rows: int = 24,
    ) -> PtySession:
        s = self._sessions.get(terminal_id)
        if s and s.alive:
            return s
        if s:
            s.close()
        s = PtySession(terminal_id, cwd, on_output, loop, cols=cols, rows=rows)
        self._sessions[terminal_id] = s
        return s

    def get(self, terminal_id: int) -> Optional[PtySession]:
        return self._sessions.get(terminal_id)

    def close(self, terminal_id: int) -> None:
        s = self._sessions.pop(terminal_id, None)
        if s:
            s.close()

    def close_all(self) -> None:
        for s in list(self._sessions.values()):
            s.close()
        self._sessions.clear()
