import asyncio
import json

import pytest

from routers import agent


MODEL_LEASE_ID = "model-lease-direct-actions"


def run(coro):
    return asyncio.run(coro)


def chat_request(**values):
    return agent.AgentChatRequest(modelLeaseId=MODEL_LEASE_ID, **values)


def branch_graph(pair_count: int = 12) -> dict:
    nodes = [
        {
            "key": "source",
            "kind": "builtin",
            "type": "meshNode",
            "enabled": True,
            "showInGenerate": True,
            "params": {"source": "current"},
        }
    ]
    edges = []
    for branch in ("left", "right"):
        previous = "source"
        for index in range(pair_count):
            for suffix, node_type in (
                ("repair", "mesh-repair/repair"),
                ("filter", "pymeshlab/pymeshlab"),
            ):
                key = f"{branch}-{index}-{suffix}"
                nodes.append({
                    "key": key,
                    "kind": "extension",
                    "type": node_type,
                    "enabled": True,
                    "showInGenerate": False,
                    "params": {},
                })
                edges.append({"source": previous, "target": key})
                previous = key
        output = f"{branch}-output"
        nodes.append({
            "key": output,
            "kind": "builtin",
            "type": "outputNode",
            "enabled": True,
            "showInGenerate": False,
            "params": {},
        })
        edges.append({"source": previous, "target": output})
    return {
        "schema": "modly.agent-workflow-graph",
        "version": 1,
        "name": "Two repair branches",
        "description": "Two branches with twelve repeated repair/filter pairs each.",
        "nodes": nodes,
        "edges": edges,
    }


def test_direct_tool_allowlist_is_exposed_independently_from_governed_capabilities():
    tools_without_capabilities = agent._build_tools([])
    names_without = [tool["function"]["name"] for tool in tools_without_capabilities]
    assert set(agent.DIRECT_ACTION_TOOL_NAMES) == {
        "create_workflow",
        "run_workflow",
        "smooth_mesh",
        "decimate_mesh",
        "unload_models",
    }
    assert set(agent.DIRECT_ACTION_TOOL_NAMES).issubset(names_without)
    assert "propose_capability_action" not in names_without

    capability = agent.AgentCapabilityPromptView(
        id="text-to-cad/generate",
        hash="a" * 64,
        name="Text to CAD",
        description="Generate CAD.",
        inputHints=[],
    )
    names_with = [tool["function"]["name"] for tool in agent._build_tools([capability])]
    assert names_with.count("propose_capability_action") == 1
    assert set(agent.DIRECT_ACTION_TOOL_NAMES).issubset(names_with)
    for tool in tools_without_capabilities:
        if tool["function"]["name"] in agent.DIRECT_ACTION_TOOL_NAMES:
            assert tool["function"]["parameters"]["additionalProperties"] is False


def test_prompt_discloses_only_the_direct_allowlist_and_keeps_process_mcp_actions_governed():
    for name in agent.DIRECT_ACTION_TOOL_NAMES:
        assert name in agent.SYSTEM_PROMPT
    assert "current request explicitly asks" in agent.SYSTEM_PROMPT
    assert "Text-to-CAD and Blender" in agent.SYSTEM_PROMPT
    assert "exclusive to propose_capability_action" in agent.SYSTEM_PROMPT
    assert "separate later user turn" in agent.SYSTEM_PROMPT
    assert "one direct action" in agent.SYSTEM_PROMPT


def test_stream_boundary_preserves_a_complete_create_workflow_graph():
    graph = branch_graph()

    normalized = agent._normalize_stream_tool_calls([{
        "function": {"name": "create_workflow", "arguments": {"graph": graph}},
    }])

    assert normalized[0]["function"]["arguments"]["graph"] == graph


@pytest.mark.parametrize(
    ("name", "arguments", "context", "payload_type"),
    [
        ("unload_models", {}, {}, "models_unloaded"),
        (
            "smooth_mesh",
            {"asset_ref": "/workspace/Workflows/mesh.glb", "iterations": 20},
            {"currentMeshRef": "/workspace/Workflows/mesh.glb"},
            "mesh_operation",
        ),
        (
            "decimate_mesh",
            {"asset_ref": "/workspace/Workflows/mesh.glb", "target_faces": 500_000},
            {"currentMeshRef": "/workspace/Workflows/mesh.glb"},
            "mesh_operation",
        ),
        (
            "run_workflow",
            {"workflow_id": "workflow-1"},
            {"workflows": [{"id": "workflow-1", "name": "Ready workflow"}]},
            "run_workflow",
        ),
        ("create_workflow", {"graph": branch_graph()}, {}, "create_workflow"),
    ],
)
def test_direct_tools_emit_typed_intents_without_constructing_an_http_client(
    monkeypatch,
    name,
    arguments,
    context,
    payload_type,
):
    monkeypatch.setattr(
        agent.httpx,
        "AsyncClient",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("direct intents must not call downstream APIs")),
    )

    result_text, payload = run(agent.execute_tool(name, arguments, context))

    assert json.loads(result_text)["code"] == "direct_action_recorded"
    assert payload["type"] == payload_type
    assert payload["actionId"].startswith("direct-")
    assert len(payload["actionId"]) == len("direct-") + 32
    assert "actionId" not in arguments
    if name == "create_workflow":
        assert payload["graph"] == branch_graph()
        assert len(payload["graph"]["nodes"]) == 51
        assert len(payload["graph"]["edges"]) == 50


