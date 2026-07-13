"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { LogOut, Plus, Send, TerminalSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, connectWs } from "@/lib/api";
import type { Conversation, Message, Terminal, User, WsEvent } from "@/lib/types";

// xterm.js and its addons touch `self` at module load, so they can't be
// evaluated during SSR — load the panel client-only.
const TerminalPanel = dynamic(
  () => import("@/components/TerminalPanel").then((m) => m.TerminalPanel),
  { ssr: false },
);

function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

function time(iso: string) {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatApp({ me, onLogout }: { me: string; onLogout: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [other, setOther] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);

  const [draft, setDraft] = useState("");
  const [folder, setFolder] = useState("");
  const [sharing, setSharing] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // --- contacts: load + poll so a peer logging in elsewhere shows up ---
  const loadUsers = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch {
      /* ignore transient errors */
    }
  }, []);

  useEffect(() => {
    loadUsers();
    const t = setInterval(loadUsers, 4000);
    return () => clearInterval(t);
  }, [loadUsers]);

  // --- open a conversation when a contact is selected ---
  useEffect(() => {
    if (!other) return;
    let cancelled = false;

    (async () => {
      const conv = await api.openConversation(me, other);
      if (cancelled) return;
      console.log(`[conv] opened id=${conv.id} me=${me} other=${other}`);
      setConversation(conv);
      const [msgs, terms] = await Promise.all([
        api.getMessages(conv.id),
        api.getTerminals(conv.id),
      ]);
      if (cancelled) return;
      setMessages(msgs);
      setTerminals(terms);
    })();

    return () => {
      cancelled = true;
      setMessages([]);
      setTerminals([]);
      setConversation(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [other, me]);

  // --- live WebSocket for the open conversation, with auto-reconnect ---
  // The server's room registry is in-memory and the socket has no keep-alive,
  // so a backend restart / laptop sleep / network blip silently drops us. On
  // every close we re-open the socket (rejoining the conversation's broadcast
  // room) and re-sync history, so we don't stay deaf and don't miss anything
  // that was sent while we were disconnected.
  useEffect(() => {
    if (!conversation) return;
    const cid = conversation.id;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      console.log(`[ws] connect() opening socket for cid=${cid}`);
      const ws = connectWs(cid);
      wsRef.current = ws;
      ws.onopen = () =>
        console.log(`[ws] OPEN cid=${cid} readyState=${ws.readyState}`);
      ws.onmessage = (ev) => {
        const event = JSON.parse(ev.data) as WsEvent;
        console.log(`[ws] message cid=${cid} type=${event.type}`);
        handleEvent(event);
      };
      ws.onerror = () => console.log(`[ws] ERROR cid=${cid}`);
      ws.onclose = (e) => {
        console.log(
          `[ws] CLOSE cid=${cid} code=${e.code} wasClean=${e.wasClean} intentional=${closed}`,
        );
        if (closed) return; // we intentionally tore down; don't reconnect
        retry = setTimeout(reconnect, 1000);
      };
    }

    async function reconnect() {
      if (closed) return;
      console.log(`[ws] reconnect() cid=${cid}`);
      connect(); // start listening again before re-syncing
      try {
        const [msgs, terms] = await Promise.all([
          api.getMessages(cid),
          api.getTerminals(cid),
        ]);
        if (closed) return;
        // Merge fetched history with any live events that landed meanwhile.
        setMessages((prev) => {
          const byId = new Map<number, Message>();
          for (const m of msgs) byId.set(m.id, m);
          for (const m of prev) byId.set(m.id, m);
          return [...byId.values()].sort((a, b) => a.id - b.id);
        });
        setTerminals(terms);
      } catch {
        // Backend still down — the fresh socket's onclose will schedule
        // another attempt, so this keeps retrying every ~1s until it's back.
      }
    }

    connect();

    return () => {
      console.log(`[ws] teardown cid=${cid}`);
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id]);

  function handleEvent(event: WsEvent) {
    switch (event.type) {
      case "message":
      case "terminal_cmd":
      case "terminal_output": {
        const msg = event.payload as Message;
        setMessages((prev) =>
          prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
        );
        break;
      }
      case "terminal_shared": {
        const term = event.payload as Terminal;
        setTerminals((prev) =>
          prev.some((t) => t.id === term.id) ? prev : [...prev, term],
        );
        break;
      }
      case "terminal_revoked": {
        const id = event.payload.terminal_id as number;
        setTerminals((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "revoked" } : t)),
        );
        break;
      }
    }
  }

  // keep chat scrolled to the newest chat bubble
  const chatMessages = messages.filter((m) => m.kind === "chat");
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages.length]);

  async function sendChat(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !conversation) return;
    setDraft("");
    await api.sendMessage(conversation.id, me, body); // append arrives via WS
  }

  async function shareTerminal(e: React.FormEvent) {
    e.preventDefault();
    if (!conversation || sharing) return;
    setSharing(true);
    try {
      await api.shareTerminal(conversation.id, me, folder.trim());
      setFolder("");
    } catch (err) {
      alert((err as Error).message); // eslint-disable-line no-alert
    } finally {
      setSharing(false);
    }
  }

  const contacts = users.filter((u) => u.username !== me);

  return (
    <div className="flex h-screen bg-[#0b141a] text-[#e9edef]">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-[#111b21]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold">
              {initials(me)}
            </div>
            <span className="text-sm font-medium">{me}</span>
          </div>
          <button
            onClick={onLogout}
            title="Log out"
            className="text-[#8696a0] hover:text-[#e9edef]"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 py-2 text-xs uppercase tracking-wide text-[#8696a0]">
          Contacts
        </div>
        <div className="flex-1 overflow-y-auto">
          {contacts.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-[#8696a0]">
              No one else here yet. Open another tab and log in as a different
              name.
            </p>
          )}
          {contacts.map((u) => (
            <button
              key={u.username}
              onClick={() => setOther(u.username)}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/5 ${
                other === u.username ? "bg-white/10" : ""
              }`}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2a3942] text-xs font-semibold">
                {initials(u.username)}
              </div>
              <span className="text-sm">{u.username}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Conversation */}
      {!other || !conversation ? (
        <div className="flex flex-1 items-center justify-center text-center text-[#8696a0]">
          <div>
            <TerminalSquare className="mx-auto mb-3 h-10 w-10 opacity-40" />
            <p>Select a contact to start chatting and sharing terminals.</p>
          </div>
        </div>
      ) : (
        <main className="flex min-w-0 flex-1">
          {/* Chat column */}
          <section className="flex min-w-0 flex-1 flex-col border-r border-white/10">
            <header className="flex items-center gap-3 border-b border-white/10 bg-[#202c33] px-4 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2a3942] text-xs font-semibold">
                {initials(other)}
              </div>
              <div>
                <div className="text-sm font-medium">{other}</div>
                <div className="text-xs text-[#8696a0]">
                  conversation #{conversation.id}
                </div>
              </div>
            </header>

            <div
              className="flex-1 space-y-2 overflow-y-auto px-4 py-4"
              style={{
                backgroundImage:
                  "radial-gradient(rgba(255,255,255,0.02) 1px, transparent 0)",
                backgroundSize: "16px 16px",
              }}
            >
              {chatMessages.map((m) => {
                const mine = m.sender === me;
                return (
                  <div
                    key={m.id}
                    className={`flex ${mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-lg px-3 py-1.5 text-sm shadow ${
                        mine
                          ? "bg-emerald-700 text-white"
                          : "bg-[#202c33] text-[#e9edef]"
                      }`}
                    >
                      {!mine && (
                        <div className="text-xs font-medium text-emerald-400">
                          {m.sender}
                        </div>
                      )}
                      <div className="whitespace-pre-wrap break-words">
                        {m.body}
                      </div>
                      <div className="mt-0.5 text-right text-[10px] text-white/50">
                        {time(m.created_at)}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>

            <form
              onSubmit={sendChat}
              className="flex items-center gap-2 border-t border-white/10 bg-[#202c33] px-3 py-3"
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message"
                className="border-white/10 bg-[#2a3942] text-[#e9edef] placeholder:text-[#8696a0]"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!draft.trim()}
                className="bg-emerald-600 hover:bg-emerald-500"
              >
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </section>

          {/* Shared terminals column */}
          <section className="flex w-[460px] shrink-0 flex-col bg-[#0b141a]">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <TerminalSquare className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-medium">Shared terminals</span>
            </div>

            <form
              onSubmit={shareTerminal}
              className="flex items-center gap-2 border-b border-white/10 px-3 py-3"
            >
              <Input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="folder to share (blank = default workspace)"
                className="border-white/10 bg-[#2a3942] font-mono text-xs text-[#e9edef] placeholder:text-[#8696a0]"
              />
              <Button
                type="submit"
                size="sm"
                disabled={sharing}
                className="shrink-0 bg-emerald-600 hover:bg-emerald-500"
              >
                <Plus className="h-4 w-4" /> Share
              </Button>
            </form>

            <div className="flex-1 space-y-3 overflow-y-auto p-3">
              {terminals.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-[#8696a0]">
                  No terminals shared yet. Share a folder to run commands
                  together — output streams live to both of you.
                </p>
              )}
              {terminals.map((t) => (
                <TerminalPanel
                  key={t.id}
                  terminal={t}
                  me={me}
                  messages={messages.filter((m) => m.terminal_id === t.id)}
                  onRevoked={(id) =>
                    setTerminals((prev) =>
                      prev.map((x) =>
                        x.id === id ? { ...x, status: "revoked" } : x,
                      ),
                    )
                  }
                />
              ))}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
