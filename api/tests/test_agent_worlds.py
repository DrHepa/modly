"""Provider NDJSON and query-transport fixtures: real parser/router/tool-loop, not live LLM or sockets."""
import asyncio
import json
import importlib.util
import os
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from routers import agent
from routers import world_ai

CONTEXT = {"schema": "modly.world-ai-context.v1", "projectKey": "world-" + "a" * 32,
           "projectId": "project:demo", "baseRevision": 4, "activeSceneId": "scene:one", "editorEpoch": 1,
           "originSessionId": "session-a", "requestId": "tx:world-ai-one"}
TRANSFORM = {"position": [2, 3, 4], "rotation": [0.1, 0.2, 0.3], "scale": [2, 2, 2]}
COMMAND = {"type": "patch-entity", "sceneId": "scene:one", "entityId": "entity:hero", "patch": {"transform": TRANSFORM}}


def test_worlds_prompt_matches_host_owned_direct_edit_not_manual_review():
    tool = next(item for item in world_ai.tools() if item["function"]["name"] == "propose_world_commands")
    guidance = f'{world_ai.SYSTEM_PROMPT} {tool["function"]["description"]}'
    assert "host validates" in guidance.lower()
    assert "automatically" in guidance.lower()
    assert "active scene" in guidance.lower()
    assert "undo" in guidance.lower()
    assert "never claim" in guidance.lower()
    assert "human review" not in guidance.lower()
    assert "human apply" not in guidance.lower()
    turn = world_ai.WorldAiTurn(world_ai.WorldAiContext.model_validate(CONTEXT))
    turn.entities["entity:hero"] = world_ai.EntityRow.model_validate({"kind": "entity", "id": "entity:hero", "name": "Hero",
        "parentId": None, "enabled": True, "locked": False, "transform": TRANSFORM, "componentCount": 1})
    result = json.loads(turn._propose({"commands": [COMMAND]}))
    assert result["code"] == "world_proposal_recorded"
    assert "host" in result["message"].lower()
    assert "not yet" in result["message"].lower()
    assert "human apply" not in result["message"].lower()


def request():
    return {"originSessionId": "session-a", "messages": [{"role": "user", "content": "Move Hero"}],
            "worldContext": CONTEXT, "context": {}, "model": "fixture-model", "ollama_url": "http://ollama.test"}


def test_worlds_real_ndjson_parser_and_tool_loop_propose_without_actions(monkeypatch):
    original = httpx.AsyncClient
    seen = []
    count = 0

    def transport(req):
        nonlocal count
        body = json.loads(req.content)
        seen.append((str(req.url), body))
        if req.url.path == "/automation/worlds/query":
            assert body["context"] == CONTEXT
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": {**TRANSFORM, "position": [0, 0, 0]}, "componentCount": 1}]}})
        assert req.url.path == "/api/chat"
        assert {tool["function"]["name"] for tool in body["tools"]} == {"query_world", "propose_world_commands"}
        count += 1
        call = ({"name": "query_world", "arguments": {"kind": "entities", "pageSize": 1}} if count == 1
                else {"name": "propose_world_commands", "arguments": {"commands": [COMMAND]}} if count == 2 else None)
        message = {"role": "assistant", "content": "Review the proposed move." if call is None else ""}
        if call:
            message["tool_calls"] = [{"function": call}]
        return httpx.Response(200, content=(json.dumps({"message": message, "done": True}) + "\n").encode())

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    async def run():
        app = FastAPI()
        app.include_router(agent.router)
        async with original(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json=request())
    response = asyncio.run(run())
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["actions"] == [] and data["proposals"] == []
    assert data["worldProposals"] == [{"type": "world_command_proposal", "context": CONTEXT, "commands": [COMMAND]}]
    assert count == 3
    assert seen[-1][1]["messages"][-1]["tool_name"] == "propose_world_commands"


@pytest.mark.parametrize("tool", ["apply_world_commands", "reject_world_commands", "undo_world", "unload_models", "create_workflow"])
def test_worlds_hallucinated_legacy_or_apply_tools_cannot_execute(monkeypatch, tool):
    original = httpx.AsyncClient
    rounds = 0
    def transport(_request):
        nonlocal rounds
        rounds += 1
        message = {"role": "assistant", "content": ""}
        if rounds == 1:
            message["tool_calls"] = [{"function": {"name": tool, "arguments": {}}}]
        return httpx.Response(200, content=(json.dumps({"message": message, "done": True}) + "\n").encode())
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("Worlds turn must not call legacy execution")
    monkeypatch.setattr(agent, "execute_tool", forbidden)
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    result = asyncio.run(agent.agent_chat(agent.AgentChatRequest(**request())))
    assert result.actions == [] and result.proposals == [] and result.worldProposals == []


