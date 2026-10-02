"""
Modly FastAPI backend.
Runs locally within the Electron app to provide AI inference endpoints.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from routers import agent, export, extensions, generation, model, optimize, settings, status, workflow_runs


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize the registry (instantiates all adapters)
    from services.generator_registry import generator_registry
    from services.generation_jobs import sweep_stale_private_inputs

    startup_failures = sweep_stale_private_inputs()
    if startup_failures:
        raise RuntimeError("Could not clean stale private generation inputs at startup")
    generator_registry.initialize()
    try:
        yield
    finally:
        # Shutdown: unload all models, then remove custody left by cancelled or
        # interrupted background generators. Abrupt process kills are recovered
        # by the next startup sweep rather than promised as synchronous cleanup.
        try:
            generator_registry.shutdown_all()
        finally:
            sweep_stale_private_inputs()


class _GenerationBodyTooLarge(Exception):
    pass


class GenerationMultipartBodyLimitMiddleware:
    """Parser-facing total bound for both image-generation multipart routes."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope.get("type") != "http"
            or scope.get("method") != "POST"
            or scope.get("path") not in {"/generate/from-image", "/workflow-runs/from-image"}
        ):
            await self.app(scope, receive, send)
            return

        from services.generation_jobs import generation_multipart_body_limit

        limit = generation_multipart_body_limit()
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length")
        if raw_length is not None:
            try:
                if int(raw_length) > limit:
                    await JSONResponse(
                        {"detail": "Generation multipart body exceeds the allowed image capacity"},
                        status_code=413,
                    )(scope, receive, send)
                    return
            except ValueError:
                await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
                return

        consumed = 0

        async def limited_receive():
            nonlocal consumed
            message = await receive()
            if message.get("type") == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > limit:
                    raise _GenerationBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _GenerationBodyTooLarge:
            await JSONResponse(
                {"detail": "Generation multipart body exceeds the allowed image capacity"},
                status_code=413,
            )(scope, receive, send)


class _StatusFilter(logging.Filter):
    def filter(self, record):
        return "/generate/status/" not in record.getMessage()

logging.getLogger("uvicorn.access").addFilter(_StatusFilter())


app = FastAPI(
    title="Modly API",
    version="0.4.1",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # drei's SplatLoader reads Content-Length to size its buffers; cross-origin
    # JS can only see it when the server explicitly exposes the header.
    expose_headers=["Content-Length"],
)
app.add_middleware(GenerationMultipartBodyLimitMiddleware)

app.include_router(status.router)
app.include_router(settings.router)
app.include_router(model.router,      prefix="/model")
app.include_router(generation.router, prefix="/generate")
app.include_router(optimize.router,    prefix="/optimize")
app.include_router(extensions.router, prefix="/extensions")
app.include_router(export.router,          prefix="/export")
app.include_router(workflow_runs.router,   prefix="/workflow-runs")
app.include_router(agent.router)

# Serve generated files from workspace — dynamic so path changes take effect immediately
@app.get("/workspace/{full_path:path}")
async def serve_workspace_file(full_path: str):
    import services.generator_registry as reg

    file_path = resolve_workspace_request_path(reg.WORKSPACE_DIR, full_path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(file_path))


def resolve_workspace_request_path(workspace_dir: Path, full_path: str) -> Path:
    candidate = full_path.replace("\\", "/").strip()
    if not candidate:
        raise HTTPException(status_code=404, detail="File not found")

    pure_path = PurePosixPath(candidate)
    if pure_path.is_absolute() or any(part in ("", ".", "..") for part in pure_path.parts):
        raise HTTPException(status_code=404, detail="File not found")
    if pure_path.parts[0].casefold() == ".modly-private-inputs":
        raise HTTPException(status_code=404, detail="File not found")

    workspace_root = workspace_dir.resolve()
    resolved_path = (workspace_root / Path(*pure_path.parts)).resolve()

    try:
        resolved_path.relative_to(workspace_root)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="File not found") from error

    resolved_relative = resolved_path.relative_to(workspace_root)
    if any(part.casefold() == ".modly-private-inputs" for part in resolved_relative.parts):
        raise HTTPException(status_code=404, detail="File not found")

    return resolved_path
