"use client";

import { useState } from "react";
import { TerminalSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

// Password-less login: type a username, backend upserts the user.
export function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const username = name.trim();
    if (!username || busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await api.login(username);
      onLogin(user.username);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b141a] p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-xl border border-white/10 bg-[#111b21] p-8 shadow-xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600">
            <TerminalSquare className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-semibold text-[#e9edef]">TermChat</h1>
          <p className="text-sm text-[#8696a0]">
            WhatsApp-style chat with a live shared terminal.
          </p>
        </div>

        <div className="space-y-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pick a username"
            autoFocus
            className="border-white/15 bg-[#202c33] text-[#e9edef] placeholder:text-[#8696a0]"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <Button
          type="submit"
          disabled={busy || !name.trim()}
          className="w-full bg-emerald-600 hover:bg-emerald-500"
        >
          {busy ? "Entering…" : "Enter"}
        </Button>
        <p className="text-center text-xs text-[#8696a0]">
          Tip: open a second browser tab and log in as another name to chat with
          yourself.
        </p>
      </form>
    </div>
  );
}
