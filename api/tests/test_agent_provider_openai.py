import asyncio
import json

import httpx
from fastapi import FastAPI
from routers import agent

CONTEXT = {"schema": "modly.world-ai-context.v1", "projectKey": "world-" + "a" * 32,
           "projectId": "project:demo", "baseRevision": 4, "activeSceneId": "scene:one", "editorEpoch": 1,
           "originSessionId": "session-a", "requestId": "tx:world-ai-one"}
TRANSFORM = {"position": [2, 3, 4], "rotation": [0.1, 0.2, 0.3], "scale": [2, 2, 2]}
COMMAND = {"type": "patch-entity", "sceneId": "scene:one", "entityId": "entity:hero", "patch": {"transform": TRANSFORM}}


def openai_request():
    return {"originSessionId": "session-a", "messages": [{"role": "user", "content": "Move Hero"}],
            "worldContext": CONTEXT, "context": {}, "provider": "openai", "openaiModel": "gpt-5.1"}


def sse(events):
    return "".join(f"event: {event.get('type', 'message')}\n: keepalive\ndata: {json.dumps(event)}\n\n" for event in events).encode()


def function_call(index, name, call_id, arguments):
    item = {"id": f"fc_{index}", "type": "function_call", "name": name, "call_id": call_id, "arguments": json.dumps(arguments, separators=(",", ":"))}
    return [
        {"type": "response.output_item.added", "output_index": index, "item": item},
        {"type": "response.function_call_arguments.done", "output_index": index, "arguments": item["arguments"]},
        {"type": "response.output_item.done", "output_index": index, "item": item},
        {"type": "response.completed", "response": {"status": "completed", "output": [item]}},
    ]


def message(index, text):
    item = {"id": f"msg_{index}", "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}
    return [
        {"type": "response.output_item.added", "output_index": index, "item": item},
        {"type": "response.output_text.delta", "output_index": index, "delta": text[:6]},
        {"type": "response.output_text.done", "output_index": index, "text": text},
        {"type": "response.output_item.done", "output_index": index, "item": item},
        {"type": "response.completed", "response": {"status": "completed", "output": [item]}},
    ]


def test_openai_request_uses_store_false_manual_transcript_no_previous_response_id(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    seen = []
    rounds = 0

    def transport(req):
        nonlocal rounds
        if req.url.path == "/automation/worlds/query":
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}})
        assert str(req.url) == "https://api.openai.com/v1/responses"
        body = json.loads(req.content); seen.append(body); rounds += 1
        if rounds == 1:
            return httpx.Response(200, content=sse(function_call(0, "query_world", "call_query", {"kind": "entities"})))
        if rounds == 2:
            assert any(item.get("type") == "function_call_output" and item.get("call_id") == "call_query" for item in body["input"])
            return httpx.Response(200, content=sse(message(0, "Done.")))
        raise AssertionError("unexpected round")

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    response = asyncio.run(agent.agent_chat(agent.AgentChatRequest(**openai_request())))
    assert response.message == "Done."
    assert seen[0]["store"] is False
    assert seen[0]["stream"] is True
    assert seen[0]["parallel_tool_calls"] is False
    assert "previous_response_id" not in seen[0]
    assert seen[0]["tools"][0]["type"] == "function" and seen[0]["tools"][0]["strict"] is False
    assert not any(item.get("role") == "tool" for request in seen for item in request["input"])


def test_openai_preserves_reasoning_items_for_stateless_tool_continuation(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    seen = []
    reasoning = {"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "opaque"}
    call = {"id": "fc_1", "type": "function_call", "name": "query_world", "call_id": "call_reason", "arguments": '{"kind":"entities"}'}
    rounds = 0
    def transport(req):
        nonlocal rounds
        if req.url.path == "/automation/worlds/query":
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 0, "nextCursor": None, "items": []}})
        body = json.loads(req.content); seen.append(body); rounds += 1
        if rounds == 1:
            return httpx.Response(200, content=sse([
                {"type": "response.output_item.done", "output_index": 0, "item": reasoning},
                {"type": "response.output_item.done", "output_index": 1, "item": call},
                {"type": "response.completed", "response": {"status": "completed", "output": [reasoning, call]}},
            ]))
        assert reasoning in body["input"]
        assert call in body["input"]
        assert any(item.get("type") == "function_call_output" and item.get("call_id") == "call_reason" for item in body["input"])
        return httpx.Response(200, content=sse(message(0, "No changes.")))
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    result = asyncio.run(agent.agent_chat(agent.AgentChatRequest(**openai_request())))
    assert result.thinking is None
    assert "opaque" not in result.model_dump_json()


def test_openai_tools_are_strict_false_raw_pydantic_and_validation_rejects_nulls(monkeypatch):
    from routers import world_ai
    tools = world_ai.openai_tools()
    assert {tool["name"] for tool in tools} == {"query_world", "propose_world_commands"}
    assert all(tool["type"] == "function" and tool["strict"] is False and "function" not in tool for tool in tools)
    turn = world_ai.WorldAiTurn(world_ai.WorldAiContext.model_validate(CONTEXT))
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _req: httpx.Response(500))) as client:
            result = await turn.execute("query_world", {"kind": "entities", "entityId": None}, client, agent.AUTOMATION_BRIDGE)
            assert json.loads(result)["code"] == "world_request_rejected"
    asyncio.run(run())