def test_worlds_rejects_broad_context_and_unknown_fields():
    for extra in [{"context": {"path": "/home/private"}}, {"worldContext": {**CONTEXT, "baseRevision": "4"}},
                  {"worldContext": {**CONTEXT, "apply": True}}, {"originSessionId": "session-b"}]:
        with pytest.raises(ValueError):
            agent.AgentChatRequest(**{**request(), **extra})


def test_worlds_two_page_query_and_current_light_proposal_preserve_fields():
    from routers import world_ai
    turn = world_ai.WorldAiTurn(world_ai.WorldAiContext.model_validate(CONTEXT))
    light = {"id": "component:light", "type": "light", "enabled": True, "lightKind": "spot", "color": "#ffffff",
             "intensity": 1, "castShadow": False, "range": 9, "angle": 0.4}
    cursor = json.dumps([json.dumps([CONTEXT, "entities", None], separators=(",", ":")), 1], separators=(",", ":"))
    seen = []
    def transport(req):
        query = json.loads(req.content)["query"]; seen.append(query)
        if query["kind"] == "components":
            items = [{"kind": "component", "entityId": "entity:hero", "id": light["id"], "type": "light", "enabled": True, "current": light}]
            total, next_cursor = 1, None
        else:
            entity_id = "entity:hero" if query.get("cursor") else "entity:a"
            items = [{"kind": "entity", "id": entity_id, "name": "Hero", "parentId": None, "enabled": True, "locked": False, "transform": TRANSFORM, "componentCount": 1}]
            total, next_cursor = 2, None if query.get("cursor") else cursor
        return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": query["kind"], "items": items, "total": total, "nextCursor": next_cursor}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            first = json.loads(await turn.execute("query_world", {"kind": "entities", "pageSize": 1}, client, agent.AUTOMATION_BRIDGE))
            assert first["total"] == 2 and first["nextCursor"] == cursor
            await turn.execute("query_world", {"kind": "entities", "pageSize": 1, "cursor": first["nextCursor"]}, client, agent.AUTOMATION_BRIDGE)
            await turn.execute("query_world", {"kind": "components", "entityId": "entity:hero"}, client, agent.AUTOMATION_BRIDGE)
            command = {"type": "replace-component", "sceneId": "scene:one", "entityId": "entity:hero", "componentId": light["id"], "component": {**light, "intensity": 3}}
            for invalid in [{**command, "component": {**command["component"], "range": 2}}, {**command, "entityId": "entity:missing"}, {**command, "sceneId": "scene:two"}]:
                assert json.loads(await turn.execute("propose_world_commands", {"commands": [invalid]}, client, agent.AUTOMATION_BRIDGE))["code"] == "world_request_rejected"
            assert not turn.proposals
            assert json.loads(await turn.execute("propose_world_commands", {"commands": [command]}, client, agent.AUTOMATION_BRIDGE))["code"] == "world_proposal_recorded"
            assert json.loads(await turn.execute("propose_world_commands", {"commands": [command]}, client, agent.AUTOMATION_BRIDGE))["code"] == "world_request_rejected"
    asyncio.run(run())
    assert len(seen) == 3 and len(turn.proposals) == 1


