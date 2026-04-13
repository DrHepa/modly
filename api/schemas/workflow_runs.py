from typing import Literal

from pydantic import BaseModel

from schemas.generation import JobProgress, JobStatus


class WorkflowRunAccepted(BaseModel):
    run_id: str
    status: Literal["pending", "running"]

    @classmethod
    def from_job(cls, job: JobStatus) -> "WorkflowRunAccepted":
        return cls(run_id=job.job_id, status=job.status)


class WorkflowRunStatus(JobProgress):
    run_id: str

    @classmethod
    def from_job(cls, job: JobStatus) -> "WorkflowRunStatus":
        return cls(
            run_id=job.job_id,
            status=job.status,
            progress=job.progress,
            step=job.step,
            output_url=job.output_url,
            error=job.error,
            scene_candidate=job.scene_candidate,
        )


class WorkflowRunCancelResponse(BaseModel):
    run_id: str
    status: Literal["pending", "running", "done", "error", "cancelled"]

    @classmethod
    def from_job(cls, job: JobStatus) -> "WorkflowRunCancelResponse":
        return cls(run_id=job.job_id, status=job.status)
