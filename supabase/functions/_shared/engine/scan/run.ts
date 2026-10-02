/**
 * HackSim Analysis Engine v1 — deterministic repository scan (L0–L3).
 * Does not import legacy scanner/review/planner modules.
 */

import { settings } from "../../ai.ts";
import { profileDataset } from "../../datasets.ts";
import { analyseSemantics, type SemanticsResult } from "../../semantics.ts";
import { ENGINE_SCAN_VERSION, HACKSIM_ENGINE_ID } from "../constants.ts";
import { extractImplementationBehaviors, behaviorsForFlow } from "../behavior/extract.ts";
import { buildEvidenceChains } from "../chains/build.ts";
import { buildRepositoryGraph, endLineFor } from "../graph/build.ts";
import {
  registerBehaviorFacts,
  registerDatasetFacts,
  registerSemanticFacts,
  registerStructuralFacts,
  registerWorkflowFacts,
} from "../evidence/structural.ts";
import {
  discoverImplementationWorkflows,
  workflowEvidenceClaims,
} from "../workflows/discover.ts";
import {
  basenameOf,
  buildProjectMap,
  categoryOf,
  countLines,
  decodeText,
  detectAuth,
  detectAuthInCode,
  detectDatabaseInCode,
  detectDatabases,
  detectFrameworks,
  detectTestCommands,
  detectTestFrameworks,
  EvidenceRegistry,
  extensionOf,
  extractDependencies,
  extractIntegrations,
  extractRoutes,
  extractSymbols,
  GitHubClient,
  GitHubError,
  importanceOf,
  isIgnored,
  isSensitive,
  isTestFile,
  languageOf,
  looksBinary,
  parseReadme,
  scanFileForSecrets,
  type Dependency,
  type Evidence,
  type FileRecord,
  type Route,
  type SecretFinding,
  type Symbol,
} from "../infra/github.ts";
import {
  ALWAYS_READ_NAMES,
  DATASET_HEAD_BYTES,
  isSourceLike,
  looksLikeDataPath,
  MAX_DATASET_BYTES,
  MAX_DATASETS_READ,
  READ_CATEGORIES,
} from "./config.ts";

export interface EngineScanResult {
  engineId: typeof HACKSIM_ENGINE_ID;
  scannerVersion: typeof ENGINE_SCAN_VERSION;
  owner: string;
  repoName: string;
  defaultBranch: string;
  commitSha: string;
  visibility: string | null;
  language: string | null;
  stars: number | null;
  forks: number | null;
  analysisMode: "full" | "limited";
  files: FileRecord[];
  chunks: Record<string, unknown>[];
  evidence: Evidence[];
  projectMap: Record<string, unknown>;
  datasetProfiles: ReturnType<typeof profileDataset> extends infer P ? NonNullable<P>[] : never[];
  semantics: SemanticsResult[];
  routes: Route[];
  secretCount: number;
}

type InventoryItem = {
  record: FileRecord;
  category: string;
  importance: string;
};

function headChunk(
  path: string,
  record: FileRecord,
  content: string,
  importance: string,
): Record<string, unknown> {
  const lines = content.split("\n").slice(0, 120).join("\n");
  return {
    file_path: path,
    chunk_index: 0,
    start_line: 1,
    end_line: Math.min(120, content.split("\n").length),
    content: lines,
    symbol_name: null,
    symbol_type: null,
    language: record.language,
    importance,
  };
}

