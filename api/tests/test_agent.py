import asyncio
import json

import httpx
import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import agent


def run(coro):
    return asyncio.run(coro)


async def stream_round(lines: list[str], *, status_code: int = 200):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status_code, text="\n".join(lines), request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=agent.LLM_TIMEOUT) as client:
        message = await agent._stream_llm_round(
            client,
            "http://provider.test/v1/",
            {"model": "test-model", "messages": []},
            1,
            {},
        )
    return message, requests


def frame(message: dict, done: bool, **extra) -> str:
    delta = {"role": "assistant", **message}
    if "thinking" in delta:
        delta["reasoning_content"] = delta.pop("thinking")
    if "tool_calls" in delta:
        delta["tool_calls"] = [
            {**call, "function": {**call["function"], "arguments": json.dumps(call["function"].get("arguments", {}))}}
            for call in delta["tool_calls"]
        ]
    return "data: " + json.dumps({
        "choices": [{"delta": delta, "finish_reason": extra.get("done_reason", "stop") if done else None}],
    }) + "\n\n"


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
        "reasoning_content": "Plan carefully.",
    }
    assert len(requests) == 1
    assert requests[0].url == httpx.URL("http://provider.test/v1/chat/completions")
    assert json.loads(requests[0].content)["stream"] is True


def test_stream_round_accumulates_tool_calls_with_thinking_and_content_across_sse_chunks():
    first_call = {"index": 0, "id": "call_models", "type": "function", "function": {"name": "list_models", "arguments": {}}}
    second_call = {"index": 1, "id": "call_processes", "type": "function", "function": {"name": "list_processes", "arguments": {}}}

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
        "reasoning_content": "Choose both.",
        "tool_calls": [
            {"id": call["id"], "type": "function", "function": {"name": call["function"]["name"], "arguments": "{}"}}
            for call in (first_call, second_call)
        ],
    }


@pytest.mark.parametrize(
    ("lines", "expected_code"),
    [
        (["data: " + json.dumps({"error": "secret upstream detail"}) + "\n\n"], "llm_error_frame"),
        (["data: {not-json\n\n"], "llm_malformed_stream"),
        (["data: " + json.dumps({"choices": [{"delta": [], "finish_reason": "stop"}]}) + "\n\n"], "llm_invalid_stream"),
        ([frame({"content": "partial"}, False)], "llm_incomplete_stream"),
    ],
)
def test_stream_round_distinguishes_protocol_failures(lines, expected_code):
    with pytest.raises(agent.LlmBoundaryError) as raised:
        run(stream_round(lines))

    assert raised.value.status_code == 502
    assert raised.value.code == expected_code
    assert "secret upstream detail" not in raised.value.safe_message


def test_stream_round_normalizes_upstream_http_failure():
    with pytest.raises(agent.LlmBoundaryError) as raised:
        run(stream_round([], status_code=503))

    assert raised.value.status_code == 502
    assert raised.value.code == "llm_upstream_error"


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
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=agent.LLM_TIMEOUT) as client:
            return await agent._stream_llm_round(client, "http://provider.test/v1", {}, 1, {})

    with pytest.raises(agent.LlmBoundaryError) as raised:
        run(invoke())
    assert raised.value.status_code == 504
    assert raised.value.code == "llm_timeout"


def test_stream_round_maps_connect_failure_to_503():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unavailable", request=request)

    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=agent.LLM_TIMEOUT) as client:
            return await agent._stream_llm_round(client, "http://provider.test/v1", {}, 1, {})

    with pytest.raises(agent.LlmBoundaryError) as raised:
        run(invoke())
    assert raised.value.status_code == 503
    assert raised.value.code == "llm_unavailable"


