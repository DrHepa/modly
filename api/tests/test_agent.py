import asyncio
import json
import unittest

import httpx
import pytest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ModuleNotFoundError as error:
    if error.name == "fastapi":
        raise unittest.SkipTest("fastapi is not installed") from error
    raise

from routers import agent


def run(coro):
    return asyncio.run(coro)


async def stream_round(lines: list[str], *, status_code: int = 200):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status_code, text="\n".join(lines), request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=agent.OLLAMA_TIMEOUT) as client:
        message = await agent._stream_ollama_round(
            client,
            "http://ollama.test/",
            {"model": "test-model", "messages": []},
            1,
        )
    return message, requests


def frame(message: dict, done: bool, **extra) -> str:
    return json.dumps({"message": {"role": "assistant", **message}, "done": done, **extra})


def test_stream_round_reconstructs_split_content_thinking_and_terminal_done():
    message, requests = run(
        stream_round(
            [
                "",
                frame({"thinking": "Plan ", "content": ""}, False),
                frame({"thinking": "carefully.", "content": "Hel"}, False),
                frame(
                    {"content": "lo"},
                    True,
                    done_reason="stop",
                    prompt_eval_count=11,
                    eval_count=3,
                ),
            ]
        )
    )

    assert message == {
        "role": "assistant",
        "content": "Hello",
        "thinking": "Plan carefully.",
    }
    assert len(requests) == 1
    assert requests[0].url == httpx.URL("http://ollama.test/api/chat")
    assert json.loads(requests[0].content)["stream"] is True


def test_stream_round_accumulates_tool_calls_with_thinking_and_content_across_ndjson_chunks():
    first_call = {"function": {"name": "list_models", "arguments": {}}}
    second_call = {"function": {"name": "list_processes", "arguments": {}}}

    message, _ = run(
        stream_round(
            [
                frame({"thinking": "Choose ", "content": "I will ", "tool_calls": [first_call]}, False),
                frame({"thinking": "both.", "content": "inspect ", "tool_calls": [second_call]}, False),
                frame({"content": "inventory."}, True, done_reason="stop"),
            ]
        )
    )

    assert message == {
        "role": "assistant",
        "content": "I will inspect inventory.",
        "thinking": "Choose both.",
        "tool_calls": [first_call, second_call],
    }


@pytest.mark.parametrize(
    ("lines", "expected_code"),
    [
        ([json.dumps({"error": "secret upstream detail"})], "ollama_error_frame"),
        (["{not-json"], "ollama_malformed_stream"),
        ([json.dumps({"message": [], "done": True})], "ollama_invalid_stream"),
        ([frame({"content": "partial"}, False)], "ollama_incomplete_stream"),
    ],
)
def test_stream_round_distinguishes_protocol_failures(lines, expected_code):
    with pytest.raises(agent.OllamaBoundaryError) as raised:
        run(stream_round(lines))

    assert raised.value.status_code == 502
    assert raised.value.code == expected_code
    assert "secret upstream detail" not in raised.value.safe_message


def test_stream_round_normalizes_upstream_http_failure():
    with pytest.raises(agent.OllamaBoundaryError) as raised:
        run(stream_round([], status_code=503))

    assert raised.value.status_code == 502
    assert raised.value.code == "ollama_upstream_error"


class RaisingStream(httpx.AsyncByteStream):
    def __init__(self, error: Exception):
        self.error = error

    async def __aiter__(self):
        raise self.error
        yield b""  # pragma: no cover


def test_stream_round_maps_read_timeout_to_504():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=RaisingStream(httpx.ReadTimeout("inactive", request=request)),
            request=request,
        )

    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=agent.OLLAMA_TIMEOUT) as client:
            return await agent._stream_ollama_round(client, "http://ollama.test", {}, 1)

    with pytest.raises(agent.OllamaBoundaryError) as raised:
        run(invoke())
    assert raised.value.status_code == 504
    assert raised.value.code == "ollama_timeout"


def test_stream_round_maps_connect_failure_to_503():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unavailable", request=request)

    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=agent.OLLAMA_TIMEOUT) as client:
            return await agent._stream_ollama_round(client, "http://ollama.test", {}, 1)

    with pytest.raises(agent.OllamaBoundaryError) as raised:
        run(invoke())
    assert raised.value.status_code == 503
    assert raised.value.code == "ollama_unavailable"


def test_chat_router_serializes_malformed_ollama_url_as_structured_503():
    app = FastAPI()
    app.include_router(agent.router)

    with TestClient(app) as client:
        response = client.post(
            "/agent/chat",
            json={"messages": [], "ollama_url": "http://[::1", "model": "test-model"},
        )

    assert response.status_code == 503
    assert response.json() == {
        "detail": {
            "code": "ollama_unavailable",
            "message": "The configured Ollama URL is invalid. Check the agent settings and try again.",
            "retryable": False,
            "round": 1,
            "actions": [],
        }
    }


