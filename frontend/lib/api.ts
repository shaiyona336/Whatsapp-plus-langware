// REST client for the existing FastAPI backend. All calls go through the
// relative /api/* proxy (see next.config.ts) which strips /api and forwards to
// the backend root. The WebSocket connects directly (rewrites don't proxy ws).

import type { Conversation, Message, Terminal, User } from "./types";

const WS_BASE =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (username: string) =>
    req<User>("/login", {
      method: "POST",
      body: JSON.stringify({ username }),
    }),

  listUsers: () => req<User[]>("/users"),

  openConversation: (me: string, other: string) =>
    req<Conversation>("/conversations", {
      method: "POST",
      body: JSON.stringify({ me, other }),
    }),

  getMessages: (conversationId: number) =>
    req<Message[]>(`/conversations/${conversationId}/messages`),

  getTerminals: (conversationId: number) =>
    req<Terminal[]>(`/conversations/${conversationId}/terminals`),

  sendMessage: (conversationId: number, sender: string, body: string) =>
    req<Message>("/messages", {
      method: "POST",
      body: JSON.stringify({ conversation_id: conversationId, sender, body }),
    }),

  shareTerminal: (conversationId: number, sharedBy: string, rootFolder: string) =>
    req<Terminal>("/terminals/share", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: conversationId,
        shared_by: sharedBy,
        root_folder: rootFolder,
      }),
    }),

  runCommand: (terminalId: number, sender: string, command: string) =>
    req<Message>("/terminals/run", {
      method: "POST",
      body: JSON.stringify({ terminal_id: terminalId, sender, command }),
    }),

  revokeTerminal: (terminalId: number, requestedBy: string) =>
    req<{ terminal_id: number; status: string }>("/terminals/revoke", {
      method: "POST",
      body: JSON.stringify({ terminal_id: terminalId, requested_by: requestedBy }),
    }),
};

export function connectWs(conversationId: number): WebSocket {
  return new WebSocket(`${WS_BASE}/ws/${conversationId}`);
}