def test_chat_router_serializes_malformed_provider_url_as_structured_503():
    app = FastAPI()
    app.include_router(agent.router)

    with TestClient(app) as client:
        response = client.post(
            "/agent/chat",
            json={"messages": [], "provider": {"type": "external", "base_url": "http://[::1"}, "model": "test-model"},
        )

    assert response.status_code == 503
    assert response.json() == {
        "detail": {
            "code": "llm_unavailable",
            "message": "The configured provider URL is invalid. Check the agent settings and try again.",
            "retryable": False,
            "round": 1,
            "actions": [],
        }
    }


def test_agent_executes_streamed_tools_with_call_ids_then_returns_final_round(monkeypatch):
    rounds: list[dict] = []
    tool_calls = [
        {"id": "call_models", "type": "function", "function": {"name": "list_models", "arguments": "{}"}},
        {"id": "call_processes", "type": "function", "function": {"name": "list_processes", "arguments": "{}"}},
    ]

    async def fake_stream(_client, _url, payload, round_number, _headers):
        rounds.append({"round": round_number, "messages": list(payload["messages"])})
        if round_number == 1:
            return {
                "role": "assistant",
                "content": "",
                "reasoning_content": "Checking inventory.",
                "tool_calls": tool_calls,
            }
        return {"role": "assistant", "content": "Inventory checked.", "reasoning_content": "Done."}

    async def fake_execute(name, arguments, context):
        return json.dumps({"complete": True, name: []}), None

    monkeypatch.setattr(agent, "_stream_llm_round", fake_stream)
    monkeypatch.setattr(agent, "execute_tool", fake_execute)

    response = run(
        agent.agent_chat(
            agent.AgentChatRequest(messages=[agent.ChatMessage(role="user", content="What is available?")], provider=agent.ProviderConfig(type="external", base_url="https://provider.test/v1"))
        )
    )

    assert response.message == "Inventory checked."
    assert [action.tool for action in response.actions] == ["list_models", "list_processes"]
    assert response.thinking == "Checking inventory.\n\n---\n\nDone."
    second_messages = rounds[1]["messages"]
    assert second_messages[-3]["tool_calls"] == tool_calls
    assert second_messages[-2]["tool_call_id"] == "call_models"
    assert second_messages[-1]["tool_call_id"] == "call_processes"


@pytest.mark.parametrize("round_to_fail", [1, 2])
def test_agent_timeout_returns_structured_detail_with_completed_actions(monkeypatch, round_to_fail):
    async def fake_stream(_client, _url, _payload, round_number, _headers):
        if round_number == round_to_fail:
            raise agent.LlmBoundaryError(504, "llm_timeout", "Ollama stopped sending data.", True)
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_wf", "type": "function", "function": {"name": "run_workflow", "arguments": '{"workflow_id":"wf-1"}'}}],
        }

    async def fake_execute(_name, _arguments, _context):
        return "Executing workflow.", {"type": "run_workflow", "workflow_id": "wf-1"}

    monkeypatch.setattr(agent, "_stream_llm_round", fake_stream)
    monkeypatch.setattr(agent, "execute_tool", fake_execute)

    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(agent.AgentChatRequest(messages=[], provider=agent.ProviderConfig(type="external", base_url="https://provider.test/v1"))))

    assert raised.value.status_code == 504
    assert raised.value.detail["code"] == "llm_timeout"
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


class ByteChunks(httpx.AsyncByteStream):
    def __init__(self, content: str):
        self.content = content.encode()

    async def __aiter__(self):
        # Split JSON tokens and UTF-8 independently of SSE line boundaries.
        for start in range(0, len(self.content), 7):
            yield self.content[start:start + 7]


def delta_frame(delta: dict, finish_reason=None) -> str:
    return "data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": finish_reason}]}, ensure_ascii=False) + "\n\n"


