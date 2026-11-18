"""Unit tests of the stage engine (wv-bin/wv-stage.py): python -m unittest tests.test_stages  (no network, no model, no real project)."""
import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "wv-bin"
_s = importlib.util.spec_from_file_location("wv_stage", BIN / "wv-stage.py")
S = importlib.util.module_from_spec(_s)
_s.loader.exec_module(S)

BOARD = "# Ticket Board\n\nStatus: x\n\n| #   | Title | Status | Mode | Runs |\n| --- | --- | --- | --- | --- |\n%s\n"
RD = "# T\n\n**Status:** draft\n%s\n\n## Screenshots\n%s\n"


class Calls:
    def __init__(self):
        self.log = []

    def design(self, root, tid):
        self.log.append(("design", tid))

    def review(self, root, tid, by, model):
        self.log.append(("review", tid, by, model))

    def deliver(self, root, tid):
        self.log.append(("deliver", tid))


def make(rows, mockup="", shots="- the button"):
    root = Path(tempfile.mkdtemp(prefix="wvstage-"))
    (root / "specs" / "tickets").mkdir(parents=True)
    (root / "job").mkdir()
    lines = []
    for tid, st, runs in rows:
        lines.append("| %s | Title %s | %s | solo | %s |" % (tid, tid, st, runs))
        d = root / "specs" / "tickets" / (tid + "-t")
        d.mkdir()
        (d / "rd.md").write_text(RD % (mockup, shots), encoding="utf-8")
    (root / "specs" / "tickets" / "BOARD.md").write_text(BOARD % "\n".join(lines), encoding="utf-8")
    return root


def status(root, tid):
    return S.row(str(root), tid)["status"]


class Suggest(unittest.TestCase):
    M = [{"id": "opencode-go/kimi-k2.7-code", "role": "worker", "worker": True}, {"id": "opencode-go/deepseek-v4-pro", "role": "reviewer"},
         {"id": "opencode-go/glm-5.3-flash", "role": "tester"}, {"id": "opencode-go/glm-5.3", "role": "router"}]

    def test_strongest_non_worker(self):
        self.assertEqual(S.suggest_reviewer(self.M, ["opencode-go"]), "opencode-go/deepseek-v4-pro")

    def test_provider_must_be_connected(self):
        self.assertIsNone(S.suggest_reviewer(self.M, ["other"]))
        m = self.M + [{"id": "anthropic/claude-opus-4", "role": ""}]
        self.assertEqual(S.suggest_reviewer(m, ["opencode-go", "anthropic"]), "anthropic/claude-opus-4")
        self.assertEqual(S.suggest_reviewer(m, ["opencode-go"]), "opencode-go/deepseek-v4-pro")

    def test_worker_only_falls_back_to_worker(self):
        self.assertEqual(S.suggest_reviewer([self.M[0]], None), "opencode-go/kimi-k2.7-code")
        self.assertIsNone(S.suggest_reviewer([], None))

    def test_never_flash_when_better_exists(self):
        self.assertNotIn("flash", S.suggest_reviewer([self.M[2], self.M[1]], None))

    def test_options_mark_one(self):
        cfg = {"models": {"worker": {"opencode": {"model": "opencode-go/kimi-k2.7-code"}}, "reviewer": {"opencode": {"model": "opencode-go/deepseek-v4-pro"}}}}
        o = S.review_options(cfg, False, ["opencode-go"], ["opencode-go/glm-5.3-flash"])
        self.assertEqual([m["suggested"] for m in o["models"]].count(True), 1)
        self.assertFalse(o["claude"]["enabled"])
        self.assertEqual(o["suggested"], "opencode-go/deepseek-v4-pro")


