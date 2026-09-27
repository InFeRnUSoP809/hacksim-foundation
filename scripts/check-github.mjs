/**
 * Read-only preflight for the HackSim analysis pipeline.
 *
 * Checks the things that fail *silently* after a deploy: a missing or expired
 * GitHub token, an exhausted rate limit, an unpriced model. Creates nothing,
 * sends no AI request, and prints no secret — only whether each one is set.
 *
 * The GitHub check is a real authenticated request rather than "is the variable
 * non-empty", because a set-but-invalid token looks identical from the inside.
 *
 * Run:  node scripts/check-github.mjs
 *
 * Reads GITHUB_TOKEN / DEEPSEEK_API_KEY from the environment. The Supabase
 * function reads them as edge-function secrets, so this verifies the same
 * values you set with `supabase secrets set` — not whatever is deployed.
 */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() ?? "";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
const GITHUB_API_BASE = process.env.GITHUB_API_BASE?.trim() || "https://api.github.com";

let failures = 0;

function show(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function note(label, detail) {
  console.log(`NOTE  ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. GitHub: authenticated reachability + remaining quota ────────────────
//
// /rate_limit does not itself consume quota, so this is safe to run repeatedly.
const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "HackSim-Preflight",
};
if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

try {
  const res = await fetch(`${GITHUB_API_BASE}/rate_limit`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  const remaining = res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("x-ratelimit-limit");
  const reset = res.headers.get("x-ratelimit-reset");
  const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;

  if (res.status === 200) {
    show("github reachable", true, `${GITHUB_API_BASE}/rate_limit answered 200`);
    show(
      "github token",
      Boolean(GITHUB_TOKEN),
      GITHUB_TOKEN ? "accepted" : "no token sent — anonymous quota only",
    );
    if (!GITHUB_TOKEN) {
      note(
        "github token",
        "Without GITHUB_TOKEN GitHub allows 60 requests/hour per IP. A real repository exhausts that during a scan. Set a fine-grained token with public-repo read only.",
      );
    }
    const rem = Number(remaining);
    const lim = Number(limit);
    show(
      "github quota",
      Number.isFinite(rem) && rem > 0,
      `${remaining}/${limit} remaining${resetAt ? `, resets ${resetAt}` : ""}`,
    );
  } else if (res.status === 401) {
    show("github reachable", false, "HTTP 401 — the token is invalid or expired");
  } else if (res.status === 403) {
    show("github reachable", false, "HTTP 403 — token lacks access, or the IP is blocked");
  } else {
    show("github reachable", false, `HTTP ${res.status}`);
  }
} catch (error) {
  show("github reachable", false, error.message);
}

// ── 2. DeepSeek: configured at all, and priced ─────────────────────────────
//
// The pricing check is the one that a deploy cannot fix on its own: a missing
// ai_model_configs row makes the budget gate refuse every call, and it looks
// exactly like "the AI is broken".
show(
  "deepseek key set",
  Boolean(DEEPSEEK_KEY),
  DEEPSEEK_KEY ? "present" : "absent — Phase 5 works, Phase 6 is refused with a reason",
);

// The pricing row cannot be checked from here, and that is deliberate.
//
// §90 closes `ai_model_configs` to every client key: RLS is enabled and the
// table has no SELECT policy, so the anon key reads zero rows whether or not
// the row exists. An earlier version of this script queried it anyway and
// reported "no default row" against a perfectly healthy database — a check
// that cannot fail correctly is worse than no check.
//
// Two ways to actually confirm pricing:
//   * SQL editor:  select provider, model_name, enabled, is_default
//                    from public.ai_model_configs;
//   * GET <supabase-url>/functions/v1/ai-admin?view=preflight
//     which reads it with the service role and is the check that ships.
note(
  "default model priced",
  "not checkable from here (RLS blocks the anon key by design) — run the SQL above, or use ?view=preflight",
);

console.log(
  failures === 0
    ? "\nAll checks passed. Next: POST {action:\"repository\"} on a real submission."
    : `\n${failures} check(s) failed. The scanner will not run until these are fixed.`,
);

process.exit(failures === 0 ? 0 : 1);