def test_no_key_returns_safe_error_without_provider_request(monkeypatch, caplog):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = asyncio.run(agent.agent_chat(agent.AgentChatRequest(**openai_request()))) if False else None
    app = FastAPI(); app.include_router(agent.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json=openai_request())
    result = asyncio.run(run())
    assert result.status_code == 400
    text = result.text + caplog.text
    assert "openai_not_configured" in text
    assert "OPENAI_API_KEY" not in text and "unit-test-key" not in text and "Authorization" not in text


def test_openai_model_validator_rejects_key_like_values_case_insensitively():
    for value in ["sk-test", "SK-test", "https://example.test/model", "bad/model", "bad model", ""]:
        try:
            agent.AgentChatRequest(**{**openai_request(), "openaiModel": value})
        except ValueError:
            pass
        else:
            raise AssertionError(value)


def test_openai_third_round_preserves_every_prior_output_and_tool_result(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    seen = []
    rounds = 0

    def transport(req):
        nonlocal rounds
        if req.url.path == "/automation/worlds/query":
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}})
        assert str(req.url) == "https://api.openai.com/v1/responses"
        body = json.loads(req.content); seen.append(body); rounds += 1
        if rounds == 1:
            return httpx.Response(200, content=sse(function_call(0, "query_world", "call_query", {"kind": "entities"})))
        if rounds == 2:
            return httpx.Response(200, content=sse(function_call(0, "propose_world_commands", "call_propose", {"commands": [COMMAND]})))
        if rounds == 3:
            input_items = body["input"]
            assert [item.get("call_id") for item in input_items if item.get("type") == "function_call_output"] == ["call_query", "call_propose"]
            query_output_index = next(index for index, item in enumerate(input_items) if item.get("type") == "function_call_output" and item.get("call_id") == "call_query")
            propose_output_index = next(index for index, item in enumerate(input_items) if item.get("type") == "function_call_output" and item.get("call_id") == "call_propose")
            query_call_index = next(index for index, item in enumerate(input_items) if item.get("type") == "function_call" and item.get("call_id") == "call_query")
            propose_call_index = next(index for index, item in enumerate(input_items) if item.get("type") == "function_call" and item.get("call_id") == "call_propose")
            assert query_call_index < query_output_index < propose_call_index < propose_output_index
            return httpx.Response(200, content=sse(message(0, "Ready for review.")))
        raise AssertionError("unexpected round")

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    response = asyncio.run(agent.agent_chat(agent.AgentChatRequest(**openai_request())))
    assert response.message == "Ready for review."
    assert len(seen) == 3


async def _safe_openai_round_from_events(events, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    def transport(req):
        assert str(req.url) == "https://api.openai.com/v1/responses"
        return httpx.Response(200, content=sse(events))
    async with original(transport=httpx.MockTransport(transport)) as client:
        return await agent.stream_openai_round(client, agent.build_openai_request("gpt-5.1", "instructions", "prompt", [], [], []), lambda value: value if isinstance(value, dict) else {})


def test_openai_stream_failure_incomplete_error_malformed_eof_refusal_and_cancel_are_safe(monkeypatch):
    cases = [
        ([{"type": "response.failed", "response": {"status": "failed", "error": {"message": "secret upstream body"}}}], "openai_upstream_error"),
        ([{"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}}], "openai_incomplete"),
        ([{"type": "error", "message": "Authorization Bearer sk-secret"}], "openai_stream_error"),
    ]
    for events, code in cases:
        try:
            asyncio.run(_safe_openai_round_from_events(events, monkeypatch))
        except agent.OpenAIBoundaryError as error:
            assert error.code == code
            assert "secret" not in error.safe_message and "Authorization" not in error.safe_message and "sk-" not in error.safe_message
        else:
            raise AssertionError(code)

    malformed = b"event: message\ndata: {not-json}\n\n"
    eof = sse([{"type": "response.output_item.added", "output_index": 0, "item": {"id": "msg", "type": "message", "role": "assistant", "content": []}}])
    for content, code in [(malformed, "openai_malformed_stream"), (eof, "openai_incomplete_stream")]:
        monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
        original = httpx.AsyncClient
        async def run():
            async with original(transport=httpx.MockTransport(lambda _req: httpx.Response(200, content=content))) as client:
                return await agent.stream_openai_round(client, agent.build_openai_request("gpt-5.1", "instructions", "prompt", [], [], []), lambda value: {})
        try:
            asyncio.run(run())
        except agent.OpenAIBoundaryError as error:
            assert error.code == code
        else:
            raise AssertionError(code)

    refusal = asyncio.run(_safe_openai_round_from_events([
        {"type": "response.refusal.delta", "delta": "No."},
        {"type": "response.refusal.done", "refusal": "No."},
        {"type": "response.completed", "response": {"status": "completed", "output": []}},
    ], monkeypatch))
    assert refusal.assistant_message == {"role": "assistant", "content": "OpenAI refused this request. No changes were proposed."}

    try:
        asyncio.run(_safe_openai_round_from_events([
            {"type": "response.refusal.done", "refusal": "No."},
            *function_call(0, "query_world", "call_refusal_tool", {"kind": "entities"}),
        ], monkeypatch))
    except agent.OpenAIBoundaryError as error:
        assert error.code == "openai_malformed_stream"
    else:
        raise AssertionError("refusal plus tool must fail closed")

    async def cancelled():
        raise asyncio.CancelledError()
    try:
        asyncio.run(cancelled())
    except asyncio.CancelledError:
        pass
