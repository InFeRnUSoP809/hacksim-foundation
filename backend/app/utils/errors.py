"""Error translation.

Database and driver errors are converted into short, user-facing sentences so
an internal message or stack trace never reaches a client.
"""

from __future__ import annotations

from fastapi import HTTPException


def to_http_error(error, *, default: str = "Something went wrong.") -> HTTPException:
    message = getattr(error, "message", None) or default
    lowered = message.lower()

    if "row-level security" in lowered or "permission denied" in lowered:
        return HTTPException(status_code=403, detail="You are not authorized to perform this action.")
    if "expired" in lowered:
        return HTTPException(status_code=409, detail="Simulation has expired.")
    if "finalized" in lowered:
        return HTTPException(status_code=409, detail="Submission already finalized.")
    if "does not exist" in lowered:
        return HTTPException(status_code=404, detail=message)

    return HTTPException(status_code=400, detail=message)