@pytest.mark.parametrize("mode", ["error", "exception", "path", "unknown", "stale", "cursor", "large"])
def test_worlds_query_errors_and_responses_never_echo_host_paths(mode):
    from routers import world_ai
    turn = world_ai.WorldAiTurn(world_ai.WorldAiContext.model_validate(CONTEXT))
    def transport(_req):
        if mode == "exception":
            raise httpx.ReadError("Cannot read /home/private/world.json")
        if mode == "error":
            return httpx.Response(500, json={"error": "Cannot read /home/private/world.json"})
        if mode == "large":
            return httpx.Response(200, content=b" " * (world_ai.PAGE_BYTES + 1))
        item = {"kind": "entity", "id": "entity:hero", "name": "/home/private/world.json" if mode == "path" else "Hero",
                "parentId": None, "enabled": True, "locked": False, "transform": TRANSFORM, "componentCount": 1}
        if mode == "unknown":
            item["path"] = "/home/private/world.json"
        return httpx.Response(200, json={"ok": True, "value": {"context": {**CONTEXT, "baseRevision": 5} if mode == "stale" else CONTEXT,
            "kind": "entities", "items": [item], "total": 2, "nextCursor": "/home/private/world.json" if mode == "cursor" else None}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            result = await turn.execute("query_world", {"kind": "entities"}, client, agent.AUTOMATION_BRIDGE)
            assert json.loads(result)["code"] == "world_request_rejected"
            assert "private" not in result and "/home" not in result
            assert not turn.entities and not turn.proposals
    asyncio.run(run())


def test_worlds_limits_are_strict_and_other_tool_depth_is_unchanged():
    from routers import world_ai
    for value in [0, 51, "1", True, 1.5]:
        with pytest.raises(ValueError):
            world_ai.Query.model_validate({"kind": "entities", "pageSize": value})
    for commands in [[], [COMMAND] * 17, [{**COMMAND, "apply": True}], [{**COMMAND, "patch": {"locked": False}}]]:
        with pytest.raises(ValueError):
            world_ai.ProposalArguments.model_validate({"commands": commands})
    full = [{"function": {"name": "propose_world_commands", "arguments": {"commands": [COMMAND]}}}]
    assert agent._normalize_stream_tool_calls(full)
    with pytest.raises(agent.OllamaBoundaryError):
        agent._normalize_stream_tool_calls([{ "function": {"name": "query_world", "arguments": {"commands": [COMMAND]}}}])


def test_creation_c1_actual_tool_turn_observes_resource_and_records_finite_scene_recipe():
    from routers import world_ai
    turn = world_ai.WorldAiTurn(world_ai.WorldAiContext.model_validate(CONTEXT))
    handle = "asset_0123456789abcdef0123456789abcdef"
    row = {"kind": "resource", "id": handle, "name": "Hero", "source": "project", "format": "glb", "capability": "mesh", "fingerprint": "a" * 64, "dependencyCount": 1}
    commands = [
        {"type": "create-scene", "localRef": "stage", "name": "Stage"},
        {"type": "create-entity", "kind": "observed-model", "localRef": "hero", "sceneRef": {"kind": "local", "localRef": "stage"}, "name": "Hero", "resourceHandle": handle},
        {"type": "configure-collider", "sceneRef": {"kind": "local", "localRef": "stage"}, "entityRef": {"kind": "local", "localRef": "hero"}, "collider": {"shape": "box", "halfExtents": [1, 1, 1]}},
        {"type": "configure-body", "sceneRef": {"kind": "local", "localRef": "stage"}, "entityRef": {"kind": "local", "localRef": "hero"}, "body": {"bodyType": "dynamic"}},
    ]
    def transport(req):
        body = json.loads(req.content)
        assert body["context"] == CONTEXT and body["query"]["source"] == "project"
        return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "resources", "items": [row], "total": 1, "nextCursor": None}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            observed = json.loads(await turn.execute("query_world", {"kind": "resources", "source": "project"}, client, agent.AUTOMATION_BRIDGE))
            assert observed.get("items") == [row], "The existing query tool must expose an actual opaque resource observation"
            result = json.loads(await turn.execute("propose_world_commands", {"commands": commands}, client, agent.AUTOMATION_BRIDGE))
            assert result["code"] == "world_proposal_recorded", "The existing proposal tool must record a real finite creation recipe"
    asyncio.run(run())
    assert len(turn.proposals) == 1
    assert turn.proposals[0].model_dump(by_alias=True, exclude_unset=True)["commands"] == commands


def test_creation_c2_actual_dto_admits_camera_light_and_local_parent_without_other_tool_depth_expansion():
    from routers import world_ai
    scene = {"kind": "existing", "id": "scene:one"}
    commands = [
        {"type": "create-entity", "kind": "group", "localRef": "actors", "sceneRef": scene, "name": "Actors"},
        {"type": "create-entity", "kind": "camera", "localRef": "shot", "sceneRef": scene, "parentRef": {"kind": "local", "localRef": "actors"}, "name": "Shot", "camera": {"projection": "orthographic", "orthographicSize": 8, "near": 0.1, "far": 100}},
        {"type": "create-entity", "kind": "light", "localRef": "key", "sceneRef": scene, "name": "Key", "light": {"lightKind": "spot", "range": 10, "angle": 0.5, "color": "#ffffff", "intensity": 2, "castShadow": True}},
    ]
    try:
        parsed = world_ai.ProposalArguments.model_validate({"commands": commands})
    except ValueError:
        pytest.fail("Finite camera/light/local-parent authoring must be admitted by the actual strict proposal DTO")
    assert parsed.model_dump(exclude_unset=True)["commands"] == commands
    assert agent._normalize_stream_tool_calls([{"function": {"name": "propose_world_commands", "arguments": {"commands": commands}}}])
    with pytest.raises(ValueError):
        world_ai.Query.model_validate({"kind": "entities", "commands": commands})

    depth_commands = [*commands, {
        "type": "configure-collider", "sceneRef": scene,
        "entityRef": {"kind": "local", "localRef": "actors"},
        "collider": {"shape": "box", "halfExtents": [1, 2, 3]},
    }]
    depth_arguments = {"commands": depth_commands}
    depth_parsed = world_ai.ProposalArguments.model_validate(depth_arguments)
    assert depth_parsed.model_dump(exclude_unset=True)["commands"] == depth_commands
    normalized = agent._normalize_stream_tool_calls([
        {"function": {"name": "propose_world_commands", "arguments": depth_arguments}},
    ])
    assert normalized[0]["function"]["arguments"] == depth_arguments
    with pytest.raises(agent.OllamaBoundaryError):
        agent._normalize_stream_tool_calls([
            {"function": {"name": "query_world", "arguments": depth_arguments}},
        ])


def test_creation_required_parent_null_survives_actual_chat_response(monkeypatch):
    original = httpx.AsyncClient
    rounds = 0
    command = {"type": "reparent", "sceneRef": {"kind": "existing", "id": "scene:one"},
               "entityRef": {"kind": "existing", "id": "entity:hero"}, "parentRef": None}

    def transport(req):
        nonlocal rounds
        if req.url.path == "/automation/worlds/query":
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": "entity:actors", "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}})
        rounds += 1
        call = ({"name": "query_world", "arguments": {"kind": "entities"}} if rounds == 1 else
                {"name": "propose_world_commands", "arguments": {"commands": [command]}} if rounds == 2 else None)
        message = {"role": "assistant", "content": "Review the detach." if call is None else ""}
        if call:
            message["tool_calls"] = [{"function": call}]
        return httpx.Response(200, content=(json.dumps({"message": message, "done": True}) + "\n").encode())

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    async def run():
        app = FastAPI()
        app.include_router(agent.router)
        async with original(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json=request())
    response = asyncio.run(run())
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["worldProposals"][0]["commands"] == [command], "Required semantic null must survive the actual typed route serializer"
    assert data["actions"] == [] and data["proposals"] == [] and rounds == 3