def test_stream_round_reconstructs_indexed_tool_arguments_across_real_byte_chunks():
    calls = [
        {"index": 0, "id": "call_1", "type": "function", "function": {"name": "run_", "arguments": '{"workflow_'}},
        {"index": 0, "function": {"name": "workflow", "arguments": 'id":"wf-1"}'}},
    ]
    stream = ": keepalive\n\n" + delta_frame({"content": "Inspect café.", "tool_calls": [calls[0]]})
    stream += delta_frame({"tool_calls": [calls[1]]}) + delta_frame({}, "tool_calls") + "data: [DONE]\n\n"

    async def invoke():
        def handler(request):
            return httpx.Response(200, stream=ByteChunks(stream), request=request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await agent._stream_llm_round(client, "https://custom.test/open-api/", {}, 1, {})

    result = run(invoke())
    assert result == {
        "role": "assistant",
        "content": "Inspect café.",
        "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "run_workflow", "arguments": '{"workflow_id":"wf-1"}'}}],
    }


@pytest.mark.parametrize("arguments", ['{"unfinished":', '[]'])
def test_stream_round_rejects_incomplete_or_nonobject_completed_tool_arguments(arguments):
    lines = [delta_frame({"tool_calls": [{"index": 0, "id": "call_bad", "function": {"name": "run_workflow", "arguments": arguments}}]}, "tool_calls")]
    with pytest.raises(agent.LlmBoundaryError) as raised:
        run(stream_round(lines))
    assert raised.value.code == "llm_invalid_stream"
    assert raised.value.retryable is False


def test_agent_never_executes_tool_deltas_from_an_incomplete_round(monkeypatch):
    lines = delta_frame({"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "run_workflow", "arguments": '{"workflow_id":"wf-1"}'}}]})
    real = httpx.AsyncClient
    def factory(*args, **kwargs):
        return real(*args, transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=ByteChunks(lines), request=request)), **kwargs)
    executions = []
    async def fake_execute(*args):
        executions.append(args)
        return "Unexpected execution", None
    monkeypatch.setattr(agent.httpx, "AsyncClient", factory)
    monkeypatch.setattr(agent, "execute_tool", fake_execute)
    request = agent.AgentChatRequest(messages=[], model="external-model", provider=agent.ProviderConfig(type="external", base_url="https://custom.test/v1"))
    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(request))
    assert raised.value.detail["code"] == "llm_incomplete_stream"
    assert raised.value.detail["actions"] == []
    assert executions == []


def test_agent_executes_one_indexed_tool_once_and_answers_its_id_in_the_next_round(monkeypatch):
    first = delta_frame({"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "run_", "arguments": '{"workflow_'}}]})
    first += delta_frame({"tool_calls": [{"index": 0, "function": {"name": "workflow", "arguments": 'id":"wf-1"}'}}]}, "tool_calls")
    final = delta_frame({"content": "Complete."}, "stop")
    requests = []
    streams = iter([first, final])
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, stream=ByteChunks(next(streams)), request=request)
    real = httpx.AsyncClient
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda *args, **kwargs: real(*args, transport=httpx.MockTransport(handler), **kwargs))
    executions = []
    async def fake_execute(name, arguments, context):
        executions.append((name, arguments, context))
        return "Executing workflow.", {"type": "run_workflow", "workflow_id": "wf-1", "workflow_name": "Workflow"}
    monkeypatch.setattr(agent, "execute_tool", fake_execute)
    request = agent.AgentChatRequest(messages=[], model="chosen-external", provider=agent.ProviderConfig(type="external", base_url="https://custom.test/compatible"))
    response = run(agent.agent_chat(request))
    assert executions == [("run_workflow", {"workflow_id": "wf-1"}, {})]
    assert response.message == "Complete."
    assert len(response.actions) == 1
    assert len(requests) == 2
    assert requests[0]["model"] == "chosen-external"
    assert requests[0]["stream"] is True
    assert requests[1]["messages"][-1] == {"role": "tool", "tool_call_id": "call_1", "content": "Executing workflow."}


class HeldSlot:
    base_url = "http://127.0.0.1:8791/v1"
    def __init__(self):
        self.released = 0
    def release(self):
        self.released += 1


