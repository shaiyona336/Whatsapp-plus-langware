"""Pydantic request/response schemas and the WebSocket event schema.

One event schema carries everything over the socket:
    message | terminal_shared | terminal_cmd | terminal_output | terminal_revoked
"""
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict


# ---------- request payloads ----------

class LoginIn(BaseModel):
    username: str


class OpenConversationIn(BaseModel):
    me: str
    other: str


class SendMessageIn(BaseModel):
    conversation_id: int
    sender: str
    body: str


class ShareTerminalIn(BaseModel):
    conversation_id: int
    shared_by: str
    root_folder: str


class RunCommandIn(BaseModel):
    terminal_id: int
    sender: str
    command: str


class RevokeTerminalIn(BaseModel):
    terminal_id: int
    requested_by: str          # must equal terminal.shared_by (owner-only revoke)


# ---------- response models (read from ORM objects) ----------

class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    username: str
    created_at: datetime


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_a: str
    user_b: str


class TerminalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    conversation_id: int
    shared_by: str
    root_folder: str
    status: str


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    conversation_id: int
    terminal_id: Optional[int]
    sender: str
    kind: str
    body: str
    created_at: datetime


# ---------- WebSocket events ----------

WsEventType = Literal[
    "message",           # new chat message
    "terminal_shared",   # a terminal was opened
    "terminal_cmd",      # a command was submitted (echo into transcript)
    "terminal_output",   # command result
    "terminal_revoked",  # terminal closed -> frontend removes the panel
]


class WsEvent(BaseModel):
    type: WsEventType
    conversation_id: int
    payload: dict
