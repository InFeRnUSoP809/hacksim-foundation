/**
 * Configuration for the HackSim edge functions.
 *
 * Every secret comes from the environment. Nothing here has a default that
 * could let a function start believing it has a credential it does not have.
 *
 * Secrets are set with `supabase secrets set`, never in a `.env` file:
 *   supabase secrets set DEEPSEEK_API_KEY=sk-... GITHUB_TOKEN=ghp_...
 */

function num(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  return Deno.env.get(name) || fallback;
}

export interface Settings {
  // GitHub (Phase 5). Optional: without a token GitHub answers 60 requests
  // per hour per IP, which the scanner exhausts on a real repository.
  githubToken: string;
  githubApiBase: string;
  githubTimeoutSeconds: number;
  githubMaxRetries: number;

  // DeepSeek (Phase 6). Absent key means Phase 5 still works and Phase 6 is
  // skipped with a recorded reason.
  deepseekApiKey: string;
  deepseekModel: string;
  deepseekBaseUrl: string;
  deepseekTimeoutSeconds: number;

  // Analysis budgets. The live ceilings live in `ai_budgets`; these are the
  // scanner's own reading limits.
  analysisMaxFiles: number;
  analysisLargeRepoThreshold: number;
  analysisMaxFileBytes: number;
  retrievalMaxFiles: number;
  retrievalMaxSnippetLines: number;
}

let cached: Settings | null = null;

export function settings(): Settings {
  if (cached) return cached;
  cached = {
    githubToken: str("GITHUB_TOKEN", ""),
    githubApiBase: str("GITHUB_API_BASE", "https://api.github.com"),
    githubTimeoutSeconds: num("GITHUB_TIMEOUT_SECONDS", 20),
    githubMaxRetries: num("GITHUB_MAX_RETRIES", 3),

    deepseekApiKey: str("DEEPSEEK_API_KEY", ""),
    deepseekModel: str("DEEPSEEK_MODEL", "deepseek-flash"),
    deepseekBaseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    deepseekTimeoutSeconds: num("DEEPSEEK_TIMEOUT_SECONDS", 60),

    analysisMaxFiles: num("ANALYSIS_MAX_FILES", 400),
    analysisLargeRepoThreshold: num("ANALYSIS_LARGE_REPO_THRESHOLD", 2000),
    analysisMaxFileBytes: num("ANALYSIS_MAX_FILE_BYTES", 400_000),
    retrievalMaxFiles: num("RETRIEVAL_MAX_FILES", 6),
    retrievalMaxSnippetLines: num("RETRIEVAL_MAX_SNIPPET_LINES", 120),
  };
  return cached;
}

/** False means Phase 6 is unavailable. Phase 5 does not use this. */
export function hasDeepseek(): boolean {
  return Boolean(settings().deepseekApiKey);
}

/** Stable short hex digest. Used for cache identity (§58) and brief hashes. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The first 32 characters — the width every stored hash in the schema uses. */
export async function shortHash(input: string): Promise<string> {
  return (await sha256Hex(input)).slice(0, 32);
}