export async function runRepositoryScan(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<EngineScanResult> {
  const config = settings();
  const metadata = (await client.repository(owner, repo)) as Record<string, unknown>;
  const branch = (metadata.default_branch as string) || "main";
  const commit = (await client.latestCommit(owner, repo, branch)) as Record<string, unknown>;
  const commitSha = commit.sha as string | undefined;
  if (!commitSha) throw new GitHubError("Could not determine the latest commit.", "no_commit");

  const tree = (await client.gitTree(owner, repo, commitSha)) as {
    tree?: { type?: string; path?: string; sha?: string; size?: number }[];
    truncated?: boolean;
  };
  const entries = (tree.tree ?? []).filter((entry) => entry.type === "blob");
  const analysisMode: "full" | "limited" =
    tree.truncated || entries.length > config.analysisLargeRepoThreshold ? "limited" : "full";

  const registry = new EvidenceRegistry();
  const inventory: InventoryItem[] = [];

  for (const entry of entries) {
    const path = entry.path ?? "";
    if (!path) continue;
    const size = Number(entry.size ?? 0);
    if (isIgnored(path) || isSensitive(path)) {
      inventory.push({
        record: {
          path,
          file_name: basenameOf(path),
          extension: extensionOf(path),
          language: languageOf(path),
          file_size: size,
          line_count: null,
          is_binary: false,
          is_ignored: true,
          file_category: categoryOf(path, false),
          importance: "ignored",
          sha: entry.sha ?? null,
        },
        category: categoryOf(path, false),
        importance: "ignored",
      });
      continue;
    }
    const extension = extensionOf(path);
    const provisionalBinary = [".png", ".jpg", ".pdf", ".zip", ".ico"].includes(extension);
    const category = categoryOf(path, provisionalBinary);
    inventory.push({
      record: {
        path,
        file_name: basenameOf(path),
        extension,
        language: languageOf(path),
        file_size: size,
        line_count: null,
        is_binary: provisionalBinary,
        is_ignored: false,
        file_category: category,
        importance: importanceOf(path, category),
        sha: entry.sha ?? null,
      },
      category,
      importance: importanceOf(path, category),
    });
  }

  const readCandidates = inventory.filter((item) => {
    if (item.record.is_ignored) return false;
    if (item.record.file_category === "dataset") return item.record.file_size <= MAX_DATASET_BYTES;
    if (looksLikeDataPath(item.record.path, item.record.file_name ?? "")) {
      return item.record.file_size <= MAX_DATASET_BYTES;
    }
    return (
      READ_CATEGORIES.has(item.record.file_category) &&
      item.record.file_size <= config.analysisMaxFileBytes
    );
  });

  const priority = (item: InventoryItem): number => {
    const name = (item.record.file_name ?? "").toLowerCase();
    if (ALWAYS_READ_NAMES.has(name)) return 0;
    if (item.record.importance === "high") return 1;
    if (item.record.importance === "medium") return 2;
    return 3;
  };
  readCandidates.sort(
    (a, b) => priority(a) - priority(b) || a.record.file_size - b.record.file_size,
  );
  const maxReads =
    analysisMode === "full"
      ? config.analysisMaxFiles
      : Math.max(40, Math.floor(config.analysisMaxFiles / 2));
  const selected = readCandidates.slice(0, maxReads);

  const files: FileRecord[] = [];
  const chunks: Record<string, unknown>[] = [];
  const dependencies: Dependency[] = [];
  const allSymbols: (Symbol & { file?: string; end_line?: number })[] = [];
  const routes: Route[] = [];
  const integrations: { url: string; file: string; line: number; method: string | null }[] = [];
  const secrets: SecretFinding[] = [];
  const sourcesForCodeScan: { path: string; content: string }[] = [];
  const testPaths: string[] = [];
  const datasetProfiles: NonNullable<Awaited<ReturnType<typeof profileDataset>>>[] = [];
  const semantics: SemanticsResult[] = [];
  let readme: ReturnType<typeof parseReadme> | null = null;
  let datasetsRead = 0;

  for (const item of inventory) {
    if (item.record.is_ignored) {
      files.push(item.record);
      continue;
    }
    if (item.category === "asset") {
      item.record.is_binary = true;
      item.record.importance = "ignored";
      files.push(item.record);
      continue;
    }
    if (isTestFile(item.record.path)) testPaths.push(item.record.path);
  }

  for (const item of selected) {
    const { record, category, importance } = item;
    const path = record.path;
    let blob: Uint8Array;
    try {
      blob = await client.blob(owner, repo, record.sha ?? "");
    } catch (error) {
      if (error instanceof GitHubError && error.code === "rate_limited") break;
      continue;
    }
    const binary = looksBinary(blob, path);
    record.is_binary = binary;
    record.file_size = blob.length;
    files.push(record);
    if (binary) continue;

    const isDataFile =
      category === "dataset" ||
      (path.toLowerCase().endsWith(".json") && looksLikeDataPath(path, record.file_name ?? ""));
    if (isDataFile && datasetsRead < MAX_DATASETS_READ) {
      datasetsRead += 1;
      const head = blob.length > DATASET_HEAD_BYTES ? blob.slice(0, DATASET_HEAD_BYTES) : blob;
      const headText = decodeText(head, path);
      if (headText) {
        const profile = profileDataset({ path, content: headText, sizeBytes: blob.length }, []);
        if (profile) datasetProfiles.push(profile);
      }
      continue;
    }

    const content = decodeText(blob, path);
    if (!content) continue;
    record.line_count = countLines(content);
    sourcesForCodeScan.push({ path, content });

    for (const finding of scanFileForSecrets(path, content)) secrets.push(finding);

    const name = (record.file_name ?? "").toLowerCase();
    if (ALWAYS_READ_NAMES.has(name) || category === "dependency") {
      dependencies.push(...extractDependencies(path, content));
    }
    if (name.startsWith("readme") && !readme) readme = parseReadme(path, content);

    if (isSourceLike(category)) {
      const { symbols } = extractSymbols(path, content);
      const spanned = symbols.map((symbol) => ({
        ...symbol,
        file: path,
        end_line: endLineFor(content, symbol.line, record.language),
      }));
      allSymbols.push(...spanned);
      chunks.push(headChunk(path, record, content, importance));
      routes.push(...extractRoutes(path, content));
      integrations.push(...extractIntegrations(content, path));
      const found = analyseSemantics(
        path,
        content,
        symbols.map((s) => ({ name: s.name, line: s.line, symbol_type: s.symbol_type })),
      );
      if (
        found.calculations.length ||
        found.rules.length ||
        found.models.length ||
        found.dataAccess.length ||
        found.ui.length
      ) {
        semantics.push(found);
      }
    }
  }

  const configFilenames = inventory.map((i) => i.record.file_name).filter(Boolean) as string[];
  const frameworks = detectFrameworks(dependencies, configFilenames);
  const databases = [
    ...detectDatabases(dependencies, files.map((f) => f.path)),
    ...detectDatabaseInCode(sourcesForCodeScan),
  ];
  const auth = [...detectAuth(dependencies), ...detectAuthInCode(sourcesForCodeScan)];
  const tests = {
    file_count: testPaths.length,
    frameworks: detectTestFrameworks(configFilenames, files.map((f) => f.path)),
    commands: detectTestCommands([]),
  };

  registerStructuralFacts(registry, {
    owner,
    repo,
    branch,
    commitSha,
    analysisMode,
    frameworks,
    dependencies,
    routes,
  });
  registerSemanticFacts(registry, semantics);
  registerDatasetFacts(registry, datasetProfiles);

  const declaredRoutes = routes.filter((r) => r.framework !== "File-based routing");
  for (const item of inventory) {
    if (!files.some((f) => f.path === item.record.path)) files.push(item.record);
  }

  const graph = buildRepositoryGraph({
    files: sourcesForCodeScan.map((s) => ({
      path: s.path,
      content: s.content,
      language: languageOf(s.path),
    })),
    symbols: allSymbols.filter((s) => s.file).map((s) => ({
      name: s.name,
      symbol_type: s.symbol_type,
      line: s.line,
      file: s.file,
    })),
    routes,
  });

  const behaviors = extractImplementationBehaviors({
    files: sourcesForCodeScan.slice(0, 48).map((s) => ({
      path: s.path,
      content: s.content,
      language: languageOf(s.path),
    })),
    symbols: graph.symbols,
  });
  registerBehaviorFacts(registry, behaviors);

  const implementationWorkflows = discoverImplementationWorkflows({
    behaviors,
    graph,
    flows: graph.flows,
  });
  registerWorkflowFacts(registry, workflowEvidenceClaims(implementationWorkflows));

  for (const flow of graph.flows.filter((f) => f.closed).slice(0, 12)) {
    registry.add({
      type: "data_flow",
      claim: `Flow ${flow.id}: ${flow.hops.map((h) => h.symbol ?? h.file).join(" → ")}`,
      file: flow.files[0] ?? null,
      confidence: "medium",
      detail: { flow_id: flow.id, level: "L2" },
    });
  }

  const evidenceList = registry.toList();
  const chains = buildEvidenceChains({
    evidence: evidenceList,
    flows: graph.flows,
    behaviors,
  });

  const projectMap = buildProjectMap({
    repository: {
      owner,
      repo_name: repo,
      default_branch: branch,
      analyzed_commit_sha: commitSha,
      visibility: (metadata.visibility as string) ?? null,
      language: (metadata.language as string) ?? null,
      stars: (metadata.stargazers_count as number) ?? null,
      forks: (metadata.forks_count as number) ?? null,
      total_files: entries.length,
    },
    files,
    dependencies,
    frameworks,
    databases,
    auth,
    routes: declaredRoutes,
    symbols: allSymbols,
    integrations,
    tests,
    readme,
    secrets,
    analysisMode,
    warnings: [],
    datasetProfiles,
    semantics,
  }) as Record<string, unknown>;

  projectMap.engine_id = HACKSIM_ENGINE_ID;
  projectMap.engine_scan_version = ENGINE_SCAN_VERSION;
  projectMap.flows = graph.flows.map((flow) => ({
    ...flow,
    behaviors: behaviorsForFlow(flow.files, behaviors).map((b) => ({
      id: b.id,
      kind: b.kind,
      claim: b.claim,
      file: b.file,
      symbol: b.symbol,
      lines: `${b.start_line}-${b.end_line}`,
      level: b.level,
    })),
  }));
  projectMap.implementation_behaviors = behaviors.slice(0, 80);
  projectMap.implementation_workflows = implementationWorkflows;
  projectMap.evidence_chains = chains;
  projectMap.graph = {
    symbols: graph.symbols.slice(0, 200),
    relationships: graph.relationships.slice(0, 300),
  };
  projectMap.analysis_coverage = {
    files_discovered: entries.length,
    files_structurally_scanned: files.length,
    files_deeply_read: sourcesForCodeScan.length,
    source_lines_inspected: sourcesForCodeScan.reduce(
      (n, s) => n + s.content.split("\n").length,
      0,
    ),
    evidence_count: evidenceList.length,
    flow_count: graph.flows.length,
    relationship_count: graph.relationships.length,
    implementation_behavior_count: behaviors.length,
    implementation_workflow_count: implementationWorkflows.length,
  };

  return {
    engineId: HACKSIM_ENGINE_ID,
    scannerVersion: ENGINE_SCAN_VERSION,
    owner,
    repoName: repo,
    defaultBranch: branch,
    commitSha,
    visibility: (metadata.visibility as string) ?? null,
    language: (metadata.language as string) ?? null,
    stars: (metadata.stargazers_count as number) ?? null,
    forks: (metadata.forks_count as number) ?? null,
    analysisMode,
    files,
    chunks,
    evidence: evidenceList,
    projectMap,
    datasetProfiles,
    semantics,
    routes,
    secretCount: secrets.length,
  };
}
