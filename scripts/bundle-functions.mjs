#!/usr/bin/env node
/**
 * Cross-platform edge function bundler (same behavior as bundle-functions.sh).
 * Run: npm run bundle:functions
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FUNCTIONS = path.join(ROOT, "supabase", "functions");
const OUT = path.join(FUNCTIONS, "bundle");

const ENGINE_MARKERS = ["hacksim-analysis-v1", "new-engine-v1"];
const LEGACY_INLINED_SCANNER = /\/\/ _shared\/scanner\.ts/;
const LEGACY_SCANNER_VERSION = /SCANNER_VERSION\s*=\s*["']p5-/;
const LEGACY_ORCHESTRATOR = [
  /\bexecuteAnalysisPlan\s*\(/,
  /\brunModuleReview\s*\(/,
  /\bplanAnalysisTasks\s*\(/,
];
const V1_FINGERPRINTS = [
  "engine_brief_verification",
  "engine_implementation_verification",
  "implementation_workflows",
  'handler: "analysis-v1"',
];

function banner(name, lineCount) {
  return [
    "// ─────────────────────────────────────────────────────────────────────",
    "// GENERATED FILE — do not edit.",
    "//",
    "// Built by scripts/bundle-functions.mjs (or bundle-functions.sh) from",
    `//   supabase/functions/${name}/index.ts`,
    "// plus supabase/functions/_shared/** (including engine/)",
    "//",
    "// Edit the sources, then re-run: npm run bundle:functions",
    `// ${lineCount} lines, self-contained — safe to paste into the Supabase dashboard.`,
    "// ─────────────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}

function assertBundleIdentity(name, content) {
  for (const marker of ENGINE_MARKERS) {
    if (!content.includes(marker)) {
      throw new Error(
        `Bundle ${name}.ts is missing required engine marker "${marker}". ` +
          "Source uses engine v1 but the bundle was not rebuilt from analysis/index.ts.",
      );
    }
  }
  if (LEGACY_INLINED_SCANNER.test(content)) {
    throw new Error(
      `Bundle ${name}.ts still inlines legacy scanner.ts — rebuild from current analysis/index.ts.`,
    );
  }
  if (LEGACY_SCANNER_VERSION.test(content)) {
    throw new Error(`Bundle ${name}.ts contains legacy SCANNER_VERSION — rebuild.`);
  }
  for (const re of LEGACY_ORCHESTRATOR) {
    if (re.test(content)) {
      throw new Error(
        `Bundle ${name}.ts contains legacy orchestrator ${re} — rebuild.`,
      );
    }
  }
  const hits = V1_FINGERPRINTS.filter((s) => content.includes(s));
  if (hits.length < 2) {
    throw new Error(
      `Bundle ${name}.ts missing v1 engine fingerprints (found: ${hits.join(", ") || "none"}).`,
    );
  }
}

function bundle(name) {
  const entry = path.join(FUNCTIONS, name, "index.ts");
  const outfile = path.join(OUT, `${name}.ts`);
  if (!fs.existsSync(entry)) throw new Error(`Missing entry: ${entry}`);

  fs.mkdirSync(OUT, { recursive: true });

  execFileSync(
    "npx",
    [
      "--yes",
      "esbuild",
      entry,
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--target=es2022",
      "--external:@supabase/supabase-js",
      `--outfile=${outfile}`,
      "--log-level=warning",
    ],
    { cwd: FUNCTIONS, stdio: "inherit", shell: true },
  );

  let body = fs.readFileSync(outfile, "utf8");
  body = body.replace(
    /from "@supabase\/supabase-js"/g,
    'from "npm:@supabase/supabase-js@2"',
  );
  body = body.replace(
    /from 'npm:@supabase\/supabase-js'/g,
    "from 'npm:@supabase/supabase-js@2'",
  );

  const bare = body
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /from "[^"]+"/.test(line))
    .filter(({ line }) => !/from "(\.|\/|npm:|jsr:|https?:)/.test(line));
  if (bare.length) {
    throw new Error(
      `Bundle ${name} has bare import specifiers the dashboard will reject:\n` +
        bare.map(({ n, line }) => `${n}: ${line}`).join("\n"),
    );
  }

  if (name === "analysis") {
    assertBundleIdentity(name, body);
  }

  const withBanner = banner(name, body.split("\n").length + 12) + body;
  fs.writeFileSync(outfile, withBanner, "utf8");
  const lines = withBanner.split("\n").length;
  console.log(`${name.padEnd(12)} ${lines} lines  ${outfile}`);
}

console.log("Bundling edge functions for dashboard deployment…");
bundle("analysis");
bundle("ai-admin");
console.log("\nDone. Paste each file into Supabase → Edge Functions → Deploy.");
