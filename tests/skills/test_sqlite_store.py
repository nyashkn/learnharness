"""Read-only SQLite/DoltLite-folder tests for the skill readers; stdlib only.

Stores are built at test time from the DDL in the app's first graph rung, so no
binary fixtures are committed. "Tree snapshot" = every file's name, bytes and
st_mtime_ns under the data dir.
"""

import contextlib
import io
import json
import os
from pathlib import Path
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "learnharness" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _data
import graph
import sessions

GOLDEN = ROOT / "tests" / "fixtures" / "golden-data"
SCHEMAS = ROOT / "docs" / "architecture" / "schemas"
DDL = re.search(r"db\.exec\(`(.*?)`\)", (ROOT / "src/store/sql/migrations/graph/0001_init.ts").read_text(encoding="utf-8"), re.S).group(1)
DOLT_HINT = "run pnpm run lh -- export"


def snapshot(root):
    out = {}
    for path in sorted(Path(root).rglob("*")):
        rel = str(path.relative_to(root))
        if path.is_symlink():
            out[rel] = ("link", os.readlink(path))
        elif path.is_file():
            out[rel] = (path.read_bytes(), path.stat().st_mtime_ns)
        else:
            out[rel] = None
    return out


def make_store(root, nodes=(), chains=(), sources=None, line_format="1", name="graph.sqlite"):
    """Create a WAL-mode store, then close it cleanly (WAL checkpointed and removed)."""
    root = Path(root)
    (root / "chats").mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / name)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(DDL)
    db.execute("INSERT INTO lh_meta VALUES ('store_kind', 'graph')")
    if line_format is not None:
        db.execute("INSERT INTO lh_meta VALUES ('line_format', ?)", (line_format,))
    db.executemany("INSERT INTO ledger_nodes(line_json) VALUES (?)", [(n if isinstance(n, str) else json.dumps(n),) for n in nodes])
    db.executemany("INSERT INTO ledger_chains(line_json) VALUES (?)", [(c if isinstance(c, str) else json.dumps(c),) for c in chains])
    db.executemany("INSERT INTO sources VALUES (?, ?)", [(k, v if isinstance(v, str) else json.dumps(v)) for k, v in (sources or {}).items()])
    db.commit()
    db.close()


def marker(root, backend="sqlite", layout=1):
    (Path(root) / "storage.json").write_text(json.dumps({"backend": backend, "layout": layout}), encoding="utf-8")


