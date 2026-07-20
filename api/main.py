"""
Modly FastAPI backend.
Runs locally within the Electron app to provide AI inference endpoints.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from routers import agent, export, extensions, generation, model, optimize, settings, status, workflow_runs


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize the registry (instantiates all adapters)
    from services.generator_registry import generator_registry
    generator_registry.initialize()
    yield
    # Shutdown: unload all models
    generator_registry.shutdown_all()


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

    workspace_root = workspace_dir.resolve()
    resolved_path = (workspace_root / Path(*pure_path.parts)).resolve()

    try:
        resolved_path.relative_to(workspace_root)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="File not found") from error

    return resolved_path