def test_creation_catalog_handle_does_not_guess_private_resource_expansion():
    from routers import world_ai
    turn = world_ai.WorldAiTurn(world_ai.WorldAiContext.model_validate(CONTEXT))
    handle = "asset_0123456789abcdef0123456789abcdef"
    row = {"kind": "resource", "id": handle, "name": "Hero", "source": "workflows", "format": "glb", "capability": "mesh", "fingerprint": "a" * 64, "dependencyCount": 1}
    commands = [{"type": "create-entity", "kind": "observed-model", "localRef": f"model{index}",
                 "sceneRef": {"kind": "existing", "id": "scene:one"}, "name": "Model", "resourceHandle": handle} for index in range(16)]
    def transport(_req):
        return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "resources", "items": [row], "total": 1, "nextCursor": None}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            await turn.execute("query_world", {"kind": "resources", "source": "workflows"}, client, agent.AUTOMATION_BRIDGE)
            result = json.loads(await turn.execute("propose_world_commands", {"commands": commands}, client, agent.AUTOMATION_BRIDGE))
            assert result["code"] == "world_proposal_recorded", "Only the host can count canonical resource reuse from private paths"
    asyncio.run(run())
    assert len(turn.proposals) == 1


@pytest.mark.parametrize("options", [
    {"kind": "camera", "camera": None}, {"kind": "camera", "camera": {"primary": True}},
    {"kind": "camera", "camera": {"near": "1"}}, {"kind": "camera", "camera": {"near": 10, "far": 1}},
    {"kind": "camera", "camera": {"projection": "orthographic", "fieldOfView": 60}},
    {"kind": "light", "light": {"lightKind": "ambient", "castShadow": True}},
    {"kind": "observed-model", "resourceHandle": "resource:model"},
])
def test_creation_strict_finite_options_reject_unknown_null_coercion_and_wrong_variants(options):
    from routers import world_ai
    command = {"type": "create-entity", "kind": "group", "localRef": "item", "sceneRef": {"kind": "existing", "id": "scene:one"}, "name": "Item", **options}
    with pytest.raises(ValueError):
        world_ai.ProposalArguments.model_validate({"commands": [command]})


def test_creation_required_null_serializer_leaves_legacy_and_optional_omission_unchanged():
    from routers import world_ai
    legacy = world_ai.WorldProposal(context=world_ai.WorldAiContext.model_validate(CONTEXT), commands=[COMMAND])
    assert legacy.model_dump(by_alias=True, exclude_none=True)["commands"] == [COMMAND]
    group = {"type": "create-entity", "kind": "group", "localRef": "group", "sceneRef": {"kind": "existing", "id": "scene:one"}, "name": "Group"}
    proposal = world_ai.WorldProposal(context=world_ai.WorldAiContext.model_validate(CONTEXT), commands=[group])
    assert proposal.model_dump(by_alias=True, exclude_none=True)["commands"] == [group]


