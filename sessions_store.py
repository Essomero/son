"""SQLite session store for Son.

Sessions live across disconnects and bot restarts: metadata (name, role,
timestamps, preview) plus the full transcript, written live as the
conversation happens. The client owns session ids (a uuid sent in /start
custom_data) so a session can be resumed from another page load.

Concurrency: the bot coroutine and the FastAPI threadpool both touch the DB,
so every operation opens its own connection (WAL mode; write transactions
are tiny). No lock needed at this scale.

The transcript is captured by ``PersistedContext`` — a write-through
LLMContext. The context aggregators commit every finalized turn through
``add_message``/``add_messages`` (speech, typed send-text, assistant
replies), so one DB row per turn lands here with zero pipeline changes.
Developer messages (the session greeting, the resume note) are excluded —
they must not replay as transcript on resume.
"""

import sqlite3
import time
from pathlib import Path

from pipecat.processors.aggregators.llm_context import LLMContext

DB_PATH = Path(__file__).parent / "son.db"
PREVIEW_LEN = 80

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,          -- client-generated uuid
  name TEXT NOT NULL,           -- "Bro · 17 Aug 14:30"
  role_file TEXT NOT NULL,      -- instruction file basename
  role_name TEXT,               -- frontmatter name, shown in the panel
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT                  -- last message, truncated
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,           -- user | assistant (developer never stored)
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id, id);
"""


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=3000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(_SCHEMA)


def _row(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r is not None else None


def create_session(session_id: str, name: str, role_file: str, role_name: str | None) -> None:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    with _conn() as conn:
        conn.execute(
            "INSERT INTO sessions (id, name, role_file, role_name, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, name, role_file, role_name, now, now),
        )


def append_message(session_id: str, role: str, text: str) -> None:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    preview = " ".join(text.split())[:PREVIEW_LEN]
    with _conn() as conn:
        conn.execute(
            "INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, text, now),
        )
        conn.execute(
            "UPDATE sessions SET updated_at = ?, message_count = message_count + 1,"
            " preview = ? WHERE id = ?",
            (now, preview, session_id),
        )


def get_session(session_id: str) -> dict | None:
    with _conn() as conn:
        return _row(conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone())


def list_sessions() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, name, role_file, role_name, created_at, updated_at,"
            " message_count, preview FROM sessions ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_messages(session_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT role, text, created_at FROM messages"
            " WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def rename_session(session_id: str, name: str) -> bool:
    name = (name or "").strip()
    if not name:
        return False
    with _conn() as conn:
        cur = conn.execute("UPDATE sessions SET name = ? WHERE id = ?", (name, session_id))
    return cur.rowcount > 0


def delete_session(session_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    return cur.rowcount > 0


def parse_frontmatter_name(text: str) -> str | None:
    """Role name from an instruction file's YAML frontmatter (gen_roles pattern)."""
    if not text.startswith("---"):
        return None
    for line in text.splitlines()[1:]:
        if line.strip() == "---":
            break
        if line.startswith("name:"):
            return line.partition(":")[2].strip().strip('"').strip("'")
    return None


class PersistedContext(LLMContext):
    """LLMContext that writes every committed turn to the session store.

    The context aggregators (and son.py's greeting) are the only writers of
    the shared context, so overriding add_message/add_messages captures the
    full transcript — one row per finalized turn. Developer messages are
    excluded: the greeting belongs to the session start, not the transcript,
    and must not replay when a session is resumed (a fresh resume note is
    added instead). set_messages is not persisted — the pipeline never
    replaces wholesale messages in this app.
    """

    def __init__(self, session_id: str | None = None, **kwargs):
        super().__init__(**kwargs)
        self._session_id = session_id

    @staticmethod
    def _content(message) -> str | None:
        content = getattr(message, "content", None)
        if content is None and isinstance(message, dict):
            content = message.get("content")
        if isinstance(content, str):
            return content
        return None  # multimodal parts / non-text content: not transcript material

    def _persist(self, message) -> None:
        if not self._session_id:
            return
        role = getattr(message, "role", None)
        if not role and isinstance(message, dict):
            role = message.get("role")
        if role not in ("user", "assistant"):
            return
        text = self._content(message)
        if text:
            append_message(self._session_id, role, text)

    def add_message(self, message) -> None:
        super().add_message(message)
        self._persist(message)

    def add_messages(self, messages) -> None:
        super().add_messages(messages)
        for m in messages:
            self._persist(m)

    def set_messages(self, messages) -> None:
        super().set_messages(messages)
