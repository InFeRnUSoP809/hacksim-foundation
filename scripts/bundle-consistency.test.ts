/**
 * Production bundle gate — bundle/analysis.ts must match engine v1 source.
 * Run: npm run test:bundle  (after npm run bundle:functions)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "supabase/functions/bundle/analysis.ts");
const SOURCE = path.join(ROOT, "supabase/functions/analysis/index.ts");

/** String literals that must survive esbuild bundling. */
const V1_MARKERS = ["hacksim-analysis-v1", "new-engine-v1"] as const;

/**
 * Legacy runtime was inlined as whole modules. Comments like `// _shared/scanner.ts`
 * plus legacy version constants indicate the old analyzer was bundled — not v1.
 */
const LEGACY_INLINED_MODULE = /\/\/ _shared\/scanner\.ts/;
const LEGACY_SCANNER_VERSION = /SCANNER_VERSION\s*=\s*["']p5-/;

/** Legacy orchestrator entrypoints (executable), not plain text in strings. */
const LEGACY_ORCHESTRATOR = [
  /\bexecuteAnalysisPlan\s*\(/,
  /\brunModuleReview\s*\(/,
  /\bplanAnalysisTasks\s*\(/,
];

/** v1 engine fingerprints (strings / ops likely retained when bundled). */
const V1_FINGERPRINTS = [
  "engine_brief_verification",
  "engine_implementation_verification",
  "implementation_workflows",
  'handler: "analysis-v1"',
  "engine_id:",
  "analysis_version:",
];

assert.ok(fs.existsSync(SOURCE), "analysis/index.ts must exist");
const source = fs.readFileSync(SOURCE, "utf8");
assert.match(source, /from\s+["'].*engine\/index\.ts["']/);
assert.doesNotMatch(source, /from\s+["'].*\/scanner\.ts["']/);
assert.doesNotMatch(source, /from\s+["'].*\/review\.ts["']/);

if (!fs.existsSync(BUNDLE)) {
  throw new Error(
    "Missing production artifact supabase/functions/bundle/analysis.ts — run: npm run bundle:functions",
  );
}

const bundle = fs.readFileSync(BUNDLE, "utf8");

for (const marker of V1_MARKERS) {
  assert.ok(bundle.includes(marker), `Production bundle missing "${marker}". Run npm run bundle:functions`);
}

assert.equal(
  LEGACY_INLINED_MODULE.test(bundle),
  false,
  "Bundle still inlines legacy scanner.ts — regenerate from current analysis/index.ts",
);
assert.equal(
  LEGACY_SCANNER_VERSION.test(bundle),
  false,
  "Bundle contains legacy SCANNER_VERSION — regenerate",
);

for (const re of LEGACY_ORCHESTRATOR) {
  assert.equal(
    re.test(bundle),
    false,
    `Bundle contains legacy orchestrator call ${re} — regenerate`,
  );
}

const v1Hits = V1_FINGERPRINTS.filter((s) => bundle.includes(s));
assert.ok(
  v1Hits.length >= 2,
  `Bundle missing v1 engine fingerprints (found ${v1Hits.length}/` +
    `${V1_FINGERPRINTS.length}): ${V1_FINGERPRINTS.join(", ")}`,
);

console.log("bundle-consistency: ok (production artifact matches engine v1)");
