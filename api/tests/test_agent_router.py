import asyncio
import json
import unittest
from unittest import mock

import httpx

import routers.agent as agent


class _MockClientFactory:
    """Builds real AsyncClients wired to a MockTransport, so execute_tool talks to
    a fake Modly API instead of the network."""

    def __init__(self, handler) -> None:
        self._handler = handler
        self._real = httpx.AsyncClient

    def __call__(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self._handler)
        return self._real(*args, **kwargs)


def _run_tool(name: str, handler) -> tuple[str, object]:
    factory = _MockClientFactory(handler)
    with mock.patch.object(agent.httpx, "AsyncClient", factory):
        return asyncio.run(agent.execute_tool(name, {}, {}))


class UnloadModelsErrorTests(unittest.TestCase):
    """A direct unload records an intent; HTTP execution and success belong to
    the host action phase, never to the chat tool's inventory transport."""

    def test_http_error_is_surfaced(self) -> None:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(500, text="boom")

        text, payload = _run_tool("unload_models", handler)
        # No failed HTTP mutation is disguised as a completed unload: this
        # phase records the exact intent without issuing an HTTP mutation.
        self.assertEqual(requests, [])
        self.assertEqual(json.loads(text)["code"], "direct_action_recorded")
        self.assertIn("apply exactly once", json.loads(text)["message"])
        self.assertEqual(agent.ModelsUnloadedIntent.model_validate(payload).type, "models_unloaded")
        self.assertNotIn("unloaded successfully", text.lower())

    def test_success_still_reports_unloaded(self) -> None:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"ok": True})

        text, payload = _run_tool("unload_models", handler)
        self.assertEqual(requests, [])
        self.assertEqual(json.loads(text)["code"], "direct_action_recorded")
        self.assertEqual(agent.ModelsUnloadedIntent.model_validate(payload).type, "models_unloaded")
        self.assertIn("after this response", json.loads(text)["message"])


if __name__ == "__main__":
    unittest.main()
