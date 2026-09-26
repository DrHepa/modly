"""Read-only Worlds CLI contract and secret-handling tests."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("modly_agent", Path(__file__).with_name("agent.py"))
agent = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(agent)


class WorldsCliTests(unittest.TestCase):
    def test_canonical_read_only_commands_exist_without_mutation_routes(self) -> None:
        parser = agent.build_parser()
        for argv in (["world", "pair"], ["world", "project", "list"],
                     ["world", "project", "open", "world-" + "a" * 32],
                     ["world", "query", "world-" + "a" * 32, "--revision", "3", "--kind", "scenes"]):
            with self.subTest(argv=argv):
                self.assertTrue(callable(parser.parse_args(argv).func))
        for argv in (["world", "plan", "world-" + "a" * 32, "--scene-id", "scene:one"],
                     ["world", "propose", "world-" + "a" * 32, "--plan", "plan_" + "a" * 48, "--json", "-"]):
            with self.subTest(argv=argv):
                self.assertTrue(callable(parser.parse_args(argv).func))
        for name in ("apply", "undo", "reject"):
            self.assertNotIn(name, parser.format_help())

    def test_pair_secret_is_tty_only_and_never_printed_or_placed_in_argv(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.chmod(root, 0o700)
            runtime = Path(root) / "modly-worlds-cli"
            runtime.mkdir(mode=0o700)
            code = "a" * 32
            token = "b" * 64
            buf = io.StringIO()
            with patch.object(agent, "_world_runtime_dir", return_value=runtime), \
                 patch.object(agent, "_world_require_tty"), \
                 patch.object(agent, "_world_pairing_code", return_value=code), \
                 patch.object(agent, "_world_wire", side_effect=[{"ok": True}, {"ok": True, "session": token, "scope": "worlds:read", "proposalScope": "worlds:auto-apply", "expiresAt": 100}]) as wire, \
                 redirect_stdout(buf):
                self.assertEqual(agent.main(["--compact", "world", "pair"]), 0)
            self.assertEqual(wire.call_args_list[0].args[1], {"operation": "pair.request"})
            self.assertEqual(wire.call_args_list[0].kwargs, {"timeout": 95})
            self.assertEqual(wire.call_args_list[1].args[1], {"operation": "pair", "code": code})
            self.assertNotIn(code, buf.getvalue())
            self.assertNotIn(token, buf.getvalue())
            self.assertTrue(json.loads(buf.getvalue())["paired"])
            self.assertEqual(json.loads(buf.getvalue())["proposalScope"], "worlds:auto-apply")
            self.assertEqual((runtime / "session.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((runtime / "session.json").read_text())["session"], token)

    def test_no_tty_pairing_fails_without_secret_or_fallback_to_stdin(self) -> None:
        with patch.object(agent, "_world_runtime_dir", return_value=Path("/unused")), \
             patch.object(agent, "_world_wire") as wire, \
             patch.object(agent, "_world_require_tty", side_effect=agent.ModlyCliError("Pair in an interactive terminal.", code="PAIRING_REQUIRES_TTY")):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(agent.main(["--compact", "world", "pair"]), 1)
            self.assertEqual(json.loads(output.getvalue())["code"], "PAIRING_REQUIRES_TTY")
            wire.assert_not_called()

    def test_pair_rejects_legacy_non_auto_apply_scope(self) -> None:
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as root, \
             patch.object(agent, "_world_runtime_dir", return_value=Path(root)), \
             patch.object(agent, "_world_require_tty"), \
             patch.object(agent, "_world_pairing_code", return_value="a" * 32), \
             patch.object(agent, "_world_wire", side_effect=[{"ok": True}, {
                 "ok": True, "session": "b" * 64, "scope": "worlds:read",
                 "proposalScope": "worlds:prepare", "expiresAt": 100,
             }]), redirect_stdout(output):
            self.assertEqual(agent.main(["--compact", "world", "pair"]), 1)
        self.assertEqual(json.loads(output.getvalue())["code"], "UNAUTHORIZED")

    def test_cancelled_native_consent_never_prompts_for_a_code(self) -> None:
        output = io.StringIO()
        with patch.object(agent, "_world_runtime_dir", return_value=Path("/unused")), \
             patch.object(agent, "_world_require_tty"), \
             patch.object(agent, "_world_wire", return_value={"ok": False, "code": "USER_DECLINED"}), \
             patch.object(agent, "_world_pairing_code") as prompt, redirect_stdout(output):
            self.assertEqual(agent.main(["--compact", "world", "pair"]), 1)
        prompt.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())["code"], "PAIRING_DECLINED")

    def test_request_validation_rejects_paths_and_page_overflow_without_socket(self) -> None:
        for value in ("../secret", "/tmp/file", "%2e%2e", "C:\\secret", "\\\\server\\share"):
            with self.subTest(value=value), self.assertRaises(agent.ModlyCliError):
                agent._world_project_key(value)
        with self.assertRaises(agent.ModlyCliError):
            agent._world_page_size(51)

    def test_last_mile_output_filters_session_and_path_sentinels(self) -> None:
        token = "b" * 64
        value = {"name": "Safe", "session": token, "workspacePath": "/private/sentinel",
                 "items": [{"name": "/private/sentinel", "resourceHandle": "asset_" + "a" * 32}]}
        public = agent._world_public(value, token)
        encoded = json.dumps(public)
        self.assertNotIn(token, encoded)
        self.assertNotIn("/private", encoded)
        self.assertEqual(public["items"][0]["name"], "[redacted]")

    def test_proposal_is_bounded_stdin_only_and_receipt_is_allowlisted(self) -> None:
        project_key = "world-" + "a" * 32
        plan_id = "plan_" + "b" * 48
        recipe = b'{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}'
        request = {}
        def wire(_runtime: Path, payload: dict[str, object]) -> dict[str, object]:
            request.update(payload)
            return {"ok": True, "proposalId": "proposal_" + "c" * 48, "projectKey": project_key,
                    "revision": 3, "digest": "d" * 64, "expiresAt": 12345, "commandCount": 1,
                    "changeCount": 3, "status": "direct-edit-dispatched", "snapshot": "/private/never-print"}
        output = io.StringIO()
        with patch.object(agent, "_world_runtime_dir", return_value=Path("/tmp")), \
             patch.object(agent, "_world_session", return_value="e" * 64), \
             patch.object(agent, "_world_wire", side_effect=wire), \
             patch.object(agent.sys, "stdin", io.TextIOWrapper(io.BytesIO(recipe), encoding="utf-8")), \
             redirect_stdout(output):
            self.assertEqual(agent.main(["--compact", "world", "propose", project_key, "--plan", plan_id, "--json", "-"]), 0)
        self.assertEqual(request["json"], recipe.decode())
        self.assertNotIn("snapshot", output.getvalue())
        self.assertNotIn("/private", output.getvalue())
        self.assertNotIn("commands", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["status"], "direct-edit-dispatched")

    def test_duplicate_oversize_and_invalid_stdin_recipes_fail_before_wire(self) -> None:
        project_key = "world-" + "a" * 32
        for recipe in (b'{"commands":[],"commands":[]}', b'{' + b' ' * 8192 + b'}', b'{"commands":1e999}', b'\xff'):
            with self.subTest(recipe=recipe[:30]), \
                 patch.object(agent, "_world_runtime_dir", return_value=Path("/tmp")), \
                 patch.object(agent, "_world_session", return_value="e" * 64), \
                 patch.object(agent, "_world_wire") as wire, \
                 patch.object(agent.sys, "stdin", io.TextIOWrapper(io.BytesIO(recipe), encoding="utf-8")), \
                 redirect_stdout(io.StringIO()):
                self.assertEqual(agent.main(["--compact", "world", "propose", project_key,
                                             "--plan", "plan_" + "b" * 48, "--json", "-"]), 1)
                wire.assert_not_called()

    def test_planned_query_publishes_and_flushes_stdout_before_delivery_ack(self) -> None:
        project_key = "world-" + "a" * 32
        plan_id = "plan_" + "b" * 48
        delivery_id = "delivery_" + "c" * 48
        args = agent.build_parser().parse_args(["--compact", "world", "query", project_key,
                                                "--revision", "3", "--kind", "project", "--plan", plan_id])
        events: list[str] = []

        class Output(io.StringIO):
            def __init__(self, fail: bool = False) -> None:
                super().__init__()
                self.fail = fail

            def flush(self) -> None:
                events.append("flush")
                if self.fail:
                    raise OSError("stdout is closed")

        def wire(_runtime: Path, payload: dict[str, object]) -> dict[str, object]:
            events.append(str(payload["operation"]))
            if payload["operation"] == "query":
                return {"ok": True, "page": {"nextCursor": None, "items": []}, "deliveryId": delivery_id}
            return {"ok": True}

        with patch.object(agent, "_world_runtime_dir", return_value=Path("/tmp")), \
             patch.object(agent, "_world_session", return_value="e" * 64), \
             patch.object(agent, "_world_wire", side_effect=wire), \
             redirect_stdout(Output()):
            self.assertEqual(args.func(args), 0)
        self.assertEqual(events, ["query", "flush", "ack"])

        events.clear()
        with patch.object(agent, "_world_runtime_dir", return_value=Path("/tmp")), \
             patch.object(agent, "_world_session", return_value="e" * 64), \
             patch.object(agent, "_world_wire", side_effect=wire), \
             redirect_stdout(Output(fail=True)):
            with self.assertRaises(OSError):
                args.func(args)
        self.assertEqual(events, ["query", "flush"], "a failed stdout flush must not authorize an observation")


if __name__ == "__main__":
    unittest.main()