def test_agent_executes_streamed_tools_with_tool_names_then_returns_final_round(monkeypatch):
    rounds: list[dict] = []
    tool_calls = [
        {"function": {"name": "list_models", "arguments": {}}},
        {"function": {"name": "list_processes", "arguments": {}}},
    ]

    async def fake_stream(_client, _url, payload, round_number):
        rounds.append({"round": round_number, "messages": list(payload["messages"])})
        if round_number == 1:
            return {
                "role": "assistant",
                "content": "",
                "thinking": "Checking inventory.",
                "tool_calls": tool_calls,
            }
        return {"role": "assistant", "content": "Inventory checked.", "thinking": "Done."}

    async def fake_execute(name, arguments, context):
        return json.dumps({"complete": True, name: []}), None

    monkeypatch.setattr(agent, "_stream_ollama_round", fake_stream)
    monkeypatch.setattr(agent, "execute_tool", fake_execute)

    response = run(
        agent.agent_chat(
            agent.AgentChatRequest(messages=[agent.ChatMessage(role="user", content="What is available?")])
        )
    )

    assert response.message == "Inventory checked."
    assert [action.tool for action in response.actions] == ["list_models", "list_processes"]
    assert response.thinking == "Checking inventory.\n\n---\n\nDone."
    second_messages = rounds[1]["messages"]
    assert second_messages[-3]["tool_calls"] == tool_calls
    assert second_messages[-2]["tool_name"] == "list_models"
    assert second_messages[-1]["tool_name"] == "list_processes"


@pytest.mark.parametrize("round_to_fail", [1, 2])
def test_agent_timeout_returns_structured_detail_with_completed_actions(monkeypatch, round_to_fail):
    async def fake_stream(_client, _url, _payload, round_number):
        if round_number == round_to_fail:
            raise agent.OllamaBoundaryError(504, "ollama_timeout", "Ollama stopped sending data.", True)
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"function": {"name": "run_workflow", "arguments": {"workflow_id": "wf-1"}}}],
        }

    async def fake_execute(_name, _arguments, _context):
        return "Executing workflow.", {"type": "run_workflow", "workflow_id": "wf-1"}

    monkeypatch.setattr(agent, "_stream_ollama_round", fake_stream)
    monkeypatch.setattr(agent, "execute_tool", fake_execute)

    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(agent.AgentChatRequest(messages=[])))

    assert raised.value.status_code == 504
    assert raised.value.detail["code"] == "ollama_timeout"
    assert raised.value.detail["round"] == round_to_fail
    assert raised.value.detail["retryable"] is True
    expected_actions = 0 if round_to_fail == 1 else 1
    assert len(raised.value.detail["actions"]) == expected_actions
    if expected_actions:
        assert raised.value.detail["actions"][0]["tool"] == "run_workflow"


class FakeResponse:
    def __init__(self, data, *, status_code=200):
        self.data = data
        self.status_code = status_code
        self.text = "unsafe upstream body"

    def json(self):
        return self.data

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", "http://test.invalid")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("failed", request=request, response=response)


class FakeToolClient:
    def __init__(self, responses=None, error=None, **_kwargs):
        self.responses = responses or {}
        self.error = error
        self.requested_urls: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, **_kwargs):
        self.requested_urls.append(url)
        if self.error:
            raise self.error
        return self.responses[url]


def install_tool_client(monkeypatch, *, responses=None, error=None):
    client = FakeToolClient(responses=responses, error=error)
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **_kwargs: client)
    return client


def test_list_models_returns_only_downloaded_local_models_with_known_state(monkeypatch):
    client = install_tool_client(
        monkeypatch,
        responses={
            f"{agent.MODLY_API}/model/all": FakeResponse(
                [
                    {"id": "mesh/ready", "name": "Ready", "downloaded": True, "loaded": True, "active": False},
                    {"id": "mesh/remote", "name": "Remote", "downloaded": False, "loaded": False},
                ]
            )
        },
    )

    result_text, payload = run(agent.execute_tool("list_models", {}, {}))
    result = json.loads(result_text)

    assert client.requested_urls == [f"{agent.MODLY_API}/model/all"]
    assert payload is None
    assert result == {
        "complete": True,
        "models": [
            {
                "id": "mesh/ready",
                "name": "Ready",
                "downloaded": True,
                "loaded": True,
                "active": False,
            }
        ],
    }


