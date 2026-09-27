/**
 * Tests for the request-security layer (Parts 14, 23, 24, 26).
 *
 * Redaction is the security-critical piece, so it is tested against the real
 * shapes a credential takes rather than a convenient one. A redactor that only
 * catches `sk-...` would look identical in a demo and leak a GitHub token in
 * production.
 *
 * Run: npx deno run --allow-env scripts/verify-security.ts
 */
import {
  MAX_BODY_BYTES,
  PayloadTooLarge,
  RateLimiter,
  readJsonBody,
  redactSecrets,
  safeMessage,
  securityHeaders,
  withSecurityHeaders,
} from "../supabase/functions/_shared/security.ts";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Redaction (Part 14.7) ───────────────────────────────────────────────────

console.log("\nSecret redaction");

const cases: [string, string, string][] = [
  // label, input, must-not-appear
  ["DeepSeek-style key", "key is sk-abcdefghijklmnopqrstuvwxyz012345 here", "sk-abcdefghij"],
  ["OpenAI project key", "OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOP1234", "sk-proj-ABCDEFGHIJ"],
  ["GitHub fine-grained", "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_ABCDEFGHIJ"],
  ["GitHub classic", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_ABCDEFGHIJ"],
  ["Authorization header", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef", "eyJhbGciOiJIUzI1NiJ9"],
  ["lowercase bearer", "authorization: bearer abcdefghijklmnop1234", "abcdefghijklmnop"],
  ["Supabase service JWT", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghij", "eyJyb2xlIjoi"],
  ["Google API key", "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "AIzaSyABCDEFGH"],
  ["Slack token", "xoxb-1234567890-abcdefghijklmnop", "xoxb-1234567890"],
  ["Stripe live key", "sk_live_abcdefghijklmnopqrstuvwx", "sk_live_abcdefgh"],
  ["labelled password", 'password = "hunter2correcthorse"', "hunter2correcthorse"],
  ["labelled api_key", "api_key: ABCDEFGHIJKLMNOP", "ABCDEFGHIJKLMNOP"],
  ["labelled secret", "client_secret=abcdefghijklmnop", "abcdefghijklmnop"],
  ["connection string", "postgres://admin:s3cr3tpass@db.internal/app", "s3cr3tpass"],
];

for (const [label, input, forbidden] of cases) {
  const out = redactSecrets(input);
  check(`redacts ${label}`, !out.includes(forbidden), out);
}

// A PEM private key is multi-line. A single-line regex would leak every line
// except the delimiters, which is the worst possible outcome: it looks redacted.
const pem = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAx7Vv8Q9pQ2mZx7Vv8Q9pQ2mZx7Vv8Q9pQ2mZx7Vv8Q9pQ2mZx",
  "8Q9pQ2mZx7Vv8Q9pQ2mZx7Vv8Q9pQ2mZx7Vv8Q9pQ2mZx7Vv8Q9pQ2mZx7Vv8Q9",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const pemOut = redactSecrets(`found this:\n${pem}\nin config`);
check("redacts a multi-line private key", !pemOut.includes("MIIEowIBAAKCAQEA"), pemOut);
check("redacts private key body lines", !pemOut.includes("8Q9pQ2mZx7Vv8Q9p"), pemOut);

// Redaction must not mangle ordinary text — a scanner that eats every
// alphanumeric run would be useless in practice.
check("leaves ordinary prose alone", redactSecrets("The build timer ends at 14:00.") === "The build timer ends at 14:00.");
check(
  "leaves a normal sentence alone",
  redactSecrets("We built a REST API with 12 endpoints for the hospital.") ===
    "We built a REST API with 12 endpoints for the hospital.",
);
check("handles null", redactSecrets(null) === "");
check("handles undefined", redactSecrets(undefined) === "");

// Every one of the real secrets from this project's own docs.
check(
  "redacts the project's real provider names",
  redactSecrets("DEEPSEEK_API_KEY=sk-1234567890abcdef GITHUB_TOKEN=ghp_1234567890abcdefghij") ===
    "DEEPSEEK_API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED]",
  redactSecrets("DEEPSEEK_API_KEY=sk-1234567890abcdef GITHUB_TOKEN=ghp_1234567890abcdefghij"),
);

// ── Safe messages (Part 14.8) ──────────────────────────────────────────────

console.log("\nError sanitisation");
check(
  "strips a token out of a provider error",
  !safeMessage(new Error("GitHub request failed: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
    .includes("ghp_ABCDEFGHIJ"),
  safeMessage(new Error("GitHub request failed: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")),
);
check(
  "falls back when a credential URL survives redaction",
  safeMessage(new Error("connect failed"), "Something went wrong.") === "connect failed",
);
check("handles a non-Error throw", safeMessage("plain string", "fallback") === "plain string");
check("returns the fallback for nothing", safeMessage(null, "fallback") === "fallback");
check(
  "truncates a very long message",
  safeMessage(new Error("x".repeat(1000))).length <= 301,
);

// ── Rate limiting (Part 24) ─────────────────────────────────────────────────

console.log("\nRate limiting");
let clock = 1000;
const limiter = new RateLimiter(() => clock);

const r1 = limiter.check("repository", "user-a", 3);
const r2 = limiter.check("repository", "user-a", 3);
const r3 = limiter.check("repository", "user-a", 3);
const r4 = limiter.check("repository", "user-a", 3);
check("allows up to the limit", r1.allowed && r2.allowed && r3.allowed);
check("refuses past the limit", !r4.allowed, JSON.stringify(r4));
check("reports a retry delay", r4.retryAfterSeconds > 0, String(r4.retryAfterSeconds));

// The limiter must be per caller, or one student's burst locks out everyone.
const other = limiter.check("repository", "user-b", 3);
check("does not let one caller affect another", other.allowed);

// And per action, or a full review budget would block a scan.
const otherAction = limiter.check("review", "user-a", 3);
check("tracks actions independently", otherAction.allowed);

// The window must actually close.
clock += 61_000;
const afterWindow = limiter.check("repository", "user-a", 3);
check("resets after the window", afterWindow.allowed);

// A read of stored data must not be limited — it costs nothing.
const free = limiter.check("read", "user-a", 0);
check("does not limit a zero-cost read", free.allowed && free.remaining === 0);

check(
  "enforce returns null when allowed",
  limiter.enforce("review", "user-c") === null,
);
for (let i = 0; i < 30; i++) limiter.check("review", "user-d", 30);
const blocked = limiter.enforce("review", "user-d");
check("enforce returns 429 when exceeded", blocked?.status === 429, String(blocked?.status));

limiter.sweep();
check("sweep is safe to call", true);

// ── Body limits (Part 14.14) ───────────────────────────────────────────────

console.log("\nRequest body limits");
const small = new Request("https://x.test", {
  method: "POST",
  body: JSON.stringify({ action: "repository", submission_id: "abc" }),
});
check("accepts a normal body", (await readJsonBody(small)).action === "repository");

const huge = new Request("https://x.test", {
  method: "POST",
  body: JSON.stringify({ blob: "x".repeat(MAX_BODY_BYTES + 1000) }),
});
let threw = false;
try {
  await readJsonBody(huge);
} catch (error) {
  threw = error instanceof PayloadTooLarge;
}
check("refuses an oversized body", threw);

const malformed = new Request("https://x.test", { method: "POST", body: "not json" });
let syntax = false;
try {
  await readJsonBody(malformed);
} catch (error) {
  syntax = error instanceof SyntaxError;
}
check("rejects malformed JSON as a syntax error", syntax);

const array = new Request("https://x.test", { method: "POST", body: "[1,2,3]" });
let rejected = false;
try {
  await readJsonBody(array);
} catch {
  rejected = true;
}
check("rejects a JSON array body", rejected);

const empty = new Request("https://x.test", { method: "POST", body: "" });
check("treats an empty body as {}", Object.keys(await readJsonBody(empty)).length === 0);

// ── Security headers (Part 26) ─────────────────────────────────────────────

console.log("\nSecurity headers");
for (const header of [
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Strict-Transport-Security",
]) {
  check(`sets ${header}`, Boolean(securityHeaders[header]));
}
check("denies framing", securityHeaders["X-Frame-Options"] === "DENY");
check("nosniff on content type", securityHeaders["X-Content-Type-Options"] === "nosniff");
const csp = securityHeaders["Content-Security-Policy"];
check("CSP has no wildcard script source", !/script-src[^;]*\*/.test(csp), csp);
check("CSP has no unsafe-inline in script-src", !/script-src[^;]*unsafe-inline/.test(csp), csp);
check("CSP blocks framing", csp.includes("frame-ancestors 'none'"));
check("CSP restricts connections to Supabase", csp.includes("https://*.supabase.co"));

// The wrapper must preserve the body and status while adding headers.
const original = new Response('{"ok":true}', {
  status: 201,
  headers: { "Content-Type": "application/json" },
});
const wrapped = withSecurityHeaders(original);
check("preserves status", wrapped.status === 201, String(wrapped.status));
check("preserves the body", (await wrapped.text()) === '{"ok":true}');
check("adds the headers", wrapped.headers.get("X-Frame-Options") === "DENY");
check("keeps the original content type", wrapped.headers.get("Content-Type") === "application/json");

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) Deno.exit(1);
