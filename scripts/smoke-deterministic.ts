/**
 * Runtime smoke test for the deterministic scanner layer (Phase 5).
 *
 * The Python reference has 40 unit tests. This asserts the *same* guarantees
 * against the edge-function implementation, because the two implement one
 * contract — a regression on one side while the other stays green is exactly
 * the failure that would reach a real repository.
 *
 * Everything here is deterministic: no network, no AI, no database. It is the
 * only layer that can be fully verified without deploying.
 *
 * Run: npx deno run --allow-env scripts/smoke-deterministic.ts
 */
import {
  EvidenceRegistry,
  detectFrameworks,
  extractDependencies,
  extractRoutes,
  extractSymbols,
  parseRepositoryUrl,
  scanFileForSecrets,
} from "../supabase/functions/_shared/github.ts";
import { shortHash } from "../supabase/functions/_shared/ai.ts";

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

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── Repository URL parsing ──────────────────────────────────────────────────

console.log("\nRepository URL parsing");
for (const url of [
  "https://github.com/vercel/next.js",
  "https://github.com/vercel/next.js/",
  "https://github.com/vercel/next.js.git",
  "http://github.com/vercel/next.js",
  "github.com/vercel/next.js",
]) {
  try {
    const ref = parseRepositoryUrl(url);
    check(
      `accepts ${url}`,
      ref.owner === "vercel" && ref.repo === "next.js",
      `got ${ref.owner}/${ref.repo}`,
    );
  } catch (error) {
    check(`accepts ${url}`, false, (error as Error).message);
  }
}

// A /tree/ or /blob/ URL points at a folder or a file, not a repository.
// Accepting it would silently scan the wrong thing.
for (const url of [
  "https://github.com/vercel/next.js/tree/canary/packages/next",
  "https://github.com/vercel/next.js/blob/main/README.md",
]) {
  check(`rejects sub-path ${url.slice(31, 58)}…`, throws(() => parseRepositoryUrl(url)));
}

for (const url of [
  "https://gitlab.com/owner/repo",
  "https://bitbucket.org/owner/repo",
  "https://example.com/owner/repo",
  "not a url",
  "https://github.com/",
  "https://github.com/onlyowner",
]) {
  check(`rejects "${url}"`, throws(() => parseRepositoryUrl(url)));
}

// ── Route extraction ────────────────────────────────────────────────────────

console.log("\nRoute extraction");
const spring = extractRoutes(
  "src/main/java/com/app/UserController.java",
  `@RestController
@RequestMapping("/api/v1")
class UserController {
  @GetMapping("/users/{id}")
  public User get(@PathVariable String id) { return null; }

  @PostMapping("/users")
  public User create(@RequestBody User u) { return null; }

  @DeleteMapping("/users/{id}")
  public void delete(@PathVariable String id) {}
}`,
);
check("finds Spring @GetMapping", spring.some((r) => r.method === "GET"));
check("finds Spring @PostMapping", spring.some((r) => r.method === "POST"));
check("finds Spring @DeleteMapping", spring.some((r) => r.method === "DELETE"));
// Spring composes the class prefix with the method path, so `/users` is not the
// route — `/api/v1/users` is. Reporting the bare method path is a wrong answer,
// and an AI given one will review the wrong endpoint.
check(
  "joins the class @RequestMapping prefix",
  spring.some((r) => r.path === "/api/v1/users" && r.method === "POST"),
  spring.map((r) => `${r.method} ${r.path}`).join(", "),
);
check(
  "joins the prefix onto a parametrised path",
  spring.some((r) => r.path === "/api/v1/users/{id}" && r.method === "GET"),
  spring.map((r) => `${r.method} ${r.path}`).join(", "),
);
check("tags the framework", spring.every((r) => r.framework === "Spring"));

// A controller with no class-level prefix must be unaffected.
const bare = extractRoutes(
  "src/PingController.java",
  `@RestController
class PingController {
  @GetMapping("/ping")
  public String ping() { return "pong"; }
}`,
);
check(
  "leaves an unmounted controller alone",
  bare.length === 1 && bare[0].path === "/ping",
  bare.map((r) => r.path).join(", "),
);
check("records the file and line", spring.every((r) => r.file.endsWith(".java") && r.line > 0));
check("does not invent a route for the class prefix", spring.length === 3, `found ${spring.length}`);

const express = extractRoutes(
  "src/server.js",
  `app.get("/health", handler);
router.post("/orders/:id/cancel", cancel);
app.put("/settings", save);
app.delete("/items/:id", remove);`,
);
check("finds Express GET", express.some((r) => r.method === "GET" && r.path === "/health"));
check("finds Express POST with :param", express.some((r) => r.path.includes("orders")));
check("finds Express PUT", express.some((r) => r.method === "PUT"));
check("finds Express DELETE", express.some((r) => r.method === "DELETE"));

