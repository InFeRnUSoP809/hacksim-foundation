"""Shared response shapes."""

from pydantic import BaseModel


class Message(BaseModel):
    detail: str


class ErrorResponse(BaseModel):
    detail: str
