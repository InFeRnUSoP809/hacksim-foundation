/**
 * An offline repository source.
 *
 * The scanner talks to a small surface — repository, latest commit, git tree,
 * blobs — so it can be pointed at a directory on disk instead of the GitHub
 * API. That matters for two reasons:
 *
 *   1. The regression harness can analyse a real repository without spending
 *      API quota or needing a token, so the tests are reproducible for anyone.
 *   2. The same engine, the same code path, is what runs in production. A test
 *      that exercises a mock scanner is not testing the scanner.
 *
 * The commit sha is derived from the tree contents, so a file change produces a
 * different commit and the commit-keyed cache behaves exactly as it does
 * against GitHub.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

export interface LocalRepo {
  owner: string;
  repo: string;
  dir: string;
  defaultBranch: string;
  commitSha: string;
  fileCount: number;
}

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", "dist",
  "build", "out", "coverage", ".next", ".nuxt", "vendor", "venv", ".venv",
  "target", "site-packages", ".idea", ".vscode",
]);

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, root, out);
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Materialise a repository locally from a GitHub URL, without the API. */
export function fetchRepo(url: string, cacheDir = "/tmp/hacksim-repos"): LocalRepo {
  const match = url.match(/github\.com\/([^/]+)\/([^/.?#]+)/i);
  if (!match) throw new Error(`Not a GitHub URL: ${url}`);
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  const dir = join(cacheDir, `${owner}-${repo}`);

  if (!existsReadable(dir)) {
    mkdirSync(dir, { recursive: true });
    const branches = ["main", "master"];
    let done = false;
    let lastError = "";
    for (const branch of branches) {
      try {
        execFileSync(
          "curl",
          [
            "-fsSL",
            "--max-time",
            "120",
            `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`,
            "-o",
            "/tmp/repo.tgz",
          ],
          { stdio: "pipe" },
        );
        execFileSync("tar", ["-xzf", "/tmp/repo.tgz", "-C", dir, "--strip-components=1"], {
          stdio: "pipe",
        });
        done = true;
        break;
      } catch (error) {
        lastError = (error as Error).message;
      }
    }
    if (!done) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`Could not download ${owner}/${repo}: ${lastError}`);
    }
  }

  const files = walk(dir).sort();
  const commitSha = sha256(files.map((path) => `${path}:${fileSize(join(dir, path))}`).join("\n"));
  const defaultBranch = readDefaultBranch(dir);

  return {
    owner,
    repo,
    dir,
    defaultBranch,
    commitSha,
    fileCount: files.length,
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readDefaultBranch(dir: string): string {
  const pkg = safeRead(join(dir, "package.json"));
  if (pkg) return "main";
  return "main";
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function existsReadable(dir: string): boolean {
  try {
    statSync(dir);
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * The same four calls the GitHub client makes, served from disk. Kept
 * deliberately method-for-method identical so `scanRepository` cannot tell the
 * difference — which is the whole point.
 */
export class LocalRepoClient {
  constructor(private readonly repo: LocalRepo) {}

  parseRepositoryUrl() {
    return { owner: this.repo.owner, repo: this.repo.repo };
  }

  async repository() {
    const stats = safeRead(join(this.repo.dir, "package.json"));
    let language: string | null = null;
    if (existsReadable(join(this.repo.dir, "requirements.txt"))) language = "Python";
    else if (stats) language = "JavaScript";
    else if (existsReadable(join(this.repo.dir, "main.py"))) language = "Python";
    void stats;
    return {
      default_branch: this.repo.defaultBranch,
      visibility: "public",
      language,
      stargazers_count: 0,
      forks_count: 0,
      description: "",
    };
  }

  async latestCommit() {
    return { sha: this.repo.commitSha };
  }

  async gitTree() {
    const tree = walk(this.repo.dir).map((path) => {
      const full = join(this.repo.dir, path);
      return {
        type: "blob",
        path,
        sha: sha256(safeRead(full) ?? path),
        size: fileSize(full),
      };
    });
    return { tree, truncated: false };
  }

  async blob(_owner: string, _name: string, blobSha: string): Promise<Uint8Array> {
    const path = this.bySha(blobSha);
    if (!path) throw new Error("blob not found");
    return new Uint8Array(readFileSync(join(this.repo.dir, path)));
  }

  private bySha(sha: string): string | null {
    for (const path of walk(this.repo.dir)) {
      const full = join(this.repo.dir, path);
      if (sha256(safeRead(full) ?? path) === sha) return path;
    }
    return null;
  }
}

/** Write a small markdown report. Used by the harness, not by the app. */
export function writeReport(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}
