"""Cost calculation and budget control (§52, §53, §55, §57).

Pricing lives in ``ai_model_configs`` so an admin can change it without a
deploy. Nothing in this file hardcodes a price.

The gate runs *before* every request, in this order (§52):

    kill switch → model enabled → global budget → submission budget
    → cache check → estimate → allow or reject

A rejection never calls the provider, and it is still recorded in ``ai_usage``
with status ``rejected`` so the ledger explains itself (§91).
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from supabase import Client

logger = logging.getLogger("hacksim.budget")

# §53 defaults, used only when no `ai_budgets` row exists.
DEFAULT_MAX_COST_USD = Decimal("0.25")
DEFAULT_MAX_REQUESTS = 30
DEFAULT_MAX_INPUT_TOKENS = 100_000
DEFAULT_MAX_OUTPUT_TOKENS = 20_000

# §75 alert thresholds, as a fraction of the budget.
WARNING_THRESHOLD = Decimal("0.5")
CRITICAL_THRESHOLD = Decimal("0.8")
STOP_THRESHOLD = Decimal("1.0")


@dataclass
class ModelPricing:
    """A row of ``ai_model_configs``."""

    provider: str
    model_name: str
    enabled: bool
    is_default: bool
    input_price_cache_hit: Decimal
    input_price_cache_miss: Decimal
    output_price: Decimal
    max_input_tokens: int
    max_output_tokens: int
    reasoning_mode: str

    @property
    def max_tokens(self) -> int:
        return self.max_output_tokens


@dataclass
class BudgetSnapshot:
    max_cost_usd: Decimal | None
    max_input_tokens: int | None
    max_output_tokens: int | None
    max_requests: int | None
    used_cost_usd: Decimal
    used_input_tokens: int
    used_output_tokens: int
    used_requests: int
    enabled: bool

    @property
    def utilization(self) -> Decimal:
        if not self.max_cost_usd:
            return Decimal(0)
        return (self.used_cost_usd / self.max_cost_usd).quantize(Decimal("0.0001"))

    def level(self) -> str:
        """Which alert band this snapshot is in (§75)."""
        ratio = self.utilization
        if ratio >= STOP_THRESHOLD:
            return "stop"
        if ratio >= CRITICAL_THRESHOLD:
            return "critical"
        if ratio >= WARNING_THRESHOLD:
            return "warning"
        return "normal"

    def over_limit(self) -> bool:
        checks = (
            (self.max_cost_usd, self.used_cost_usd),
            (self.max_requests, self.used_requests),
        )
        if any(limit is not None and Decimal(used) >= Decimal(limit) for limit, used in checks):
            return True
        if self.max_input_tokens and self.used_input_tokens >= self.max_input_tokens:
            return True
        if self.max_output_tokens and self.used_output_tokens >= self.max_output_tokens:
            return True
        return False


class BudgetDecision:
    """The outcome of the gate. ``allowed`` is the only field callers branch on."""

    def __init__(
        self,
        allowed: bool,
        reason: str = "",
        estimated_cost_usd: Decimal = Decimal(0),
        budget: BudgetSnapshot | None = None,
    ) -> None:
        self.allowed = allowed
        self.reason = reason
        self.estimated_cost_usd = estimated_cost_usd
        self.budget = budget

    def __bool__(self) -> bool:
        return self.allowed


# ── Pricing ────────────────────────────────────────────────────────────────


def load_pricing(service: "Client") -> ModelPricing | None:
    """The enabled default model, or the enabled model matching the env var."""
    result = (
        service.table("ai_model_configs")
        .select("*")
        .eq("enabled", True)
        .eq("is_default", True)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        # No default flagged — fall back to any enabled row.
        result = (
            service.table("ai_model_configs")
            .select("*")
            .eq("enabled", True)
            .order("created_at")
            .limit(1)
            .execute()
        )
        rows = result.data or []
    if not rows:
        return None

    row = rows[0]
    return ModelPricing(
        provider=row.get("provider") or "deepseek",
        model_name=row.get("model_name") or "deepseek-flash",
        enabled=bool(row.get("enabled", True)),
        is_default=bool(row.get("is_default", False)),
        input_price_cache_hit=Decimal(str(row.get("input_price_per_million_cache_hit") or 0)),
        input_price_cache_miss=Decimal(str(row.get("input_price_per_million_cache_miss") or 0)),
        output_price=Decimal(str(row.get("output_price_per_million") or 0)),
        max_input_tokens=int(row.get("max_input_tokens") or 32000),
        max_output_tokens=int(row.get("max_output_tokens") or 4000),
        reasoning_mode=row.get("reasoning_mode") or "off",
    )


def calculate_cost(
    pricing: ModelPricing,
    *,
    cached_tokens: int,
    cache_miss_tokens: int,
    output_tokens: int,
) -> Decimal:
    """§57. Per-million prices, applied to the provider's reported usage."""
    million = Decimal(1_000_000)
    cost = (
        (Decimal(cached_tokens) * pricing.input_price_cache_hit)
        + (Decimal(cache_miss_tokens) * pricing.input_price_cache_miss)
        + (Decimal(output_tokens) * pricing.output_price)
    ) / million
    return cost.quantize(Decimal("0.00000001"))


