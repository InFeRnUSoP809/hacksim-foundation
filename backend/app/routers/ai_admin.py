"""AI operations API (§68–§77).

Every route here is admin-only and reads or writes with the service client,
because these are the tables RLS deliberately closes to students (§90). No
response in this module ever contains an API key or a provider credential.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from supabase import Client

from app.core.security import AdminUser, get_service_client

logger = logging.getLogger("hacksim.api.ai")

router = APIRouter()


def _window_start(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# ── §69 overview ───────────────────────────────────────────────────────────


@router.get("/overview")
def overview(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    days: int = Query(30, ge=1, le=365),
) -> dict[str, Any]:
    """Totals, cache hit rate and error breakdown."""
    since = _window_start(days)
    summary = service.rpc("ai_usage_summary", {"p_since": since}).execute()
    if summary.error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not load AI usage.",
        )

    payload = summary.data or {}
    input_tokens = int(payload.get("input_tokens") or 0)
    cached_tokens = int(payload.get("cached_tokens") or 0)
    total_cost = float(payload.get("total_cost") or 0)
    requests = int(payload.get("requests") or 0)

    analyses = (
        service.table("ai_analyses").select("id, estimated_cost_usd").eq("status", "success").execute()
    ).data or []
    submission_count = (
        service.table("ai_usage")
        .select("submission_id")
        .eq("status", "success")
        .not_.is_("submission_id", "null")
        .execute()
    ).data or []
    distinct_submissions = len({row.get("submission_id") for row in submission_count})

    budgets = service.table("ai_budgets").select("*").execute().data or []
    global_budget = next((b for b in budgets if b.get("scope") == "global"), None)

    return {
        "window_days": days,
        "total_requests": requests,
        "successful": int(payload.get("success") or 0),
        "failed": int(payload.get("failed") or 0),
        "rejected": int(payload.get("rejected") or 0),
        "input_tokens": input_tokens,
        "output_tokens": int(payload.get("output_tokens") or 0),
        "cached_tokens": cached_tokens,
        "cache_miss_tokens": max(0, input_tokens - cached_tokens),
        "cache_hit_rate": round(cached_tokens / input_tokens, 4) if input_tokens else 0.0,
        "total_cost_usd": total_cost,
        "average_cost_per_submission": round(total_cost / distinct_submissions, 6)
        if distinct_submissions
        else 0.0,
        "successful_analyses": len(analyses),
        "error_codes": payload.get("error_codes") or {},
        "global_budget": _budget_view(global_budget),
    }


def _budget_view(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    max_cost = Decimal(str(row.get("max_cost_usd") or 0))
    used_cost = Decimal(str(row.get("used_cost_usd") or 0))
    ratio = float(used_cost / max_cost) if max_cost else 0.0
    level = "stop" if ratio >= 1 else "critical" if ratio >= 0.8 else "warning" if ratio >= 0.5 else "normal"
    return {
        "max_cost_usd": float(max_cost),
        "used_cost_usd": float(used_cost),
        "max_requests": row.get("max_requests"),
        "used_requests": row.get("used_requests"),
        "max_input_tokens": row.get("max_input_tokens"),
        "used_input_tokens": row.get("used_input_tokens"),
        "utilization": round(ratio, 4),
        "level": level,
        "enabled": row.get("enabled", True),
    }


# ── §70 usage table ────────────────────────────────────────────────────────


@router.get("/usage")
def usage(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    days: int = Query(30, ge=1, le=365),
    operation: str | None = None,
    model: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    submission_id: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """The request ledger, with the §70 filters."""
    query = (
        service.table("ai_usage")
        .select(
            "id, created_at, user_id, submission_id, repository_id, operation, provider, "
            "model, input_tokens, output_tokens, total_tokens, cached_tokens, "
            "estimated_cost_usd, status, error_code, duration_ms, request_id",
            count="exact",
        )
        .gte("created_at", _window_start(days))
    )
    if operation:
        query = query.eq("operation", operation)
    if model:
        query = query.eq("model", model)
    if status_filter:
        query = query.eq("status", status_filter)
    if submission_id:
        query = query.eq("submission_id", submission_id)

    result = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )

    rows = result.data or []
    enriched = []
    for row in rows:
        enriched.append(
            {
                **row,
                "user_email": _user_email(service, row.get("user_id")),
                "project_name": _project_name(service, row.get("submission_id")),
            }
        )

    return {
        "rows": enriched,
        "count": result.count if result.count is not None else len(rows),
        "limit": limit,
        "offset": offset,
    }


def _user_email(service: Client, user_id: str | None) -> str | None:
    if not user_id:
        return None
    cached = getattr(service, "_hacksim_email_cache", None)
    if cached is None:
        cached = {}
        setattr(service, "_hacksim_email_cache", cached)
    if user_id in cached:
        return cached[user_id]
    result = (
        service.table("profiles").select("email").eq("id", user_id).limit(1).execute()
    ).data or []
    email = result[0]["email"] if result else None
    cached[user_id] = email
    return email


def _project_name(service: Client, submission_id: str | None) -> str | None:
    if not submission_id:
        return None
    cached = getattr(service, "_hacksim_project_cache", None)
    if cached is None:
        cached = {}
        setattr(service, "_hacksim_project_cache", cached)
    if submission_id in cached:
        return cached[submission_id]
    result = (
        service.table("submissions").select("project_name").eq("id", submission_id).limit(1).execute()
    ).data or []
    name = (result[0].get("project_name") or None) if result else None
    cached[submission_id] = name
    return name


# ── §71 request detail ─────────────────────────────────────────────────────


@router.get("/requests/{request_id}")
def request_detail(
    request_id: str,
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
) -> dict[str, Any]:
    """One request, with the §71 cost breakdown. Never any credential."""
    result = (
        service.table("ai_usage")
        .select("*")
        .eq("request_id", request_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="That request was not found."
        )
    row = rows[0]

    pricing = _pricing_for(service, row.get("provider") or "deepseek", row.get("model") or "")
    cached = int(row.get("cached_tokens") or 0)
    miss = int(row.get("cache_miss_tokens") or 0)
    output = int(row.get("output_tokens") or 0)

    cache_hit_cost = _portion(pricing, cached, "cache_hit")
    cache_miss_cost = _portion(pricing, miss, "cache_miss")
    output_cost = _portion(pricing, output, "output")

    return {
        "request": {
            "request_id": row.get("request_id"),
            "provider": row.get("provider"),
            "model": row.get("model"),
            "operation": row.get("operation"),
            "prompt_version": row.get("prompt_version"),
            "status": row.get("status"),
            "duration_ms": row.get("duration_ms"),
            "created_at": row.get("created_at"),
            "error_code": row.get("error_code"),
            "error_message": row.get("error_message"),
        },
        "tokens": {
            "input": row.get("input_tokens"),
            "output": row.get("output_tokens"),
            "total": row.get("total_tokens"),
            "cached": cached,
            "cache_miss": miss,
        },
        "cost": {
            "cache_hit": cache_hit_cost,
            "cache_miss": cache_miss_cost,
            "output": output_cost,
            "total": float(row.get("estimated_cost_usd") or 0),
        },
        "pricing": pricing,
    }


def _pricing_for(service: Client, provider: str, model: str) -> dict[str, Any]:
    result = (
        service.table("ai_model_configs")
        .select("*")
        .eq("provider", provider)
        .eq("model_name", model)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        return {}
    row = rows[0]
    return {
        "input_price_per_million_cache_hit": float(row.get("input_price_per_million_cache_hit") or 0),
        "input_price_per_million_cache_miss": float(row.get("input_price_per_million_cache_miss") or 0),
        "output_price_per_million": float(row.get("output_price_per_million") or 0),
    }


def _portion(pricing: dict[str, Any], tokens: int, kind: str) -> float:
    price_key = {
        "cache_hit": "input_price_per_million_cache_hit",
        "cache_miss": "input_price_per_million_cache_miss",
        "output": "output_price_per_million",
    }[kind]
    price = Decimal(str(pricing.get(price_key) or 0))
    return float((Decimal(tokens) * price / Decimal(1_000_000)).quantize(Decimal("0.00000001")))


# ── §72 errors ─────────────────────────────────────────────────────────────


@router.get("/errors")
def errors(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """Failed and rejected requests, grouped by code."""
    rows = (
        service.table("ai_usage")
        .select(
            "id, created_at, operation, model, status, error_code, error_message, duration_ms"
        )
        .gte("created_at", _window_start(days))
        .in_("status", ["failed", "rejected"])
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    ).data or []

    grouped: dict[str, int] = {}
    for row in rows:
        code = row.get("error_code") or "unknown"
        grouped[code] = grouped.get(code, 0) + 1

    return {"rows": rows, "counts": grouped, "total": len(rows)}


# ── §73 budgets ────────────────────────────────────────────────────────────


@router.get("/budgets")
def list_budgets(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
) -> dict[str, Any]:
    rows = service.table("ai_budgets").select("*").order("scope").execute().data or []
    return {
        "budgets": [
            {
                "id": row["id"],
                "scope": row["scope"],
                "user_id": row.get("user_id"),
                "submission_id": row.get("submission_id"),
                "project_name": _project_name(service, row.get("submission_id")),
                "user_email": _user_email(service, row.get("user_id")),
                "max_cost_usd": float(row["max_cost_usd"]) if row.get("max_cost_usd") is not None else None,
                "max_input_tokens": row.get("max_input_tokens"),
                "max_output_tokens": row.get("max_output_tokens"),
                "max_requests": row.get("max_requests"),
                "used_cost_usd": float(row.get("used_cost_usd") or 0),
                "used_input_tokens": row.get("used_input_tokens") or 0,
                "used_output_tokens": row.get("used_output_tokens") or 0,
                "used_requests": row.get("used_requests") or 0,
                "enabled": row.get("enabled", True),
                "view": _budget_view(row),
            }
            for row in rows
        ]
    }


@router.post("/budgets")
def upsert_budget(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Create or update a budget. ``scope`` is required; ``id`` updates."""
    scope = payload.get("scope")
    if scope not in ("global", "user", "submission"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown budget scope."
        )

    fields = {
        "scope": scope,
        "user_id": payload.get("user_id"),
        "submission_id": payload.get("submission_id"),
        "max_cost_usd": payload.get("max_cost_usd"),
        "max_input_tokens": payload.get("max_input_tokens"),
        "max_output_tokens": payload.get("max_output_tokens"),
        "max_requests": payload.get("max_requests"),
        "enabled": bool(payload.get("enabled", True)),
    }
    # A submission budget without a target would silently never apply.
    if scope == "user" and not fields["user_id"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="A user budget needs a user id."
        )
    if scope == "submission" and not fields["submission_id"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A submission budget needs a submission id.",
        )

    budget_id = payload.get("id")
    try:
        if budget_id:
            service.table("ai_budgets").update(fields).eq("id", budget_id).execute()
        else:
            service.table("ai_budgets").insert(fields).execute()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Could not save the budget."
        ) from exc

    return {"ok": True}