@pytest.mark.parametrize("create_new_scene", [False, True], ids=["active-existing-scene", "prior-new-scene"])
def test_creation_explicit_root_parent_null_records_actual_turn_and_dto(create_new_scene):
    from routers import world_ai
    commands = ([{"type": "create-scene", "localRef": "stage", "name": "Stage"}] if create_new_scene else []) + [
        {"type": "create-entity", "kind": "group", "localRef": "root", "name": "Root", "parentRef": None,
         "sceneRef": {"kind": "local", "localRef": "stage"} if create_new_scene else {"kind": "existing", "id": "scene:one"},
         "transform": TRANSFORM},
    ]
    turn = world_ai.WorldAiTurn(world_ai.WorldAiContext.model_validate(CONTEXT))

    def transport(_req):
        return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "items": [], "total": 0, "nextCursor": None}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            queried = json.loads(await turn.execute("query_world", {"kind": "entities"}, client, agent.AUTOMATION_BRIDGE))
            assert queried["kind"] == "entities"
            result = json.loads(await turn.execute("propose_world_commands", {"commands": commands}, client, agent.AUTOMATION_BRIDGE))
            assert result["code"] == "world_proposal_recorded", "Explicit nullable creation parent means root, not an invalid optional field"

    asyncio.run(run())
    assert len(turn.proposals) == 1
    parsed = world_ai.ProposalArguments.model_validate({"commands": commands})
    assert parsed.model_dump(exclude_unset=True)["commands"] == commands
    serialized = turn.proposals[0].model_dump(by_alias=True, exclude_none=True)["commands"]
    expected = [{key: value for key, value in command.items() if value is not None} for command in commands]
    assert serialized == expected, "Optional creation parent null may omit because both representations mean root"


def _load_owned_bridge_startup(environment):
    """Execute the real router startup in an isolated namespace and memory-only environment."""
    name = "routers._owned_bridge_startup_control"
    spec = importlib.util.spec_from_file_location(name, agent.__file__)
    module = importlib.util.module_from_spec(spec)
    with patch.object(os, "environ", dict(environment)), patch.dict(sys.modules, {name: module}):
        spec.loader.exec_module(module)
    return module