class Flow(unittest.TestCase):
    def test_happy_with_mockup(self):
        r = make([("001", "draft", "alongside")], mockup="**Mockup:** required")
        rr = str(r)
        c = Calls()
        self.assertEqual(S.act(rr, "001", "dispatch")[0], 200)
        self.assertEqual(status(r, "001"), "specifying")
        self.assertEqual(S.tick(rr, live=set()), [])  # the planner is still writing
        bp = r / "specs/tickets/BOARD.md"
        bp.write_text(bp.read_text().replace("| specifying", "| draft     "))  # the planner writes `draft` when its spec is done
        self.assertEqual(len(S.tick(rr, live=set(), hooks=c)), 1)
        self.assertEqual(status(r, "001"), "designing")
        S.act(rr, "001", "design", hooks=c)
        self.assertEqual(c.log, [("design", "001")])
        self.assertEqual(S.event(rr, "001", "design_done")[0], 200)
        self.assertEqual(status(r, "001"), "todo")
        S.act(rr, "001", "dispatch")
        self.assertEqual(status(r, "001"), "ready")
        S.set_status(rr, "001", "in-progress")
        S.event(rr, "001", "worker_done")
        self.assertEqual(status(r, "001"), "in-review")
        S.act(rr, "001", "review", {"by": "model", "model": "p/m"}, hooks=c)
        sc = r / "specs/tickets/001-t/delivery/screens"
        sc.mkdir(parents=True)
        (sc / "01.png").write_bytes(b"x")
        S.event(rr, "001", "review_result", {"state": "clean"}, hooks=c)
        self.assertEqual(status(r, "001"), "delivering")
        self.assertEqual(c.log[-1], ("deliver", "001"))
        S.event(rr, "001", "deliver_result", {"ok": True, "prUrl": "https://x/pr/1"})
        self.assertEqual(status(r, "001"), "done")
        self.assertEqual(S.load_sf(rr, "001")["prUrl"], "https://x/pr/1")

    def test_no_mockup_goes_to_todo_and_skip_design(self):
        r = make([("001", "specifying", "alongside"), ("002", "designing", "alongside")], mockup="**Mockup:** none")
        S.set_status(str(r), "001", "specifying", stage="plan")
        S.event(str(r), "001", "plan_done")
        self.assertEqual(status(r, "001"), "todo")
        S.act(str(r), "002", "skip_design")
        self.assertEqual(status(r, "002"), "todo")
        self.assertIn("Design skipped", S.read_rd(str(r), "002"))

    def test_dependency_blocks_dispatch(self):
        r = make([("001", "todo", "alongside"), ("002", "todo", "waits for 001: x")])
        code, body = S.act(str(r), "002", "dispatch")
        self.assertEqual(code, 409)
        self.assertIn("001", body["error"])
        t = S.annotate(str(r), [{"id": "002", "status": "todo", "runs": "waits for 001: x"}, {"id": "001", "status": "todo", "runs": "alongside"}])
        self.assertTrue(t[0]["actions"][0]["disabled"])
        S.set_status(str(r), "001", "done")
        self.assertEqual(S.act(str(r), "002", "dispatch")[0], 200)
        self.assertEqual(S.deps_of("after: 003, 005 - why"), ["003", "005"])

    def test_findings_fix_and_skip(self):
        r = make([("001", "in-review", "alongside"), ("002", "in-review", "alongside")])
        for t in ("001", "002"):
            S.act(str(r), t, "review", {"by": "claude"})
            S.event(str(r), t, "review_result", {"state": "findings", "findings": 2, "text": "1. bug A\n2. bug B"})
            self.assertTrue(S.load_sf(str(r), t)["ask"])
        S.act(str(r), "001", "fix")
        self.assertEqual((status(r, "001"), S.stage_of("ready", S.load_sf(str(r), "001"))), ("ready", "building"))
        self.assertIn("bug A", S.read_rd(str(r), "001"))
        S.act(str(r), "002", "skip_findings", hooks=Calls())
        self.assertEqual(status(r, "002"), "delivering")

    def test_missing_item_ask(self):
        r = make([("001", "in-review", "alongside"), ("002", "in-review", "alongside"), ("003", "in-review", "alongside")])
        for t in ("001", "002", "003"):
            S.act(str(r), t, "skip_review")
            self.assertEqual(S.load_sf(str(r), t)["ask"]["kind"], "missing")
            self.assertEqual(status(r, t), "delivering")
        c = Calls()
        S.act(str(r), "001", "missing", {"choice": "self"}, hooks=c)
        self.assertEqual(c.log, [("deliver", "001")])
        S.act(str(r), "002", "missing", {"choice": "ticket"})
        self.assertEqual(status(r, "002"), "ready")
        S.act(str(r), "003", "missing", {"choice": "done"})
        self.assertEqual(status(r, "003"), "done")

    def test_screens_present_delivers(self):
        r = make([("001", "in-review", "alongside")])
        sc = r / "specs/tickets/001-t/delivery/screens"
        sc.mkdir(parents=True)
        (sc / "01.png").write_bytes(b"x")
        c = Calls()
        S.act(str(r), "001", "skip_review", hooks=c)
        self.assertEqual(c.log, [("deliver", "001")])

    def test_reopen_from_done(self):
        r = make([("001", "done", "alongside")])
        self.assertEqual(S.act(str(r), "001", "note", {"note": ""})[0], 409)
        S.act(str(r), "001", "note", {"note": "there is a bug on save"})
        self.assertEqual(status(r, "001"), "ready")
        self.assertEqual(S.stage_of("ready", S.load_sf(str(r), "001")), "building")
        self.assertIn("there is a bug on save", S.read_rd(str(r), "001"))

    def test_needs_you_keeps_its_column(self):
        r = make([("001", "in-review", "alongside")])
        S.set_status(str(r), "001", "in-review")
        S.set_status(str(r), "001", "failed")
        self.assertEqual(S.stage_of("failed", S.load_sf(str(r), "001")), "review")
        t = S.annotate(str(r), [{"id": "001", "status": "failed", "runs": ""}])[0]
        self.assertTrue(t["needsYou"] and t["stage"] == "review")
        S.act(str(r), "001", "retry")
        self.assertEqual(status(r, "001"), "in-review")

    def test_worker_done_tick(self):
        r = make([("001", "in-progress", "alongside")])
        S.set_status(str(r), "001", "in-progress")
        d = r / "specs/tickets/001-t"
        self.assertEqual(S.tick(str(r), live=set()), [])
        time.sleep(1.1)
        (d / "results.json").write_text(json.dumps({"finishedAt": "2026-01-01T00:00:00Z"}))
        self.assertEqual(S.tick(str(r), live={"001"}), [])  # worker still live
        self.assertEqual(len(S.tick(str(r), live=set())), 1)
        self.assertEqual(status(r, "001"), "in-review")


