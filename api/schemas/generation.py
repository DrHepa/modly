from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class SceneCandidate(BaseModel):
    kind: Literal["mesh", "scene"]
    workspace_path: str
    output_url: str
    display_name: str


class JobProgress(BaseModel):
    status: Literal["pending", "running", "done", "error", "cancelled"]
    progress: int = 0
    step: Optional[str] = None
    output_url: Optional[str] = None
    output_kind: Optional[Literal["mesh", "scene"]] = None
    error: Optional[str] = None
    scene_candidate: Optional[SceneCandidate] = None


class JobStatus(JobProgress):
    job_id: str

    @property
    def run_id(self) -> str:
        return self.job_id


class GenerateFromTextRequest(BaseModel):
    prompt: str
    model_id: str = "sf3d"
    collection: str = "Default"
    remesh: str = "quad"
    enable_texture: bool = False
    texture_resolution: int = 1024
    params: dict[str, Any] = Field(default_factory=dict)


class GenerateFromNoneRequest(BaseModel):
    model_id: str
    collection: str = "Default"
    remesh: str = "quad"
    enable_texture: bool = False
    texture_resolution: int = 1024
    params: dict[str, Any] = Field(default_factory=dict)


class GenerateFromSceneRequest(BaseModel):
    scene_path: str
    model_id: str = "sf3d"
    collection: str = "Default"
    remesh: str = "quad"
    enable_texture: bool = False
    texture_resolution: int = 1024
    params: dict[str, Any] = Field(default_factory=dict)