@contextmanager
def _owned_bridge_query_server():
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append((self.path, self.headers["Host"], body))
            assert self.path == "/automation/worlds/query"
            assert self.headers["Host"] == "127.0.0.1:" + str(self.server.server_port)
            assert self.headers["Content-Type"] == "application/json"
            assert self.headers.get("Authorization") is None and self.headers.get("Cookie") is None
            assert body["context"] == CONTEXT
            payload = json.dumps({"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port), seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)
        assert not thread.is_alive(), "Owned bridge control must close its own socket and thread"
        assert server.socket.fileno() == -1


def test_bridge_startup_unset_preserves_default():
    loaded = _load_owned_bridge_startup({})
    assert loaded.AUTOMATION_BRIDGE == "http://127.0.0.1:8766", "Unset startup config must retain the exact legacy default without I/O"


def test_bridge_startup_explicit_loopback_origin():
    with _owned_bridge_query_server() as (origin, seen):
        loaded = _load_owned_bridge_startup({"MODLY_AUTOMATION_BRIDGE_ORIGIN": origin})
        assert loaded.AUTOMATION_BRIDGE == origin, "Real router startup must bind the explicit still-owned loopback origin"
        assert seen == []
        for valid in ["http://127.0.0.1:1", "http://127.0.0.1:65535"]:
            assert _load_owned_bridge_startup({"MODLY_AUTOMATION_BRIDGE_ORIGIN": valid}).AUTOMATION_BRIDGE == valid


def test_bridge_startup_invalid_origin_has_zero_external_requests(monkeypatch):
    attempts = []

    def forbidden_client(**kwargs):
        attempts.append(kwargs)
        raise AssertionError("Invalid startup origin must fail before HTTP client creation")

    monkeypatch.setattr(httpx, "AsyncClient", forbidden_client)
    for invalid in ["", "http://localhost:43123", "https://127.0.0.1:43123", "http://127.0.0.1:0", "http://127.0.0.1:01",
                    "http://127.0.0.1:65536", "http://127.0.0.1:43123/", "http://127.0.0.1:43123?q=1", "http://127.0.0.1:43123#x",
                    "http://user@127.0.0.1:43123", " http://127.0.0.1:43123", "http://127.0.0.1:43123\n", "http://127.0.0.1:４"]:
        with pytest.raises(ValueError, match="bridge origin"):
            _load_owned_bridge_startup({"MODLY_AUTOMATION_BRIDGE_ORIGIN": invalid})
    assert attempts == []


def test_worlds_configured_owned_bridge_query_and_propose_authority(monkeypatch):
    original = httpx.AsyncClient
    with _owned_bridge_query_server() as (origin, seen):
        loaded = _load_owned_bridge_startup({"MODLY_AUTOMATION_BRIDGE_ORIGIN": origin})
        assert loaded.AUTOMATION_BRIDGE == origin, "Configured canonical router queries must never target the fixed default occupant"
        rounds = []

        class OwnedTransport(httpx.AsyncBaseTransport):
            def __init__(self):
                self.query_transport = httpx.AsyncHTTPTransport(trust_env=False)

            async def handle_async_request(self, req):
                if str(req.url) == origin + "/automation/worlds/query":
                    assert req.method == "POST"
                    return await self.query_transport.handle_async_request(req)
                assert str(req.url) == "http://ollama.test/api/chat", "Unknown destinations are rejected before network I/O"
                body = json.loads(req.content)
                assert {tool["function"]["name"] for tool in body["tools"]} == {"query_world", "propose_world_commands"}
                rounds.append(body)
                call = ({"name": "query_world", "arguments": {"kind": "entities", "pageSize": 1}} if len(rounds) == 1
                        else {"name": "propose_world_commands", "arguments": {"commands": [COMMAND]}} if len(rounds) == 2 else None)
                message = {"role": "assistant", "content": "Review the owned-query proposal." if call is None else ""}
                if call:
                    message["tool_calls"] = [{"function": call}]
                return httpx.Response(200, content=(json.dumps({"message": message, "done": True}) + "\n").encode())

            async def aclose(self):
                await self.query_transport.aclose()

        async def forbidden_execution(*_args, **_kwargs):
            raise AssertionError("Configured bridge adds transport configuration, never apply or legacy authority")

        monkeypatch.setattr(loaded, "execute_tool", forbidden_execution)
        monkeypatch.setattr(loaded.httpx, "AsyncClient", lambda **kwargs: original(transport=OwnedTransport(), trust_env=False, **kwargs))
        result = asyncio.run(loaded.agent_chat(loaded.AgentChatRequest(**request())))
        assert result.actions == [] and result.proposals == []
        assert [proposal.model_dump(by_alias=True, exclude_none=True) for proposal in result.worldProposals] == [
            {"type": "world_command_proposal", "context": CONTEXT, "commands": [COMMAND]}]
        assert len(rounds) == 3 and len(seen) == 1
        assert seen[0][2] == {"context": CONTEXT, "query": {"kind": "entities", "pageSize": 1}}
        with pytest.raises(ValueError):
            loaded.AgentChatRequest(**{**request(), "MODLY_AUTOMATION_BRIDGE_ORIGIN": "http://127.0.0.1:1"})


def test_openai_requires_world_context_and_rejects_generic_direct_action_turns_before_provider_call(monkeypatch):
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("OpenAI provider must not be called for generic/direct-action turns")
    monkeypatch.setattr(agent, "_run_openai_worlds_chat", forbidden)
    app = FastAPI(); app.include_router(agent.router)
    async def run(body):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json=body)
    generic = {"originSessionId": "session-a", "messages": [{"role": "user", "content": "Unload models"}],
               "provider": "openai", "openaiModel": "gpt-5.1", "context": {"currentMeshRef": "/workspace/a.glb"}}
    response = asyncio.run(run(generic))
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "openai_worlds_only"
    broad = {**request(), "provider": "openai", "openaiModel": "gpt-5.1", "context": {"currentMeshRef": "/workspace/a.glb"}}
    assert asyncio.run(run(broad)).status_code == 422


def _openai_sse(events):
    return "".join(f"event: {event.get('type', 'message')}\n: ignored comment\ndata: {json.dumps(event)}\n\n" for event in events).encode()


def _openai_function_call(index, name, call_id, arguments):
    item = {"id": f"fc_asgi_{index}", "type": "function_call", "name": name, "call_id": call_id, "arguments": json.dumps(arguments, separators=(",", ":"))}
    return [
        {"type": "response.output_item.added", "output_index": index, "item": item},
        {"type": "response.function_call_arguments.done", "output_index": index, "arguments": item["arguments"]},
        {"type": "response.output_item.done", "output_index": index, "item": item},
        {"type": "response.completed", "response": {"status": "completed", "output": [item]}},
    ]


def _openai_message(index, text):
    item = {"id": f"msg_asgi_{index}", "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}
    return [
        {"type": "response.output_item.added", "output_index": index, "item": item},
        {"type": "response.output_text.done", "output_index": index, "text": text},
        {"type": "response.output_item.done", "output_index": index, "item": item},
        {"type": "response.completed", "response": {"status": "completed", "output": [item]}},
    ]


def test_openai_worlds_asgi_tool_loop_crosses_query_proposal_preview_contract(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    openai_bodies = []
    worlds_queries = []
    rounds = 0

    def transport(req):
        nonlocal rounds
        if req.url.path == "/automation/worlds/query":
            body = json.loads(req.content); worlds_queries.append(body)
            assert body == {"context": CONTEXT, "query": {"kind": "entities", "pageSize": 50}}
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}})
        assert str(req.url) == "https://api.openai.com/v1/responses"
        body = json.loads(req.content); openai_bodies.append(body); rounds += 1
        assert body["store"] is False and body["parallel_tool_calls"] is False and "previous_response_id" not in body
        if rounds == 1:
            return httpx.Response(200, content=_openai_sse(_openai_function_call(0, "query_world", "call_query", {"kind": "entities"})))
        if rounds == 2:
            return httpx.Response(200, content=_openai_sse(_openai_function_call(0, "propose_world_commands", "call_propose", {"commands": [COMMAND]})))
        if rounds == 3:
            input_items = body["input"]
            assert [item.get("call_id") for item in input_items if item.get("type") == "function_call_output"] == ["call_query", "call_propose"]
            return httpx.Response(200, content=_openai_sse(_openai_message(0, "Review the proposed move.")))
        raise AssertionError("unexpected OpenAI round")

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    app = FastAPI(); app.include_router(agent.router)
    body = {**request(), "provider": "openai", "openaiModel": "gpt-5.1"}
    async def run():
        async with original(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json=body)
    response = asyncio.run(run())
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["message"] == "Review the proposed move."
    assert data["actions"] == [] and data["proposals"] == []
    assert data["worldProposals"] == [{"type": "world_command_proposal", "context": CONTEXT, "commands": [COMMAND]}]
    assert len(worlds_queries) == 1 and len(openai_bodies) == 3


