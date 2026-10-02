/**
 * Cross-cutting request security: rate limiting, body size caps, secret
 * redaction, and security headers.
 *
 * The spec asks for these as system-wide guarantees (Parts 14, 23, 24, 26)
 * rather than per-endpoint code, because a rule applied in one handler is a
 * rule that is eventually missing from another. Everything here is deliberately
 * dependency-free and in-memory: an edge function instance is short-lived, and
 * a shared store would be a network hop in front of every request.
 *
 * The limiters are per-instance, which is a real limitation and worth stating
 * plainly: a burst is capped per warm instance, not per account across the fleet.
 * That is enough to stop a single client hammering an expensive endpoint, which
 * is the failure this exists to prevent. Making it exact would mean a shared
 * store (Postgres or Redis) and a round trip on every call; the trade is
 * deliberate, and the comment is here so nobody assumes otherwise.
 */

import { json, fail } from "./http.ts";

// ── Security headers (Part 26) ──────────────────────────────────────────────

/**
 * Applied to every response.
 *
 * No wildcard `script-src`: the frontend is a Vite bundle that needs no inline
 * script from us, and `unsafe-inline` is exactly the allowance Part 26 warns
 * against. The frame denial matters most — it is what stops a student project
 * from being framed for clickjacking inside an admin session.
 */
export const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  // `connect-src` allows the Supabase project the app talks to and nothing else,
  // so a compromised dependency cannot exfiltrate a session to a third origin.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",   // Tailwind injects a stylesheet at runtime
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "),
};

/** Merge the security headers into an existing response, preserving its body. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Request body limits (Part 14.14) ────────────────────────────────────────

/** 256 KB. A repository URL or a project description is kilobytes, not megabytes. */
export const MAX_BODY_BYTES = 256 * 1024;

export class PayloadTooLarge extends Error {
  constructor(readonly limit: number) {
    super("Request body is too large.");
    this.name = "PayloadTooLarge";
  }
}

/**
 * Read a JSON body with a size cap.
 *
 * `Content-Length` is only a hint — it is absent on chunked requests and can be
 * a lie on a hostile one — so the cap is enforced again on the bytes actually
 * read. A declared-but-short body is rejected, which is the correct direction
 * to be wrong in.
 */
export async function readJsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PayloadTooLarge(MAX_BODY_BYTES);
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new PayloadTooLarge(MAX_BODY_BYTES);

  if (!text.trim()) return {} as T;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // SyntaxError specifically: withErrorHandling maps it to a 400. A plain
    // Error here would surface as a 500 and tell a user their malformed body
    // was our fault.
    throw new SyntaxError("Request body must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Request body must be a JSON object.");
  }
  return parsed as T;
}

// ── Rate limiting (Part 24) ─────────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Which endpoints are expensive enough to be worth limiting.
 *
 * A read of already-stored analysis costs the platform nothing beyond a query,
 * so limiting it would only add latency and confusion. The list is the set of
 * things that either call a paid provider or burn GitHub quota.
 */
const COSTLY_ACTIONS: Record<string, number> = {
  repository: 10,     // GitHub: a real repository is dozens of API calls
  reanalyze: 10,
  analyze: 30,        // DeepSeek: a few grouped model calls per run
  review: 30,
  "retry-task": 10,
  "retry-module": 10,
};

const DEFAULT_WINDOW_MS = 60_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
}