// The file-based route convention, which is the other common shape.
const nextRoutes = extractRoutes("app/dashboard/page.tsx", "export default function Page() {}");
check("recognises an app/ route file", nextRoutes.length > 0);

// ── Dependencies ────────────────────────────────────────────────────────────

console.log("\nDependency parsing");
const pkg = extractDependencies(
  "package.json",
  JSON.stringify({
    dependencies: { express: "^4.18.2", zod: "^3.23.8" },
    devDependencies: { vitest: "^2.0.0" },
  }),
);
const names = pkg.map((d) => d.package);
check("finds express", names.includes("express"), names.join(", "));
check("finds zod", names.includes("zod"));
check("finds a devDependency", names.includes("vitest"));
// The range prefix is stripped so `^4.18.2` and `~4.18.2` compare equal.
check("records a version without the range prefix", pkg.find((d) => d.package === "express")?.version === "4.18.2", pkg.find((d) => d.package === "express")?.version);
check(
  "marks express as a dependency, vitest as dev",
  pkg.find((d) => d.package === "express")?.dev === false &&
    pkg.find((d) => d.package === "vitest")?.dev === true,
);
check("labels the ecosystem", pkg.find((d) => d.package === "express")?.ecosystem === "npm");

const reqs = extractDependencies("requirements.txt", "flask==2.3.0\n# a comment\nrequests>=2.31\n\nsqlalchemy\n");
const reqNames = reqs.map((d) => d.package);
check("finds flask", reqNames.includes("flask"), reqNames.join(", "));
check("finds requests", reqNames.includes("requests"));
check("finds a version-less dep", reqNames.includes("sqlalchemy"), reqNames.join(", "));
check("gives a version-less dep a null version", reqs.find((d) => d.package === "sqlalchemy")?.version === null);
check("ignores a requirements option line", !reqNames.includes("-r"));
check(
  "cleans a pinned version to digits",
  reqs.find((d) => d.package === "flask")?.version === "2.3.0",
  String(reqs.find((d) => d.package === "flask")?.version),
);
check("labels the python ecosystem", reqs.find((d) => d.package === "flask")?.ecosystem === "pypi");

// A malformed manifest must degrade, never throw. §13: a bad file may not stop
// a scan of ten thousand good ones.
check(
  "survives malformed JSON",
  extractDependencies("package.json", "{ not json at all").length === 0,
);
check("ignores an unknown file", extractDependencies("notes.txt", "hello").length === 0);

// ── Secret redaction ────────────────────────────────────────────────────────
//
// The most important guarantee in the file: a real-looking credential must
// never reach the database or the model. A miss here is a leak to a third party.

console.log("\nSecret redaction");
const findings = scanFileForSecrets(
  "config.py",
  `OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
DB = "postgresql://admin:supersecret@db.internal:5432/prod"
password = "correcthorsebattery"
`,
);
const types = findings.map((f) => f.secret_type);
check("flags an OpenAI key", types.includes("openai_key"), types.join(", "));
check("flags a GitHub token", types.includes("github_token"));
check("flags a connection string", types.includes("connection_string"));

