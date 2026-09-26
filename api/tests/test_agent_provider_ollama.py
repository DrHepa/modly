import asyncio
import json

import httpx
from routers import agent


def test_ollama_provider_extraction_is_shape_compatible(monkeypatch):
    original = httpx.AsyncClient
    seen = []
    def transport(req):
        body = json.loads(req.content)
        seen.append(body)
        message = {"role": "assistant", "content": "Hello", "thinking": "bounded thought", "tool_calls": []}
        return httpx.Response(200, content=(json.dumps({"message": message, "done": True, "done_reason": "stop"}) + "\n").encode())
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    request = agent.AgentChatRequest(originSessionId="session-a", messages=[{"role": "user", "content": "Hi"}], context={}, model="fixture", ollama_url="http://ollama.test")
    result = asyncio.run(agent.agent_chat(request))
    assert result.message == "Hello"
    assert result.thinking == "bounded thought"
    assert result.actions == [] and result.proposals == []
    assert seen[0]["stream"] is True
