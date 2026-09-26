import os

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    """Health check — used by Electron to know the API is ready."""
    response = {"status": "ok"}
    # A launch ID lets Electron distinguish its child from another service on
    # the fixed loopback port. This is an identity check, not authentication.
    launch_id = os.environ.get("MODLY_BRIDGE_LAUNCH_ID")
    if launch_id:
        response["bridge_instance"] = launch_id
    return response
