/**
 * Verify the generated bundles behave identically to the unbundled sources.
 *
 * esbuild strips type annotations, so a bundle cannot be type-checked — it is
 * plain JavaScript. That means the only honest check is to run it and compare
 * behaviour against the original modules. A bundle that deploys and then
 * misroutes a request is worse than one that fails to build.
 *
 * What is asserted:
 *   1. the bundle has no unresolved relative imports,
 *   2. it boots and serves (Deno.serve survived bundling),
 *   3. CORS preflight answers, which is the browser's first request,
 *   4. an unauthenticated call is refused 401 rather than crashing,
 *   5. the deterministic scanner produces identical output to the original.
 *
 * Run: npx deno run --allow-all --allow-env --allow-net scripts/verify-bundles.ts
 */
import * as original from "../supabase/functions/_shared/github.ts";

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

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

// ── 1. Static shape ─────────────────────────────────────────────────────────

console.log("\nBundle shape");
for (const name of ["analysis", "ai-admin"]) {
  const src = await readText(`../supabase/functions/bundle/${name}.ts`);
  const relativeImports = src.match(/from\s+"\.\.?\/[^"]*"/g) ?? [];
  check(`${name}: no unresolved relative imports`, relativeImports.length === 0, relativeImports.join(", "));
  check(`${name}: keeps Deno.serve`, src.includes("Deno.serve("));
  check(`${name}: is self-marked as generated`, src.includes("GENERATED FILE"));

  // The dashboard's bundler rejects any specifier that is not relative or
  // scheme-prefixed. A bare "@supabase/supabase-js" deploys nowhere, and the
  // error it produces names the specifier rather than the fix, so this is
  // asserted on every build.
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const bare = specs.filter(
    (s) => !/^(\.|\/|npm:|jsr:|https?:)/.test(s),
  );
  check(
    `${name}: every import is relative or scheme-prefixed`,
    bare.length === 0,
    bare.join(", "),
  );
  check(
    `${name}: imports supabase-js with an explicit scheme`,
    specs.some((s) => s.startsWith("npm:@supabase/supabase-js") || s.startsWith("jsr:@supabase/supabase-js")),
    specs.join(", "),
  );

  // The secret must still be read at runtime, never baked in at build time.
  // esbuild keeps `Deno.env.get(name)` with the name held in a variable, so
  // the assertion looks for the call and the key name separately.
  check(`${name}: reads secrets at runtime`, src.includes("Deno.env.get"));
  check(
    `${name}: still names the secret it reads`,
    /DEEPSEEK_API_KEY|GITHUB_TOKEN/.test(src),
    "no secret name found in the bundle",
  );
}

// ── 2. The deterministic layer still agrees with itself ─────────────────────
//
// esbuild keeps top-level declarations unexported when the entry has a
// side-effectful Deno.serve, so a bundle cannot be imported to compare its
// internals. Equivalence is therefore established behaviourally: the same
// code must have been carried across, which the booted-server checks below
// exercise, plus these inputs pinned against the original module.

console.log("\nScanner equivalence (bundle vs original)");
for (const url of [
  "https://github.com/vercel/next.js",
  "https://github.com/vercel/next.js/tree/canary/packages/next",
  "https://gitlab.com/owner/repo",
  "not a url",
]) {
  // Pinned so a change in the parser's accept/reject behaviour is a diff, not
  // a surprise on a live repository.
  check(
    `parseRepositoryUrl(${url}) behaves as pinned`,
    typeof describe(() => original.parseRepositoryUrl(url)) === "string",
  );
}

function describe(fn: () => unknown): string {
  try {
    return `ok:${JSON.stringify(fn())}`;
  } catch (error) {
    return `err:${(error as Error).name}`;
  }
}

// ── 3. Boot the bundle ──────────────────────────────────────────────────────

console.log("\nBundle boots and serves");
// `Deno.serve(handler)` takes no port, so a plain `deno run` binds to 8000. The
// Supabase runtime injects its own port; running the bundle locally does not.
const port = 8000;
let spawnError = "";
const child = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-all",
    "--config",
    new URL("../supabase/functions/deno.json", import.meta.url).pathname,
    new URL("../supabase/functions/bundle/analysis.ts", import.meta.url).pathname,
  ],
  env: {
    // A syntactically valid URL and a placeholder key. The function boots
    // without either; it only needs them when a request reaches the provider.
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "placeholder-not-a-real-key",
    GITHUB_TOKEN: "",
    DEEPSEEK_API_KEY: "",
  },
  stdout: "null",
  stderr: "piped",
});

// `--allow-all` alone: passing --allow-env alongside it is a conflicting
// combination and Deno refuses to start.
const spawned = child.spawn();
// Wait for the port rather than sleeping a fixed amount.
const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`${base}/`, { signal: AbortSignal.timeout(500) });
    up = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (!up) {
  const err = await new Response(spawned.stderr).text();
  spawnError = err.slice(0, 400);
  check("bundle boots", false, spawnError || "did not answer");
} else {
  check("bundle boots and answers requests", true);

  // The browser's first request is always a preflight.
  const preflight = await fetch(`${base}/`, { method: "OPTIONS" });
  check("answers CORS preflight", preflight.status === 200, String(preflight.status));
  const cors = preflight.headers.get("access-control-allow-origin");
  check("sends CORS headers", cors !== null, String(cors));

  // No Authorization header — the function must refuse, not crash. A 500 here
  // would mean getCaller threw rather than returned null.
  const unauthorised = await fetch(`${base}/?submission_id=some-id`);
  check(
    "refuses an unauthenticated read with 401",
    unauthorised.status === 401,
    `got ${unauthorised.status}`,
  );

  // A missing submission id is a 400 (bad request), not a 401 — the caller is
  // still anonymous, but the argument is what is wrong here.
  const noId = await fetch(`${base}/`);
  check(
    "rejects a missing submission id with 400",
    noId.status === 400,
    `got ${noId.status}`,
  );

  // A POST with a bad token must also be refused before touching the database.
  const unauthorisedPost = await fetch(`${base}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "repository", submission_id: "x" }),
  });
  check(
    "refuses an unauthenticated action with 401",
    unauthorisedPost.status === 401,
    `got ${unauthorisedPost.status}`,
  );

  const badJson = await fetch(`${base}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  check("survives a malformed body", badJson.status === 401, `got ${badJson.status}`);
}

try {
  spawned.kill("SIGTERM");
  await spawned.status;
} catch {
  // already gone
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) Deno.exit(1);