@pytest.mark.parametrize("failure", [asyncio.CancelledError(), agent.LlmBoundaryError(504, "llm_timeout", "Timed out.", True)])
def test_local_slot_is_released_once_after_cancellation_or_stream_failure(monkeypatch, failure):
    slot = HeldSlot()
    holds = []
    def ensure(model, spec, hold):
        holds.append((model, spec, hold))
        return slot
    monkeypatch.setattr(agent.llm_server, "resolve_model", lambda _: {"vision": False})
    monkeypatch.setattr(agent.llm_server, "sampling_for", lambda _: {})
    monkeypatch.setattr(agent.llama_pool, "ensure", ensure)
    async def fail(*_args):
        raise failure
    monkeypatch.setattr(agent, "_stream_llm_round", fail)
    expected = asyncio.CancelledError if isinstance(failure, asyncio.CancelledError) else agent.HTTPException
    with pytest.raises(expected):
        run(agent.agent_chat(agent.AgentChatRequest(messages=[], model="selected-local")))
    assert holds == [("selected-local", {"vision": False}, True)]
    assert slot.released == 1


@pytest.mark.parametrize("vision", [True, False])
def test_local_selected_model_retains_sampling_thinking_and_vision_contract(monkeypatch, vision):
    slot = HeldSlot()
    seen = []
    monkeypatch.setattr(agent.llm_server, "resolve_model", lambda _: {"vision": vision})
    monkeypatch.setattr(agent.llm_server, "sampling_for", lambda _: {"temperature": 0.42})
    monkeypatch.setattr(agent.llama_pool, "ensure", lambda *_: slot)
    async def stream(_client, url, payload, round_number, headers):
        seen.append((url, payload, headers))
        return {"role": "assistant", "content": "Complete."}
    monkeypatch.setattr(agent, "_stream_llm_round", stream)
    request = agent.AgentChatRequest(messages=[agent.ChatMessage(role="user", content="Image", images=["data:image/png;base64,AAAA"])], model="selected-local", thinking="off")
    assert run(agent.agent_chat(request)).message == "Complete."
    url, payload, headers = seen[0]
    assert url == slot.base_url
    assert headers == {}
    assert payload["model"] == "selected-local"
    assert payload["temperature"] == 0.42
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}
    content = payload["messages"][1]["content"]
    if vision:
        assert content == [{"type": "text", "text": "Image"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]
    else:
        assert content == "Image"
    assert slot.released == 1


def test_local_failure_after_completed_workflow_unloads_only_after_releasing_its_slot(monkeypatch):
    """Requires the separately proposed OWN lifecycle compatibility remedy."""
    slot = HeldSlot()
    released_at_unload = []
    monkeypatch.setattr(agent.llm_server, "resolve_model", lambda _: {"vision": False})
    monkeypatch.setattr(agent.llm_server, "sampling_for", lambda _: {})
    monkeypatch.setattr(agent.llama_pool, "ensure", lambda *_: slot)
    monkeypatch.setattr(agent.llama_pool, "unload_all", lambda: released_at_unload.append(slot.released))
    async def stream(_client, _url, _payload, round_number, _headers):
        if round_number == 2:
            raise agent.LlmBoundaryError(504, "llm_timeout", "Timed out.", True)
        return {"role": "assistant", "content": "", "tool_calls": [{"id": "wf_call", "function": {"name": "run_workflow", "arguments": '{"workflow_id":"wf-1"}'}}]}
    async def execute(*_args):
        return "Executing workflow.", {"type": "run_workflow", "workflow_id": "wf-1", "workflow_name": "Workflow"}
    monkeypatch.setattr(agent, "_stream_llm_round", stream)
    monkeypatch.setattr(agent, "execute_tool", execute)
    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(agent.AgentChatRequest(messages=[], model="selected-local")))
    assert raised.value.detail["round"] == 2
    assert raised.value.detail["actions"] == [{"tool": "run_workflow", "result": "Executing workflow.", "payload": {"type": "run_workflow", "workflow_id": "wf-1", "workflow_name": "Workflow"}}]
    assert slot.released == 1
    assert released_at_unload == [1]


