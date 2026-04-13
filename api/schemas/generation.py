from typing import Literal, Optional

from pydantic import BaseModel


class SceneCandidate(BaseModel):
    kind: Literal["mesh"]
    workspace_path: str
    output_url: str
    display_name: str


class JobProgress(BaseModel):
    status: Literal["pending", "running", "done", "error", "cancelled"]
    progress: int = 0
    step: Optional[str] = None
    output_url: Optional[str] = None
    error: Optional[str] = None
    scene_candidate: Optional[SceneCandidate] = None


class JobStatus(JobProgress):
    job_id: str

    @property
    def run_id(self) -> str:
        return self.job_id