def test_model_inventory_marks_malformed_core_and_state_fields_incomplete():
    result = agent._normalize_model_inventory(
        [
            {"id": "mesh/unknown", "name": "Unknown", "downloaded": "yes"},
            {"id": "mesh/no-name", "name": None, "downloaded": True},
            {"id": "mesh/valid", "name": "Valid", "downloaded": True, "loaded": "yes", "active": False},
        ]
    )

    assert result["complete"] is False
    assert result["models"] == [
        {"id": "mesh/valid", "name": "Valid", "downloaded": True, "active": False}
    ]
    assert all(error["code"] == "invalid_model_entry" for error in result["errors"])


def test_list_processes_distinguishes_empty_complete_inventory(monkeypatch):
    install_tool_client(
        monkeypatch,
        responses={
            f"{agent.AUTOMATION_BRIDGE}/automation/capabilities": FakeResponse(
                {"backend_ready": False, "models": [], "processes": [], "errors": [
                    {"source": "backend-runtime", "code": "BACKEND_NOT_READY", "message": "GET /health failed", "retryable": True}
                ]}
            )
        },
    )

    result_text, _ = run(agent.execute_tool("list_processes", {}, {}))
    assert json.loads(result_text) == {"complete": True, "processes": []}


def test_list_processes_preserves_unknown_readiness_and_sanitized_partial_errors(monkeypatch):
    install_tool_client(
        monkeypatch,
        responses={
            f"{agent.AUTOMATION_BRIDGE}/automation/capabilities": FakeResponse(
                {
                    "backend_ready": True,
                    "models": [],
                    "processes": [
                        {
                            "id": "mesh-tools/optimize",
                            "extension_id": "mesh-tools",
                            "node_id": "optimize",
                            "name": "Optimize Mesh",
                            "extension_name": "Mesh Tools",
                            "input": "mesh",
                            "output": "mesh",
                            "builtin": True,
                            "trusted": True,
                            "ready": None,
                            "automation": {"boundary": "electron", "headless": True},
                        }
                    ],
                    "errors": [
                        {
                            "source": "electron-manifest",
                            "code": "PROCESS_DISCOVERY_FAILED",
                            "message": "Failed to read /private/extensions/secret.",
                            "retryable": True,
                        }
                    ],
                }
            )
        },
    )

    result_text, _ = run(agent.execute_tool("list_processes", {}, {}))
    result = json.loads(result_text)

    assert result["complete"] is False
    assert result["processes"][0]["id"] == "mesh-tools/optimize"
    assert result["processes"][0]["ready"] == "unknown"
    assert result["processes"][0]["automation"] == {"boundary": "electron", "headless": True}
    assert result["errors"][0]["code"] == "PROCESS_DISCOVERY_FAILED"
    assert "/private/extensions" not in result["errors"][0]["message"]


@pytest.mark.parametrize(
    "process",
    [
        {
            "id": "/node",
            "extension_id": "",
            "node_id": "node",
            "name": "Node",
            "extension_name": "Extension",
            "builtin": True,
            "trusted": True,
        },
        {
            "id": "extension/pack/node",
            "extension_id": "extension/pack",
            "node_id": "node",
            "name": "Node",
            "extension_name": "Extension",
            "builtin": True,
            "trusted": True,
        },
        {
            "id": "extension/",
            "extension_id": "extension",
            "node_id": "",
            "name": "Node",
            "extension_name": "Extension",
            "builtin": True,
            "trusted": True,
        },
    ],
)
def test_process_inventory_rejects_noncanonical_empty_or_extra_slash_ids(process):
    result = agent._normalize_process_inventory({"processes": [process]})

    assert result["complete"] is False
    assert result["processes"] == []
    assert result["errors"][0]["code"] == "invalid_process_entry"


def test_process_inventory_marks_invalid_required_port_shape_incomplete():
    result = agent._normalize_process_inventory(
        {
            "processes": [
                {
                    "id": "mesh-tools/optimize",
                    "extension_id": "mesh-tools",
                    "node_id": "optimize",
                    "name": "Optimize",
                    "extension_name": "Mesh Tools",
                    "builtin": True,
                    "trusted": True,
                    "inputs": [
                        {"name": "mesh", "type": "mesh", "required": "yes"},
                        {"name": "quality", "type": "text", "required": False},
                    ],
                }
            ]
        }
    )

    assert result["complete"] is False
    assert result["processes"][0]["inputs"] == [
        {"name": "quality", "type": "text", "required": False}
    ]
    assert result["errors"][0]["code"] == "invalid_process_port"


def test_list_processes_bridge_failure_is_an_incomplete_tool_result(monkeypatch):
    request = httpx.Request("GET", f"{agent.AUTOMATION_BRIDGE}/automation/capabilities")
    install_tool_client(monkeypatch, error=httpx.ConnectError("unavailable", request=request))

    result_text, payload = run(agent.execute_tool("list_processes", {}, {}))
    result = json.loads(result_text)

    assert payload is None
    assert result["complete"] is False
    assert result["processes"] == []
    assert result["errors"][0]["code"] == "process_discovery_unavailable"