class EventChunks(httpx.AsyncByteStream):
    def __init__(self, chunks, *, after=None):
        self.chunks = chunks
        self.after = after
        self.reads = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk
        if self.after is not None:
            raise self.after


def install_transport(monkeypatch, handler):
    real_client = httpx.AsyncClient
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda *args, **kwargs: real_client(*args, transport=httpx.MockTransport(handler), **kwargs))


def external_request():
    return agent.AgentChatRequest(
        messages=[agent.ChatMessage(role="user", content="Inspect café.")],
        model="selected-external",
        provider=agent.ProviderConfig(type="external", base_url="https://custom.test/arbitrary-compatible", api_key="fixture-key"),
    )


def test_agent_dispatches_byte_split_multiline_data_only_at_the_event_boundary(monkeypatch):
    call = {"index": 0, "id": "call_multiline", "function": {"name": "list_models", "arguments": "{}"}}
    choice = {"delta": {"role": "assistant", "content": "Café.", "reasoning_content": "Inspect.", "tool_calls": [call]}, "finish_reason": "tool_calls"}
    event = "id: fixture-42\nretry: 1000\n: keepalive\nevent: message\nx-fixture: ignored\ndata: {\ndata: \"choices\": [\ndata: " + json.dumps(choice, ensure_ascii=False) + "\ndata: ]}\n\n"
    # Each byte is its own transport chunk, including both UTF-8 bytes of é.
    streams = iter([EventChunks([bytes([byte]) for byte in event.encode()]), EventChunks([delta_frame({"content": "Inventory checked."}, "stop").encode()])])
    requests = []
    def handler(request):
        requests.append((str(request.url), dict(request.headers), json.loads(request.content)))
        return httpx.Response(200, stream=next(streams), request=request)
    install_transport(monkeypatch, handler)
    executed = []
    async def execute(name, arguments, context):
        executed.append((name, arguments, context))
        return "Inventory.", None
    monkeypatch.setattr(agent, "execute_tool", execute)
    response = run(agent.agent_chat(external_request()))
    assert response.message == "Inventory checked."
    assert response.thinking == "Inspect."
    assert executed == [("list_models", {}, {})]
    assert [action.tool for action in response.actions] == ["list_models"]
    assert len(requests) == 2
    assert requests[0][0] == "https://custom.test/arbitrary-compatible/chat/completions"
    assert requests[0][1]["authorization"] == "Bearer fixture-key"
    assert requests[0][2]["model"] == "selected-external"
    assert requests[0][2]["stream"] is True
    assert requests[1][2]["messages"][-1] == {"role": "tool", "tool_call_id": "call_multiline", "content": "Inventory."}


@pytest.mark.parametrize("ending", ["", "\n"])
def test_agent_rejects_an_unterminated_terminal_event_without_executing_its_valid_tool(monkeypatch, ending):
    choice = {"delta": {"tool_calls": [{"index": 0, "id": "unfinished_event", "function": {"name": "run_workflow", "arguments": '{"workflow_id":"wf-1"}'}}]}, "finish_reason": "tool_calls"}
    # HTTPX flushes this complete JSON line at EOF, but SSE has not dispatched it.
    wire = ("data: " + json.dumps({"choices": [choice]}) + ending).encode()
    install_transport(monkeypatch, lambda request: httpx.Response(200, stream=EventChunks([wire[:9], wire[9:]]), request=request))
    executed = []
    async def execute(*args):
        executed.append(args)
        return "Unexpected mutation.", None
    monkeypatch.setattr(agent, "execute_tool", execute)
    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(external_request()))
    assert raised.value.status_code == 502
    assert raised.value.detail["code"] == "llm_incomplete_stream"
    assert raised.value.detail["round"] == 1
    assert raised.value.detail["actions"] == []
    assert executed == []