def test_openai_request_rejects_key_like_body_fields_and_images_before_provider(monkeypatch):
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("OpenAI provider must not run for rejected request bodies")
    monkeypatch.setattr(agent, "_run_openai_worlds_chat", forbidden)
    app = FastAPI(); app.include_router(agent.router)
    base = {**request(), "provider": "openai", "openaiModel": "gpt-5.1"}
    async def post(body):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json=body)
    for key in ["OPENAI_API_KEY", "apiKey", "authorization", "openaiApiKey"]:
        response = asyncio.run(post({**base, key: "sk-should-not-enter"}))
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "openai_key_fields_unsupported"
        assert "sk-should-not-enter" not in response.text
    image_response = asyncio.run(post({**base, "messages": [{"role": "user", "content": "Describe", "images": ["data:image/png;base64,AA=="]}]}))
    assert image_response.status_code == 400
    assert image_response.json()["detail"]["code"] == "openai_images_unsupported"


@pytest.mark.parametrize("terminal", ["refusal", "refusal_item", "failed", "incomplete", "malformed", "eof"])
def test_openai_worlds_prior_proposal_fails_closed_on_noncompletion(monkeypatch, terminal):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    rounds = 0
    queries = 0

    def transport(req):
        nonlocal rounds, queries
        if req.url.path == "/automation/worlds/query":
            queries += 1
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}})
        assert str(req.url) == "https://api.openai.com/v1/responses"
        rounds += 1
        if rounds == 1:
            return httpx.Response(200, content=_openai_sse(_openai_function_call(0, "query_world", "call_query", {"kind": "entities"})))
        if rounds == 2:
            return httpx.Response(200, content=_openai_sse(_openai_function_call(0, "propose_world_commands", "call_propose", {"commands": [COMMAND]})))
        assert rounds == 3
        endings = {
            "refusal": _openai_sse([{"type": "response.refusal.done", "refusal": "private refusal"},
                                   {"type": "response.completed", "response": {"status": "completed", "output": []}}]),
            "refusal_item": _openai_sse([{"type": "response.completed", "response": {"status": "completed", "output": [
                {"type": "message", "role": "assistant", "content": [{"type": "refusal", "refusal": "private refusal"}]}]}}]),
            "failed": _openai_sse([{"type": "response.failed", "response": {"status": "failed", "error": {"message": "private upstream"}}}]),
            "incomplete": _openai_sse([{"type": "response.incomplete", "response": {"status": "incomplete"}}]),
            "malformed": b"event: message\ndata: {not-json}\n\n",
            "eof": _openai_sse([{"type": "response.output_item.added", "output_index": 0, "item": {"type": "message", "role": "assistant", "content": []}}]),
        }
        return httpx.Response(200, content=endings[terminal])

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    app = FastAPI(); app.include_router(agent.router)
    async def run():
        async with original(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json={**request(), "provider": "openai", "openaiModel": "gpt-5.1"})
    response = asyncio.run(run())
    data = response.json()
    assert rounds == 3 and queries == 1
    if terminal in {"refusal", "refusal_item"}:
        assert response.status_code == 200, response.text
        assert data["actions"] == data["proposals"] == data["worldProposals"] == []
    else:
        assert response.status_code == 502, response.text
        assert data["detail"]["actions"] == data["detail"]["proposals"] == []
        assert not data["detail"].get("worldProposals")
    assert "private" not in response.text and "unit-test-key" not in response.text