def writer(root, name="graph.sqlite"):
    """A live writer: WAL mode, autocheckpoint off, so commits stay in the -wal."""
    db = sqlite3.connect(Path(root) / name, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA wal_autocheckpoint=0")
    return db


def add_node(db, record):
    db.execute("INSERT INTO ledger_nodes(line_json) VALUES (?)", (json.dumps(record),))


def point(chat, message=""):
    return {"chatId": chat, "messageId": message}


def node(identifier, session="s1", **updates):
    value = {"id": identifier, "name": f"Name {identifier}", "statement": f"Statement {identifier}",
             "aliases": [], "createdAt": "2026-01-01T00:00:00Z", "provenance": [point(session)]}
    value.update(updates)
    return value


def chain(identifier, premises, conclusion, session="s1", **updates):
    value = {"id": identifier, "premises": premises, "conclusion": conclusion,
             "createdAt": "2026-01-02T00:00:00Z", "provenance": [point(session)]}
    value.update(updates)
    return value


def run_main(module, root, *args, fmt="json"):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        status = module.main(["--data-dir", str(root), "--format", fmt, *args])
    return status, out.getvalue(), err.getvalue()


def records(root, *args):
    status, out, err = run_main(graph, root, *args)
    assert status == 0, err
    return json.loads(out)["records"]


class Base(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.tmp = Path(temp.name).resolve()
        self.root = self.tmp / "data"
        self.root.mkdir()

    def cli(self, script, root, *args, sandbox=None):
        env = dict(os.environ)
        if sandbox is not None:
            env["TMPDIR"] = str(sandbox)
        return subprocess.run([sys.executable, "-B", str(SCRIPTS / script), "--data-dir", str(root), "--format", "json", *args],
                              capture_output=True, text=True, env=env, cwd=self.tmp)

    def sandbox(self):
        path = self.tmp / "sandbox"
        path.mkdir(exist_ok=True)
        return path

    def assert_clean_failure(self, proc, text=None):
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("Traceback", proc.stderr)
        if text:
            self.assertIn(text, proc.stderr)


class MarkerTests(Base):  # (a)
    def backend(self, text):
        (self.root / "storage.json").write_text(text, encoding="utf-8")
        return _data.store_backend(self.root)

    def test_accepted(self):
        self.assertEqual(_data.store_backend(self.root), "file")
        for backend in ("file", "sqlite", "doltlite"):
            self.assertEqual(self.backend(json.dumps({"backend": backend, "layout": 1})), backend)
        self.assertEqual(self.backend('{"backend":"sqlite","layout":1.0}'), "sqlite")

    def test_refused(self):
        cases = {
            "invalid json": ("{nope", "Cannot read"),
            "non-object": ("[1]", "not an object"),
            "null": ("null", "not an object"),
            "layout 2": ('{"backend":"sqlite","layout":2}', "newer than this skill supports"),
            "huge layout": ('{"backend":"sqlite","layout":1' + "0" * 400 + "}", "newer than this skill supports"),
            "layout 0": ('{"backend":"sqlite","layout":0}', "unsupported layout"),
            "layout 1.5": ('{"backend":"sqlite","layout":1.5}', "unsupported layout"),
            "layout inf": ('{"backend":"sqlite","layout":1e999}', "unsupported layout"),
            "layout true": ('{"backend":"sqlite","layout":true}', "unsupported layout"),
            "layout string": ('{"backend":"sqlite","layout":"1"}', "unsupported layout"),
            "missing layout": ('{"backend":"sqlite"}', "unsupported layout"),
            "unknown backend": ('{"backend":"postgres","layout":1}', "unknown backend"),
            "missing backend": ('{"layout":1}', "unknown backend"),
        }
        for label, (text, expected) in cases.items():
            with self.subTest(label), self.assertRaises(_data.DataError) as caught:
                self.backend(text)
            self.assertIn(expected, str(caught.exception))


class ParityTests(Base):  # (b)
    COMMANDS = [("sessions",), ("propositions",), ("propositions", "--session", "ch_one"), ("find", "learn"), ("find", "*a*"), ("chains",), ("chains", "--node", "n_two")]

    def lines(self, name):
        return (GOLDEN / "graph" / name).read_text(encoding="utf-8").splitlines()

    def build_pair(self, node_lines, chain_lines, sources, chats=None):
        file_root, sql_root = self.tmp / "file", self.tmp / "sql"
        (file_root / "graph").mkdir(parents=True)
        (file_root / "graph" / "nodes.jsonl").write_text("".join(l + "\n" for l in node_lines), encoding="utf-8")
        (file_root / "graph" / "chains.jsonl").write_text("".join(l + "\n" for l in chain_lines), encoding="utf-8")
        (file_root / "graph" / "sources.json").write_text(json.dumps(sources), encoding="utf-8")
        make_store(sql_root, node_lines, chain_lines, sources)
        marker(sql_root)
        if chats:
            for r in (file_root, sql_root):
                shutil.copytree(chats, r / "chats", dirs_exist_ok=True)
        return file_root, sql_root

    def test_golden(self):
        sources = json.loads((GOLDEN / "graph" / "sources.json").read_text(encoding="utf-8"))
        file_root, sql_root = self.build_pair(self.lines("nodes.jsonl"), self.lines("chains.jsonl"), sources, GOLDEN / "chats")
        self.assertTrue(records(file_root, "propositions"), "golden fixture must not be empty")
        for fmt_args in self.COMMANDS:
            with self.subTest(fmt_args):
                self.assertEqual(records(sql_root, *fmt_args), records(file_root, *fmt_args))
        for command in ("sessions", "propositions", "chains"):  # markdown goes through load_metadata too
            a, b = run_main(graph, file_root, command, fmt="markdown"), run_main(graph, sql_root, command, fmt="markdown")
            self.assertEqual(a[0], b[0])
            self.assertEqual(a[1].replace(str(file_root.resolve()), "R"), b[1].replace(str(sql_root.resolve()), "R"))

    def gen_ledger(self, rng):
        ids = [f"n{i}" for i in range(rng.randint(1, 5))]
        words = ["alpha", "beta", "", "Café", "x y", "ſ"]
        points = [point(f"c{rng.randint(0, 3)}", rng.choice(["", "m1", "m2"])) for _ in range(6)]
        nodes, chains = [], []
        for _ in range(rng.randint(0, 12)):
            roll = rng.random()
            record = node(rng.choice(ids), name=rng.choice(words), statement=rng.choice(words),
                          aliases=[rng.choice(words) for _ in range(rng.randint(0, 3))],
                          provenance=[rng.choice(points) for _ in range(rng.randint(0, 3))])
            nodes.append(json.dumps(record) if roll > 0.2 else rng.choice(["{broken", json.dumps({**record, "name": 5}), "   ", "[]", '{"id":NaN}']))
        for _ in range(rng.randint(0, 8)):
            record = chain(f"a{rng.randint(0, 3)}", [rng.choice(ids) for _ in range(rng.randint(0, 3))], rng.choice(ids),
                           provenance=[rng.choice(points) for _ in range(rng.randint(0, 2))])
            chains.append(json.dumps(record))
            if rng.random() < 0.3:
                chains.append(json.dumps({**record, "id": "dup"}))
        sources = {f"c{i}": {"id": f"c{i}", "filePath": f"/p/{i}.md", "importedAt": f"2026-0{i + 1}-01"} for i in range(rng.randint(0, 3))}
        if rng.random() < 0.3:
            sources["bad"] = {"id": 5}
        return nodes, chains, sources

    def test_seeded_property(self):  # (c)
        for seed in range(200):
            nodes, chains, sources = self.gen_ledger(random.Random(seed))
            file_root, sql_root = self.tmp / f"f{seed}", self.tmp / f"s{seed}"
            (file_root / "graph").mkdir(parents=True)
            (file_root / "graph" / "nodes.jsonl").write_text("".join(l + "\n" for l in nodes), encoding="utf-8")
            (file_root / "graph" / "chains.jsonl").write_text("".join(l + "\n" for l in chains), encoding="utf-8")
            (file_root / "graph" / "sources.json").write_text(json.dumps(sources), encoding="utf-8")
            make_store(sql_root, nodes, chains, sources)
            marker(sql_root)
            for command in (("propositions",), ("chains",), ("sessions",)):
                a, b = run_main(graph, file_root, *command), run_main(graph, sql_root, *command)
                self.assertEqual((a[0], json.loads(a[1])["records"]), (b[0], json.loads(b[1])["records"]), f"seed={seed} {command}")


class SqlBehaviourTests(Base):
    def test_seq_order_defines_identity(self):  # (d)
        make_store(self.root)
        db = sqlite3.connect(self.root / "graph.sqlite")
        for seq, label in ((3, "Third"), (1, "First"), (2, "Second")):
            db.execute("INSERT INTO ledger_nodes VALUES (?, ?)", (seq, json.dumps(node("n1", name=label, statement=f"S-{label}", createdAt=f"c{seq}"))))
        db.commit(); db.close()
        marker(self.root)
        [result] = records(self.root, "propositions")
        self.assertEqual((result["name"], result["statement"], result["createdAt"], result["aliases"]), ("First", "S-First", "c1", ["S-Second", "S-Third"]))

    def test_wal_only_node_visible(self):  # (f)
        make_store(self.root, [node("n_base", name="In main file")])
        marker(self.root)
        db = writer(self.root)
        add_node(db, node("n_wal", name="Only In WAL"))
        self.addCleanup(db.close)
        self.assertGreater((self.root / "graph.sqlite-wal").stat().st_size, 0)
        self.assertEqual([r["name"] for r in records(self.root, "propositions")], ["In main file", "Only In WAL"])

    def test_odd_paths(self):  # (g)
        for dirname in ("a b", "h#ash", "q?mark", "p%20ct"):
            with self.subTest(dirname):
                root = self.tmp / dirname
                make_store(root, [node("n1", name="Clean")])
                marker(root)
                self.assertEqual([r["name"] for r in records(root, "propositions")], ["Clean"])
                db = writer(root)
                add_node(db, node("n2", name="Live"))
                try:
                    self.assertEqual([r["name"] for r in records(root, "propositions")], ["Clean", "Live"])
                finally:
                    db.close()

    def test_leftover_jsonl_ignored(self):  # (j)
        make_store(self.root, [node("n_sql", name="From SQL")])
        marker(self.root)
        (self.root / "graph").mkdir()
        (self.root / "graph" / "nodes.jsonl").write_text(json.dumps(node("n_file", name="From JSONL")) + "\n", encoding="utf-8")
        (self.root / "graph" / "sources.json").write_text("not json", encoding="utf-8")
        (self.root / "graph" / "format.json").write_text('{"version": 99}', encoding="utf-8")
        self.assertEqual([r["name"] for r in records(self.root, "propositions")], ["From SQL"])
        self.assertEqual(run_main(graph, self.root, "propositions", fmt="markdown")[0], 0)

    def test_warning_labels(self):
        make_store(self.root, ["{oops", node("n1")], ["[]"], {"s": "{bad"})
        marker(self.root)
        status, out, err = run_main(graph, self.root, "propositions")
        self.assertEqual(status, 0)
        self.assertIn("graph.sqlite:ledger_nodes:1: malformed JSON", err)
        self.assertIn("graph.sqlite:ledger_chains:1: invalid record shape", err)
        self.assertIn("graph.sqlite:sources:s: malformed JSON", err)


class ReadOnlyTests(Base):  # (e)
    def check_unchanged(self, root, expect_names, *, sandbox=None):
        sandbox = sandbox or self.sandbox()
        before = snapshot(root)
        for script, args in (("graph.py", ("propositions",)), ("graph.py", ("sessions",)), ("sessions.py", ("list",))):
            proc = self.cli(script, root, *args, sandbox=sandbox)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            if args == ("propositions",):
                self.assertEqual([r["name"] for r in json.loads(proc.stdout)["records"]], expect_names)
        self.assertEqual(snapshot(root), before)
        self.assertEqual(list(sandbox.iterdir()), [], "read left files in TMPDIR")

    def test_cleanly_closed(self):
        make_store(self.root, [node("n1", name="One")])
        marker(self.root)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["chats", "graph.sqlite", "storage.json"])
        self.check_unchanged(self.root, ["One"])

    def test_live_writer_with_wal(self):
        make_store(self.root, [node("n1", name="One")])
        marker(self.root)
        db = writer(self.root)
        self.addCleanup(db.close)
        add_node(db, node("n2", name="Two"))
        self.assertGreater((self.root / "graph.sqlite-wal").stat().st_size, 0)
        self.check_unchanged(self.root, ["One", "Two"])

    def crash_copy(self, with_shm):
        make_store(self.root, [node("n1", name="One")])
        db = writer(self.root)
        try:
            add_node(db, node("n2", name="Two"))
            crash = self.tmp / "crash"
            (crash / "chats").mkdir(parents=True)
            for suffix in ("", "-wal", "-shm") if with_shm else ("", "-wal"):
                shutil.copyfile(self.root / f"graph.sqlite{suffix}", crash / f"graph.sqlite{suffix}")
        finally:
            db.close()
        marker(crash)
        return crash

    def test_crash_state_with_shm(self):
        crash = self.crash_copy(True)
        self.assertTrue((crash / "graph.sqlite-shm").exists())
        self.check_unchanged(crash, ["One", "Two"])

    def test_wal_without_shm(self):
        crash = self.crash_copy(False)
        self.assertFalse((crash / "graph.sqlite-shm").exists())
        self.check_unchanged(crash, ["One", "Two"])

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores directory modes")
    def test_read_only_directory(self):
        make_store(self.root, [node("n1", name="One")])
        marker(self.root)
        db = writer(self.root)
        add_node(db, node("n2", name="Two"))
        self.root.chmod(0o500)
        self.addCleanup(lambda: self.root.chmod(0o700))
        self.addCleanup(db.close)
        self.check_unchanged(self.root, ["One", "Two"])
        db.close()
        self.root.chmod(0o700)
        self.root.chmod(0o500)  # now cleanly closed: the -wal is gone
        self.check_unchanged(self.root, ["One", "Two"])


class ErrorTests(Base):  # (h)
    def check(self, text=None):
        before = snapshot(self.root)
        proc = self.cli("graph.py", self.root, "propositions")
        self.assert_clean_failure(proc, text)
        self.assertEqual(snapshot(self.root), before)

    def test_missing_store(self):
        marker(self.root)
        self.check("graph.sqlite")
        self.assertFalse((self.root / "graph.sqlite").exists())

    def test_garbage_store(self):
        marker(self.root)
        (self.root / "graph.sqlite").write_bytes(b"this is not a database " * 200)
        self.check("graph.sqlite")

    def test_newer_line_format(self):
        make_store(self.root, line_format="2"); marker(self.root)
        self.check("newer than supported version 1; upgrade this skill")

    def test_missing_line_format(self):
        make_store(self.root, line_format=None); marker(self.root)
        self.check("line_format")

    def test_non_integer_line_format(self):
        make_store(self.root, line_format="1.5"); marker(self.root)
        self.check("invalid graph format version")

    def test_missing_tables(self):
        sqlite3.connect(self.root / "graph.sqlite").close()
        marker(self.root)
        self.check("graph.sqlite")

    def test_symlink_escape(self):
        outside = self.tmp / "outside"
        make_store(outside, [node("n1")])
        os.symlink(outside / "graph.sqlite", self.root / "graph.sqlite")
        marker(self.root)
        self.check("outside the selected data folder")

    def test_bad_marker_refuses_both_scripts(self):
        marker(self.root, layout=2)
        self.check("newer than this skill supports")
        self.assert_clean_failure(self.cli("sessions.py", self.root, "list"), "newer than this skill supports")


class DoltTests(Base):  # (i)
    def test_garbage_dolt_store(self):
        marker(self.root, "doltlite")
        (self.root / "graph.doltlite").write_bytes(b"\x00garbage" * 50)
        (self.root / "graph").mkdir()
        (self.root / "graph" / "nodes.jsonl").write_text(json.dumps(node("n1", name="Leftover")) + "\n", encoding="utf-8")
        before = snapshot(self.root)
        proc = self.cli("graph.py", self.root, "propositions")
        self.assert_clean_failure(proc, DOLT_HINT)
        self.assertIn("--data-dir", proc.stderr)
        self.assertNotIn("Leftover", proc.stdout + proc.stderr)
        self.assertEqual(snapshot(self.root), before)

    def test_dolt_without_file_still_refuses(self):
        marker(self.root, "doltlite")
        proc = self.cli("graph.py", self.root, "sessions")
        self.assert_clean_failure(proc, DOLT_HINT)
        self.assertEqual(list(self.root.iterdir()), [self.root / "storage.json"])


class MovingStoreTests(Base):  # (k)
    def setUp(self):
        super().setUp()
        make_store(self.root, [node("n1", name="One")])
        marker(self.root)
        self.db = writer(self.root)
        self.addCleanup(self.db.close)
        add_node(self.db, node("n2", name="Two"))
        self.real = shutil.copyfile

    def moving(self, limit):
        calls = {"n": 0}
        def fake(src, dst, **kw):
            result = self.real(src, dst, **kw)
            calls["n"] += 1
            if calls["n"] <= limit:
                add_node(self.db, node(f"late{calls['n']}", name=f"Late{calls['n']}"))
            return result
        return calls, mock.patch.object(_data.shutil, "copyfile", fake)

    def test_retry_then_success(self):
        calls, patch = self.moving(1)
        with patch:
            names = [n["name"] for n in graph.load_graph(self.root)["nodes"]]
        self.assertEqual(names, ["One", "Two", "Late1"])
        self.assertGreater(calls["n"], 2)

    def test_torn_copy_retries(self):
        calls = {"n": 0}
        def fake(src, dst, **kw):
            result = self.real(src, dst, **kw)
            calls["n"] += 1
            if calls["n"] == 1:  # a checkpoint landed mid-copy: the copy is unreadable and the store moved
                Path(dst).write_bytes(b"torn, not a database" * 300)
                add_node(self.db, node("late", name="Late"))
            return result
        with mock.patch.object(_data.shutil, "copyfile", fake):
            names = [n["name"] for n in graph.load_graph(self.root)["nodes"]]
        self.assertEqual(names, ["One", "Two", "Late"])

    def test_always_moving(self):
        _, patch = self.moving(10**6)
        with patch, self.assertRaises(_data.DataError) as caught:
            graph.load_graph(self.root)
        self.assertIn("LearnHarness is writing", str(caught.exception))
        self.assertIn("Try again", str(caught.exception))


def evaluate(schema, value):
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return False
        if any(key not in value for key in schema.get("required", [])):
            return False
        return all(evaluate(sub, value[key]) for key, sub in schema.get("properties", {}).items() if key in value)
    if kind == "array":
        if not isinstance(value, list) or len(value) < schema.get("minItems", 0):
            return False
        return "items" not in schema or all(evaluate(schema["items"], item) for item in value)
    if kind == "string":
        return isinstance(value, str)
    raise AssertionError(f"evaluator does not support {kind}")


@unittest.skipUnless(SCHEMAS.is_dir(), "run from the repository to check the JSON Schemas")
class SchemaConformanceTests(unittest.TestCase):  # (l)
    def test_valid_record_matches_schemas(self):
        schemas = {False: json.loads((SCHEMAS / "node-line.json").read_text()), True: json.loads((SCHEMAS / "chain-line.json").read_text())}
        junk = [1, None, [], {}, True, "x", 1.5]
        for seed in range(200):
            rng = random.Random(seed)
            is_chain = rng.random() < 0.5
            pts = [{**point(f"c{rng.randint(0, 2)}", "m"), **({"extra": 1} if rng.random() < .3 else {})} for _ in range(rng.randint(0, 3))]
            record = chain("a1", [f"n{i}" for i in range(rng.randint(1, 3))], "n9", provenance=pts) if is_chain else node("n1", aliases=["a"] * rng.randint(0, 2), provenance=pts)
            mutation = rng.choice(["none", "drop", "type", "empty", "extra", "badpoint", "badelem"])
            key = rng.choice(list(record))
            if mutation == "drop":
                del record[key]
            elif mutation == "type":
                record[key] = rng.choice(junk)
            elif mutation == "empty" and is_chain:
                record["premises"] = []
            elif mutation == "extra":
                record["extra"] = rng.choice(junk)
            elif mutation == "badpoint":
                record["provenance"] = record["provenance"] + [rng.choice([{"chatId": "c"}, {"messageId": "m"}, {"chatId": 1, "messageId": "m"}, "x", None])]
            elif mutation == "badelem":
                record["premises" if is_chain else "aliases"] = ["ok", rng.choice(junk[:5])]
            self.assertEqual(graph.valid_record(record, is_chain), evaluate(schemas[is_chain], record), f"seed={seed} mutation={mutation} record={record!r}")

    def test_literal_regressions(self):
        self.assertFalse(graph.valid_record(chain("a", [], "n"), True))
        self.assertTrue(graph.valid_record(node("n", extra=1)))


class SessionsTests(Base):  # (m)
    def write_chat(self):
        (self.root / "chats").mkdir()
        (self.root / "chats" / "c1.json").write_text(json.dumps({"id": "c1", "title": "Hello", "createdAt": "2026-01-01", "updatedAt": "2026-01-02", "messages": []}), encoding="utf-8")

    def test_sqlite_and_doltlite_folders(self):
        self.write_chat()
        for backend in ("sqlite", "doltlite"):
            with self.subTest(backend):
                marker(self.root, backend)
                status, out, err = run_main(sessions, self.root, "list")
                self.assertEqual((status, err), (0, ""))
                self.assertEqual([s["id"] for s in json.loads(out)["sessions"]], ["c1"])

    def test_newer_layout_refused(self):
        self.write_chat()
        marker(self.root, "sqlite", 2)
        status, out, err = run_main(sessions, self.root, "list")
        self.assertEqual(status, 1)
        self.assertIn("newer than this skill supports", err)


if __name__ == "__main__":
    unittest.main()