/**
 * A fixed-window counter keyed by action and caller.
 *
 * Fixed-window rather than sliding because it needs no ordering and cannot
 * grow without bound. The known cost is that a caller can spend a full window's
 * budget at the boundary; at these limits that is irrelevant.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * @param action    the expensive operation, e.g. "repository"
   * @param callerId  the authenticated user id — never a client-supplied value
   * @param limit     permits per window
   */
  check(action: string, callerId: string, limit: number): RateLimitResult {
    const windowMs = DEFAULT_WINDOW_MS;
    const key = `${action}:${callerId}`;
    const at = this.now();

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      this.buckets.set(key, { count: 1, resetAt: at + windowMs });
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0, limit };
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)),
        limit,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      // Clamped: a limit of 0 means "not rate limited", and `0 - 1` reporting a
      // negative allowance would be nonsense to anything reading the header.
      remaining: Math.max(0, limit - bucket.count),
      retryAfterSeconds: 0,
      limit,
    };
  }

  /** Reject a request that would exceed a limit, naming the wait. */
  enforce(action: string, callerId: string): Response | null {
    const limit = COSTLY_ACTIONS[action] ?? 0;
    if (limit === 0) return null;

    const result = this.check(action, callerId, limit);
    if (result.allowed) return null;

    return fail(
      `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
      429,
      { retry_after: result.retryAfterSeconds, limit: result.limit },
    );
  }

  /** Drop expired buckets so a long-lived instance does not accumulate them. */
  sweep(): void {
    const at = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
  }
}

export const rateLimiter = new RateLimiter();

// ── Secret redaction (Part 14.7, 14.8) ─────────────────────────────────────

/**
 * Strips credentials from anything on its way to a log or an admin.
 *
 * This mirrors `redact_secrets()` in 007 so the same input is scrubbed whether
 * it reaches Postgres or a console line. Both are needed: the SQL function
 * guards the audit log, this guards `console.error` in the edge runtime, and
 * neither can see the other.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  // Authorization headers, in any casing, with the scheme preserved for context.
  [/\b(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+/-]{12,}=*/gi, "$1$2[REDACTED]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1[REDACTED]"],
  // Provider key shapes, before the generic rule so the label is preserved.
  [/\b(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "[REDACTED]"],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "[REDACTED]"],
  [/\b(AIza[A-Za-z0-9_-]{20,})/g, "[REDACTED]"],
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]"],
  [/\b([sr]k_(?:live|test)_[A-Za-z0-9]{12,})/g, "[REDACTED]"],
  // A URL carrying its own credentials. This one has no label to key off, so
  // it needs a rule of its own: `postgres://admin:s3cr3t@db/app` appears bare in
  // a stack trace or an error string and the labelled pattern below would miss
  // it entirely. The userinfo half goes; the host is kept, because "which host"
  // is diagnostic and "the password" is not.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s:@]+)@/gi, "$1$2:[REDACTED]@"],
  // PEM blocks: a private key is a multi-line secret that a single-line regex
  // would otherwise leak a line of.
  [/-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, "[REDACTED]"],
  // Labelled assignments — the last line of defence, so `password = "hunter2"`
  // is caught even when the value does not match a provider's shape.
  [
    /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|connection[_-]?string)\s*[:=]\s*)(['"]?)[^\s'",;}]{8,}\2/gi,
    "$1[REDACTED]",
  ],
];

/** Replace every credential-shaped substring with `[REDACTED]`. */
export function redactSecrets(input: string | null | undefined): string {
  if (!input) return "";
  let out = String(input);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * A console that cannot leak.
 *
 * Every internal log line goes through this rather than `console.*` directly, so
 * a future log statement cannot accidentally print a key. The caller-supplied
 * message is redacted, and objects are serialised first — an Error's useful
 * detail is often in a nested cause, and `String(err)` would lose it.
 */
export const safeLog = {
  info(scope: string, message: string, detail?: unknown) {
    console.log(`[${scope}] ${redactSecrets(message)}`, detail ? safeDetail(detail) : "");
  },
  warn(scope: string, message: string, detail?: unknown) {
    console.warn(`[${scope}] ${redactSecrets(message)}`, detail ? safeDetail(detail) : "");
  },
  error(scope: string, message: string, detail?: unknown) {
    console.error(`[${scope}] ${redactSecrets(message)}`, detail ? safeDetail(detail) : "");
  },
};

function safeDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return redactSecrets(`${detail.name}: ${detail.message} ${detail.stack ?? ""}`);
  }
  try {
    return redactSecrets(JSON.stringify(detail));
  } catch {
    return "[unserialisable]";
  }
}

/**
 * Turn any thrown value into something safe to return to a client (Part 14.8).
 *
 * A provider error often carries the request that caused it, and that request
 * carried the credential. Redaction here is the last thing between a provider
 * stack trace and a student's browser.
 */
export function safeMessage(error: unknown, fallback = "Something went wrong."): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = redactSecrets(raw).trim();
  if (!cleaned) return fallback;
  // Anything that still looks like a URL with credentials, or a raw token, is
  // replaced wholesale rather than trusted after partial redaction.
  if (/:\/\/[^/\s:@]+:[^/\s:@]+@/.test(cleaned)) return fallback;
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

export { json };
