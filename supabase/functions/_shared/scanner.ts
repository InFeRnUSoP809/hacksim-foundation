/**
 * Phase 5 scanner and persistence.
 *
 * The orchestrator. It walks the tree once, decides what is worth reading,
 * reads as little as possible, and produces three things:
 *
 *   • repository_files — the inventory
 *   • evidence         — the facts, each with a stable id
 *   • project_map      — the compact summary Phase 6 consumes
 *
 * Cost discipline, in order of importance:
 *   1. §14 — never read an ignored or sensitive file.
 *   2. §87 — read only what classification marks as important or medium.
 *   3. §88 — a very large tree switches to `limited` mode and tightens further.
 *   4. §9  — a blob fetch is a GitHub API request, so they are budgeted, not
 *      sprayed.
 *
 * Everything here is deterministic. It costs zero LLM tokens.
 */

import { db, HttpError } from "./http.ts";
import { settings } from "./ai.ts";
import { GitHubClient, GitHubError } from "./github-api.ts";
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
  extensionOf,
  Evidence,
  EvidenceRegistry,
  extractDependencies,
  extractIntegrations,
  extractRoutes,
  extractSymbols,
  importanceOf,
  isIgnored,
  isSensitive,
  isSourceLike,
  isTestFile,
  languageOf,
  looksBinary,
  parseReadme,
  scanFileForSecrets,
  SecretFinding,
  type Dependency,
  type Detection,
  type ProjectMap,
  type Route,
  type Symbol,
} from "./github.ts";

export const SCANNER_VERSION = "p5-1";

// §87 read priority. Anything not in these categories is never fetched.
const READ_CATEGORIES = new Set([
  "source", "component", "api", "model", "schema", "database", "config",
  "documentation", "test",
]);

// Config/dependency files that are small and always worth reading.
const ALWAYS_READ_NAMES = new Set([
  "readme.md", "package.json", "requirements.txt", "pyproject.toml", "go.mod",
  "cargo.toml", "pom.xml", "build.gradle", "dockerfile", "docker-compose.yml",
  "docker-compose.yaml", "composer.json", "pubspec.yaml", "alembic.ini",
  "manage.py", "schema.prisma",
]);

interface FileRecord {
  path: string;
  file_name: string;
  extension: string;
  language: string | null;
  file_size: number;
  line_count: number | null;
  is_binary: boolean;
  is_ignored: boolean;
  file_category: string;
  importance: string;
  sha: string | null;
}

export interface ScanResult {
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
  projectMap: ProjectMap;
  secretCount: number;
  scannerVersion: string;
}

interface InventoryItem {
  record: FileRecord;
  category: string;
  importance: string;
}

// ── The scan ───────────────────────────────────────────────────────────────

