"""SQLAlchemy ORM models. Four tables: users, conversations, terminals, messages.

Chat and terminal transcript share the `messages` table via `kind`; a message
belongs to a shared terminal when `terminal_id` is set, otherwise it is plain chat.
"""
from datetime import datetime
from typing import Optional, List

from sqlalchemy import String, Integer, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db import Base


class User(Base):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(String, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (UniqueConstraint("user_a", "user_b", name="uq_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_a: Mapped[str] = mapped_column(String)          # sorted pair, (a,b) == (b,a)
    user_b: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    terminals: Mapped[List["Terminal"]] = relationship(back_populates="conversation")
    messages: Mapped[List["Message"]] = relationship(back_populates="conversation")


class Terminal(Base):
    __tablename__ = "terminals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"))
    shared_by: Mapped[str] = mapped_column(String)       # owner; whose folder executes
    root_folder: Mapped[str] = mapped_column(String)     # this terminal's "specific folder"
    status: Mapped[str] = mapped_column(String, default="active")   # 'active' | 'revoked'
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    conversation: Mapped["Conversation"] = relationship(back_populates="terminals")
    messages: Mapped[List["Message"]] = relationship(back_populates="terminal")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"))
    terminal_id: Mapped[Optional[int]] = mapped_column(ForeignKey("terminals.id"), nullable=True)
    sender: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)            # 'chat' | 'terminal_cmd' | 'terminal_output'
    body: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    conversation: Mapped["Conversation"] = relationship(back_populates="messages")
    terminal: Mapped[Optional["Terminal"]] = relationship(back_populates="messages")
