-- ────────────────────────────────────────────────────────────────────────────
-- 005_model_pricing.sql
--
-- The DeepSeek price list. Pricing lives in the database rather than in code so
-- an admin can change it without a deploy (§52), which only works if a row
-- actually exists — a missing model is not a default, it is a hard refusal.
--
-- Idempotent: re-running updates the existing row instead of failing the
-- `unique (provider, model_name)` constraint.
--
-- deepseek-flash prices are USD per million tokens. `cache_hit` is DeepSeek's
-- discounted prompt-cache read rate; keeping the two input prices distinct is
-- what makes the cost estimate worth having, because the stable prompt prefix
-- the analysis prompts are built around is exactly what gets cached.
-- ────────────────────────────────────────────────────────────────────────────

insert into public.ai_model_configs (
  provider,
  model_name,
  enabled,
  is_default,
  input_price_per_million_cache_hit,
  input_price_per_million_cache_miss,
  output_price_per_million,
  max_input_tokens,
  max_output_tokens,
  reasoning_mode
)
values (
  'deepseek',
  'deepseek-flash',
  true,
  true,
  0.028,
  0.28,
  0.42,
  32000,
  4000,
  'off'
)
on conflict (provider, model_name) do update
  set enabled                            = excluded.enabled,
      is_default                         = excluded.is_default,
      input_price_per_million_cache_hit  = excluded.input_price_per_million_cache_hit,
      input_price_per_million_cache_miss = excluded.input_price_per_million_cache_miss,
      output_price_per_million           = excluded.output_price_per_million,
      max_input_tokens                   = excluded.max_input_tokens,
      max_output_tokens                  = excluded.max_output_tokens,
      reasoning_mode                     = excluded.reasoning_mode,
      updated_at                         = now();

-- Exactly one default model. If an admin previously promoted a different
-- provider, this keeps the newest row from silently creating a second default.
update public.ai_model_configs
   set is_default = (provider = 'deepseek' and model_name = 'deepseek-flash')
 where is_default
   and not (provider = 'deepseek' and model_name = 'deepseek-flash');
