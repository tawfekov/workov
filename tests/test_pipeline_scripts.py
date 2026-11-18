"""Standalone tests of the zero-token pipeline scripts (wv-bin/): python -m unittest tests.test_pipeline_scripts
Everything runs against a scratch HOME and a scratch fleet folder: no network, no model, no real project, no OpenCode."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "wv-bin"
BOARD = ("# Ticket Board\n\nStatus: x\n\n| #   | Title | Status | Mode | Runs |\n| --- | --- | --- | --- | --- |\n%s\n")
SCRIPTS = ["wv-adopt", "wv-busy", "wv-dispatch", "wv-gate", "wv-plan", "wv-ready", "wv-sessions", "wv-settle", "wv-stage", "wv-stop", "wv-turn"]


class Scratch(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / "home"
        self.root = Path(self._tmp.name) / "fleet"
        (self.home / ".workov").mkdir(parents=True)
        (self.root / "specs" / "tickets").mkdir(parents=True)
        (self.home / ".workov" / "fleets.json").write_text(json.dumps([{"name": "fx", "root": str(self.root).replace("\\", "/")}]))
        self.env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home), PYTHONDONTWRITEBYTECODE="1")

    def tearDown(self):
        self._tmp.cleanup()

    def ticket(self, num, slug, status, runs="alongside"):
        rows = (self.root / "specs" / "tickets" / "BOARD.md")
        old = rows.read_text() if rows.exists() else BOARD % ""
        rows.write_text(old.rstrip("\n") + "\n| %s | %s | %s | solo | %s |\n" % (num, slug, status, runs))
        d = self.root / "specs" / "tickets" / ("%s-%s" % (num, slug))
        d.mkdir(exist_ok=True)
        (d / "rd.md").write_text("# %s\n\n**Status:** %s\n" % (slug, status))

    def run_script(self, name, *args):
        return subprocess.run([sys.executable, str(BIN / (name + ".py")), *args], env=self.env, cwd=str(self.root),
                              capture_output=True, text=True, timeout=60)


class Scripts(Scratch):
    def test_every_script_compiles_and_loads(self):
        for n in SCRIPTS:
            spec = importlib.util.spec_from_file_location(n.replace("-", "_"), BIN / (n + ".py"))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)  # the scripts only act under __main__
            self.assertTrue(hasattr(mod, "main") or n == "wv-stage", n)

    def test_ready_prints_a_ready_ticket(self):
        self.ticket("001", "alpha", "ready")
        r = self.run_script("wv-ready", str(self.root))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("001-alpha", r.stdout)

    def test_ready_ignores_tickets_that_are_not_ready(self):
        self.ticket("001", "alpha", "draft")
        self.ticket("002", "beta", "done")
        r = self.run_script("wv-ready", str(self.root))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, ""), r.stderr)

    def test_ready_waits_for_dependencies(self):
        self.ticket("001", "alpha", "todo")
        self.ticket("002", "beta", "ready", runs="waits for 001")
        r = self.run_script("wv-ready", str(self.root))
        self.assertNotIn("002-beta", r.stdout)
        self.ticket("003", "gamma", "done")
        self.ticket("004", "delta", "ready", runs="waits for 003")
        self.assertIn("004-delta", self.run_script("wv-ready", str(self.root)).stdout)

    def test_idle_fleet_has_no_turn_and_is_not_busy(self):
        self.ticket("001", "alpha", "draft")
        r = self.run_script("wv-turn", "--pick", "--peek")
        self.assertEqual(r.returncode, 1)
        r = self.run_script("wv-busy", str(self.root))
        self.assertEqual((r.returncode, r.stdout.strip()), (1, ""))

    def test_no_live_sessions_without_opencode(self):
        self.assertEqual(self.run_script("wv-sessions", "live").returncode, 1)
        self.assertEqual(self.run_script("wv-sessions", "reap", "--dry").returncode, 0)

    def test_dry_runs_change_nothing(self):
        self.ticket("001", "alpha", "ready")
        before = (self.root / "specs" / "tickets" / "BOARD.md").read_text()
        for name, args in (("wv-gate", ["--dry"]), ("wv-adopt", ["--dry"]), ("wv-plan", ["--dry"]), ("wv-dispatch", ["--dry"]),
                           ("wv-settle", ["--dry"])):
            r = self.run_script(name, *args)
            self.assertEqual(r.returncode, 0, "%s: %s" % (name, r.stderr))
            self.assertNotIn("Traceback", r.stderr, name)
        self.assertEqual((self.root / "specs" / "tickets" / "BOARD.md").read_text(), before)


if __name__ == "__main__":
    unittest.main()