@router.delete("/budgets/{budget_id}")
def delete_budget(
    budget_id: str,
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
) -> dict[str, Any]:
    service.table("ai_budgets").delete().eq("id", budget_id).execute()
    return {"ok": True}


# ── §74 AI settings + §55 kill switch ──────────────────────────────────────


@router.get("/settings")
def get_settings_page(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
) -> dict[str, Any]:
    models = service.table("ai_model_configs").select("*").order("is_default", desc=True).execute().data or []
    budgets = service.table("ai_budgets").select("*").eq("scope", "global").limit(1).execute().data or []
    return {
        "models": models,
        "global_budget": budgets[0] if budgets else None,
        "kill_switch": {"ai_enabled": budgets[0].get("enabled", True) if budgets else True},
    }


@router.post("/settings/models")
def save_model(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Create or update a model config. Pricing lives here, never in code (§56)."""
    provider = payload.get("provider")
    model_name = payload.get("model_name")
    if not provider or not model_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider and model are required."
        )

    fields = {
        "provider": provider,
        "model_name": model_name,
        "enabled": bool(payload.get("enabled", True)),
        "is_default": bool(payload.get("is_default", False)),
        "input_price_per_million_cache_hit": payload.get("input_price_per_million_cache_hit", 0),
        "input_price_per_million_cache_miss": payload.get("input_price_per_million_cache_miss", 0),
        "output_price_per_million": payload.get("output_price_per_million", 0),
        "max_input_tokens": int(payload.get("max_input_tokens") or 32000),
        "max_output_tokens": int(payload.get("max_output_tokens") or 4000),
        "reasoning_mode": payload.get("reasoning_mode") or "off",
    }

    try:
        if fields["is_default"]:
            # Only one default at a time.
            service.table("ai_model_configs").update({"is_default": False}).eq("is_default", True).execute()
        model_id = payload.get("id")
        if model_id:
            service.table("ai_model_configs").update(fields).eq("id", model_id).execute()
        else:
            service.table("ai_model_configs").upsert(fields, on_conflict="provider,model_name").execute()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Could not save the model settings."
        ) from exc

    return {"ok": True}


@router.post("/settings/kill-switch")
def set_kill_switch(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    enabled: bool,
) -> dict[str, Any]:
    """§55 — off means no new AI calls; existing analysis stays visible."""
    existing = service.table("ai_budgets").select("id").eq("scope", "global").limit(1).execute().data or []
    if existing:
        service.table("ai_budgets").update({"enabled": enabled}).eq("id", existing[0]["id"]).execute()
    else:
        service.table("ai_budgets").insert({"scope": "global", "enabled": enabled}).execute()
    return {"ok": True, "ai_enabled": enabled}


# ── §76 cost forecast, §77 cache analytics ─────────────────────────────────


@router.get("/forecast")
def forecast(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
) -> dict[str, Any]:
    result = service.rpc("ai_cost_forecast").execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not build the cost forecast.",
        )
    payload = result.data or {}
    return {**payload, "basis": "historical_average", "is_estimate": True}


@router.get("/cache-analytics")
def cache_analytics(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    days: int = Query(30, ge=1, le=365),
) -> dict[str, Any]:
    """§77 — all figures come from the provider's reported usage."""
    summary = service.rpc("ai_usage_summary", {"p_since": _window_start(days)}).execute().data or {}
    input_tokens = int(summary.get("input_tokens") or 0)
    cached = int(summary.get("cached_tokens") or 0)
    miss = max(0, input_tokens - cached)

    pricing_rows = service.table("ai_model_configs").select("*").eq("is_default", True).limit(1).execute().data or []
    savings = 0.0
    if pricing_rows:
        hit_price = Decimal(str(pricing_rows[0].get("input_price_per_million_cache_hit") or 0))
        miss_price = Decimal(str(pricing_rows[0].get("input_price_per_million_cache_miss") or 0))
        saved = (Decimal(miss) * (miss_price - hit_price)) / Decimal(1_000_000)
        savings = float(max(Decimal(0), saved).quantize(Decimal("0.00000001")))

    return {
        "window_days": days,
        "cached_tokens": cached,
        "uncached_tokens": miss,
        "cache_hit_rate": round(cached / input_tokens, 4) if input_tokens else 0.0,
        "estimated_cache_savings_usd": savings,
    }
