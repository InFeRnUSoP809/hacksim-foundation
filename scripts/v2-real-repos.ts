/**
 * Real GitHub repository validation for HackSim V2 (deterministic pipeline).
 * Run: deno run -A scripts/v2-real-repos.ts
 *
 * Uses production scanRepository + V2 graph/evidence/workflow modules.
 * DeepSeek and Supabase persistence are reported separately when credentials exist.
 */

import { GitHubClient } from "../supabase/functions/_shared/github-api.ts";
import { scanRepository } from "../supabase/functions/_shared/scanner.ts";
import { LocalRepoClient, type LocalRepo } from "./lib/local-source.ts";
import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { attachContent, contentByPath } from "../supabase/functions/_shared/v2/content.ts";
import { buildFileInventory, entryPointCandidates, scoreImportance } from "../supabase/functions/_shared/v2/discover.ts";
import { compileEvidence, resetEvidenceCounter } from "../supabase/functions/_shared/v2/evidence.ts";
import { buildRelationshipGraph } from "../supabase/functions/_shared/v2/graph.ts";
import { indexSymbols } from "../supabase/functions/_shared/v2/symbols.ts";
import { discoverFeatureWorkflows, buildEvidenceChains } from "../supabase/functions/_shared/v2/workflows.ts";
import { mapRequirements } from "../supabase/functions/_shared/v2/requirement-map.ts";
import { buildRequirementMap } from "../supabase/functions/_shared/requirements.ts";

const REPOS = [
  { name: "Life Insurance Survey", owner: "InFeRnUSoP809", repo: "life-insurance-survey" },
  { name: "Quick Fix", owner: "InFeRnUSoP809", repo: "quick-fix" },
  {
    name: "HackSim",
    owner: "InFeRnUSoP809",
    repo: "hacksim-foundation",
    localDir: Deno.env.get("HACKSIM_LOCAL_DIR") ?? "/workspace",
  },
];

const GENERIC_HACKATHON = {
  id: "validation",
  name: "Validation hackathon",
  problem_statement: "Build a working application with clear user-facing functionality.",
  requirements: "- Implement the core application workflow\n- Provide a usable interface\n- Handle user input and produce results",
  constraints: "",
  expected_outcome: "",
  evaluation_criteria: "",
};

interface RepoMetrics {
  name: string;
  repository: string;
  commitSha: string;
  filesDiscovered: number;
  filesRead: number;
  symbols: number;
  relationships: number;
  evidence: number;
  implEvidence: number;
  features: string[];
  requirements: number;
  durationMs: number;
  status: "PASS" | "FAIL";
  error?: string;
}

function localRepoFromDir(dir: string, owner: string, repo: string): LocalRepo {
  const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);
  const files: string[] = [];
  function walk(base: string, root = base) {
    for (const entry of readdirSync(base)) {
      if (IGNORED.has(entry)) continue;
      const full = join(base, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, root);
      else files.push(relative(root, full).split("\\").join("/"));
    }
  }
  walk(dir);
  files.sort();
  const commitSha = createHash("sha256")
    .update(files.map((p) => `${p}:${statSync(join(dir, p)).size}`).join("\n"))
    .digest("hex");
  return { owner, repo, dir, defaultBranch: "main", commitSha, fileCount: files.length };
}

