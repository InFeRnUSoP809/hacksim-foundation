export const READ_CATEGORIES = new Set([
  "source",
  "frontend",
  "backend",
  "api",
  "database",
  "schema",
  "configuration",
  "dependency",
  "test",
  "prompt",
  "deployment",
  "security",
]);

export const ALWAYS_READ_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "cargo.toml",
  "dockerfile",
  "docker-compose.yml",
  "readme.md",
  "readme",
]);

export const MAX_DATASET_BYTES = 8 * 1024 * 1024;
export const MAX_DATASETS_READ = 8;
export const DATASET_HEAD_BYTES = 256 * 1024;

export function isSourceLike(category: string): boolean {
  return ["source", "frontend", "backend", "api", "test", "prompt"].includes(category);
}

export function looksLikeDataPath(path: string, name: string): boolean {
  const lower = `${path}/${name}`.toLowerCase();
  return lower.includes("/data/") || lower.endsWith(".csv") || lower.endsWith(".parquet");
}