export async function scanRepository(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<ScanResult> {
  const config = settings();

  const metadata = (await client.repository(owner, repo)) as Record<string, unknown>;
  const branch = (metadata.default_branch as string) || "main";

  const commit = (await client.latestCommit(owner, repo, branch)) as Record<string, unknown>;
  const commitSha = commit.sha as string | undefined;
  if (!commitSha) {
    throw new GitHubError("Could not determine the latest commit.", "no_commit");
  }

  const tree = (await client.gitTree(owner, repo, commitSha)) as {
    tree?: { type?: string; path?: string; sha?: string; size?: number }[];
    truncated?: boolean;
  };
  const entries = (tree.tree ?? []).filter((entry) => entry.type === "blob");
  const truncatedTree = Boolean(tree.truncated);

  const analysisMode: "full" | "limited" =
    truncatedTree || entries.length > config.analysisLargeRepoThreshold ? "limited" : "full";

  const warnings: string[] = [];
  if (truncatedTree) {
    warnings.push(
      "GitHub returned a truncated file tree; some paths are not listed by the API.",
    );
  }
  if (entries.length > config.analysisLargeRepoThreshold) {
    warnings.push(
      `Repository has ${entries.length} files. Analysis was limited to relevant files.`,
    );
  }

  const registry = new EvidenceRegistry();

  // ── 1. Inventory every path, reading nothing yet ────────────────────────
  const inventory: InventoryItem[] = [];
  for (const entry of entries) {
    const path = entry.path ?? "";
    if (!path) continue;
    const size = Number(entry.size ?? 0);

    // §14 — an ignored or sensitive file is recorded as ignored and never
    // becomes a fetch candidate.
    if (isIgnored(path) || isSensitive(path)) {
      const category = categoryOf(path, false);
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
          file_category: category,
          importance: "ignored",
          sha: entry.sha ?? null,
        },
        category,
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

  // ── 2. Choose the read set (§87, §88) ──────────────────────────────────
  const readCandidates = inventory.filter(
    (item) =>
      !item.record.is_ignored &&
      READ_CATEGORIES.has(item.record.file_category) &&
      item.record.file_size <= config.analysisMaxFileBytes,
  );

  // Always read the small, high-signal files first.
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
  if (readCandidates.length > selected.length) {
    warnings.push(
      `${readCandidates.length - selected.length} candidate files were not read ` +
        "to stay within the analysis budget.",
    );
  }

  // ── 3. Read, parse, record ─────────────────────────────────────────────
  const files: FileRecord[] = [];
  const chunks: Record<string, unknown>[] = [];
  const dependencies: Dependency[] = [];
  const allSymbols: Symbol[] = [];
  const routes: Route[] = [];
  const integrations: { url: string; file: string; line: number; method: string | null }[] = [];
  const secrets: SecretFinding[] = [];
  const testPaths: string[] = [];
  const sourcesForCodeScan: { path: string; content: string }[] = [];
  const configFilenames = inventory
    .map((item) => item.record.file_name)
    .filter((name): name is string => Boolean(name));
  const testCommandContents: string[] = [];
  let readme: ReturnType<typeof parseReadme> | null = null;
  let blobBudgetExhausted = false;

  for (const item of inventory) {
    const { record, category } = item;
    if (record.is_ignored) {
      files.push(record);
      continue;
    }
    if (category === "asset") {
      record.is_binary = true;
      record.importance = "ignored";
      files.push(record);
      continue;
    }
    if (isTestFile(record.path)) testPaths.push(record.path);
  }

  for (const item of selected) {
    const { record, category, importance } = item;
    const path = record.path;

    let blob: Uint8Array;
    try {
      blob = await client.blob(owner, repo, record.sha ?? "");
    } catch (error) {
      if (error instanceof GitHubError && error.code === "rate_limited") {
        blobBudgetExhausted = true;
        warnings.push(
          "GitHub rate limit reached partway through; later files were not read.",
        );
        break;
      }
      warnings.push(`Could not read \`${path}\`.`);
      continue;
    }

    const binary = looksBinary(blob);
    record.is_binary = binary;
    record.file_size = blob.length;
    files.push(record);

    if (binary) {
      record.importance = "ignored";
      continue;
    }

    const content = decodeText(blob);
    if (content === null) {
      record.is_binary = true;
      continue;
    }

    record.line_count = countLines(content);
    sourcesForCodeScan.push({ path, content });

    // Secrets first: if a file leaks a key, we still record it, but the
    // content never leaves this process in a model prompt.
    for (const finding of scanFileForSecrets(path, content)) {
      secrets.push(finding);
      registry.add({
        type: "secret",
        claim: `Possible hard-coded ${finding.secret_type.replace(/_/g, " ")}`,
        file: path,
        lines: String(finding.line),
        confidence: "medium",
        detail: { secret_type: finding.secret_type },
      });
    }

    const name = (record.file_name ?? "").toLowerCase();

    if (ALWAYS_READ_NAMES.has(name) || category === "dependency") {
      dependencies.push(...extractDependencies(path, content));
    }

    if (name.startsWith("readme") && readme === null) {
      readme = parseReadme(path, content);
      if (readme.description) {
        registry.add({
          type: "readme",
          claim: `README describes the project: ${readme.description.slice(0, 160)}`,
          file: path,
          confidence: "high",
        });
      }
    }

    if (["package.json", "makefile", "pyproject.toml"].includes(name)) {
      testCommandContents.push(content);
    }

    if (isSourceLike(category)) {
      const { symbols, parserStatus } = extractSymbols(path, content);
      if (parserStatus === "ok") {
        allSymbols.push(...symbols);
        chunks.push(...chunksFor(path, record, symbols, content, importance));
      }
      routes.push(...extractRoutes(path, content));
      integrations.push(...extractIntegrations(content, path));
    }
  }

  // ── 4. Dependency-derived detections ───────────────────────────────────
  const frameworks = detectFrameworks(dependencies, configFilenames);
  const databases = [
    ...detectDatabases(dependencies, files.map((f) => f.path)),
    ...detectDatabaseInCode(sourcesForCodeScan),
  ];
  const auth = [...detectAuth(dependencies), ...detectAuthInCode(sourcesForCodeScan)];

  const tests = {
    file_count: testPaths.length,
    frameworks: detectTestFrameworks(configFilenames, files.map((f) => f.path)),
    commands: detectTestCommands(testCommandContents),
  };

  // ── 5. Evidence ────────────────────────────────────────────────────────
  recordStructuralEvidence(registry, {
    metadata,
    owner,
    repo,
    branch,
    commitSha,
    frameworks,
    dependencies,
    databases,
    auth,
    routes,
    tests,
    secrets,
    files,
    analysisMode,
  });

  const projectMap = buildProjectMap({
    repository: {
      owner,
      repo_name: repo,
      default_branch: branch,
      analyzed_commit_sha: commitSha,
      visibility: metadata.visibility ?? null,
      language: metadata.language ?? null,
      stars: metadata.stargazers_count ?? null,
      forks: metadata.forks_count ?? null,
      total_files: entries.length,
    },
    files,
    dependencies,
    frameworks,
    databases,
    auth,
    routes,
    symbols: allSymbols,
    integrations,
    tests,
    readme,
    secrets,
    analysisMode,
    warnings,
  });

  if (blobBudgetExhausted && !projectMap.apis.length) {
    throw new GitHubError(
      "GitHub rate limit reached before any endpoint could be detected.",
      "rate_limited",
      429,
    );
  }

  return {
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
    evidence: registry.toList(),
    projectMap,
    secretCount: secrets.length,
    scannerVersion: SCANNER_VERSION,
  };
}

/** One chunk per significant symbol, not per arbitrary line window (§9). */
function chunksFor(
  path: string,
  record: FileRecord,
  symbols: Symbol[],
  content: string,
  importance: string,
): Record<string, unknown>[] {
  const lines = content.split("\n");
  const chunks: Record<string, unknown>[] = [];

  if (symbols.length === 0) {
    if (importance === "high" && lines.length <= 200) {
      chunks.push({
        file_path: path,
        chunk_index: 0,
        start_line: 1,
        end_line: lines.length,
        content: content.slice(0, 20000),
        symbol_name: null,
        symbol_type: "file",
        language: record.language,
        importance,
      });
    }
    return chunks;
  }

  symbols.slice(0, 20).forEach((symbol, index) => {
    const start = Math.max(1, symbol.line);
    const end = Math.min(lines.length, start + 160);
    const body = lines.slice(start - 1, end).join("\n");
    if (!body.trim()) return;
    chunks.push({
      file_path: path,
      chunk_index: index,
      start_line: start,
      end_line: end,
      content: body.slice(0, 20000),
      symbol_name: symbol.name,
      symbol_type: symbol.symbol_type,
      language: record.language,
      importance,
    });
  });

  return chunks;
}

/** Turn every detection into an evidence object (§26). */
function recordStructuralEvidence(
  registry: EvidenceRegistry,
  input: {
    metadata: Record<string, unknown>;
    owner: string;
    repo: string;
    branch: string;
    commitSha: string;
    frameworks: Detection[];
    dependencies: Dependency[];
    databases: Detection[];
    auth: Detection[];
    routes: Route[];
    tests: { file_count: number; frameworks: { name: string; evidence: string }[] };
    secrets: SecretFinding[];
    files: FileRecord[];
    analysisMode: "full" | "limited";
  },
): void {
  registry.add({
    type: "repository",
    claim:
      `Repository ${input.owner}/${input.repo} analysed at commit ` +
      `${input.commitSha.slice(0, 12)} on branch ${input.branch}`,
    confidence: "high",
    detail: {
      visibility: input.metadata.visibility ?? null,
      language: input.metadata.language ?? null,
      stars: input.metadata.stargazers_count ?? null,
    },
  });

  registry.add({
    type: "analysis_mode",
    claim:
      input.analysisMode === "limited"
        ? "Analysis mode limited to relevant files."
        : "Full repository analysis.",
    confidence: "high",
  });

  for (const item of input.frameworks) {
    registry.add({
      type: "framework",
      claim: `${item.name} is in use (${item.evidence})`,
      file: item.file ?? null,
      symbol: item.symbol ?? null,
      lines: item.lines ?? null,
      confidence: item.file ? "high" : "medium",
    });
  }

  for (const dependency of input.dependencies) {
    if (["utility", "testing"].includes(dependency.category)) continue;
    registry.add({
      type: "dependency",
      claim: `Dependency \`${dependency.package}\` (${dependency.category})`,
      symbol: dependency.package,
      confidence: "high",
      detail: { category: dependency.category, version: dependency.version },
    });
  }

  for (const item of input.databases) {
    registry.add({
      type: "database",
      claim: `${item.name} detected (${item.evidence})`,
      file: item.file ?? null,
      lines: item.lines ?? null,
      confidence: "high",
    });
  }

  for (const item of input.auth) {
    registry.add({
      type: "authentication",
      claim: `${item.name} detected (${item.evidence})`,
      file: item.file ?? null,
      lines: item.lines ?? null,
      confidence: item.file ? "high" : "medium",
    });
  }

  for (const route of input.routes.slice(0, 120)) {
    registry.add({
      type: "route",
      claim: `${route.method} ${route.path} exists`,
      file: route.file,
      symbol: route.symbol,
      lines: `${route.line}-${route.line}`,
      confidence: "high",
      detail: { method: route.method, framework: route.framework },
    });
  }

  for (const framework of input.tests.frameworks) {
    registry.add({
      type: "test_framework",
      claim: `Test framework ${framework.name} detected (${framework.evidence})`,
      confidence: "medium",
    });
  }

  if (input.tests.file_count) {
    registry.add({
      type: "testing",
      claim: `${input.tests.file_count} test files present`,
      confidence: "medium",
    });
  }

  for (const secret of input.secrets) {
    registry.add({
      type: "secret",
      claim:
        `Possible hard-coded ${secret.secret_type.replace(/_/g, " ")} ` +
        `at ${secret.file}:${secret.line}`,
      file: secret.file,
      lines: String(secret.line),
      confidence: "medium",
    });
  }

  for (const record of input.files
    .filter((f) => ["schema", "database"].includes(f.file_category))
    .slice(0, 20)) {
    registry.add({
      type: "database_schema",
      claim: `Schema or migration file present: ${record.path}`,
      file: record.path,
      confidence: "high",
    });
  }

  for (const record of input.files
    .filter((f) => f.file_category === "config" && f.importance === "high")
    .slice(0, 15)) {
    registry.add({
      type: "config",
      claim: `Configuration file present: ${record.path}`,
      file: record.path,
      confidence: "medium",
    });
  }
}

// ── Persistence (§13 commit cache) ─────────────────────────────────────────

export interface LoadedAnalysis {
  repository: Record<string, unknown>;
  files: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  projectMap: Record<string, unknown>;
}

export class AnalysisStore {
  private readonly service = db();

  /** One scan per (submission, commit, scanner version). */
  async cached(submissionId: string, commitSha: string) {
    const { data } = await this.service
      .from("repositories")
      .select(
        "id, analysis_status, project_map, evidence, analyzed_commit_sha, analysis_version",
      )
      .eq("submission_id", submissionId)
      .eq("analyzed_commit_sha", commitSha)
      .eq("analysis_version", SCANNER_VERSION)
      .in("analysis_status", ["completed", "limited"])
      .limit(1);
    return (data as Record<string, unknown>[] | null)?.[0] ?? null;
  }

  async markScanning(submissionId: string, githubUrl: string): Promise<void> {
    await this.service.from("repositories").upsert(
      {
        submission_id: submissionId,
        github_url: githubUrl,
        analysis_status: "scanning",
        analysis_version: SCANNER_VERSION,
        error_code: null,
        error_message: null,
      },
      { onConflict: "submission_id" },
    );
  }

  async markFailed(
    submissionId: string,
    githubUrl: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.service.from("repositories").upsert(
      {
        submission_id: submissionId,
        github_url: githubUrl,
        analysis_status: "failed",
        analysis_version: SCANNER_VERSION,
        error_code: code,
        error_message: message.slice(0, 500),
      },
      { onConflict: "submission_id" },
    );
  }

  /** Mark the cached row stale so a forced re-analysis does not short-circuit. */
  async markStale(submissionId: string): Promise<void> {
    await this.service
      .from("repositories")
      .update({ analysis_status: "stale" })
      .eq("submission_id", submissionId);
  }

  async persist(submissionId: string, result: ScanResult): Promise<string> {
    const { data, error } = await this.service
      .from("repositories")
      .upsert(
        {
          submission_id: submissionId,
          github_url: `https://github.com/${result.owner}/${result.repoName}`,
          owner: result.owner,
          repo_name: result.repoName,
          default_branch: result.defaultBranch,
          latest_commit_sha: result.commitSha,
          analyzed_commit_sha: result.commitSha,
          visibility: result.visibility,
          language: result.language,
          stars: result.stars,
          forks: result.forks,
          // `completed` for a full scan, `limited` when we tightened the read set.
          analysis_status: result.analysisMode === "full" ? "completed" : "limited",
          analysis_version: result.scannerVersion,
          analysis_mode: result.analysisMode,
          project_map: result.projectMap,
          evidence: result.evidence,
          file_count: result.files.length,
          chunk_count: result.chunks.length,
          secret_count: result.secretCount,
          error_code: null,
          error_message: null,
          last_analyzed_at: new Date().toISOString(),
        },
        { onConflict: "submission_id" },
      )
      .select("id")
      .single();

    if (error || !data) {
      throw new HttpError("Could not persist the repository row.", 500);
    }
    const repositoryId = (data as { id: string }).id;

    await this.writeFiles(repositoryId, result.files);
    await this.writeChunks(repositoryId, result.chunks);
    return repositoryId;
  }

  /** Inventory rows are rewritten wholesale; a re-scan supersedes them. */
  private async writeFiles(repositoryId: string, files: FileRecord[]): Promise<void> {
    const service = this.service;
    await service.from("repository_files").delete().eq("repository_id", repositoryId);

    const rows = files.map((record) => ({
      repository_id: repositoryId,
      path: record.path,
      file_name: record.file_name,
      extension: record.extension || null,
      language: record.language,
      file_size: record.file_size,
      line_count: record.line_count,
      is_binary: record.is_binary,
      is_ignored: record.is_ignored,
      file_category: record.file_category,
      importance: record.importance,
      sha: record.sha,
    }));

    for (let start = 0; start < rows.length; start += 500) {
      const { error } = await service
        .from("repository_files")
        .upsert(rows.slice(start, start + 500), { onConflict: "repository_id,path" });
      if (error) {
        console.warn("[hacksim.analysis] could not write file rows:", error.message);
        return;
      }
    }
  }

  /** Chunks reference a file id, so they are written after the files. */
  private async writeChunks(
    repositoryId: string,
    chunks: Record<string, unknown>[],
  ): Promise<void> {
    const service = this.service;
    const { data: fileRows } = await service
      .from("repository_files")
      .select("id, path")
      .eq("repository_id", repositoryId);

    const idByPath = new Map(
      ((fileRows ?? []) as unknown as { id: string; path: string }[]).map((row) => [
        row.path,
        row.id,
      ]),
    );

    await service.from("code_chunks").delete().eq("repository_id", repositoryId);

    const rows = chunks
      .map((chunk) => {
        const fileId = idByPath.get(chunk.file_path as string);
        if (!fileId) return null;
        return {
          repository_id: repositoryId,
          file_id: fileId,
          chunk_index: chunk.chunk_index ?? 0,
          start_line: chunk.start_line ?? null,
          end_line: chunk.end_line ?? null,
          content: String(chunk.content ?? "").slice(0, 20000),
          symbol_name: chunk.symbol_name ?? null,
          symbol_type: chunk.symbol_type ?? null,
          language: chunk.language ?? null,
          importance: chunk.importance ?? null,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    for (let start = 0; start < rows.length; start += 400) {
      const { error } = await service
        .from("code_chunks")
        .upsert(rows.slice(start, start + 400), { onConflict: "file_id,chunk_index" });
      if (error) {
        console.warn("[hacksim.analysis] could not write chunk rows:", error.message);
        return;
      }
    }
  }

  /** Everything the Phase 6 reviewer needs, in one read. */
  async loadForReview(submissionId: string): Promise<LoadedAnalysis | null> {
    const { data: repositories } = await this.service
      .from("repositories")
      .select("*")
      .eq("submission_id", submissionId)
      .limit(1);
    const repository = (repositories as unknown as Record<string, unknown>[] | null)?.[0];
    if (!repository) return null;

    const [{ data: files }, { data: chunks }] = await Promise.all([
      this.service
        .from("repository_files")
        .select(
          "id, path, file_name, language, file_category, importance, " +
            "is_ignored, is_binary, line_count",
        )
        .eq("repository_id", repository.id)
        .eq("is_ignored", false),
      this.service
        .from("code_chunks")
        .select(
          "file_id, chunk_index, start_line, end_line, content, symbol_name, " +
            "symbol_type, language, importance",
        )
        .eq("repository_id", repository.id)
        .eq("importance", "high")
        .limit(600),
    ]);

    // Chunks reference paths via file_id; restore it for retrieval ranking.
    const pathById = new Map(
      ((files ?? []) as unknown as { id: string; path: string }[]).map((row) => [
        row.id,
        row.path,
      ]),
    );

    return {
      repository,
      files: (files ?? []) as unknown as Record<string, unknown>[],
      chunks: ((chunks ?? []) as unknown as Record<string, unknown>[])
        .map((chunk) => ({
          ...chunk,
          file_path: pathById.get(chunk.file_id as string),
        }))
        .filter((chunk) => chunk.file_path),
      evidence: (repository.evidence as Record<string, unknown>[]) ?? [],
      projectMap: (repository.project_map as Record<string, unknown>) ?? {},
    };
  }
}

export interface AnalyzeOutcome {
  status: "completed" | "limited" | "cached" | "failed";
  repository_id?: string;
  commit_sha?: string;
  file_count?: number;
  evidence_count?: number;
  project_map?: unknown;
  error?: string;
  code?: string;
}

/**
 * Run Phase 5 for one submission, with the commit cache in front.
 *
 * Never throws for an expected failure: a GitHub outage records a `failed`
 * repository and leaves the submission untouched (§89).
 */
export async function analyzeSubmission(
  submissionId: string,
  githubUrl: string,
): Promise<AnalyzeOutcome> {
  const store = new AnalysisStore();
  const client = new GitHubClient();

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = client.parseRepositoryUrl(githubUrl));
  } catch (error) {
    const message = (error as Error).message;
    const code = error instanceof GitHubError ? error.code : "invalid_url";
    await store.markFailed(submissionId, githubUrl, code, message);
    return { status: "failed", error: message, code };
  }

  await store.markScanning(submissionId, githubUrl);

  let result: ScanResult;
  try {
    result = await scanRepository(client, owner, repo);
  } catch (error) {
    const message = (error as Error).message ?? "Repository analysis failed.";
    const code = error instanceof GitHubError ? error.code : "scanner_error";
    await store.markFailed(submissionId, githubUrl, code, message);
    return { status: "failed", error: message, code };
  }

  const cached = await store.cached(submissionId, result.commitSha);
  if (cached) {
    return {
      status: "cached",
      repository_id: cached.id as string,
      project_map: cached.project_map,
    };
  }

  const repositoryId = await store.persist(submissionId, result);
  return {
    // A full scan reports "completed"; a tightened one reports "limited".
    status: result.analysisMode === "full" ? "completed" : "limited",
    repository_id: repositoryId,
    commit_sha: result.commitSha,
    file_count: result.files.length,
    evidence_count: result.evidence.length,
  };
}