@pytest.mark.parametrize(
    ("name", "arguments", "context"),
    [
        ("smooth_mesh", {"asset_ref": "/workspace/a.glb", "iterations": 0}, {"currentMeshRef": "/workspace/a.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/a.glb", "iterations": 21}, {"currentMeshRef": "/workspace/a.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/a.glb", "iterations": 1, "actionId": "model-id"}, {"currentMeshRef": "/workspace/a.glb"}),
        ("decimate_mesh", {"asset_ref": "/workspace/a.glb", "target_faces": 99}, {"currentMeshRef": "/workspace/a.glb"}),
        ("decimate_mesh", {"asset_ref": "/workspace/a.glb", "target_faces": 500_001}, {"currentMeshRef": "/workspace/a.glb"}),
        ("smooth_mesh", {"asset_ref": "/home/user/a.glb", "iterations": 1}, {"currentMeshRef": "/home/user/a.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/../a.glb", "iterations": 1}, {"currentMeshRef": "/workspace/../a.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/%2e%2e/a.glb", "iterations": 1}, {"currentMeshRef": "/workspace/%2e%2e/a.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/a\\b.glb", "iterations": 1}, {"currentMeshRef": "/workspace/a\\b.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/a\nb.glb", "iterations": 1}, {"currentMeshRef": "/workspace/a\nb.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/a\x7fb.glb", "iterations": 1}, {"currentMeshRef": "/workspace/a\x7fb.glb"}),
        ("smooth_mesh", {"asset_ref": "/workspace/a.glb", "iterations": 1}, {"currentMeshRef": "/workspace/other.glb"}),
        ("run_workflow", {"workflow_id": "missing"}, {"workflows": [{"id": "workflow-1", "name": "Ready"}]}),
        ("run_workflow", {"workflow_id": "workflow-1", "workflow_name": "model supplied"}, {"workflows": [{"id": "workflow-1", "name": "Ready"}]}),
        ("unload_models", {"unexpected": True}, {}),
        ("create_workflow", {"graph": {**branch_graph(), "unexpected": True}}, {}),
    ],
)
def test_direct_tool_arguments_fail_closed_on_bounds_identity_paths_and_extra_keys(name, arguments, context):
    result_text, payload = run(agent.execute_tool(name, arguments, context))
    assert json.loads(result_text)["code"] == "invalid_direct_action"
    assert payload is None


@pytest.mark.parametrize("endpoint", ["constructor", "prototype", "__proto__"])
@pytest.mark.parametrize("field", ["source", "target"])
def test_workflow_graph_edges_reject_unsafe_endpoints_with_renderer_parity(field, endpoint):
    graph = branch_graph(pair_count=1)
    graph["edges"][0][field] = endpoint

    result_text, payload = run(agent.execute_tool("create_workflow", {"graph": graph}, {}))

    assert json.loads(result_text)["code"] == "invalid_direct_action"
    assert payload is None


def test_unknown_mutations_still_require_governed_capabilities_without_downstream_calls(monkeypatch):
    monkeypatch.setattr(
        agent.httpx,
        "AsyncClient",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("unknown tools must not call downstream APIs")),
    )
    result_text, payload = run(agent.execute_tool("invented_mutation", {}, {}))
    assert json.loads(result_text) == agent.GOVERNED_ACTION_REQUIRED_RESULT
    assert payload is None


def test_success_and_terminal_serialization_preserve_the_public_workflow_graph_discriminator():
    _, payload = run(agent.execute_tool("create_workflow", {"graph": branch_graph()}, {}))
    action = agent.ActionDone(tool="create_workflow", result="recorded", payload=payload)

    serialized = agent._serialize_actions([action])
    success = agent.AgentChatResponse(message="created", actions=[action]).model_dump(
        by_alias=True,
        exclude_none=True,
    )

    assert serialized[0]["payload"]["graph"]["schema"] == "modly.agent-workflow-graph"
    assert "schema_" not in serialized[0]["payload"]["graph"]
    assert success["actions"][0]["payload"]["graph"]["schema"] == "modly.agent-workflow-graph"