class Guard(unittest.TestCase):
    def setUp(self):
        self.r = make([("001", "in-progress", "alongside"), ("002", "in-progress", "alongside")])
        self.root = str(self.r)
        S.set_status(self.root, "001", "in-progress")  # 002 stays a legacy ticket: no engine history
        self.later = time.time() + 60

    def board(self, tid, status):  # a board write by something that is not the engine
        bp = self.r / "specs/tickets/BOARD.md"
        bp.write_text(bp.read_text(encoding="utf-8").replace("| %s | Title %s | in-progress |" % (tid, tid), "| %s | Title %s | %s |" % (tid, tid, status)), encoding="utf-8")

    def test_foreign_stage_status_restored_and_logged(self):
        self.board("001", "done")
        self.assertEqual(S.guard(self.root, now_ts=self.later), ["001"])
        self.assertEqual(status(self.r, "001"), "in-progress")
        self.assertIn("001 board=done engine=in-progress", (self.r / "job/stage/violations.log").read_text(encoding="utf-8"))
        self.assertEqual(S.load_sf(self.root, "001")["status"], "in-progress")

    def test_legacy_ticket_never_flipped(self):
        self.board("002", "done")
        self.assertEqual(S.guard(self.root, now_ts=self.later), [])
        self.assertEqual(status(self.r, "002"), "done")
        self.assertFalse((self.r / "job/stage/violations.log").exists())

    def test_engine_and_other_statuses_left_alone(self):
        S.set_status(self.root, "001", "in-review")  # through the engine: sf matches
        self.assertEqual(S.guard(self.root, now_ts=self.later), [])
        S.set_status(self.root, "001", "in-progress")
        self.board("001", "blocked")  # not a stage-owned status: the worker's own flag
        self.assertEqual(S.guard(self.root, now_ts=self.later), [])
        self.assertEqual(status(self.r, "001"), "blocked")

    def test_grace_after_a_fresh_board_write(self):
        self.board("001", "done")
        self.assertEqual(S.guard(self.root), [])  # just written: a set_status caller may still be mid-write
        self.assertEqual(status(self.r, "001"), "done")

    def test_tick_runs_the_guard(self):
        import os
        self.board("001", "in-review")
        old = time.time() - 60
        os.utime(self.r / "specs/tickets/BOARD.md", (old, old))
        S.tick(self.root, live={"001"})
        self.assertEqual(status(self.r, "001"), "in-progress")


if __name__ == "__main__":
    unittest.main()
