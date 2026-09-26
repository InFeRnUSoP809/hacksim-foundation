-- ============================================================================
-- seed.sql — optional development data
-- ============================================================================
-- Strictly optional. The application does NOT depend on any of this existing:
-- an admin can create entirely different hackathons from /admin/hackathons,
-- and the app never references "MediStock" in code.
--
-- Safe to run more than once — the hackathon is matched on its name.
--
-- Usage:
--   1. Run 001 → 002 → 003
--   2. Run this file
--   3. Open /admin/hackathons and flip Practice on
-- ============================================================================

do $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.hackathons where name = 'MediStock Practice Hackathon') then
    raise notice 'MediStock Practice Hackathon already exists — skipping.';
    return;
  end if;

  insert into public.hackathons (
    name,
    problem_statement,
    requirements,
    constraints,
    expected_outcome,
    evaluation_criteria,
    simulation_duration_minutes,
    status
  )
  values (
    'MediStock Practice Hackathon',
    'Build a pharmacy inventory and medicine demand prediction solution.

Small and mid-size pharmacies hold stock they do not need and run out of the medicines their patients actually ask for. Demand swings with seasonality, local demographics, weather, and prescribing patterns, yet most orders are still placed by hand.

Design and build a system that helps a pharmacy decide what to reorder, when, and how much — and that tells a pharmacist what it does not know.',
    E'## Requirements

- Ingest a historical purchase and stock dataset of your choosing (public or synthetic).
- Produce a demand forecast per medicine for a configurable future window.
- Recommend a reorder quantity and a reorder date per medicine.
- Surface low-stock risk so a pharmacist can act before a stockout.
- Expose a clear confidence or data-quality signal alongside every recommendation.
- Provide an interface a pharmacist can use in a few seconds per item.

## Optional, if you have the time

- Scenario planning: model the effect of a lead-time change or a sudden demand spike.
- An explanation of why a given medicine was flagged.',
    E'## Constraints

- The system must run without paid third-party data services.
- Recommendations must be explainable — a pharmacist should be able to see the reason, not just a number.
- The solution must degrade honestly: when data is thin or missing, say so rather than guessing silently.
- Do not require manual entry of the entire historical dataset.
- Nothing you build may include real patient-identifiable data.',
    E'## Expected outcome

A working prototype in which a pharmacist can open a dashboard, see which medicines are at risk of stocking out, understand why, and either accept the suggested reorder or adjust it.

The goal is not perfect forecast accuracy. It is a credible, explainable decision tool that a real pharmacist would trust enough to act on.',
    E'## Evaluation criteria

1. **Forecast quality** — are the predictions defensible, and is the method appropriate for the data?
2. **Explainability** — can a user understand why an item was flagged?
3. **Honesty about uncertainty** — does the system surface what it does not know?
4. **Usability** — can a pharmacist act on the output quickly?
5. **Engineering quality** — structure, testing, and the handling of edge cases.
6. **Judgement** — were the right trade-offs made under a time limit?'
  )
  returning id into v_id;

  -- 8 hours, stored as minutes. The admin can change this later without
  -- affecting any session that has already started.
  update public.hackathons
     set simulation_duration_minutes = 480
   where id = v_id;

  raise notice 'Created MediStock Practice Hackathon (%).', v_id;
  raise notice 'Enable practice from /admin/hackathons when you are ready.';
end
$$;