def estimate_cost(
    pricing: ModelPricing, *, input_tokens: int, output_tokens: int, cache_ratio: float = 0.0
) -> Decimal:
    """A pre-flight estimate. Deliberately pessimistic (§52)."""
    cached = int(input_tokens * cache_ratio)
    miss = max(0, input_tokens - cached)
    return calculate_cost(
        pricing, cached_tokens=cached, cache_miss_tokens=miss, output_tokens=output_tokens
    )


# ── Budgets ────────────────────────────────────────────────────────────────


def load_budget(service: "Client", submission_id: str | None) -> BudgetSnapshot:
    result = service.rpc("ai_budget_for_submission", {"p_submission_id": submission_id}).execute()
    row = (result.data or [None])[0] if result.data else None

    if not row:
        return BudgetSnapshot(
            max_cost_usd=DEFAULT_MAX_COST_USD,
            max_input_tokens=DEFAULT_MAX_INPUT_TOKENS,
            max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
            max_requests=DEFAULT_MAX_REQUESTS,
            used_cost_usd=Decimal(0),
            used_input_tokens=0,
            used_output_tokens=0,
            used_requests=0,
            enabled=True,
        )

    return BudgetSnapshot(
        max_cost_usd=Decimal(str(row["max_cost_usd"])) if row.get("max_cost_usd") is not None else None,
        max_input_tokens=int(row["max_input_tokens"]) if row.get("max_input_tokens") else None,
        max_output_tokens=int(row["max_output_tokens"]) if row.get("max_output_tokens") else None,
        max_requests=int(row["max_requests"]) if row.get("max_requests") else None,
        used_cost_usd=Decimal(str(row.get("used_cost_usd") or 0)),
        used_input_tokens=int(row.get("used_input_tokens") or 0),
        used_output_tokens=int(row.get("used_output_tokens") or 0),
        used_requests=int(row.get("used_requests") or 0),
        enabled=bool(row.get("enabled", True)),
    )


def check_budget(
    service: "Client",
    pricing: ModelPricing,
    submission_id: str | None,
    *,
    estimated_input_tokens: int,
    estimated_output_tokens: int,
    cache_ratio: float = 0.0,
) -> BudgetDecision:
    """The §52 gate. Returns a decision; never raises."""
    if not pricing.enabled:
        return BudgetDecision(False, "model_disabled")

    budget = load_budget(service, submission_id)

    if not budget.enabled:
        return BudgetDecision(False, "ai_disabled", budget=budget)

    if budget.over_limit():
        return BudgetDecision(
            False,
            f"budget_exceeded:{budget.level()}",
            budget=budget,
        )

    estimate = estimate_cost(
        pricing,
        input_tokens=estimated_input_tokens,
        output_tokens=estimated_output_tokens,
        cache_ratio=cache_ratio,
    )

    if budget.max_cost_usd is not None:
        projected = budget.used_cost_usd + estimate
        if projected > budget.max_cost_usd:
            return BudgetDecision(False, "budget_would_be_exceeded", estimate, budget)

    if budget.max_input_tokens and estimated_input_tokens > budget.max_input_tokens:
        return BudgetDecision(False, "input_token_limit", estimate, budget)

    if estimated_input_tokens > pricing.max_input_tokens:
        return BudgetDecision(False, "model_input_limit", estimate, budget)

    return BudgetDecision(True, "", estimate, budget)


