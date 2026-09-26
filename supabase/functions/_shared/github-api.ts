/**
 * GitHub REST client.
 *
 * Deliberately small and boring: cache, retry, back off, and refuse to hammer
 * a rate limit. Everything the scanner needs is here, and nothing else.
 *
 * Two rules shape this module:
 *   * §12 — rate limits are tracked and retried with exponential backoff up to
 *     a limit, and a rate-limited request raises immediately so the scan can
 *     degrade instead of stalling.
 *   * §13 — responses are cached for the life of the invocation, so a
 *     re-analysis of the same commit does not re-fetch the tree.
 */

import { settings } from "./config.ts";
import { InvalidRepositoryUrl, parseRepositoryUrl } from "./github.ts";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 0,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface RateLimitState {
  limit: number;
  /**
   * -1 means "unknown". It must not default to 0: a zero default reads as
   * "exhausted" and would refuse the very first request of every scan.
   */
  remaining: number;
  resetEpoch: number;
  // Secondary (abuse) limits are not advertised through headers in a way we can
  // rely on, so we self-impose a small pause after a 403/429.
  cooldownUntil: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubClient {
  private readonly cache = new Map<string, unknown>();
  readonly rateLimit: RateLimitState = {
    limit: 0,
    remaining: -1,
    resetEpoch: 0,
    cooldownUntil: 0,
  };

  private get exhausted(): boolean {
    return (
      this.rateLimit.remaining === 0 ||
      Date.now() / 1000 < this.rateLimit.cooldownUntil
    );
  }

  /** GET a GitHub path, returning decoded JSON. */
  async get<T = unknown>(path: string, cacheable = true): Promise<T> {
    if (cacheable && this.cache.has(path)) {
      return this.cache.get(path) as T;
    }

    if (this.exhausted) {
      throw new GitHubError(
        "GitHub rate limit reached; analysis cannot continue right now.",
        "rate_limited",
        429,
      );
    }

    const { githubMaxRetries, githubTimeoutSeconds } = settings();
    let lastError: GitHubError | null = null;

    for (let attempt = 0; attempt < githubMaxRetries; attempt++) {
      const response = await this.request(path, githubTimeoutSeconds);

      if (response.status === 200) {
        const body = (await response.json()) as T;
        if (cacheable) this.cache.set(path, body);
        return body;
      }

      if (response.status === 404) {
        throw new GitHubError(
          "That repository, branch or file was not found on GitHub.",
          "not_found",
          404,
        );
      }

      if (response.status === 403 || response.status === 429) {
        // §12 — never blindly retry a rate-limited request. We record a
        // cooldown and stop; the caller degrades gracefully.
        this.rateLimit.cooldownUntil = Date.now() / 1000 + Math.min(60, 2 * (attempt + 1));
        this.rateLimit.remaining = 0;
        throw new GitHubError(
          "GitHub rate limit reached; analysis cannot continue right now.",
          "rate_limited",
          response.status,
        );
      }

      if (response.status >= 500) {
        lastError = new GitHubError(
          `GitHub is unavailable (${response.status}).`,
          "provider_error",
          response.status,
        );
      } else {
        throw new GitHubError("GitHub rejected the request.", "client_error", response.status);
      }

      // Exponential backoff, but only for retryable transport/server errors.
      if (attempt < githubMaxRetries - 1) {
        await sleep(Math.min(8000, 750 * 2 ** attempt));
      }
    }

    throw lastError ?? new GitHubError("GitHub request failed.", "network");
  }

  /** One HTTP attempt, with the rate-limit headers read on every response. */
  private async request(path: string, timeoutSeconds: number): Promise<Response> {
    const { githubApiBase, githubToken } = settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HackSim-Scanner",
    };
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

    try {
      const response = await fetch(`${githubApiBase}${path}`, {
        headers,
        signal: controller.signal,
      });
      this.readRateLimitHeaders(response);
      return response;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw aborted
        ? new GitHubError("GitHub timed out.", "timeout")
        : new GitHubError(
            `GitHub request failed: ${(error as Error)?.message ?? error}`,
            "network",
          );
    } finally {
      clearTimeout(timer);
    }
  }

  private readRateLimitHeaders(response: Response): void {
    // A missing header leaves the previous value alone. Treating "absent" as 0
    // would mark the client exhausted on any response GitHub did not annotate.
    const read = (name: string) => {
      const raw = response.headers.get(name);
      if (raw === null) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const limit = read("x-ratelimit-limit");
    const remaining = read("x-ratelimit-remaining");
    const reset = read("x-ratelimit-reset");

    if (limit !== null) this.rateLimit.limit = limit;
    if (remaining !== null) this.rateLimit.remaining = remaining;
    if (reset !== null) this.rateLimit.resetEpoch = reset;
  }

  // ── §10 URL validation + parsing ─────────────────────────────────────────

  parseRepositoryUrl(url: string): { owner: string; repo: string } {
    try {
      const ref = parseRepositoryUrl(url);
      return { owner: ref.owner, repo: ref.repo };
    } catch (error) {
      if (error instanceof InvalidRepositoryUrl) {
        throw new GitHubError(error.message, "invalid_url");
      }
      throw error;
    }
  }

  // ── §11 endpoints the scanner uses ───────────────────────────────────────

  repository(owner: string, repo: string) {
    return this.get(`/repos/${owner}/${repo}`);
  }

  latestCommit(owner: string, repo: string, branch: string) {
    return this.get(`/repos/${owner}/${repo}/commits/${branch}`);
  }

  gitTree(owner: string, repo: string, commitSha: string) {
    return this.get(`/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`);
  }

  /**
   * Raw file bytes, cached.
   *
   * Uses the blob API rather than /contents so a file is fetched in one request
   * regardless of size, and we never base64-decode a payload we would then
   * throw away.
   */
  async blob(owner: string, repo: string, blobSha: string): Promise<Uint8Array> {
    if (this.cache.has(blobSha)) {
      return this.cache.get(blobSha) as Uint8Array;
    }
    if (this.exhausted) {
      throw new GitHubError(
        "GitHub rate limit reached; analysis cannot continue right now.",
        "rate_limited",
        429,
      );
    }

    const { githubApiBase, githubToken, githubTimeoutSeconds, analysisMaxFileBytes } =
      settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), githubTimeoutSeconds * 1000);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HackSim-Scanner",
    };
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

    try {
      const response = await fetch(
        `${githubApiBase}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
        { headers, signal: controller.signal },
      );
      this.readRateLimitHeaders(response);

      if (response.status === 200) {
        const payload = (await response.json()) as { content?: string };
        const binary = atob((payload.content ?? "").replace(/\n/g, ""));
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        // Only small files are worth keeping in memory.
        if (bytes.length <= analysisMaxFileBytes) this.cache.set(blobSha, bytes);
        return bytes;
      }

      if (response.status === 403 || response.status === 429) {
        this.rateLimit.cooldownUntil = Date.now() / 1000 + 5;
        this.rateLimit.remaining = 0;
        throw new GitHubError(
          "GitHub rate limit reached; analysis cannot continue right now.",
          "rate_limited",
          response.status,
        );
      }

      throw new GitHubError(
        `Could not read a file from the repository (HTTP ${response.status}).`,
        "blob_error",
        response.status,
      );
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw aborted
        ? new GitHubError("GitHub timed out.", "timeout")
        : new GitHubError(
            `Could not read a file from the repository: ${(error as Error)?.message ?? error}`,
            "blob_error",
          );
    } finally {
      clearTimeout(timer);
    }
  }
}
