"""Native-fixture child only: real agent router/parser, deterministic NDJSON provider STUB."""
import asyncio
import json
from importlib.metadata import version
import os
from pathlib import Path
import socket
import sys
from urllib.parse import urlsplit

# Python -I intentionally omits cwd/PYTHONPATH; import only frozen, hashed router copies.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import uvicorn
from routers import agent

SAFE_HEADER_LIMIT = 160
SAFE_HEADER_NAMES_LIMIT = 12
SAFE_METHODS = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
SAFE_CORS_RESPONSE_HEADERS = {
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-max-age",
}


def emit(kind, **data):
    print(json.dumps({"kind": kind, **data}, separators=(",", ":")), flush=True)


def safe_visible_text(value):
    if not isinstance(value, str) or len(value) > SAFE_HEADER_LIMIT:
        return None
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        return None
    return value


def safe_origin(value):
    text = safe_visible_text(value)
    if text is None:
        return {"kind": "absent" if value is None else "redacted"}
    if text == "null":
        return {"kind": "null"}
    if text == "file://":
        return {"kind": "file", "value": "file://"}
    try:
        parsed = urlsplit(text)
        port = parsed.port
    except ValueError:
        return {"kind": "redacted"}
    if (parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and port is not None
            and 1024 <= port <= 65535 and not parsed.username and not parsed.password
            and not parsed.path and not parsed.query and not parsed.fragment):
        return {"kind": "loopback", "value": "http://127.0.0.1:" + str(port)}
    return {"kind": "redacted"}


def safe_preflight_method(value):
    text = safe_visible_text(value)
    if text is None:
        return None if value is None else "<redacted>"
    method = text.upper()
    return method if method in SAFE_METHODS else "<redacted>"


def safe_header_names(value):
    if value is None:
        return []
    if not isinstance(value, str) or len(value) > SAFE_HEADER_LIMIT:
        return ["<redacted>"]
    names = []
    for raw_name in value.split(","):
        name = raw_name.strip().lower()
        if not name:
            continue
        if len(names) >= SAFE_HEADER_NAMES_LIMIT:
            names.append("<truncated>")
            break
        if (len(name) > 64 or any(term in name for term in ("auth", "cookie", "token", "secret"))
                or any(ord(character) < 0x21 or ord(character) > 0x7E for character in name)
                or any(character in name for character in ":/\\?&=#")):
            names.append("<redacted>")
        else:
            names.append(name)
    return names


def safe_method(value):
    return safe_preflight_method(value) or "<redacted>"


def safe_path(path, query):
    if query:
        return "<redacted>"
    return path if path in ("/agent/chat", "/api/chat") else "<redacted>"


def cors_headers(response):
    observed = {}
    for name, value in response.headers.items():
        lower = name.lower()
        if lower in SAFE_CORS_RESPONSE_HEADERS:
            if lower == "access-control-allow-origin":
                observed[lower] = safe_origin(value)
            elif lower == "access-control-allow-methods":
                observed[lower] = [safe_preflight_method(method.strip()) for method in value.split(",")]
            elif lower == "access-control-allow-headers":
                observed[lower] = safe_header_names(value)
            elif lower == "access-control-max-age" and value.isdigit() and len(value) <= 8:
                observed[lower] = value
            else:
                observed[lower] = "<redacted>"
    return observed


def checked_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username
            or parsed.password or parsed.path or parsed.query or parsed.fragment
            or parsed.port is None or not 1024 <= parsed.port <= 65535
            or parsed.port in (8765, 8766, 11434)):
        raise ValueError("Only owned ephemeral loopback origins are accepted")
    return parsed.port


