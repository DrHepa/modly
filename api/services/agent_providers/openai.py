"""OpenAI Responses transport for Worlds-only agent turns."""
from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, NoReturn

import httpx

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
OPENAI_TIMEOUT = httpx.Timeout(connect=10.0, write=30.0, pool=10.0, read=300.0)
MAX_PROVIDER_ROUND_DEADLINE_SECONDS = 30 * 60.0
MAX_PROVIDER_STREAM_RAW_BYTES = 8 * 1024 * 1024
MAX_PROVIDER_STREAM_EVENTS = 4096
MAX_PROVIDER_CONTENT_BYTES = 2 * 1024 * 1024
MAX_PROVIDER_REFUSAL_BYTES = 64 * 1024
MAX_TOOL_ARGUMENT_BYTES_PER_ROUND = 256 * 1024 + 7 * 16 * 1024
ALLOWED_OUTPUT_ITEM_TYPES = {"message", "function_call", "reasoning"}


@dataclass
class AgentProviderRound:
    assistant_message: dict[str, Any]
    provider_state_items: list[dict[str, Any]] = field(default_factory=list)
    safe_metrics: dict[str, object] = field(default_factory=dict)
    refused: bool = False


class OpenAIBoundaryError(Exception):
    def __init__(self, status_code: int, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.safe_message = message
        self.retryable = retryable
        self.provider = "openai"


def _error(status_code: int, code: str, message: str, retryable: bool) -> OpenAIBoundaryError:
    return OpenAIBoundaryError(status_code, code, message, retryable)


def missing_key_error() -> OpenAIBoundaryError:
    return _error(
        400,
        "openai_not_configured",
        "OpenAI is not configured on this device. Choose Ollama or configure a server-side OpenAI key before using the remote provider.",
        False,
    )


def upstream_error() -> OpenAIBoundaryError:
    return _error(502, "openai_upstream_error", "OpenAI could not complete the request. Check the selected model and try again.", True)


def unavailable_error() -> OpenAIBoundaryError:
    return _error(503, "openai_unavailable", "Cannot reach OpenAI. Check network access and try again.", True)


def incomplete_error() -> OpenAIBoundaryError:
    return _error(502, "openai_incomplete", "OpenAI stopped before completing the response. Try again or choose a smaller request.", True)


def malformed_error() -> OpenAIBoundaryError:
    return _error(502, "openai_malformed_stream", "OpenAI returned malformed streaming data. No changes were proposed.", True)


def stream_error() -> OpenAIBoundaryError:
    return _error(502, "openai_stream_error", "OpenAI returned a streaming error. No changes were proposed.", True)


def deadline_error() -> OpenAIBoundaryError:
    return _error(504, "openai_round_deadline_exceeded", "OpenAI exceeded the total deadline for one agent round. Try again.", True)


def _redacted_key_from_env() -> str:
    value = os.environ.get("OPENAI_API_KEY")
    if not isinstance(value, str) or not value.strip():
        raise missing_key_error()
    return value


def build_responses_input(user_text: str, prior_round_items: list[dict[str, Any]], tool_outputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": user_text}]},
        *prior_round_items,
        *tool_outputs,
    ]


def build_openai_request(model: str, instructions: str, user_text: str, tools: list[dict[str, Any]], prior_round_items: list[dict[str, Any]], tool_outputs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "model": model,
        "instructions": instructions,
        "input": build_responses_input(user_text, prior_round_items, tool_outputs),
        "tools": tools,
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
    }


def _text_from_message_item(item: dict[str, Any]) -> str:
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if isinstance(part, dict) and part.get("type") in {"output_text", "text"} and isinstance(part.get("text"), str):
            parts.append(part["text"])
    return "".join(parts)


def _set_message_text(item: dict[str, Any], text: str) -> dict[str, Any]:
    return {**item, "type": "message", "role": item.get("role") if item.get("role") == "assistant" else "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}


def _event_json(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise malformed_error() from error
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise malformed_error()
    return value


async def _iter_sse_events(response: httpx.Response):
    raw_bytes = 0
    events = 0
    data_parts: list[str] = []
    async for line in response.aiter_lines():
        raw_bytes += len(line.encode("utf-8")) + 1
        if raw_bytes > MAX_PROVIDER_STREAM_RAW_BYTES:
            raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the streaming size limit. No changes were proposed.", True)
        stripped = line.strip()
        if not stripped:
            if data_parts:
                events += 1
                if events > MAX_PROVIDER_STREAM_EVENTS:
                    raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the streaming event limit. No changes were proposed.", True)
                yield _event_json("\n".join(data_parts))
                data_parts = []
            continue
        if stripped.startswith(":") or stripped.startswith("event:"):
            continue
        if stripped.startswith("data:"):
            data = stripped[5:].lstrip()
            if data == "[DONE]":
                continue
            data_parts.append(data)
    if data_parts:
        events += 1
        if events > MAX_PROVIDER_STREAM_EVENTS:
            raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the streaming event limit. No changes were proposed.", True)
        yield _event_json("\n".join(data_parts))


async def consume_openai_sse(response: httpx.Response, normalize_arguments: Callable[[object], dict[str, Any]]) -> AgentProviderRound:
    items: dict[int, dict[str, Any]] = {}
    text_by_index: dict[int, str] = {}
    args_by_index: dict[int, str] = {}
    content_bytes = 0
    argument_bytes = 0
    refusal = ""
    refusal_seen = False
    completed = False
    response_output: list[dict[str, Any]] | None = None

    async for event in _iter_sse_events(response):
        event_type = event["type"]
        if event_type == "response.output_item.added":
            index = event.get("output_index")
            item = event.get("item")
            if not isinstance(index, int) or not isinstance(item, dict) or item.get("type") not in ALLOWED_OUTPUT_ITEM_TYPES:
                raise malformed_error()
            items[index] = dict(item)
        elif event_type == "response.output_text.delta":
            index = event.get("output_index")
            delta = event.get("delta")
            if not isinstance(index, int) or not isinstance(delta, str):
                raise malformed_error()
            content_bytes += len(delta.encode("utf-8"))
            if content_bytes > MAX_PROVIDER_CONTENT_BYTES:
                raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the content limit. No changes were proposed.", True)
            text_by_index[index] = text_by_index.get(index, "") + delta
        elif event_type == "response.output_text.done":
            index = event.get("output_index")
            text = event.get("text")
            if not isinstance(index, int) or not isinstance(text, str):
                raise malformed_error()
            content_bytes += len(text.encode("utf-8"))
            if content_bytes > MAX_PROVIDER_CONTENT_BYTES:
                raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the content limit. No changes were proposed.", True)
            text_by_index[index] = text
        elif event_type == "response.refusal.delta":
            refusal_seen = True
            delta = event.get("delta")
            if not isinstance(delta, str):
                raise malformed_error()
            refusal += delta
            if len(refusal.encode("utf-8")) > MAX_PROVIDER_REFUSAL_BYTES:
                raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the refusal limit. No changes were proposed.", True)
        elif event_type == "response.refusal.done":
            refusal_seen = True
            text = event.get("refusal") or event.get("text")
            if isinstance(text, str):
                refusal = text
            if len(refusal.encode("utf-8")) > MAX_PROVIDER_REFUSAL_BYTES:
                raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the refusal limit. No changes were proposed.", True)
        elif event_type == "response.function_call_arguments.delta":
            index = event.get("output_index")
            delta = event.get("delta")
            if not isinstance(index, int) or not isinstance(delta, str):
                raise malformed_error()
            argument_bytes += len(delta.encode("utf-8"))
            if argument_bytes > MAX_TOOL_ARGUMENT_BYTES_PER_ROUND:
                raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the tool-argument limit. No changes were proposed.", True)
            args_by_index[index] = args_by_index.get(index, "") + delta
        elif event_type == "response.function_call_arguments.done":
            index = event.get("output_index")
            args = event.get("arguments")
            if not isinstance(index, int) or not isinstance(args, str):
                raise malformed_error()
            argument_bytes += len(args.encode("utf-8"))
            if argument_bytes > MAX_TOOL_ARGUMENT_BYTES_PER_ROUND:
                raise _error(502, "openai_stream_limit_exceeded", "OpenAI exceeded the tool-argument limit. No changes were proposed.", True)
            args_by_index[index] = args
        elif event_type == "response.output_item.done":
            index = event.get("output_index")
            item = event.get("item")
            if not isinstance(index, int) or not isinstance(item, dict) or item.get("type") not in ALLOWED_OUTPUT_ITEM_TYPES:
                raise malformed_error()
            items[index] = dict(item)
        elif event_type == "response.completed":
            response_value = event.get("response")
            if not isinstance(response_value, dict) or response_value.get("status") != "completed":
                raise incomplete_error()
            output = response_value.get("output")
            if isinstance(output, list):
                if any(not isinstance(item, dict) or item.get("type") not in ALLOWED_OUTPUT_ITEM_TYPES for item in output):
                    raise malformed_error()
                response_output = [dict(item) for item in output]
            completed = True
        elif event_type == "response.failed":
            raise upstream_error()
        elif event_type == "response.incomplete":
            raise incomplete_error()
        elif event_type == "error":
            raise stream_error()
        else:
            continue

    if not completed:
        raise _error(502, "openai_incomplete_stream", "OpenAI closed the stream before completing the response. Try again.", True)

    completed_items = response_output if response_output is not None else [items[index] for index in sorted(items)]
    normalized_items: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    message_parts: list[str] = []
    for index, item in enumerate(completed_items):
        item = dict(item)
        item_type = item.get("type")
        if item_type == "message":
            content = item.get("content")
            if isinstance(content, list) and any(isinstance(part, dict) and part.get("type") == "refusal" for part in content):
                refusal_seen = True
            text = text_by_index.get(index) or _text_from_message_item(item)
            item = _set_message_text(item, text)
            if text:
                message_parts.append(text)
        elif item_type == "function_call":
            name = item.get("name")
            call_id = item.get("call_id")
            args_text = args_by_index.get(index) or item.get("arguments")
            if not isinstance(name, str) or not isinstance(call_id, str) or not isinstance(args_text, str):
                raise malformed_error()
            try:
                parsed_args = json.loads(args_text or "{}")
            except json.JSONDecodeError as error:
                raise malformed_error() from error
            normalized_args = normalize_arguments(parsed_args)
            item["arguments"] = args_text
            tool_calls.append({"function": {"name": name, "arguments": normalized_args, "call_id": call_id}})
        elif item_type != "reasoning":
            raise malformed_error()
        normalized_items.append(item)

    if refusal_seen and tool_calls:
        raise malformed_error()
    content = "".join(message_parts)
    if refusal_seen:
        content = "OpenAI refused this request. No changes were proposed."
    assistant: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        assistant["tool_calls"] = tool_calls
    return AgentProviderRound(assistant_message=assistant, provider_state_items=normalized_items, refused=refusal_seen)


async def stream_openai_round(client: httpx.AsyncClient, payload: dict[str, Any], normalize_arguments: Callable[[object], dict[str, Any]]) -> AgentProviderRound:
    api_key = _redacted_key_from_env()
    started = time.monotonic()

    async def consume() -> AgentProviderRound:
        async with client.stream(
            "POST",
            OPENAI_RESPONSES_URL,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        ) as response:
            if not response.is_success:
                raise upstream_error()
            return await consume_openai_sse(response, normalize_arguments)

    try:
        result = await asyncio.wait_for(consume(), timeout=MAX_PROVIDER_ROUND_DEADLINE_SECONDS)
    except OpenAIBoundaryError:
        raise
    except asyncio.TimeoutError as error:
        raise deadline_error() from error
    except (httpx.ConnectError, httpx.ConnectTimeout) as error:
        raise unavailable_error() from error
    except httpx.ReadTimeout as error:
        raise _error(504, "openai_timeout", "OpenAI stopped sending data before the response completed. Try again.", True) from error
    except httpx.TimeoutException as error:
        raise _error(504, "openai_timeout", "OpenAI timed out before the response completed. Try again.", True) from error
    except httpx.HTTPError as error:
        raise stream_error() from error
    result.safe_metrics = {"provider": "openai", "elapsed_ms": round((time.monotonic() - started) * 1000)}
    return result