def test_agent_returns_after_a_dispatched_terminal_event_without_waiting_for_done_or_eof(monkeypatch):
    stream = EventChunks([delta_frame({"content": "Complete."}, "stop").encode()], after=httpx.ReadTimeout("Must not wait for another chunk"))
    install_transport(monkeypatch, lambda request: httpx.Response(200, stream=stream, request=request))
    response = run(agent.agent_chat(external_request()))
    assert response.message == "Complete."
    assert response.actions == []
    assert stream.reads == 1


def test_agent_transport_cancellation_discards_pending_event_and_releases_local_hold(monkeypatch):
    slot = HeldSlot()
    released = []
    def ensure(model, spec, hold):
        assert (model, spec, hold) == ("selected-local", {"vision": False}, True)
        return slot
    monkeypatch.setattr(agent.llm_server, "resolve_model", lambda _: {"vision": False})
    monkeypatch.setattr(agent.llm_server, "sampling_for", lambda _: {})
    monkeypatch.setattr(agent.llama_pool, "ensure", ensure)
    monkeypatch.setattr(agent.llama_pool, "unload_all", lambda: released.append(slot.released))
    pending = delta_frame({"tool_calls": [{"index": 0, "id": "cancelled", "function": {"name": "run_workflow", "arguments": '{"workflow_id":"wf-1"}'}}]}, "tool_calls").removesuffix("\n\n") + "\n"
    install_transport(monkeypatch, lambda request: httpx.Response(200, stream=EventChunks([pending.encode()], after=asyncio.CancelledError()), request=request))
    executed = []
    async def execute(*args):
        executed.append(args)
        return "Unexpected execution.", None
    monkeypatch.setattr(agent, "execute_tool", execute)
    with pytest.raises(asyncio.CancelledError):
        run(agent.agent_chat(agent.AgentChatRequest(messages=[], model="selected-local")))
    assert slot.released == 1
    assert executed == []
    assert released == []


@pytest.mark.parametrize("finish_reason", ["length", "content_filter"])
@pytest.mark.parametrize("completed_prior_round", [False, True])
def test_agent_rejects_failed_finish_even_with_valid_tool_json_and_preserves_earlier_actions(monkeypatch, finish_reason, completed_prior_round):
    prior = delta_frame({"tool_calls": [{"index": 0, "id": "prior_call", "function": {"name": "smooth_mesh", "arguments": '{"path":"/synthetic/mesh.glb"}'}}]}, "tool_calls")
    failed = delta_frame({"tool_calls": [{"index": 0, "id": "failed_call", "function": {"name": "run_workflow", "arguments": '{"workflow_id":"wf-1"}'}}]}, finish_reason)
    streams = iter(([prior] if completed_prior_round else []) + [failed])
    requests = []
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, stream=ByteChunks(next(streams)), request=request)
    install_transport(monkeypatch, handler)
    executed = []
    async def execute(name, arguments, _context):
        executed.append((name, arguments))
        return "Smoothed.", {"type": "mesh_update", "url": "/workspace/synthetic-smoothed.glb"}
    monkeypatch.setattr(agent, "execute_tool", execute)
    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(external_request()))
    assert raised.value.status_code == 502
    assert raised.value.detail["code"] == "llm_incomplete_stream"
    assert raised.value.detail["round"] == (2 if completed_prior_round else 1)
    assert raised.value.detail["retryable"] is (finish_reason == "length")
    expected_actions = [{"tool": "smooth_mesh", "result": "Smoothed.", "payload": {"type": "mesh_update", "url": "/workspace/synthetic-smoothed.glb"}}] if completed_prior_round else []
    assert raised.value.detail["actions"] == expected_actions
    assert executed == ([("smooth_mesh", {"path": "/synthetic/mesh.glb"})] if completed_prior_round else [])
    assert len(requests) == (2 if completed_prior_round else 1)