def create_fixture_app(config, api_origin, emit_event=emit):
    # Process-local fixture configuration; production source and HTTPX transport remain intact.
    bridge_origin = config["bridgeOrigin"]
    agent.AUTOMATION_BRIDGE = bridge_origin
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=["null"], allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
    requests_seen = set()
    counts = {"agent": 0, "provider": 0}
    app.state.fixture_counts = counts

    @app.middleware("http")
    async def fixture_boundary(request: Request, call_next):
        diagnostic = {
            "method": safe_method(request.method),
            "path": safe_path(request.url.path, request.url.query),
            "origin": safe_origin(request.headers.get("origin")),
            "accessControlRequestMethod": safe_preflight_method(request.headers.get("access-control-request-method")),
            "accessControlRequestHeaders": safe_header_names(request.headers.get("access-control-request-headers")),
        }
        emit_event("http-attempt", **diagnostic)
        def reject(reason, status):
            response = JSONResponse({"error": "Fixture request rejected"}, status_code=status)
            emit_event("http-reject", **diagnostic, status=status, rejection=reason,
                       responseCorsHeaders=cors_headers(response))
            return response
        if request.client is None or request.client.host != "127.0.0.1":
            return reject("loopback_only", 403)
        route = request.url.path
        is_models = route == "/agent/models" and request.method == "GET" and list(request.query_params.multi_items()) == [("ollama_url", api_origin)]
        is_tags = route == "/api/tags" and request.method == "GET" and not request.url.query
        if not (is_models or is_tags or (route in ("/agent/chat", "/api/chat") and not request.url.query)):
            return reject("route_unavailable", 404)
        origin = request.headers.get("origin")
        if origin not in (None, "null"):
            return reject("origin_rejected", 403)
        if is_models or is_tags:
            response = await call_next(request)
            emit_event("http-complete", **diagnostic, status=response.status_code, responseCorsHeaders=cors_headers(response))
            return response
        if request.method == "OPTIONS" and request.url.path == "/agent/chat":
            response = await call_next(request)
            emit_event("http-complete", **diagnostic, status=response.status_code, responseCorsHeaders=cors_headers(response))
            return response
        length = request.headers.get("content-length", "")
        if request.method != "POST" or not length.isdigit() or not 0 < int(length) <= 65536:
            return reject("request_bound", 400)
        body = await request.body()
        if len(body) != int(length):
            return reject("body_mismatch", 400)
        try:
            payload = json.loads(body)
            if request.url.path == "/agent/chat":
                context = payload["worldContext"]
                if (payload["ollama_url"] != api_origin or payload["model"] != "worlds-fixture-stub"
                        or payload["messages"] != [{"role": "user", "content": "Rename the target to Reviewed target."}]
                        or payload["context"] != {} or context["projectKey"] != config["projectKey"]
                        or context["projectId"] != "project:ai-fixture" or context["activeSceneId"] != "scene:ai-fixture"
                        or context["requestId"] in requests_seen or counts["agent"] >= 3):
                    raise ValueError("Fixture agent request rejected")
                requests_seen.add(context["requestId"])
                counts["agent"] += 1
                emit_event("agent-request", context=context)
        except (ValueError, KeyError, TypeError):
            return reject("payload_rejected", 400)
        response = await call_next(request)
        emit_event("http-complete", **diagnostic, status=response.status_code, responseCorsHeaders=cors_headers(response))
        return response

    app.include_router(agent.router)

    @app.get("/api/tags")
    async def deterministic_model_inventory():
        return {"models": [{"name": "worlds-fixture-stub", "digest": "sha256:" + "f" * 64}]}

    @app.post("/api/chat")
    async def deterministic_provider(request: Request):
        payload = await request.json()
        counts["provider"] += 1
        if counts["provider"] > 9 or payload.get("model") != "worlds-fixture-stub" or payload.get("stream") is not True:
            return JSONResponse({"error": "STUB request bound"}, status_code=400)
        if {tool["function"]["name"] for tool in payload["tools"]} != {"query_world", "propose_world_commands"}:
            return JSONResponse({"error": "STUB tool boundary"}, status_code=400)
        tool_messages = [message for message in payload["messages"] if message["role"] == "tool"]
        message = {"role": "assistant", "content": ""}
        if not tool_messages:
            function = {"name": "query_world", "arguments": {"kind": "entities", "pageSize": 50}}
        elif len(tool_messages) == 1 and tool_messages[0].get("tool_name") == "query_world":
            page = json.loads(tool_messages[0]["content"])
            targets = [item for item in page["items"] if item["name"] == "Fixture target"]
            if len(targets) != 1 or page["nextCursor"] is not None:
                return JSONResponse({"error": "STUB requires one queried target"}, status_code=400)
            target = targets[0]
            # IDs come exclusively from actual query output, not fixture constants.
            commands = [{"type": "patch-entity", "sceneId": page["context"]["activeSceneId"], "entityId": target["id"],
                         "patch": {"name": name}} for name in ("Intermediate target", "Reviewed target")]
            function = {"name": "propose_world_commands", "arguments": {"commands": commands}}
            emit_event("stub-proposal", context=page["context"], queriedEntityId=target["id"], commands=commands)
        elif (len(tool_messages) == 2 and tool_messages[-1].get("tool_name") == "propose_world_commands"
              and json.loads(tool_messages[-1]["content"])["code"] == "world_proposal_recorded"):
            function = None
            message["content"] = "STUB: Rename the target in the active scene."
        else:
            return JSONResponse({"error": "STUB unexpected tool-loop state"}, status_code=400)
        if function:
            message["tool_calls"] = [{"function": function}]
        emit_event("stub-round", number=counts["provider"], tool=function["name"] if function else None)
        encoded = (json.dumps({"message": message, "done": True}) + "\n").encode()

        async def frames():
            # Real streamed byte fragments exercise the production NDJSON accumulator.
            for offset in range(0, len(encoded), 17):
                yield encoded[offset:offset + 17]
                await asyncio.sleep(0)
        return StreamingResponse(frames(), media_type="application/x-ndjson")
    return app


