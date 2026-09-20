from typing import Annotated, Any, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


ProgressPercent = Annotated[float, Field(ge=0.0, le=100.0)]


class JobStatus(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    job_id: str
    status: Literal["pending", "running", "done", "error", "cancelled"]
    progress: ProgressPercent = 0.0
    step: Optional[str] = None    # Human-readable current step
    output_url: Optional[str] = None
    error: Optional[str] = None


class GenerateFromSceneRequest(BaseModel):
    scene_path: str
    model_id: str
    collection: str = "Default"
    remesh: str = "quad"
    enable_texture: bool = False
    texture_resolution: int = 1024
    params: dict[str, Any] = Field(default_factory=dict)


class GenerateFromArtifactRequest(BaseModel):
    input_kind: Literal["capture", "scene"]
    input_path: str
    model_id: str
    collection: str = "Default"
    remesh: str = "none"
    enable_texture: bool = False
    texture_resolution: int = 1024
    params: dict[str, Any] = Field(default_factory=dict)