def test_openai_worlds_nine_completed_calls_rejected_before_any_world_query(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    queries = 0
    calls = [{"id": f"fc_{index}", "type": "function_call", "name": "query_world", "call_id": f"call_{index}",
              "arguments": '{"kind":"entities"}'} for index in range(9)]

    def transport(req):
        nonlocal queries
        if req.url.path == "/automation/worlds/query":
            queries += 1
            raise AssertionError("Nine-call round must not execute any Worlds query")
        return httpx.Response(200, content=_openai_sse([{"type": "response.completed", "response": {"status": "completed", "output": calls}}]))

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    app = FastAPI(); app.include_router(agent.router)
    async def run():
        async with original(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json={**request(), "provider": "openai", "openaiModel": "gpt-5.1"})
    response = asyncio.run(run())
    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "openai_tool_limit_exceeded"
    assert queries == 0


def test_openai_worlds_ten_round_exhaustion_cannot_return_prior_proposal(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    rounds = 0

    def transport(req):
        nonlocal rounds
        if req.url.path == "/automation/worlds/query":
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}})
        rounds += 1
        if rounds == 2:
            events = _openai_function_call(0, "propose_world_commands", "call_propose", {"commands": [COMMAND]})
        else:
            events = _openai_function_call(0, "query_world", f"call_query_{rounds}", {"kind": "entities"})
        return httpx.Response(200, content=_openai_sse(events))

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    app = FastAPI(); app.include_router(agent.router)
    async def run():
        async with original(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json={**request(), "provider": "openai", "openaiModel": "gpt-5.1"})
    response = asyncio.run(run())
    assert rounds == 10
    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "openai_round_limit_exceeded"
    assert response.json()["detail"]["actions"] == response.json()["detail"]["proposals"] == []
    assert not response.json()["detail"].get("worldProposals")


def test_openai_worlds_inflight_stream_route_cancellation_has_no_partial_preview(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-key")
    original = httpx.AsyncClient
    reached_stream = asyncio.Event()
    rounds = 0
    delivered = []

    class WaitingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield _openai_sse([{"type": "response.output_item.added", "output_index": 0,
                                "item": {"type": "message", "role": "assistant", "content": []}}])
            reached_stream.set()
            await asyncio.Event().wait()

        async def aclose(self):
            pass

    def transport(req):
        nonlocal rounds
        if req.url.path == "/automation/worlds/query":
            return httpx.Response(200, json={"ok": True, "value": {"context": CONTEXT, "kind": "entities", "total": 1, "nextCursor": None,
                "items": [{"kind": "entity", "id": "entity:hero", "name": "Hero", "parentId": None, "enabled": True, "locked": False,
                           "transform": TRANSFORM, "componentCount": 1}]}})
        rounds += 1
        if rounds == 1:
            return httpx.Response(200, content=_openai_sse(_openai_function_call(0, "query_world", "call_query", {"kind": "entities"})))
        if rounds == 2:
            return httpx.Response(200, content=_openai_sse(_openai_function_call(0, "propose_world_commands", "call_propose", {"commands": [COMMAND]})))
        assert rounds == 3
        return httpx.Response(200, stream=WaitingStream())

    async def forbidden_apply(*_args, **_kwargs):
        raise AssertionError("OpenAI Worlds route must never Apply")

    monkeypatch.setattr(agent, "execute_tool", forbidden_apply)
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    app = FastAPI(); app.include_router(agent.router)
    async def run():
        async with original(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            async def post():
                delivered.append(await client.post("/agent/chat", json={**request(), "provider": "openai", "openaiModel": "gpt-5.1"}))
            task = asyncio.create_task(post())
            await asyncio.wait_for(reached_stream.wait(), timeout=2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=2)
    asyncio.run(run())
    assert rounds == 3
    assert delivered == [], "No response or partial proposal may escape a cancelled route task"
