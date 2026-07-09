"""FastAPI app: REST + WebSocket for the WhatsApp-prototype.

Hero feature = shared terminals (command-runner). Chat is the thin frame.
Single backend, demoed as two browser tabs. No sandbox (out of scope).
"""
import os
import asyncio
import subprocess

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_db, init_db
import models
import schemas

SHARED_ROOT = os.environ.get("SHARED_ROOT", os.path.join(os.path.dirname(__file__), "workspace"))
CMD_TIMEOUT = int(os.environ.get("CMD_TIMEOUT", "20"))

app = FastAPI(title="WhatsApp-prototype")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()
    os.makedirs(SHARED_ROOT, exist_ok=True)


# --------------------------------------------------------------------------
# WebSocket registry:  conversation_id -> set[WebSocket]
# --------------------------------------------------------------------------
class Hub:
    def __init__(self) -> None:
        self.rooms: dict[int, set[WebSocket]] = {}

    async def join(self, conversation_id: int, ws: WebSocket) -> None:
        await ws.accept()
        self.rooms.setdefault(conversation_id, set()).add(ws)

    def leave(self, conversation_id: int, ws: WebSocket) -> None:
        self.rooms.get(conversation_id, set()).discard(ws)

    async def broadcast(self, conversation_id: int, event: dict) -> None:
        for ws in list(self.rooms.get(conversation_id, set())):
            try:
                await ws.send_json(event)
            except Exception:
                self.leave(conversation_id, ws)


hub = Hub()


@app.websocket("/ws/{conversation_id}")
async def ws_endpoint(ws: WebSocket, conversation_id: int):
    await hub.join(conversation_id, ws)
    try:
        while True:
            await ws.receive_text()   # clients push actions via REST; socket is notify-only
    except WebSocketDisconnect:
        hub.leave(conversation_id, ws)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _msg_event(kind_type: str, msg: models.Message) -> dict:
    return {
        "type": kind_type,
        "conversation_id": msg.conversation_id,
        "payload": schemas.MessageOut.model_validate(msg).model_dump(mode="json"),
    }


def _add_message(db: Session, conversation_id, sender, kind, body, terminal_id=None) -> models.Message:
    msg = models.Message(
        conversation_id=conversation_id, terminal_id=terminal_id,
        sender=sender, kind=kind, body=body,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg


# --------------------------------------------------------------------------
# Auth / users  (type-a-username, no password)
# --------------------------------------------------------------------------
@app.post("/login", response_model=schemas.UserOut)
def login(payload: schemas.LoginIn, db: Session = Depends(get_db)):
    name = payload.username.strip()
    if not name:
        raise HTTPException(400, "username required")
    user = db.get(models.User, name)
    if not user:
        user = models.User(username=name)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


@app.get("/users", response_model=list[schemas.UserOut])
def list_users(db: Session = Depends(get_db)):
    return db.scalars(select(models.User).order_by(models.User.username)).all()


# --------------------------------------------------------------------------
# Conversations  (1:1 DM keyed by sorted username pair)
# --------------------------------------------------------------------------
@app.post("/conversations", response_model=schemas.ConversationOut)
def open_conversation(payload: schemas.OpenConversationIn, db: Session = Depends(get_db)):
    a, b = sorted([payload.me.strip(), payload.other.strip()])
    conv = db.scalar(
        select(models.Conversation).where(
            models.Conversation.user_a == a, models.Conversation.user_b == b)
    )
    if not conv:
        conv = models.Conversation(user_a=a, user_b=b)
        db.add(conv)
        db.commit()
        db.refresh(conv)
    return conv


@app.get("/conversations/{conversation_id}/messages", response_model=list[schemas.MessageOut])
def get_messages(conversation_id: int, db: Session = Depends(get_db)):
    return db.scalars(
        select(models.Message)
        .where(models.Message.conversation_id == conversation_id)
        .order_by(models.Message.id)
    ).all()


@app.get("/conversations/{conversation_id}/terminals", response_model=list[schemas.TerminalOut])
def get_terminals(conversation_id: int, db: Session = Depends(get_db)):
    return db.scalars(
        select(models.Terminal).where(
            models.Terminal.conversation_id == conversation_id,
            models.Terminal.status == "active",
        ).order_by(models.Terminal.id)
    ).all()


# --------------------------------------------------------------------------
# Chat
# --------------------------------------------------------------------------
@app.post("/messages", response_model=schemas.MessageOut)
async def send_message(payload: schemas.SendMessageIn, db: Session = Depends(get_db)):
    msg = _add_message(db, payload.conversation_id, payload.sender, "chat", payload.body)
    await hub.broadcast(payload.conversation_id, _msg_event("message", msg))
    return msg


# --------------------------------------------------------------------------
# Shared terminals  (HERO)
# --------------------------------------------------------------------------
@app.post("/terminals/share", response_model=schemas.TerminalOut)
async def share_terminal(payload: schemas.ShareTerminalIn, db: Session = Depends(get_db)):
    folder = payload.root_folder.strip() or SHARED_ROOT
    if not os.path.isdir(folder):
        raise HTTPException(400, f"not a directory: {folder}")
    term = models.Terminal(
        conversation_id=payload.conversation_id, shared_by=payload.shared_by, root_folder=folder,
    )
    db.add(term)
    db.commit()
    db.refresh(term)
    await hub.broadcast(payload.conversation_id, {
        "type": "terminal_shared", "conversation_id": payload.conversation_id,
        "payload": schemas.TerminalOut.model_validate(term).model_dump(mode="json"),
    })
    return term


@app.post("/terminals/run", response_model=schemas.MessageOut)
async def run_command(payload: schemas.RunCommandIn, db: Session = Depends(get_db)):
    term = db.get(models.Terminal, payload.terminal_id)
    if not term:
        raise HTTPException(404, "terminal not found")
    if term.status != "active":
        raise HTTPException(409, "terminal is closed")
    cid = term.conversation_id

    # echo the command into the transcript immediately
    cmd_msg = _add_message(db, cid, payload.sender, "terminal_cmd", payload.command, term.id)
    await hub.broadcast(cid, _msg_event("terminal_cmd", cmd_msg))

    # run fresh from the terminal's folder — one-shot, off the event loop
    output = await asyncio.to_thread(_execute, payload.command, term.root_folder)

    out_msg = _add_message(db, cid, payload.sender, "terminal_output", output, term.id)
    await hub.broadcast(cid, _msg_event("terminal_output", out_msg))
    return out_msg


@app.post("/terminals/revoke")
async def revoke_terminal(payload: schemas.RevokeTerminalIn, db: Session = Depends(get_db)):
    term = db.get(models.Terminal, payload.terminal_id)
    if not term:
        raise HTTPException(404, "terminal not found")
    if payload.requested_by != term.shared_by:
        raise HTTPException(403, "only the owner can revoke")
    term.status = "revoked"
    db.commit()
    await hub.broadcast(term.conversation_id, {
        "type": "terminal_revoked", "conversation_id": term.conversation_id,
        "payload": {"terminal_id": term.id},
    })
    return {"terminal_id": term.id, "status": "revoked"}


def _execute(command: str, cwd: str) -> str:
    """Run one command to completion. NO SANDBOX — prototype only."""
    try:
        proc = subprocess.run(
            command, cwd=cwd, shell=True, capture_output=True, text=True, timeout=CMD_TIMEOUT,
        )
        return (proc.stdout or "") + (proc.stderr or "") or "(no output)"
    except subprocess.TimeoutExpired:
        return f"(timed out after {CMD_TIMEOUT}s)"
    except Exception as e:
        return f"(error: {e})"