@pytest.mark.parametrize(
    "tool_calls",
    [
        [
            {"function": {"name": "unload_models", "arguments": {}}},
            {"function": {"name": "unload_models", "arguments": {}}},
        ],
        [
            {"function": {"name": "create_workflow", "arguments": {"graph": branch_graph()}}},
            {"function": {"name": "create_workflow", "arguments": {"graph": branch_graph()}}},
        ],
        [
            {"function": {"name": "create_workflow", "arguments": {"graph": branch_graph()}}},
            {"function": {"name": "run_workflow", "arguments": {"workflow_id": "workflow-1"}}},
        ],
    ],
)
def test_second_direct_tool_call_suppresses_the_entire_executable_batch(monkeypatch, tool_calls):
    rounds = []

    async def fake_stream(_client, _url, payload, round_number):
        rounds.append(json.loads(json.dumps(payload)))
        if round_number == 1:
            return {"role": "assistant", "content": "", "tool_calls": tool_calls}
        return {"role": "assistant", "content": "No direct action was retained."}

    monkeypatch.setattr(agent, "_stream_ollama_round", fake_stream)
    response = run(agent.agent_chat(chat_request(
        messages=[],
        context={"workflows": [{"id": "workflow-1", "name": "Ready workflow"}]},
    )))

    assert response.actions == []
    assert json.loads(rounds[1]["messages"][-1]["content"])["code"] == "direct_action_batch_rejected"


def test_second_direct_tool_call_in_a_later_round_still_suppresses_the_batch(monkeypatch):
    async def fake_stream(_client, _url, _payload, round_number):
        if round_number in {1, 2}:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"function": {"name": "unload_models", "arguments": {}}}],
            }
        return {"role": "assistant", "content": "No direct action was retained."}

    monkeypatch.setattr(agent, "_stream_ollama_round", fake_stream)
    response = run(agent.agent_chat(chat_request(messages=[])))

    assert response.actions == []


def test_governed_proposal_does_not_count_as_a_second_direct_action(monkeypatch):
    capability = agent.AgentCapabilityPromptView(
        id="text-to-cad/generate",
        hash="a" * 64,
        name="Text to CAD",
        description="Generate CAD.",
        inputHints=[],
    )

    async def fake_stream(_client, _url, _payload, round_number):
        if round_number == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"function": {"name": "unload_models", "arguments": {}}},
                    {"function": {"name": "propose_capability_action", "arguments": {
                        "capability_id": "text-to-cad/generate",
                        "arguments": {"input": "chair"},
                    }}},
                ],
            }
        return {"role": "assistant", "content": "Recorded separately."}

    monkeypatch.setattr(agent, "_stream_ollama_round", fake_stream)
    response = run(agent.agent_chat(chat_request(messages=[], capabilities=[capability])))

    assert [action.tool for action in response.actions] == ["unload_models"]
    assert len(response.proposals) == 1


def test_terminal_error_after_a_second_direct_call_contains_no_executable_batch(monkeypatch):
    async def fake_stream(_client, _url, _payload, round_number):
        if round_number == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"function": {"name": "unload_models", "arguments": {}}},
                    {"function": {"name": "smooth_mesh", "arguments": {
                        "asset_ref": "/workspace/a.glb",
                        "iterations": 1,
                    }}},
                ],
            }
        raise agent.OllamaBoundaryError(504, "ollama_timeout", "Ollama stopped sending data.", True)

    monkeypatch.setattr(agent, "_stream_ollama_round", fake_stream)
    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(chat_request(
            messages=[],
            context={"currentMeshRef": "/workspace/a.glb"},
        )))

    assert raised.value.detail["actions"] == []


def test_server_action_batch_serialization_is_atomic_and_cumulatively_bounded():
    _, first_payload = run(agent.execute_tool("unload_models", {}, {}))
    _, second_payload = run(agent.execute_tool("unload_models", {}, {}))
    duplicate_direct = [
        agent.ActionDone(tool="unload_models", result="first", payload=first_payload),
        agent.ActionDone(tool="unload_models", result="second", payload=second_payload),
    ]
    oversized = [
        agent.ActionDone(tool="list_models", result="x" * (64 * 1024))
        for _ in range(9)
    ]

    assert agent.MAX_AGENT_ACTION_BATCH_BYTES == 512 * 1024
    assert agent._serialize_actions(duplicate_direct) == []
    assert agent._serialize_actions(oversized) == []
    assert agent.AgentChatResponse(message="duplicate", actions=duplicate_direct).actions == []
    assert agent.AgentChatResponse(message="oversized", actions=oversized).actions == []


def test_direct_action_is_returned_once_when_a_later_ollama_round_times_out(monkeypatch):
    async def fake_stream(_client, _url, _payload, round_number):
        if round_number == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"function": {"name": "unload_models", "arguments": {}}}],
            }
        raise agent.OllamaBoundaryError(504, "ollama_timeout", "Ollama stopped sending data.", True)

    monkeypatch.setattr(agent, "_stream_ollama_round", fake_stream)
    with pytest.raises(agent.HTTPException) as raised:
        run(agent.agent_chat(chat_request(messages=[])))

    assert raised.value.detail["code"] == "ollama_timeout"
    assert len(raised.value.detail["actions"]) == 1
    action = raised.value.detail["actions"][0]
    assert action["tool"] == "unload_models"
    assert action["payload"]["type"] == "models_unloaded"
    assert action["payload"]["actionId"].startswith("direct-")