async def serve(config):
    bridge_origin = config["bridgeOrigin"]
    bridge_port = checked_origin(bridge_origin)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    api_origin = "http://127.0.0.1:" + str(listener.getsockname()[1])
    api_port = checked_origin(api_origin)
    allowed = {("127.0.0.1", bridge_port), ("127.0.0.1", api_port)}

    def deny_external_network(event, arguments):
        if event == "socket.connect":
            address = arguments[1]
            if not isinstance(address, tuple) or len(address) != 2 or address not in allowed:
                raise PermissionError("Fixture refuses non-owned network destinations")
        if event == "socket.getaddrinfo" and arguments[0] != "127.0.0.1":
            raise PermissionError("Fixture refuses external DNS")

    sys.addaudithook(deny_external_network)
    app = create_fixture_app(config, api_origin)

    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(500):
            if task.done():
                await task
                raise RuntimeError("Fixture API stopped before readiness")
            if server.started:
                emit("ready", pid=os.getpid(), runId=config["runId"], apiOrigin=api_origin, bridgeOrigin=bridge_origin,
                     provider="DETERMINISTIC_NDJSON_STUB", python=sys.version,
                     versions={name: version(name) for name in ("fastapi", "httpx", "pydantic", "uvicorn")})
                break
            await asyncio.sleep(0.01)
        else:
            raise RuntimeError("Fixture API readiness deadline exceeded")
        await asyncio.wait_for(task, timeout=125)
    finally:
        server.should_exit = True
        listener.close()
        emit("finished", counts=dict(app.state.fixture_counts))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Fixture child requires one owned configuration file")
    config_path = Path(sys.argv[1])
    resolved = config_path.resolve(strict=True)
    if config_path != resolved or resolved.name != "backend-config.json" or not resolved.parent.name.startswith("run-"):
        raise SystemExit("Invalid private fixture configuration")
    if resolved.stat().st_uid != os.getuid() or resolved.stat().st_mode & 0o777 != 0o600:
        raise SystemExit("Fixture configuration ownership mismatch")
    asyncio.run(serve(json.loads(resolved.read_text())))