def test_agent_accepts_a_provider_specific_success_finish_without_a_reason_allowlist(monkeypatch):
    first = delta_frame({"tool_calls": [{"index": 0, "id": "custom_finish", "function": {"name": "list_models", "arguments": "{}"}}]}, "vendor_complete")
    final = delta_frame({"content": "Complete."}, "vendor_final")
    streams = iter([first, final])
    install_transport(monkeypatch, lambda request: httpx.Response(200, stream=ByteChunks(next(streams)), request=request))
    executed = []
    async def execute(*args):
        executed.append(args)
        return "Inventory.", None
    monkeypatch.setattr(agent, "execute_tool", execute)
    response = run(agent.agent_chat(external_request()))
    assert response.message == "Complete."
    assert executed == [("list_models", {}, {})]
    assert [action.tool for action in response.actions] == ["list_models"]


def test_process_inventory_transport_preserves_positional_repetition_labels_and_named_ports(monkeypatch):
    positional = ["image", "image", "text", "audio", "capture"]
    labels = ["front", "side", "prompt", "sound", "capture"]
    named = [{"name": "references", "type": "image", "label": "References", "required": True, "multiple": True, "ordered": True, "min_items": 1, "max_items": 2}]
    processes = [
        {"id": "bundle/positional", "extension_id": "bundle", "node_id": "positional", "name": "Positional", "extension_name": "Bundle", "builtin": False, "trusted": True, "input": "capture", "output": "video", "inputs": positional, "input_labels": labels, "ready": None},
        {"id": "bundle/named", "extension_id": "bundle", "node_id": "named", "name": "Named", "extension_name": "Bundle", "builtin": False, "trusted": True, "inputs": named, "input_labels": ["Upstream label"], "ready": None},
        # Current producer falls back to positional slots for duplicate names
        # in an input_contract. Repeated modalities must never be deduplicated.
        {"id": "bundle/duplicate-fallback", "extension_id": "bundle", "node_id": "duplicate-fallback", "name": "Fallback", "extension_name": "Bundle", "builtin": False, "trusted": True, "inputs": ["text", "text"], "input_labels": ["First", "Second"], "ready": None},
    ]
    requests = []
    def handler(request):
        requests.append((request.method, str(request.url)))
        return httpx.Response(200, json={"processes": processes}, request=request)
    install_transport(monkeypatch, handler)
    text, payload = run(agent.execute_tool("list_processes", {}, {}))
    result = json.loads(text)
    assert payload is None
    assert requests == [("GET", f"{agent.AUTOMATION_BRIDGE}/automation/capabilities")]
    assert result["complete"] is True
    assert "errors" not in result
    assert result["processes"][0]["inputs"] == positional
    assert result["processes"][0]["input_labels"] == labels
    assert result["processes"][0]["input"] == "capture"
    assert result["processes"][0]["output"] == "video"
    assert result["processes"][1]["inputs"] == named
    assert result["processes"][1]["input_labels"] == ["Upstream label"]
    assert result["processes"][2]["inputs"] == ["text", "text"]
    assert result["processes"][2]["input_labels"] == ["First", "Second"]
    assert all(process["ready"] == "unknown" for process in result["processes"])


def test_process_inventory_preserves_valid_positional_slots_when_named_metadata_is_malformed():
    result = agent._normalize_process_inventory({"processes": [
        {"id": "bundle/positional", "extension_id": "bundle", "node_id": "positional", "name": "Positional", "extension_name": "Bundle", "builtin": False, "trusted": True, "inputs": ["image", "text"], "input_labels": ["Image", "Prompt"]},
        {"id": "bundle/bad-named", "extension_id": "bundle", "node_id": "bad-named", "name": "Named", "extension_name": "Bundle", "builtin": False, "trusted": True, "inputs": [{"name": "mesh", "type": "mesh", "required": "yes"}, {"name": "quality", "type": "text", "required": False}]},
    ]})
    assert result["complete"] is False
    assert result["processes"][0]["inputs"] == ["image", "text"]
    assert result["processes"][0]["input_labels"] == ["Image", "Prompt"]
    assert result["processes"][1]["inputs"] == [{"name": "quality", "type": "text", "required": False}]
    assert [error["code"] for error in result["errors"]] == ["invalid_process_port"]
