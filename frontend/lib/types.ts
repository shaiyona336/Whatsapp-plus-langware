// Mirrors backend/schemas.py response models and the WebSocket event schema.

export interface User {
  username: string;
  created_at: string;
}

export interface Conversation {
  id: number;
  user_a: string;
  user_b: string;
}

export interface Terminal {
  id: number;
  conversation_id: number;
  shared_by: string;
  root_folder: string;
  status: string; // 'active' | 'revoked'
}

export type MessageKind = "chat" | "terminal_cmd" | "terminal_output";

export interface Message {
  id: number;
  conversation_id: number;
  terminal_id: number | null;
  sender: string;
  kind: MessageKind;
  body: string;
  created_at: string;
}

// WebSocket events — one envelope carries everything (see schemas.WsEvent).
export type WsEventType =
  | "message"
  | "terminal_shared"
  | "terminal_cmd"
  | "terminal_output"
  | "terminal_revoked";

export interface WsEvent {
  type: WsEventType;
  conversation_id: number;
  payload: any;
}