# ── §58 cache identity ─────────────────────────────────────────────────────


def context_hash(*parts: Any) -> str:
    """Stable hash of the context that shaped a call."""
    payload = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def find_cached_analysis(
    service: "Client",
    *,
    repository_id: str | None,
    analysis_type: str,
    prompt_version: str,
    model: str,
    ctx_hash: str,
) -> dict[str, Any] | None:
    """A previously successful result for this exact identity, if any."""
    query = (
        service.table("ai_analyses")
        .select("*")
        .eq("analysis_type", analysis_type)
        .eq("prompt_version", prompt_version)
        .eq("model", model)
        .eq("context_hash", ctx_hash)
        .eq("status", "success")
        .limit(1)
    )
    if repository_id:
        query = query.eq("repository_id", repository_id)
    else:
        query = query.is_("repository_id", None)

    result = query.execute()
    return (result.data or [None])[0]


def save_analysis(
    service: "Client",
    *,
    analysis_type: str,
    provider: str,
    model: str,
    prompt_version: str,
    ctx_hash: str,
    status: str,
    result_payload: dict[str, Any] | None,
    input_tokens: int,
    output_tokens: int,
    total_tokens: int,
    cached_tokens: int,
    cache_miss_tokens: int,
    cost_usd: Decimal,
    repository_id: str | None = None,
    submission_id: str | None = None,
    scope_key: str | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> str | None:
    """Persist a result or a failure. Failures are stored, not discarded (§45)."""
    try:
        inserted = (
            service.table("ai_analyses")
            .insert(
                {
                    "repository_id": repository_id,
                    "submission_id": submission_id,
                    "analysis_type": analysis_type,
                    "scope_key": scope_key,
                    "provider": provider,
                    "model": model,
                    "model_version": model,
                    "prompt_version": prompt_version,
                    "context_hash": ctx_hash,
                    "input_hash": None,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "cached_tokens": cached_tokens,
                    "cache_miss_tokens": cache_miss_tokens,
                    "estimated_cost_usd": float(cost_usd),
                    "result": result_payload,
                    "status": status,
                    "error_code": error_code,
                    "error_message": (error_message or "")[:500] or None,
                    "completed_at": None,
                }
            )
            .execute()
        )
        rows = inserted.data or []
        return rows[0]["id"] if rows else None
    except Exception as exc:  # noqa: BLE001 — accounting must never break a scan
        logger.warning("[hacksim.budget] could not persist ai_analyses row: %s", exc)
        return None


def record_usage(
    service: "Client",
    *,
    operation: str,
    provider: str,
    model: str,
    prompt_version: str,
    input_tokens: int,
    output_tokens: int,
    cached_tokens: int,
    cache_miss_tokens: int,
    cost_usd: Decimal,
    request_id: str | None,
    status: str,
    duration_ms: int,
    user_id: str | None = None,
    submission_id: str | None = None,
    repository_id: str | None = None,
    session_id: str | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    """Write one ``ai_usage`` row per request — success, failure or rejection."""
    try:
        service.rpc(
            "ai_record_usage",
            {
                "p_operation": operation,
                "p_provider": provider,
                "p_model": model,
                "p_prompt_version": prompt_version,
                "p_input_tokens": input_tokens,
                "p_output_tokens": output_tokens,
                "p_cached_tokens": cached_tokens,
                "p_cost_usd": float(cost_usd),
                "p_request_id": request_id,
                "p_status": status,
                "p_error_code": error_code,
                "p_error_message": (error_message or "")[:500] or None,
                "p_duration_ms": duration_ms,
                "p_user_id": user_id,
                "p_submission_id": submission_id,
                "p_repository_id": repository_id,
                "p_session_id": session_id,
            },
        ).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[hacksim.budget] could not record ai_usage: %s", exc)
