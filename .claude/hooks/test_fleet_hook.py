#!/usr/bin/env python3
"""Tests for fleet-hook.py: runs the script as a subprocess with python3 -I."""
import json
import os
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fleet-hook.py")


class HookTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = os.path.realpath(self._tmp.name)
        self.wt = os.path.join(self.root, "wt")
        self.main = os.path.join(self.root, "main")
        os.makedirs(self.wt)
        os.makedirs(self.main)
        self.status_path = os.path.join(self.wt, "job", "hook-status.json")

    def marker(self, **over):
        data = {"ticket": "012", "slug": "demo", "kind": "session", "main": self.main}
        data.update(over)
        os.makedirs(os.path.join(self.wt, "job"), exist_ok=True)
        with open(os.path.join(self.wt, "job", "ticket.json"), "w") as f:
            json.dump(data, f)

    def run_hook(self, event=None, raw=None, **fields):
        if raw is None:
            payload = {"session_id": "s-1", "transcript_path": "/t/s-1.jsonl", "cwd": self.wt}
            payload.update(fields)
            if event is not None:
                payload["hook_event_name"] = event
            raw = json.dumps(payload)
        # Run from the root, not the worktree, so the script must honour input cwd.
        p = subprocess.run(["python3", "-I", HOOK], input=raw, capture_output=True,
                           text=True, cwd=self.root)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "")
        return p

    def status(self):
        with open(self.status_path) as f:
            return json.load(f)

    def test_no_marker_writes_nothing(self):
        self.run_hook("SessionStart")
        self.assertFalse(os.path.exists(os.path.join(self.wt, "job")))

    def test_session_start_creates_status(self):
        self.marker()
        self.run_hook("SessionStart")
        s = self.status()
        self.assertEqual(s["version"], 1)
        self.assertEqual(s["state"], "active")
        self.assertEqual(s["ticket"], "012")
        self.assertEqual(s["kind"], "session")
        self.assertEqual(s["sessionId"], "s-1")
        self.assertEqual(s["transcriptPath"], "/t/s-1.jsonl")
        self.assertRegex(s["startedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertIsNone(s["attention"])
        self.assertEqual(s["subagents"], [])

    def test_post_tool_use_updates_heartbeat(self):
        self.marker()
        self.run_hook("SessionStart")
        started = self.status()["startedAt"]
        self.run_hook("PostToolUse", tool_name="Bash")
        s = self.status()
        self.assertEqual(s["lastTool"], "Bash")
        self.assertTrue(s["lastActivityAt"])
        self.assertEqual(s["startedAt"], started)
        self.assertEqual(s["state"], "active")

    def test_subagent_stop_appends(self):
        self.marker()
        self.run_hook("SubagentStop", agent_type="tester")
        self.run_hook("SubagentStop")
        subs = self.status()["subagents"]
        self.assertEqual([x["type"] for x in subs], ["tester", "unknown"])
        self.assertTrue(subs[0]["stoppedAt"])
        self.assertEqual(self.status()["state"], "active")

    def test_subagent_stop_keeps_last_20(self):
        self.marker()
        for i in range(25):
            self.run_hook("SubagentStop", agent_type="a%d" % i)
        subs = self.status()["subagents"]
        self.assertEqual(len(subs), 20)
        self.assertEqual(subs[0]["type"], "a5")
        self.assertEqual(subs[-1]["type"], "a24")

    def test_stop_sets_idle(self):
        self.marker()
        self.run_hook("Stop")
        self.assertEqual(self.status()["state"], "idle")

    def test_notification_sets_attention(self):
        self.marker()
        self.run_hook("Notification", message="x" * 400)
        s = self.status()
        self.assertEqual(s["state"], "needs-attention")
        self.assertEqual(s["attention"], "x" * 300)

    def test_activity_clears_attention(self):
        self.marker()
        self.run_hook("Notification", message="need input")
        self.run_hook("PostToolUse", tool_name="Read")
        s = self.status()
        self.assertEqual(s["state"], "active")
        self.assertIsNone(s["attention"])

    def test_session_end_sets_ended(self):
        self.marker()
        self.run_hook("SessionEnd")
        self.assertEqual(self.status()["state"], "ended")

    def test_subagent_kind_from_marker(self):
        self.marker(kind="subagent", ticket="099")
        self.run_hook("Stop")
        s = self.status()
        self.assertEqual((s["kind"], s["ticket"]), ("subagent", "099"))

    def test_preserves_unowned_fields(self):
        self.marker()
        self.run_hook("SessionStart")
        s = self.status()
        s["extra"] = {"keep": True}
        with open(self.status_path, "w") as f:
            json.dump(s, f)
        self.run_hook("Stop")
        self.assertEqual(self.status()["extra"], {"keep": True})

    def test_corrupt_marker_exits_zero(self):
        os.makedirs(os.path.join(self.wt, "job"))
        with open(os.path.join(self.wt, "job", "ticket.json"), "w") as f:
            f.write("{not json")
        self.run_hook("SessionStart")
        self.assertFalse(os.path.exists(self.status_path))

    def test_missing_main_path(self):
        self.marker(main=os.path.join(self.root, "nope"))
        self.run_hook("SessionStart")
        self.assertEqual(self.status()["state"], "active")
        self.assertFalse(os.path.exists(os.path.join(self.root, "nope")))

    def test_garbage_stdin(self):
        self.marker()
        self.run_hook(raw="not json")
        self.assertFalse(os.path.exists(self.status_path))

    def test_unknown_event_ignored(self):
        self.marker()
        self.run_hook("PreCompact")
        self.assertFalse(os.path.exists(self.status_path))
        self.run_hook("Stop")
        before = self.status()
        self.run_hook("PreCompact")
        self.assertEqual(self.status(), before)

    def test_pre_tool_use_marks_tool_running(self):
        self.marker()
        self.run_hook("SessionStart")
        self.assertIsNone(self.status()["toolRunning"])
        self.run_hook("PreToolUse", tool_name="Bash")
        s = self.status()
        self.assertEqual(s["toolRunning"], "Bash")
        self.assertEqual(s["state"], "active")
        self.assertTrue(s["lastActivityAt"])
        self.assertIsNone(s["lastTool"])
        self.run_hook("SubagentStop", agent_type="tester")
        self.assertEqual(self.status()["toolRunning"], "Bash")
        self.run_hook("PostToolUse", tool_name="Bash")
        s = self.status()
        self.assertIsNone(s["toolRunning"])
        self.assertEqual(s["lastTool"], "Bash")

    def test_stop_clears_tool_running(self):
        self.marker()
        self.run_hook("PreToolUse", tool_name="Bash")
        self.run_hook("Stop")
        self.assertIsNone(self.status()["toolRunning"])

    def test_concurrent_hooks_lose_no_update(self):
        self.marker()
        self.run_hook("SessionStart")
        count = 12
        procs = []
        for i in range(count):
            raw = json.dumps({"session_id": "s-1", "cwd": self.wt, "hook_event_name": "SubagentStop",
                              "agent_type": "agent-%d" % i})
            p = subprocess.Popen(["python3", "-I", HOOK], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, cwd=self.root)
            p.stdin.write(raw)
            p.stdin.close()
            procs.append(p)
        for p in procs:
            self.assertEqual(p.wait(timeout=30), 0)
            p.stdout.close()
            p.stderr.close()
        types = sorted(e["type"] for e in self.status()["subagents"])
        self.assertEqual(types, sorted("agent-%d" % i for i in range(count)))
        self.assertFalse(os.path.exists(os.path.join(self.main, "job", "logs", "fleet-hook.log")))

    def test_atomic_write(self):
        self.marker()
        self.run_hook("SessionStart")
        self.run_hook("PostToolUse", tool_name="Bash")
        leftovers = [n for n in os.listdir(os.path.join(self.wt, "job")) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_write_failure_logs_to_main(self):
        self.marker()
        os.makedirs(self.status_path)  # a directory where the file should go
        self.run_hook("Stop")
        log = os.path.join(self.main, "job", "logs", "fleet-hook.log")
        with open(log) as f:
            lines = f.read().splitlines()
        self.assertEqual(len(lines), 1)
        leftovers = [n for n in os.listdir(os.path.join(self.wt, "job")) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_marker_found_from_subdirectory(self):
        self.marker()
        sub = os.path.join(self.wt, "a", "b")
        os.makedirs(sub)
        self.run_hook("PostToolUse", cwd=sub, tool_name="Bash")
        self.assertEqual(self.status()["lastTool"], "Bash")
        self.assertFalse(os.path.exists(os.path.join(sub, "job")))

    def test_marker_in_git_root_dir_is_found(self):
        self.marker()
        os.makedirs(os.path.join(self.wt, ".git"))
        sub = os.path.join(self.wt, "a")
        os.makedirs(sub)
        self.run_hook("Stop", cwd=sub)
        self.assertEqual(self.status()["state"], "idle")

    def test_git_boundary_stops_walk(self):
        self.marker()
        inner = os.path.join(self.wt, "a")
        sub = os.path.join(inner, "b")
        os.makedirs(sub)
        with open(os.path.join(inner, ".git"), "w") as f:  # worktree-style .git file
            f.write("gitdir: x")
        self.run_hook("Stop", cwd=sub)
        self.assertFalse(os.path.exists(self.status_path))

    def test_no_marker_anywhere_in_subdirectory(self):
        sub = os.path.join(self.wt, "a", "b")
        os.makedirs(sub)
        self.run_hook("Stop", cwd=sub)
        self.assertFalse(os.path.exists(os.path.join(self.wt, "job")))
        self.assertFalse(os.path.exists(os.path.join(sub, "job")))

    def test_notification_types(self):
        self.marker()
        for t in ("permission_prompt", "idle_prompt", "agent_needs_input", "elicitation_dialog"):
            self.run_hook("Notification", message="m", notification_type=t)
            s = self.status()
            self.assertEqual((s["state"], s["attentionType"]), ("needs-attention", t))
        self.run_hook("Notification", message="m")
        s = self.status()
        self.assertEqual(s["state"], "needs-attention")
        self.assertIsNone(s["attentionType"])

    def test_notification_other_types_ignored(self):
        self.marker()
        self.run_hook("Stop")
        before = self.status()
        for t in ("agent_completed", "auth_success"):
            self.run_hook("Notification", message="m", notification_type=t)
            self.assertEqual(self.status(), before)

    def test_activity_clears_attention_type(self):
        self.marker()
        self.run_hook("Notification", message="m", notification_type="idle_prompt")
        self.run_hook("PostToolUse", tool_name="Read")
        s = self.status()
        self.assertIsNone(s["attention"])
        self.assertIsNone(s["attentionType"])

    def test_subagent_stop_empty_type_ignored(self):
        self.marker()
        self.run_hook("Stop")
        before = self.status()
        self.run_hook("SubagentStop", agent_type="")
        self.assertEqual(self.status(), before)

    def test_session_start_source_controls_started_at(self):
        self.marker()
        self.run_hook("SessionStart", source="startup")
        s = self.status()
        s["startedAt"] = "2020-01-01T00:00:00Z"
        with open(self.status_path, "w") as f:
            json.dump(s, f)
        for src in ("resume", "clear", "compact", "fork"):
            self.run_hook("SessionStart", source=src)
            self.assertEqual(self.status()["startedAt"], "2020-01-01T00:00:00Z", src)
        self.run_hook("SessionStart")  # missing source resets
        self.assertNotEqual(self.status()["startedAt"], "2020-01-01T00:00:00Z")
        s = self.status()
        s["startedAt"] = "2020-01-01T00:00:00Z"
        with open(self.status_path, "w") as f:
            json.dump(s, f)
        self.run_hook("SessionStart", source="startup")
        self.assertNotEqual(self.status()["startedAt"], "2020-01-01T00:00:00Z")

    def test_session_start_resume_without_file_sets_started_at(self):
        self.marker()
        self.run_hook("SessionStart", source="resume")
        self.assertTrue(self.status()["startedAt"])


if __name__ == "__main__":
    unittest.main()