// The value itself must never appear in the finding.
const serialised = JSON.stringify(findings);
check("never echoes the key", !serialised.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"));
check("never echoes the GitHub token", !serialised.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
check("never echoes the password", !serialised.includes("supersecret"));
check("redacts with a marker", findings.every((f) => f.redacted.includes("[redacted]")));

// A false positive here is expensive: it tells students their repo is unsafe
// when it is not, and a finding that is always wrong trains people to ignore
// the real ones.
const placeholders = scanFileForSecrets(
  "config.ts",
  `const API_KEY = "your_api_key_here";
const SECRET = "changeme";
const url = "postgres://user:pass@localhost/db";
const ci = "postgresql://postgres:postgres@127.0.0.1:5432/app";
// const key = "example-secret-value-here"
`,
);
check(
  "ignores obvious placeholders",
  !placeholders.some((f) => ["openai_key", "api_key_assignment", "connection_string"].includes(f.secret_type)),
  placeholders.map((f) => f.secret_type).join(", "),
);

// Reading a variable is not a leak, however the file gets the value.
const fromEnv = scanFileForSecrets(
  "server.ts",
  `const token = process.env.GITHUB_TOKEN;
const other = Deno.env.get("DEEPSEEK_API_KEY");
const key = os.environ["OPENAI_KEY"];`,
);
check(
  "ignores environment reads",
  fromEnv.length === 0,
  fromEnv.map((f) => f.secret_type).join(", "),
);

// A real remote host must still be caught, or the local-host exemption has
// swallowed the rule it was added to protect.
const realHost = scanFileForSecrets(
  ".env",
  `DATABASE_URL=postgresql://admin:hunter2xyz@db.prod.acme.internal:5432/app`,
);
check("still flags a real remote host", realHost.some((f) => f.secret_type === "connection_string"));
check("and still redacts it", !JSON.stringify(realHost).includes("hunter2xyz"));

// ── Symbols ─────────────────────────────────────────────────────────────────

console.log("\nSymbol extraction");
const { symbols: syms, parserStatus } = extractSymbols(
  "src/orders.ts",
  `export class OrderService {
  async createOrder(input: Input): Promise<Order> { return null; }
  private validate(x: string) { return true; }
}
export function helper() {}
const arrow = (a: number) => a * 2;
`,
);
const symNames = syms.map((s) => s.name);
check("reports the parser as ok", parserStatus === "ok");
check("finds a class", symNames.includes("OrderService"), symNames.join(", "));
check("finds a function", symNames.includes("helper"));
check("finds a method", symNames.includes("createOrder"), symNames.join(", "));
check("finds an arrow function", symNames.includes("arrow"));
check(
  "finds a plain method",
  symNames.includes("validate"),
  symNames.join(", "),
);
check(
  "types a method as a method, not a plain function",
  syms.find((s) => s.name === "createOrder")?.symbol_type === "method",
  syms.find((s) => s.name === "createOrder")?.symbol_type,
);

// §21 — an unsupported language reports rather than fabricating an empty result
// that reads as "this file has no symbols".
const unsupported = extractSymbols("notes.txt", "hello world");
check("reports an unsupported language", unsupported.parserStatus === "unsupported");
check("fabricates nothing for it", unsupported.symbols.length === 0);

// ── Evidence registry ───────────────────────────────────────────────────────
//
// Stable ids are what make the AI cache safe (§58): the same commit must
// produce the same ids, or the cache silently misses and re-pays every call.

console.log("\nDetection");
const expressDeps = extractDependencies(
  "package.json",
  JSON.stringify({ dependencies: { express: "^4.18.2", vitest: "^2.0.0", "passport-local": "^1.0.0" } }),
);
const fw = detectFrameworks(expressDeps, ["package.json"]);
const fwNames = fw.map((f) => f.name);
check("detects Express", fwNames.includes("Express"), fwNames.join(", "));
// `vitest` contains `vite` and `passport-local` contains `passport`. Substring
// matching would credit a student with two frameworks they did not install.
check("does not mistake vitest for Vite", !fwNames.includes("Vite"), fwNames.join(", "));
check("does not mistake passport-local for Passport", !fwNames.includes("Passport"), fwNames.join(", "));
check("cites the package as evidence", fw.every((f) => f.evidence.startsWith("dependency ")));

// A config file is a stronger signal than a guessed package, and must still win.
const withConfig = detectFrameworks(expressDeps, ["vite.config.ts"]);
check("detects Vite from its config file", withConfig.map((f) => f.name).includes("Vite"));

console.log("\nEvidence registry");
const registry = new EvidenceRegistry();
const first = registry.add({ type: "route", claim: "GET /health exists", file: "src/server.js", line: 1 });
const again = registry.add({ type: "route", claim: "GET /health exists", file: "src/server.js", line: 1 });
const different = registry.add({ type: "route", claim: "POST /orders exists", file: "src/server.js", line: 2 });
check("gives a stable id for the same evidence", first.id === again.id, `${first.id} vs ${again.id}`);
check("does not duplicate identical evidence", registry.toList().length === 2);
check("distinguishes different evidence", first.id !== different.id);
check("uses a readable id format", /^EV-\d{3}$/.test(first.id), first.id);

// A second registry over the same inputs must reproduce the same ids, or the
// cache is not keyed on anything stable.
const registry2 = new EvidenceRegistry();
registry2.add({ type: "route", claim: "GET /health exists", file: "src/server.js", line: 1 });
check(
  "is reproducible across runs",
  registry2.toList()[0].id === first.id,
  `${registry2.toList()[0].id} vs ${first.id}`,
);

// ── Cache identity ──────────────────────────────────────────────────────────

console.log("\nCache identity");
const a = await shortHash("hello");
const b = await shortHash("hello");
const c = await shortHash("hello!");
check("is deterministic", a === b);
check("distinguishes input", a !== c);
check("is hex and short enough to store", /^[0-9a-f]{32}$/.test(a), `got "${a}"`);
// The full sha256 of "hello", so a truncation bug would be visible here.
check("is a truncated sha256", a === "2cf24dba5fb0a30e26e83b2ac5b9e29e", `got "${a}"`);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) Deno.exit(1);
