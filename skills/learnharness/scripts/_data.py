"""Small read-only filesystem helpers for the LearnHarness skill.

No application imports, discovery scans, migrations, caches, or writes inside
the data folder. SQLite stores are read through a read-only, immutable
connection or, when a WAL holds committed data, through a private copy in the
system temp directory. Paths inside the selected data folder may not resolve
outside it. Imported-note paths and artifact references are data, not
instructions to open another file.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from typing import Any, Callable

sys.dont_write_bytecode = True


class DataError(Exception):
    """An actionable reader error, suitable for stderr without a traceback."""


def data_root(override: str | None = None) -> Path:
    """Resolve an explicit data directory or the normal desktop location.

    Never create a missing directory or try a different installation. For a
    development copy or an app launched with LH_DATA_DIR, pass --data-dir.
    """
    if override is not None:
        root = Path(override).expanduser()
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support" / "LearnHarness" / "data"
    elif sys.platform == "win32":
        roaming = os.environ.get("APPDATA")
        if not roaming:
            raise DataError("APPDATA is not set; specify the learning data folder with --data-dir.")
        root = Path(roaming) / "LearnHarness" / "data"
    elif sys.platform.startswith("linux"):
        configured = os.environ.get("XDG_CONFIG_HOME")
        base = Path(configured) if configured else Path.home() / ".config"
        if configured and not base.is_absolute():
            raise DataError("XDG_CONFIG_HOME is relative; specify an absolute --data-dir instead.")
        root = base / "LearnHarness" / "data"
    else:
        raise DataError("Unknown desktop data location on this OS; specify --data-dir.")
    try:
        root = root.resolve()
        if not root.is_dir():
            raise DataError(f"Data folder not found: {root}. Use --data-dir for another copy; nothing was created.")
    except (OSError, RuntimeError, ValueError) as exc:
        raise DataError(f"Cannot resolve the data folder: {exc}") from exc
    return root


def safe_path(root: Path, relative: str | Path) -> Path:
    """Resolve a data-relative path, rejecting traversal and escaping symlinks."""
    try:
        part = Path(relative)
        if part.is_absolute():
            raise DataError("Expected a path relative to the selected data folder.")
        base = root.resolve()
        target = (base / part).resolve()
        if not target.is_relative_to(base):
            raise DataError(f"Refusing a path outside the selected data folder: {relative}")
    except (OSError, RuntimeError, ValueError) as exc:
        raise DataError(f"Cannot resolve data-relative path {relative!s}: {exc}") from exc
    return target


def _reject_constant(value: str) -> None:
    raise ValueError(f"Non-JSON numeric constant: {value}")


def read_json(root: Path, relative: str | Path, *, missing: Any = None) -> Any:
    """Read a JSON file without creating it; missing optional files use missing."""
    target = safe_path(root, relative)
    try:
        with target.open("r", encoding="utf-8") as source:
            return json.load(source, parse_constant=_reject_constant)
    except FileNotFoundError:
        return missing
    except (OSError, UnicodeError, ValueError) as exc:
        raise DataError(f"Cannot read {target}: {exc}") from exc


_MISSING = object()


def store_backend(root: Path) -> str:
    """Return "file", "sqlite" or "doltlite" from storage.json (missing = file).

    Mirrors src/store/marker.ts readMarker: same checks, same order.
    """
    marker = read_json(root, "storage.json", missing=_MISSING)
    if marker is _MISSING:
        return "file"
    if not isinstance(marker, dict):
        raise DataError("storage.json: the storage marker is not an object")
    layout, backend = marker.get("layout"), marker.get("backend")
    is_number = isinstance(layout, (int, float)) and not isinstance(layout, bool)
    is_integer = is_number and (isinstance(layout, int) or float(layout).is_integer())
    if is_integer and layout > 1:
        raise DataError(f"storage.json: storage layout {layout} is newer than this skill supports (1); upgrade the skill")
    if not is_integer or layout < 1:
        raise DataError(f"storage.json: unsupported layout {json.dumps(layout)} (this skill supports 1)")
    if backend not in ("file", "sqlite", "doltlite"):
        raise DataError(f"storage.json: unknown backend {json.dumps(backend)}")
    return backend


def _stamp(*paths: Path) -> tuple:
    out = []
    for path in paths:
        try:
            info = path.stat()
            out.append((info.st_size, info.st_mtime_ns))
        except FileNotFoundError:
            out.append((0, 0))  # a vanished WAL counts as size 0
    return tuple(out)


def read_sqlite(root: Path, name: str, callback: Callable[[sqlite3.Connection], Any]) -> Any:
    """Run callback(connection) on a snapshot of a data-relative SQLite store.

    Never writes in the data folder. Why not plain ?mode=ro: probing SQLite 3.50
    showed it creates -wal/-shm beside a cleanly closed WAL store and touches
    -shm on a live one; ?immutable=1 avoids that but ignores the WAL, so a
    non-empty WAL is read from a private copy instead.
    """
    store = safe_path(root, name)
    wal = safe_path(root, name + "-wal")
    if not store.is_file():
        raise DataError(f"Store not found: {store}; nothing was created.")
    for _ in range(5):
        before = _stamp(store, wal)
        try:
            if before[1][0] == 0:
                connection = sqlite3.connect(store.as_uri() + "?mode=ro&immutable=1", uri=True)
                try:
                    result = callback(connection)
                finally:
                    connection.close()
            else:
                with tempfile.TemporaryDirectory(prefix="lh-read-") as scratch:
                    copy = Path(scratch) / store.name
                    shutil.copyfile(store, copy)
                    shutil.copyfile(wal, Path(scratch) / (store.name + "-wal"))
                    connection = sqlite3.connect(str(copy))
                    try:
                        result = callback(connection)
                    finally:
                        connection.close()
        except sqlite3.Error as exc:
            if _stamp(store, wal) == before:
                raise DataError(f"Cannot read {store}: {exc}") from exc
            result = _MISSING  # a copy torn by a concurrent write: treat as moving
        except OSError as exc:
            if not store.is_file():
                raise DataError(f"Cannot read {store}: {exc}") from exc
            result = _MISSING  # WAL vanished mid-copy (checkpoint): treat as moving
        if result is not _MISSING and _stamp(store, wal) == before:
            return result
    raise DataError(f"{store.name} is changing: LearnHarness is writing to it. Try again in a moment.")


def read_chat(root: Path, session_id: str) -> dict[str, Any]:
    """Read a native v1 session; refuse unsupported formats rather than migrate."""
    if not session_id or session_id in {".", ".."} or any(char in session_id for char in ("/", "\\", "\x00")):
        raise DataError("Use a session ID from sessions.py list, not a filesystem path.")
    relative = Path("chats") / f"{session_id}.json"
    record = read_json(root, relative)
    if record is None:
        raise DataError(f"Session not found: {session_id} (under {root / 'chats'}).")
    if not isinstance(record, dict):
        raise DataError(f"Session {session_id} is not a JSON object.")
    version = record.get("version", 1)
    if isinstance(version, bool) or not isinstance(version, (int, float)):
        raise DataError(f"Session {session_id} has an invalid version; this reader supports native format 1.")
    if version > 1:
        raise DataError(f"Session {session_id} uses format {version}; this reader supports 1. Update the skill; no migration was attempted.")
    if record.get("id") != session_id:
        raise DataError(f"Session filename/ID mismatch: {session_id}.")
    if not all(isinstance(record.get(key), str) for key in ("title", "createdAt", "updatedAt")):
        raise DataError(f"Session {session_id} is missing string title/date metadata.")
    messages = record.get("messages")
    if not isinstance(messages, list):
        raise DataError(f"Session {session_id} has no native message array.")
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            raise DataError(f"Session {session_id}, message {index}: unsupported message shape.")
        if "parts" in message and "content" not in message:
            raise DataError(f"Session {session_id} uses the older UIMessage/parts format. This skill reads native v1 records only; inspect the source JSON read-only.")
    return record


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    """Common CLI options precede the subcommand, as shown in SKILL.md."""
    parser.add_argument("--data-dir", metavar="PATH", help="LearnHarness data root (contains chats/ and/or graph/); default: normal desktop location")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown", help="Output format (default: markdown)")


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