async function analyzeRepo(
  spec: { name: string; owner: string; repo: string; localDir?: string },
): Promise<RepoMetrics> {
  const started = Date.now();
  try {
    let scan;
    if (spec.localDir) {
      const local = localRepoFromDir(spec.localDir, spec.owner, spec.repo);
      scan = await scanRepository(
        new LocalRepoClient(local) as unknown as GitHubClient,
        spec.owner,
        spec.repo,
      );
    } else {
      const client = new GitHubClient();
      try {
        scan = await scanRepository(client, spec.owner, spec.repo);
      } catch (error) {
        const msg = (error as Error).message ?? "";
        if (spec.repo === "hacksim-foundation" && /rate limit/i.test(msg)) {
          scan = await scanRepository(
            new LocalRepoClient(localRepoFromDir("/workspace", spec.owner, spec.repo)) as unknown as GitHubClient,
            spec.owner,
            spec.repo,
          );
        } else throw error;
      }
    }
    resetEvidenceCounter();
    const pathByFileId = new Map(scan.files.map((f) => [f.path, f.path]));
    const chunks = scan.chunks.map((c) => ({
      file_path: String(c.file_path ?? pathByFileId.get(String(c.file_id)) ?? ""),
      start_line: c.start_line as number | null,
      content: String(c.content ?? ""),
    })).filter((c) => c.file_path);

    const byPath = contentByPath(chunks);
    const tree = scan.files.map((f) => ({ path: f.path, size: f.file_size }));
    let inventory = buildFileInventory(tree, byPath);
    let provisional = attachContent(inventory, byPath);
    let symbols = indexSymbols(provisional);
    const { relationships, inDegree, routeFiles } = buildRelationshipGraph(provisional, symbols);
    inventory = scoreImportance(inventory, inDegree, routeFiles, entryPointCandidates(provisional.map((f) => f.path)));
    const files = attachContent(inventory, byPath);
    symbols = indexSymbols(files);
    const evidence = await compileEvidence(files, relationships);
    const features = discoverFeatureWorkflows(relationships, evidence);
    buildEvidenceChains(features);

    const reqMap = buildRequirementMap(GENERIC_HACKATHON as Record<string, unknown>);
    const reqLinks = mapRequirements(reqMap, evidence, features);

    return {
      name: spec.name,
      repository: `https://github.com/${spec.owner}/${spec.repo}`,
      commitSha: scan.commitSha,
      filesDiscovered: scan.files.length,
      filesRead: chunks.length > 0 ? new Set(chunks.map((c) => c.file_path)).size : 0,
      symbols: symbols.length,
      relationships: relationships.length,
      evidence: evidence.length,
      implEvidence: evidence.filter((e) => e.level === "implementation" || e.level === "relationship").length,
      features: features.map((f) => f.featureKey),
      requirements: reqLinks.length,
      durationMs: Date.now() - started,
      status: evidence.length > 0 && relationships.length > 0 ? "PASS" : "FAIL",
    };
  } catch (error) {
    return {
      name: spec.name,
      repository: `https://github.com/${spec.owner}/${spec.repo}`,
      commitSha: "",
      filesDiscovered: 0,
      filesRead: 0,
      symbols: 0,
      relationships: 0,
      evidence: 0,
      implEvidence: 0,
      features: [],
      requirements: 0,
      durationMs: Date.now() - started,
      status: "FAIL",
      error: (error as Error).message,
    };
  }
}

console.log("HackSim V2 — real repository validation (deterministic stages)\n");
console.log(`GITHUB_TOKEN: ${Deno.env.get("GITHUB_TOKEN") ? "set" : "missing (unauthenticated API)"}`);
console.log(`DEEPSEEK_API_KEY: ${Deno.env.get("DEEPSEEK_API_KEY") ? "set" : "missing"}`);
console.log(`SUPABASE: ${Deno.env.get("SUPABASE_URL") ? "set" : "missing"}\n`);

const results: RepoMetrics[] = [];
for (const spec of REPOS) {
  console.log(`Analyzing ${spec.name} (${spec.owner}/${spec.repo})...`);
  const m = await analyzeRepo(spec);
  results.push(m);
  console.log(JSON.stringify(m, null, 2));
  console.log("");
}

const failed = results.filter((r) => r.status === "FAIL");
if (failed.length) {
  console.error(`${failed.length} repository(ies) failed deterministic pipeline.`);
  Deno.exit(1);
}
console.log("All three repositories completed deterministic V2 pipeline stages.");
