import { db, HttpError } from "../../http.ts";
import { ENGINE_SCAN_VERSION } from "../constants.ts";
import type { EngineScanResult } from "../scan/run.ts";
import type { FileRecord } from "../infra/github.ts";
import type { DatasetProfile } from "../../datasets.ts";
import type { SemanticsResult } from "../../semantics.ts";
import type { Route } from "../infra/github.ts";

export interface LoadedEngineAnalysis {
  repository: Record<string, unknown>;
  files: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  projectMap: Record<string, unknown>;
  datasetProfiles: DatasetProfile[];
  semantics: SemanticsResult[];
  routes: Route[];
  inspection: {
    mode: "full" | "limited";
    warnings: string[];
    filesSeen: number;
    filesRead: number;
  };
}

export class EnginePersistence {
  private readonly service = db();

  async cached(submissionId: string, commitSha: string) {
    const { data } = await this.service
      .from("repositories")
      .select("id, analysis_status, project_map, evidence, analyzed_commit_sha, analysis_version")
      .eq("submission_id", submissionId)
      .eq("analyzed_commit_sha", commitSha)
      .eq("analysis_version", ENGINE_SCAN_VERSION)
      .in("analysis_status", ["completed", "limited"])
      .limit(1);
    return (data as Record<string, unknown>[] | null)?.[0] ?? null;
  }

  async markScanning(submissionId: string, githubUrl: string, stage = "discovering_repository"): Promise<void> {
    await this.service.from("repositories").upsert(
      {
        submission_id: submissionId,
        github_url: githubUrl,
        analysis_status: "scanning",
        analysis_stage: stage,
        analysis_version: ENGINE_SCAN_VERSION,
        error_code: null,
        error_message: null,
      },
      { onConflict: "submission_id" },
    );
  }

  async markFailed(submissionId: string, githubUrl: string, code: string, message: string): Promise<void> {
    await this.service.from("repositories").upsert(
      {
        submission_id: submissionId,
        github_url: githubUrl,
        analysis_status: "failed",
        analysis_stage: "failed",
        analysis_version: ENGINE_SCAN_VERSION,
        error_code: code,
        error_message: message.slice(0, 500),
      },
      { onConflict: "submission_id" },
    );
  }

  async markStale(submissionId: string): Promise<void> {
    await this.service.from("repositories").update({ analysis_status: "stale" }).eq("submission_id", submissionId);
  }

  async persist(submissionId: string, result: EngineScanResult): Promise<string> {
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
          analysis_status: result.analysisMode === "full" ? "completed" : "limited",
          analysis_stage: "completed",
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
    if (error || !data) throw new HttpError("Could not persist the repository row.", 500);
    const repositoryId = (data as { id: string }).id;
    await this.writeFiles(repositoryId, result.files);
    await this.writeChunks(repositoryId, result.chunks);
    await this.writeGraph(repositoryId, result.projectMap);
    return repositoryId;
  }

  async loadForReview(submissionId: string): Promise<LoadedEngineAnalysis | null> {
    const { data: repository } = await this.service
      .from("repositories")
      .select("*")
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (!repository) return null;
    const repo = repository as Record<string, unknown>;
    const { data: files } = await this.service
      .from("repository_files")
      .select("*")
      .eq("repository_id", repo.id);
    const { data: chunks } = await this.service
      .from("code_chunks")
      .select("*")
      .eq("repository_id", repo.id);
    const projectMap = (repo.project_map as Record<string, unknown>) ?? {};
    return {
      repository: repo,
      files: (files ?? []) as Record<string, unknown>[],
      chunks: (chunks ?? []) as Record<string, unknown>[],
      evidence: (repo.evidence ?? []) as Record<string, unknown>[],
      projectMap,
      datasetProfiles: (projectMap.data_sources as DatasetProfile[]) ?? [],
      semantics: [],
      routes: (projectMap.apis as Route[]) ?? [],
      inspection: {
        mode: (repo.analysis_mode as "full" | "limited") ?? "full",
        warnings: (projectMap.warnings as string[]) ?? [],
        filesSeen: Number((projectMap.repository_stats as Record<string, number>)?.total_files_seen ?? 0),
        filesRead: ((files ?? []) as { is_ignored?: boolean }[]).filter((row) => !row.is_ignored).length,
      },
    };
  }

  private async writeFiles(repositoryId: string, files: FileRecord[]): Promise<void> {
    await this.service.from("repository_files").delete().eq("repository_id", repositoryId);
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
      await this.service.from("repository_files").upsert(rows.slice(start, start + 500), {
        onConflict: "repository_id,path",
      });
    }
  }

  private async writeChunks(repositoryId: string, chunks: Record<string, unknown>[]): Promise<void> {
    const { data: fileRows } = await this.service
      .from("repository_files")
      .select("id, path")
      .eq("repository_id", repositoryId);
    const idByPath = new Map(
      ((fileRows ?? []) as { id: string; path: string }[]).map((row) => [row.path, row.id]),
    );
    await this.service.from("code_chunks").delete().eq("repository_id", repositoryId);
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
      await this.service.from("code_chunks").upsert(rows.slice(start, start + 400), {
        onConflict: "file_id,chunk_index",
      });
    }
  }

  private async writeGraph(repositoryId: string, projectMap: Record<string, unknown>): Promise<void> {
    const graph = projectMap.graph as {
      symbols?: {
        file: string;
        name: string;
        symbol_type: string;
        language: string | null;
        start_line: number;
        end_line: number;
      }[];
      relationships?: {
        from_file: string;
        to_file: string;
        from_symbol: string | null;
        to_symbol: string | null;
        relation: string;
        line: number;
        confidence: string;
      }[];
    } | undefined;
    if (!graph) return;
    await this.service.from("repository_symbols").delete().eq("repository_id", repositoryId);
    await this.service.from("repository_relationships").delete().eq("repository_id", repositoryId);
    const symbols = (graph.symbols ?? []).slice(0, 400).map((symbol) => ({
      repository_id: repositoryId,
      file_path: symbol.file,
      symbol: symbol.name,
      symbol_type: symbol.symbol_type,
      language: symbol.language,
      start_line: symbol.start_line,
      end_line: symbol.end_line,
    }));
    const edges = (graph.relationships ?? []).slice(0, 500).map((edge) => ({
      repository_id: repositoryId,
      from_file: edge.from_file,
      to_file: edge.to_file,
      from_symbol: edge.from_symbol,
      to_symbol: edge.to_symbol,
      relation: edge.relation,
      line: edge.line,
      confidence: edge.confidence,
    }));
    if (symbols.length) await this.service.from("repository_symbols").insert(symbols);
    if (edges.length) await this.service.from("repository_relationships").insert(edges);
  }
}
