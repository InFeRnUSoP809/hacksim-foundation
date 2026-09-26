/**
 * Phase 5 — deterministic GitHub repository analysis.
 *
 * Zero AI tokens. Everything here is a pure function over repository content, so
 * the same commit always produces the same evidence ids and the AI cache in
 * §58 stays valid.
 *
 * Two absolute rules:
 *   * an ignored or sensitive file is never read, and
 *   * a detected secret never leaves this module — only its type, location and
 *     a fixed-shape redaction do.
 */

const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "venv", ".venv", "env", "__pycache__", "dist",
  "build", "out", "coverage", ".coverage", ".cache", ".next", ".nuxt",
  ".svelte-kit", "target", "vendor", "bower_components", ".gradle", ".idea",
  ".vscode", "site-packages", ".terraform", ".mypy_cache", ".pytest_cache",
  ".tox", "htmlcov",
]);

const IGNORED_SUFFIXES = [
  ".min.js", ".min.css", ".pyc", ".pyo", ".so", ".dylib", ".dll", ".exe",
  ".class", ".jar", ".war", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".rar", ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".flac",
  ".ogg", ".aac", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svgz",
  ".webp", ".psd", ".ai", ".ttf", ".otf", ".woff", ".woff2", ".eot", ".db",
  ".sqlite", ".sqlite3", ".dump", ".bak", ".pack", ".idx", ".pdf", ".docx",
  ".xlsx", ".pptx", ".map",
];

const IGNORED_FILENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "bun.lockb", "composer.lock", "cargo.lock", "gemfile.lock", "poetry.lock",
  "pdm.lock", "uv.lock", "mix.lock", "packages.lock.json",
]);

const SENSITIVE_FILENAMES = new Set([
  ".env", ".env.local", ".env.production", ".npmrc", ".netrc", ".pgpass",
]);

const MANIFEST_FILENAMES: Record<string, string> = {
  "package.json": "dependency",
  "requirements.txt": "dependency",
  "pyproject.toml": "dependency",
  "pipfile": "dependency",
  "poetry.lock": "dependency",
  "pom.xml": "dependency",
  "build.gradle": "dependency",
  "go.mod": "dependency",
  "cargo.toml": "dependency",
  "composer.json": "dependency",
  "gemfile": "dependency",
  "pubspec.yaml": "dependency",
  "deno.json": "dependency",
};

const DEPLOYMENT_FILENAMES = new Set([
  "dockerfile", "docker-compose.yml", "docker-compose.yaml", "vercel.json",
  "netlify.toml", "fly.toml", "render.yaml", "railway.json", "heroku.yml",
  "procfile", "makefile", "justfile", "serverless.yml", "k8s.yaml",
  "helmfile.yaml", "app.yaml",
]);

const CONFIG_FILENAMES = new Set([
  "vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs",
  "nuxt.config.ts", "angular.json", "svelte.config.js", "astro.config.mjs",
  "tailwind.config.js", "tailwind.config.ts", "postcss.config.js",
  "tsconfig.json", "jsconfig.json", "eslint.config.js", ".eslintrc.js",
  ".eslintrc.json", ".prettierrc", "babel.config.js", "jest.config.js",
  "vitest.config.ts", "pytest.ini", "tox.ini", "setup.cfg", "ruff.toml",
  "mypy.ini", "alembic.ini", "manage.py", "wsgi.py", "asgi.py",
]);

const HIGH_IMPORTANCE = new Set([
  "readme.md", "package.json", "requirements.txt", "pyproject.toml", "go.mod",
  "cargo.toml", "pom.xml", "build.gradle", "dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "supabase/schema.sql",
]);

const MEDIUM_IMPORTANCE_HINTS = [
  "schema", "migration", "model", "auth", "route", "router", "controller",
  "api", "service", "middleware", "config", "settings", "requirements",
  "prisma", "supabase",
];

const CATEGORY_BY_EXTENSION: Record<string, string> = {
  ".py": "source", ".ts": "source", ".tsx": "component", ".jsx": "component",
  ".js": "source", ".mjs": "source", ".cjs": "source", ".go": "source",
  ".rs": "source", ".rb": "source", ".java": "source", ".kt": "source",
  ".swift": "source", ".dart": "source", ".c": "source", ".h": "source",
  ".cpp": "source", ".hpp": "source", ".cs": "source", ".php": "source",
  ".vue": "component", ".svelte": "component",
  ".sql": "database", ".prisma": "schema", ".graphql": "schema",
  ".gql": "schema", ".proto": "schema",
  ".json": "config", ".yaml": "config", ".yml": "config", ".toml": "config",
  ".ini": "config", ".cfg": "config", ".conf": "config",
  ".properties": "config", ".env": "config",
  ".md": "documentation", ".mdx": "documentation", ".rst": "documentation",
  ".txt": "documentation", ".adoc": "documentation",
  ".html": "component", ".css": "component", ".scss": "component",
  ".sass": "component", ".less": "component",
  ".sh": "deployment", ".bash": "deployment", ".zsh": "deployment",
  ".ps1": "deployment", ".tf": "deployment", ".dockerfile": "deployment",
  ".gradle": "dependency", ".kts": "dependency", ".bat": "deployment",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
  ".cjs": "JavaScript", ".vue": "Vue", ".svelte": "Svelte",
  ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".java": "Java",
  ".kt": "Kotlin", ".swift": "Swift", ".dart": "Dart", ".php": "PHP",
  ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cs": "C#",
  ".sql": "SQL", ".sh": "Shell", ".bash": "Shell", ".ps1": "PowerShell",
  ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".json": "JSON",
  ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".md": "Markdown",
  ".graphql": "GraphQL", ".prisma": "Prisma", ".tf": "Terraform",
  ".ipynb": "Jupyter Notebook",
};

const SUPPORTED_EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".java",
  ".kt", ".rb", ".rs", ".php", ".cs",
]);

// ── Paths ──────────────────────────────────────────────────────────────────

export function normalize(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  return normalized.replace(/\/$/, "");
}

export function basenameOf(path: string): string {
  const parts = normalize(path).split("/");
  return parts[parts.length - 1] ?? "";
}

export function extensionOf(path: string): string {
  const name = basenameOf(path).toLowerCase();
  if (name in MANIFEST_FILENAMES || name.startsWith("dockerfile")) return "";
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

export function isSensitive(path: string): boolean {
  const name = basenameOf(path).toLowerCase();
  return SENSITIVE_FILENAMES.has(name) || name.startsWith(".env");
}

export function isIgnored(path: string): boolean {
  const parts = normalize(path).split("/");
  const directories = parts.slice(0, -1);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();

  for (const directory of directories) {
    if (IGNORED_DIRECTORIES.has(directory) || directory.endsWith(".egg-info")) {
      return true;
    }
  }
  if (SENSITIVE_FILENAMES.has(name) || name.startsWith(".env.")) return true;
  if (IGNORED_FILENAMES.has(name) || IGNORED_DIRECTORIES.has(name)) return true;

  const lower = name.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function languageOf(path: string): string | null {
  const name = basenameOf(path).toLowerCase();
  if (name.startsWith("dockerfile")) return "Dockerfile";
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

// ── Classification ─────────────────────────────────────────────────────────

export function categoryOf(
  path: string,
  isBinary: boolean,
): string {
  if (isBinary) return "asset";
  const normalized = normalize(path);
  const name = basenameOf(normalized).toLowerCase();
  const dirs = normalized.split("/").slice(0, -1).map((p) => p.toLowerCase());

  if (SENSITIVE_FILENAMES.has(name) || name.startsWith(".env")) return "config";
  if (name in MANIFEST_FILENAMES || name.endsWith(".lock")) return "dependency";
  if (name.startsWith("dockerfile") || DEPLOYMENT_FILENAMES.has(name)) {
    return "deployment";
  }
  const testDir = dirs.some((d) =>
    ["test", "tests", "spec", "__tests__"].includes(d)
  );
  if (testDir || /^(test|spec)/.test(name)) return "test";
  if (name.includes("jest.config") || name.includes("vitest.config") ||
      name.includes("playwright.config") || name.includes("cypress")) {
    return "test";
  }
  if (CONFIG_FILENAMES.has(name)) return "config";
  if (/\.(md|mdx|rst)$/.test(name)) return "documentation";

  const byExtension = CATEGORY_BY_EXTENSION[extensionOf(normalized)];
  if (byExtension) return byExtension;

  if (dirs.some((d) => ["routes", "routers", "api", "controllers", "endpoints"].includes(d))) {
    return "api";
  }
  if (dirs.some((d) => ["models", "entities", "db", "database"].includes(d))) {
    return "model";
  }
  if (dirs.some((d) => ["pages", "views", "components", "app"].includes(d))) {
    return "component";
  }
  return "unknown";
}

export function importanceOf(path: string, category: string): string {
  if (isIgnored(path)) return "ignored";
  if (category === "asset") return "ignored";

  const name = basenameOf(path).toLowerCase();
  if (HIGH_IMPORTANCE.has(name)) return "high";
  if (category === "schema" || category === "database" || category === "deployment") {
    return "high";
  }
  if (MEDIUM_IMPORTANCE_HINTS.some((hint) => name.includes(hint))) return "high";
  if (["api", "model", "component", "config", "source", "test"].includes(category)) {
    return "medium";
  }
  return "low";
}

export function isSourceLike(category: string): boolean {
  return ["source", "component", "api", "model", "schema", "database"].includes(
    category,
  );
}

// ── GitHub URL parsing (§10) ───────────────────────────────────────────────

export interface RepositoryRef {
  owner: string;
  repo: string;
  normalizedUrl: string;
}

export class InvalidRepositoryUrl extends Error {}

const ALLOWED = /^[A-Za-z0-9._-]+$/;

export function parseRepositoryUrl(url: string): RepositoryRef {
  const raw = (url ?? "").trim();
  if (!raw) throw new InvalidRepositoryUrl("No repository URL was provided.");

  let candidate = raw;

  if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.split(":")[1] ?? "";
  } else {
    const withoutScheme = candidate.replace(/^[a-z]+:\/\//i, "");
    const [host, ...rest] = withoutScheme.split("/");
    if (!host || !["github.com", "www.github.com"].includes(host.toLowerCase())) {
      throw new InvalidRepositoryUrl("Only GitHub repository URLs are supported.");
    }
    candidate = rest.join("/");
  }

  candidate = candidate.split("?")[0].split("#")[0].replace(/^\/+|\/+$/g, "");
  if (candidate.toLowerCase().endsWith(".git")) {
    candidate = candidate.slice(0, -4);
  }

  const parts = candidate.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new InvalidRepositoryUrl(
      "Enter a GitHub repository URL, like https://github.com/user/repo",
    );
  }
  const [owner, repo] = parts;
  if (!ALLOWED.test(owner) || !ALLOWED.test(repo)) {
    throw new InvalidRepositoryUrl(
      "Enter a GitHub repository URL, like https://github.com/user/repo",
    );
  }
  return {
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  };
}

// ── Secrets (§15) ──────────────────────────────────────────────────────────

interface SecretPattern {
  type: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { type: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { type: "service_role_key", regex: /\bey[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { type: "aws_access_key_id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { type: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { type: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { type: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { type: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { type: "stripe_key", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { type: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { type: "credential_url", regex: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i },
  { type: "connection_string", regex: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i },
  {
    type: "api_key_assignment",
    regex: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
  },
];

const PLACEHOLDER_TOKENS = [
  "your_", "your-", "example", "changeme", "change-me", "placeholder",
  "xxxxx", "dummy", "fake", "todo", "insert_", "replace_",
];

const SAFE_ASSIGNMENT =
  /(?:process\.env\.|Deno\.env\.|import\.meta\.env\.|os\.environ|getenv\(|env\[)/;

/**
 * Redaction takes only the secret *type*. An earlier version kept the
 * surrounding label and leaked the entire value for patterns with no `=` in
 * them — this signature makes that impossible.
 */
function redact(secretType: string): string {
  return `${secretType.replace(/_/g, " ")}: [redacted]`;
}

export interface SecretFinding {
  secret_type: string;
  file: string;
  line: number;
  redacted: string;
}

export function scanFileForSecrets(
  path: string,
  content: string,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const { type, regex } of SECRET_PATTERNS) {
    if (seen.has(type)) continue;
    const match = regex.exec(content);
    if (!match) continue;

    const matched = match[0];
    const lowered = matched.toLowerCase();
    if (SAFE_ASSIGNMENT.test(matched)) continue;
    if (PLACEHOLDER_TOKENS.some((token) => lowered.includes(token))) continue;

    const line = content.slice(0, match.index).split("\n").length;
    seen.add(type);
    findings.push({ secret_type: type, file: path, line, redacted: redact(type) });
  }
  return findings;
}

// ── Binary handling ────────────────────────────────────────────────────────

export function looksBinary(content: Uint8Array): boolean {
  const sample = content.slice(0, 8000);
  if (sample.length === 0) return false;
  let nulls = 0;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) nulls++;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printable++;
    }
  }
  if (nulls > 0) return true;
  return printable / sample.length < 0.98;
}

export function decodeText(content: Uint8Array): string | null {
  if (looksBinary(content)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(content);
  } catch {
    return null;
  }
}

export function countLines(content: string): number {
  if (!content) return 0;
  const breaks = (content.match(/\n/g) ?? []).length;
  return content.endsWith("\n") ? breaks : breaks + 1;
}

// ── Dependencies (§19) ────────────────────────────────────────────────────

const CATEGORY_RULES: [string, string[]][] = [
  ["frontend", [
    "react", "react-dom", "next", "vue", "nuxt", "svelte", "@angular/core",
    "preact", "solid-js", "astro", "@remix-run/react", "redux",
    "@reduxjs/toolkit", "zustand", "tailwindcss", "bootstrap", "@mui/material",
    "antd", "@chakra-ui/react", "framer-motion", "vite", "webpack", "esbuild",
  ]],
  ["backend", [
    "express", "fastapi", "flask", "django", "@nestjs/core", "spring-boot",
    "laravel/framework", "gin-gonic/gin", "actix-web", "axum", "rails",
    "sinatra",
  ]],
  ["database", [
    "pg", "psycopg", "psycopg2", "asyncpg", "mysql2", "pymysql", "sqlalchemy",
    "prisma", "@prisma/client", "mongoose", "mongodb", "redis", "ioredis",
    "typeorm", "sequelize", "drizzle-orm", "knex", "sqlite3",
    "better-sqlite3", "@supabase/supabase-js",
  ]],
  ["ai_ml", [
    "openai", "anthropic", "langchain", "transformers", "torch",
    "tensorflow", "keras", "scikit-learn", "xgboost", "lightgbm", "prophet",
    "sentence-transformers", "deepseek",
  ]],
  ["testing", [
    "pytest", "jest", "vitest", "mocha", "chai", "cypress", "playwright",
    "@testing-library/react", "supertest", "hypothesis", "msw",
  ]],
  ["authentication", [
    "passport", "jsonwebtoken", "pyjwt", "python-jose", "auth0", "next-auth",
    "@auth/core", "@clerk/nextjs", "bcrypt", "argon2", "passlib", "lucia",
    "better-auth",
  ]],
  ["deployment", [
    "vercel", "netlify", "docker", "kubernetes", "serverless", "pm2",
    "terraform", "pulumi", "firebase", "firebase-admin", "cloudflare-workers",
  ]],
];

/** Exact matches beat substring matches, so `vitest` never lands in frontend. */
export function categorisePackage(pkg: string): string {
  const lowered = pkg.toLowerCase();
  for (const [category, needles] of CATEGORY_RULES) {
    if (needles.some((n) => n.toLowerCase() === lowered)) return category;
  }
  for (const [category, needles] of CATEGORY_RULES) {
    const ordered = [...needles].sort((a, b) => b.length - a.length);
    if (ordered.some((n) => lowered.includes(n.toLowerCase()))) return category;
  }
  return "utility";
}

export interface Dependency {
  package: string;
  version: string | null;
  category: string;
  ecosystem: string;
  dev: boolean;
}

function cleanPythonVersion(spec: string): string | null {
  const match = /(\d+(?:\.\d+)*)/.exec(spec.replace(/^[<>=!~\[\s]+/, ""));
  return match ? match[1] : null;
}

function parseJson(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pushTarget(
  out: Dependency[],
  pkg: string,
  version: string | null,
  ecosystem: string,
  dev = false,
) {
  const package_ = pkg.split("[")[0].split(";")[0].trim();
  if (!package_) return;
  out.push({
    package: package_,
    version,
    category: categorisePackage(package_),
    ecosystem,
    dev,
  });
}

function parseRequirementsTxt(content: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line || line.startsWith("-")) continue;

    if (line.includes("git+") || line.includes("http")) {
      const name = /([A-Za-z0-9_.-]+)/.exec(line.split("@")[0] ?? "");
      if (name) pushTarget(out, name[1], null, "pypi");
      continue;
    }
    const specMatch = /^(.*?)(==|>=|~=)(.*)$/.exec(line);
    if (!specMatch) continue;
    pushTarget(out, specMatch[1], cleanPythonVersion(specMatch[3]), "pypi");
  }
  return out;
}

function parsePyproject(content: string): Dependency[] {
  const out: Dependency[] = [];
  const data = parseJson(content);
  if (!data) return out;

  const project = (data.project ?? {}) as Record<string, unknown>;
  for (const spec of (project.dependencies as string[]) ?? []) {
    const [name, version] = String(spec).split(">=");
    pushTarget(out, name ?? "", version ? cleanPythonVersion(version) : null, "pypi");
  }

  const optional = (project["optional-dependencies"] ?? {}) as Record<string, string[]>;
  for (const [group, specs] of Object.entries(optional)) {
    for (const spec of specs ?? []) {
      const [name, version] = String(spec).split(">=");
      pushTarget(
        out, name ?? "", version ? cleanPythonVersion(version) : null, "pypi",
        ["dev", "test", "tests"].includes(group),
      );
    }
  }

  const poetry = ((data.tool as Record<string, unknown>)?.poetry ?? {}) as Record<
    string, unknown
  >;
  for (const [section, dev] of [["dependencies", false], ["dev-dependencies", true]] as const) {
    for (const [pkg, spec] of Object.entries((poetry[section] ?? {}) as Record<string, string>)) {
      pushTarget(out, pkg, cleanPythonVersion(String(spec)), "pypi", dev);
    }
  }
  return out;
}

function parsePackageJson(content: string): Dependency[] {
  const out: Dependency[] = [];
  const data = parseJson(content);
  if (!data) return out;

  for (const [section, dev] of [
    ["dependencies", false],
    ["devDependencies", true],
    ["peerDependencies", true],
  ] as const) {
    const block = (data[section] ?? {}) as Record<string, string>;
    for (const [pkg, spec] of Object.entries(block)) {
      pushTarget(out, pkg, spec ? String(spec).replace(/^[\^~>=<\s]+/, "") : null, "npm", dev);
    }
  }
  return out;
}

function parseGoMod(content: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || /^(module|go\s|\/\/)/.test(line)) continue;
    const match = /^(?:require\s+)?([\w./-]+)\s+(v[\w.+-]+)/.exec(line);
    if (match) pushTarget(out, match[1], match[2].replace(/^v/, ""), "go");
  }
  return out;
}

function parseCargo(content: string): Dependency[] {
  const out: Dependency[] = [];
  let inDeps = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[dependencies]")) { inDeps = true; continue; }
    if (line.startsWith("[") && inDeps) { inDeps = false; continue; }
    if (!inDeps || !line.includes("=")) continue;
    const [pkg, spec] = line.split("=");
    const version = /version\s*=\s*"([^"]+)"/.exec(spec ?? "");
    pushTarget(out, (pkg ?? "").trim().replace(/^"|"$/g, ""), version?.[1] ?? null, "cargo");
  }
  return out;
}

function parseMaven(content: string): Dependency[] {
  const out: Dependency[] = [];
  const regex = /<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    pushTarget(out, `${match[1]}:${match[2]}`, match[3] ?? null, "maven");
  }
  return out;
}

function parseGradle(content: string): Dependency[] {
  const out: Dependency[] = [];
  const regex = /(implementation|api|testImplementation|compileOnly)\s*[('"]+([\w.-]+):([\w.-]+):?([\w.-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    pushTarget(
      out, `${match[2]}:${match[3]}`, match[4] || null, "maven",
      match[1] === "testImplementation",
    );
  }
  return out;
}

function parseComposer(content: string): Dependency[] {
  const out: Dependency[] = [];
  const data = parseJson(content);
  if (!data) return out;
  for (const [section, dev] of [["require", false], ["require-dev", true]] as const) {
    for (const [pkg, spec] of Object.entries((data[section] ?? {}) as Record<string, string>)) {
      if (pkg === "php" || pkg.startsWith("ext-")) continue;
      pushTarget(out, pkg, String(spec).replace(/^[\^~>=<\s]+/, ""), "composer", dev);
    }
  }
  return out;
}

function parsePubspec(content: string): Dependency[] {
  const out: Dependency[] = [];
  let inBlock = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "dependencies:") { inBlock = true; continue; }
    if (line.endsWith(":") && !line.startsWith(" ") && !line.startsWith("\t")) {
      inBlock = false;
      continue;
    }
    if (!inBlock || !line.startsWith(" ") || !line.includes(":")) continue;
    const [name, spec] = line.split(":");
    if (name && name.trim()) pushTarget(out, name, spec?.trim() || null, "pub");
  }
  return out;
}

const MANIFEST_PARSERS: Record<string, (content: string) => Dependency[]> = {
  "package.json": parsePackageJson,
  "requirements.txt": parseRequirementsTxt,
  "pyproject.toml": parsePyproject,
  pipfile: parseRequirementsTxt,
  "pom.xml": parseMaven,
  "build.gradle": parseGradle,
  "go.mod": parseGoMod,
  "cargo.toml": parseCargo,
  "composer.json": parseComposer,
  "pubspec.yaml": parsePubspec,
};

export function extractDependencies(path: string, content: string): Dependency[] {
  const parser = MANIFEST_PARSERS[basenameOf(path).toLowerCase()];
  if (!parser) return [];
  try {
    return parser(content);
  } catch {
    // A malformed manifest must never stop a scan.
    return [];
  }
}

// ── Symbols (§21) ──────────────────────────────────────────────────────────

export interface Symbol {
  name: string;
  symbol_type: string;
  line: number;
  signature: string;
}

type SymbolRule = [RegExp, number, string];

const SYMBOL_RULES: Record<string, SymbolRule[]> = {
  ".py": [
    [/^\s*async\s+def\s+(\w+)\s*\(/, 1, "function"],
    [/^\s*def\s+(\w+)\s*\(/, 1, "function"],
    [/^\s*class\s+(\w+)\s*[\(:]/, 1, "class"],
  ],
  ts: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/, 1, "function"],
    [/^\s*(?:export\s+)?class\s+(\w+)/, 1, "class"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)/, 1, "function"],
    [/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/, 1, "type"],
  ],
  ".go": [
    [/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, 1, "function"],
    [/^type\s+(\w+)\s+struct/, 1, "type"],
  ],
  ".java": [
    [/^\s*(?:public|private|protected)?[\w\s<>[\],]*\s(\w+)\s*\([^;]*\)\s*\{/, 1, "method"],
    [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/, 1, "class"],
  ],
  ".kt": [
    [/^\s*(?:suspend\s+)?fun\s+(\w+)\s*\(/, 1, "function"],
    [/^\s*(?:data\s+)?class\s+(\w+)/, 1, "class"],
  ],
  ".rb": [
    [/^\s*def\s+([\w?!.]+)/, 1, "method"],
    [/^\s*class\s+(\w+)/, 1, "class"],
    [/^\s*module\s+(\w+)/, 1, "module"],
  ],
  ".rs": [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 1, "function"],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/, 1, "type"],
  ],
  ".php": [
    [/^\s*(?:public|private|protected)?\s*function\s+(\w+)\s*\(/, 1, "method"],
    [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 1, "class"],
  ],
  ".cs": [
    [/^\s*(?:public|private|protected|internal)[\w\s<>[\],]*\s(\w+)\s*\([^;]*\)\s*\{/, 1, "method"],
    [/^\s*(?:public\s+)?(?:class|record|struct|interface)\s+(\w+)/, 1, "class"],
  ],
};

const RESERVED = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "class",
]);

function rulesFor(extension: string): SymbolRule[] {
  if (extension === ".ts" || extension === ".tsx") return SYMBOL_RULES.ts;
  if (extension === ".js" || extension === ".jsx" ||
      extension === ".mjs" || extension === ".cjs") {
    return SYMBOL_RULES.ts;
  }
  return SYMBOL_RULES[extension] ?? [];
}

export function extractSymbols(
  path: string,
  content: string,
): { symbols: Symbol[]; parserStatus: "ok" | "unsupported" } {
  const extension = extensionOf(path);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    // §21 — an unsupported language reports so. We never fabricate a result.
    return { symbols: [], parserStatus: "unsupported" };
  }

  const rules = rulesFor(extension);
  const symbols: Symbol[] = [];
  const seen = new Set<string>();
  // Indent of the nearest enclosing class, so a function inside one is a method.
  const classIndents: number[] = [];

  content.split("\n").forEach((line, index) => {
    const trimmed = line.trimEnd();
    if (!trimmed.trim() || /^\s*(#|\/\/|\*|\/\*)/.test(trimmed)) return;

    const indent = trimmed.length - trimmed.trimStart().length;
    while (classIndents.length && indent <= classIndents[classIndents.length - 1]) {
      classIndents.pop();
    }

    for (const [regex, group, type] of rules) {
      const match = regex.exec(trimmed);
      if (!match) continue;
      const name = match[group];
      if (!name || RESERVED.has(name)) continue;

      let symbolType = type;
      if (type === "class") classIndents.push(indent);
      else if (type === "function" && classIndents.length > 0) {
        symbolType = "method";
      }

      const key = `${name}:${symbolType}`;
      if (seen.has(key)) return;
      seen.add(key);
      symbols.push({
        name,
        symbol_type: symbolType,
        line: index + 1,
        signature: trimmed.trim().slice(0, 200),
      });
      return;
    }
  });

  return { symbols, parserStatus: "ok" };
}

// ── Routes (§20) ───────────────────────────────────────────────────────────

export interface Route {
  method: string;
  path: string;
  file: string;
  line: number;
  symbol: string | null;
  framework: string;
}

const FILE_BASED_ROUTE =
  /^(app|pages|src\/app|src\/pages)\/(.*)\.(tsx|jsx|ts|js)$/;

export function extractRoutes(path: string, content: string): Route[] {
  const routes: Route[] = [];
  const seen = new Set<string>();
  const extension = extensionOf(path);

  const add = (method: string, routePath: string, line: number, symbol: string | null, framework: string) => {
    const key = `${method.toUpperCase()} ${routePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({
      method: method.toUpperCase(),
      path: routePath,
      file: path,
      line,
      symbol,
      framework,
    });
  };

  content.split("\n").forEach((line, index) => {
    const number = index + 1;

    let m = /^\s*@(app|router|api)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/i.exec(line);
    if (m) { add(m[2], m[3], number, null, "FastAPI"); return; }

    m = /@(\w+)\.route\s*\(\s*["']([^"']+)["']([^)]*)\)/.exec(line);
    if (m) {
      const methods = [...(m[3] ?? "").matchAll(/get|post|put|patch|delete/gi)];
      for (const method of methods.length ? methods : ["GET"]) {
        add(method[0], m[2], number, m[1], "Flask");
      }
      return;
    }

    m = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']?(\/?[\w{}\/-]*)/.exec(line);
    if (m) {
      add(m[1] === "Request" ? "GET" : m[1], m[2] || "/", number, null, "Spring");
      return;
    }

    m = /\b(\w+)\.(Get|Post|Put|Patch|Delete)\s*\(\s*["`]([^"`]+)["`]/.exec(line);
    if (m) { add(m[2], m[3], number, m[1], "Go"); return; }

    m = /Route::(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/.exec(line);
    if (m) { add(m[1], m[2], number, null, "Laravel"); return; }

    m = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/.exec(line);
    if (m) { add(m[1], m[2], number, null, "Rails"); return; }

    m = /^\s*(?:path|re_path|url)\s*\(\s*r?["']([^"']+)["']/.exec(line);
    if (m) { add("ANY", m[1], number, null, "Django"); return; }

    if (extension === ".py") return;

    m = /\b(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/.exec(line);
    if (m) { add(m[1], m[2], number, null, "Express"); return; }

    m = /<Route[^>]*\bpath\s*=\s*["']([^"']+)["']/i.exec(line);
    if (m) { add("GET", m[1], number, null, "React Router"); return; }
  });

  const fileRoute = FILE_BASED_ROUTE.exec(path);
  if (fileRoute) {
    const segments = (fileRoute[2] ?? "")
      .split("/")
      .filter((s) => s && s !== "index");
    add("GET", `/${segments.join("/")}`, 1, null, "File-based routing");
  }

  return routes;
}

const EXTERNAL_CALL =
  /\b(?:fetch|axios(?:\.\w+)?)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g;
const REQUESTS_CALL =
  /\brequests\.(get|post|put|patch|delete)\s*\(\s*f?["'](https?:\/\/[^"']+)["']/g;

export function extractIntegrations(
  content: string,
  file: string,
): { url: string; file: string; line: number; method: string | null }[] {
  const found = new Map<string, { url: string; file: string; line: number; method: string | null }>();

  for (const match of content.matchAll(EXTERNAL_CALL)) {
    found.set(match[1], {
      url: match[1],
      file,
      line: content.slice(0, match.index).split("\n").length,
      method: null,
    });
  }
  for (const match of content.matchAll(REQUESTS_CALL)) {
    if (!found.has(match[2])) {
      found.set(match[2], {
        url: match[2],
        file,
        line: content.slice(0, match.index).split("\n").length,
        method: match[1].toUpperCase(),
      });
    }
  }
  return [...found.values()];
}

// ── Tests (§24) ────────────────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/,
  /(^|\/)(tests?\/.*\.(py|ts|tsx|js|jsx))$/,
  /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  /(__tests__\/.*\.(ts|tsx|js|jsx))$/,
];

export function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some((regex) => regex.test(path));
}

const TEST_FRAMEWORKS: [string, string[]][] = [
  ["Jest", ["jest.config"]],
  ["Vitest", ["vitest.config"]],
  ["Pytest", ["pytest.ini", "conftest.py"]],
  ["Playwright", ["playwright.config"]],
  ["Cypress", ["cypress.config", "cypress.json"]],
  ["Mocha", [".mocharc"]],
  ["Testing Library", ["setupTests", "jest.setup"]],
  ["Django test runner", ["manage.py"]],
];

export function detectTestFrameworks(
  filenames: string[],
  paths: string[],
): { name: string; evidence: string }[] {
  const haystack = [...filenames, ...paths].map((p) => p.toLowerCase());
  const found: { name: string; evidence: string }[] = [];

  for (const [name, needles] of TEST_FRAMEWORKS) {
    for (const needle of needles) {
      if (haystack.some((p) => p.includes(needle))) {
        found.push({ name, evidence: `\`${needle}\` present` });
        break;
      }
    }
  }

  if (found.length === 0 && paths.some(isTestFile)) {
    found.push({
      name: "Unidentified",
      evidence: "test files present but no known test configuration found",
    });
  }
  return found;
}

const TEST_COMMANDS: [string, RegExp][] = [
  ["npm test", /"test"\s*:\s*"[^"]+"/],
  ["pytest", /\bpytest\b/],
  ["go test", /\bgo test\b/],
  ["cargo test", /\bcargo test\b/],
];

export function detectTestCommands(contents: string[]): string[] {
  const found = new Set<string>();
  for (const content of contents) {
    for (const [command, regex] of TEST_COMMANDS) {
      if (regex.test(content)) found.add(command);
    }
  }
  return [...found].sort();
}

// ── Frameworks, database and auth detection (§18, §22, §23) ────────────────

export interface Detection {
  name: string;
  category: string;
  evidence: string;
  file?: string | null;
  symbol?: string | null;
  lines?: string | null;
}

const FRAMEWORK_SIGNALS: Record<string, string[]> = {
  React: ["react", "react-dom", "preact"],
  "Next.js": ["next"],
  Vue: ["vue"],
  Nuxt: ["nuxt"],
  Angular: ["@angular/core"],
  Svelte: ["svelte"],
  SvelteKit: ["@sveltejs/kit"],
  Astro: ["astro"],
  Remix: ["@remix-run/react", "@remix-run/node"],
  Vite: ["vite"],
  FastAPI: ["fastapi"],
  Flask: ["flask", "flask-cors", "flask-sqlalchemy"],
  Django: ["django", "djangorestframework"],
  Express: ["express"],
  NestJS: ["@nestjs/core", "@nestjs/common"],
  Spring: ["spring-boot", "spring-boot-starter", "spring-web"],
  Laravel: ["laravel/framework", "laravel/sanctum"],
  Rails: ["rails", "railties"],
  Gin: ["gin-gonic/gin"],
  Fiber: ["gofiber/fiber"],
  Actix: ["actix-web"],
  Axum: ["axum"],
  Sinatra: ["sinatra"],
  Flutter: ["flutter"],
  "React Native": ["react-native", "expo"],
};

const FRAMEWORK_CONFIG_SIGNALS: Record<string, string> = {
  "next.config.js": "Next.js",
  "next.config.mjs": "Next.js",
  "next.config.ts": "Next.js",
  "nuxt.config.ts": "Nuxt",
  "nuxt.config.js": "Nuxt",
  "svelte.config.js": "Svelte",
  "angular.json": "Angular",
  "astro.config.mjs": "Astro",
  "vite.config.ts": "Vite",
  "vite.config.js": "Vite",
  "manage.py": "Django",
  "vercel.json": "Vercel",
  "netlify.toml": "Netlify",
  "serverless.yml": "Serverless",
  "fly.toml": "Fly.io",
};

const DATABASE_SIGNALS: Record<string, string[]> = {
  PostgreSQL: ["pg", "psycopg", "psycopg2", "asyncpg", "postgres", "@supabase/supabase-js"],
  MySQL: ["mysql2", "pymysql", "mysql-connector"],
  MongoDB: ["mongoose", "mongodb", "pymongo"],
  SQLite: ["sqlite3", "better-sqlite3"],
  Redis: ["redis", "ioredis"],
  SQLAlchemy: ["sqlalchemy"],
  Prisma: ["prisma", "@prisma/client"],
  TypeORM: ["typeorm"],
  Sequelize: ["sequelize"],
  Drizzle: ["drizzle-orm"],
  "Django ORM": ["django"],
  Mongoose: ["mongoose"],
};

const ORM_KEYWORDS: Record<string, string[]> = {
  SQLAlchemy: ["from sqlalchemy", "import sqlalchemy", "sqlalchemy.orm"],
  Prisma: ["@prisma/client", "prisma."],
  TypeORM: ["typeorm", "@Entity("],
  Sequelize: ["sequelize"],
  Drizzle: ["drizzle-orm"],
  "Django ORM": ["from django.db", "models.Model"],
  Mongoose: ["new mongoose.Schema", "mongoose.model"],
  Supabase: ["createClient", "supabase.from"],
};

const AUTH_SIGNALS: Record<string, string[]> = {
  "Supabase Auth": ["@supabase/supabase-js", "@supabase/auth-js"],
  JWT: ["jsonwebtoken", "pyjwt", "python-jose", "jose"],
  OAuth: ["passport", "oauthlib", "auth0", "next-auth", "@auth/core", "@clerk/nextjs"],
  Passport: ["passport"],
  NextAuth: ["next-auth"],
  Clerk: ["@clerk/nextjs"],
  Auth0: ["auth0", "@auth0/auth0-react"],
  bcrypt: ["bcrypt", "argon2", "passlib"],
  "Laravel Sanctum": ["laravel/sanctum"],
  "Better Auth": ["better-auth"],
};

const AUTH_CODE_SIGNALS: Record<string, string[]> = {
  "Supabase Auth": ["supabase.auth.signIn", "supabase.auth.signUp", "getSession("],
  "JWT verification": ["jwt.decode", "jwt.verify", "verify(", "getUser("],
  "Session cookies": ["setCookie", "document.cookie", "res.cookie"],
  "Authorization middleware": [
    "requireAuth", "authenticate", "get_current_user", "verifyToken", "requireLogin",
  ],
  "Authorization checks": ["is_admin", "isAdmin", "role ===", "hasRole", "require_role"],
};

function matchByDependencies(
  dependencies: Dependency[],
  signals: Record<string, string[]>,
  category: string,
): Detection[] {
  const byPackage = new Map(dependencies.map((d) => [d.package.toLowerCase(), d]));
  const found: Detection[] = [];
  const seen = new Set<string>();

  for (const [technology, needles] of Object.entries(signals)) {
    for (const needle of needles) {
      for (const [pkg, dependency] of byPackage) {
        if (!pkg.includes(needle.toLowerCase())) continue;
        if (seen.has(technology)) break;
        seen.add(technology);
        found.push({
          name: technology,
          category,
          evidence: `dependency \`${dependency.package}\``,
          symbol: dependency.package,
        });
        break;
      }
    }
  }
  return found;
}

export function detectFrameworks(
  dependencies: Dependency[],
  filenames: string[],
): Detection[] {
  const found = matchByDependencies(dependencies, FRAMEWORK_SIGNALS, "framework");
  const present = new Set(found.map((f) => f.name));

  for (const filename of filenames) {
    const technology = FRAMEWORK_CONFIG_SIGNALS[filename.toLowerCase()];
    if (technology && !present.has(technology)) {
      present.add(technology);
      found.push({
        name: technology,
        category: "framework",
        evidence: `configuration file \`${filename}\``,
        file: filename,
      });
    }
  }
  return found;
}

export function detectDatabases(
  dependencies: Dependency[],
  paths: string[],
): Detection[] {
  const found = matchByDependencies(dependencies, DATABASE_SIGNALS, "database");

  if (paths.some((p) => p.endsWith(".sql")) &&
      !found.some((d) => d.name === "SQLAlchemy")) {
    found.push({
      name: "SQL",
      category: "database",
      evidence: "SQL files in the repository",
    });
  }
  if (paths.some((p) => p.endsWith("schema.prisma"))) {
    found.push({
      name: "Prisma",
      category: "database",
      evidence: "`schema.prisma` present",
      file: "schema.prisma",
    });
  }
  return found;
}

export function detectAuth(dependencies: Dependency[]): Detection[] {
  return matchByDependencies(dependencies, AUTH_SIGNALS, "authentication");
}

function detectInCode(
  sources: { path: string; content: string }[],
  signals: Record<string, string[]>,
  category: string,
): Detection[] {
  const found = new Map<string, Detection>();

  for (const [technology, needles] of Object.entries(signals)) {
    for (const source of sources) {
      for (const needle of needles) {
        const index = source.content.indexOf(needle);
        if (index === -1) continue;
        const line = source.content.slice(0, index).split("\n").length;
        if (!found.has(technology)) {
          found.set(technology, {
            name: technology,
            category,
            evidence: `\`${needle}\` used in source`,
            file: source.path,
            lines: `${line}-${line}`,
          });
        }
        break;
      }
    }
  }
  return [...found.values()];
}

export function detectAuthInCode(sources: { path: string; content: string }[]): Detection[] {
  return detectInCode(sources, AUTH_CODE_SIGNALS, "authentication");
}

export function detectDatabaseInCode(sources: { path: string; content: string }[]): Detection[] {
  return detectInCode(sources, ORM_KEYWORDS, "database");
}

// ── README (§25) ───────────────────────────────────────────────────────────

const README_MAX_BYTES = 60_000;

const SECTION_ALIASES: Record<string, string[]> = {
  description: ["description", "about", "overview", "introduction", "what is", "summary"],
  setup: ["installation", "getting started", "setup", "quick start", "how to run"],
  features: ["features", "functionality", "capabilities", "key features", "what it does"],
  technologies: ["tech stack", "technologies", "built with", "stack", "tools"],
  usage: ["usage", "how to use", "examples", "example"],
};

const TECH_HINTS = [
  "react", "next.js", "nextjs", "vue", "nuxt", "angular", "svelte", "vite",
  "typescript", "javascript", "python", "django", "flask", "fastapi",
  "express", "nestjs", "spring", "laravel", "rails", "flutter", "supabase",
  "postgres", "postgresql", "mysql", "mongodb", "redis", "prisma", "tailwind",
  "openai", "tensorflow", "pytorch", "scikit-learn", "docker", "vercel", "aws",
  "node.js", "php", "java",
];

export interface ReadmeFacts {
  path: string;
  present: boolean;
  description: string;
  features: string[];
  technologies: string[];
  setup: string;
  usage: string;
  sections: string[];
}

export function parseReadme(path: string, raw: string): ReadmeFacts {
  const content = raw.length > README_MAX_BYTES ? raw.slice(0, README_MAX_BYTES) : raw;

  const headingRegex = /^(#{1,4})\s+(.+?)\s*$/gm;
  const sections = new Map<string, string>();
  const preambles: string[] = [];
  let lastIndex = 0;
  let lastTitle = "";
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(content)) !== null) {
    const body = content.slice(lastIndex, match.index);
    if (lastTitle) sections.set(lastTitle, body);
    else preambles.push(body);
    lastTitle = match[2].trim().toLowerCase();
    lastIndex = headingRegex.lastIndex;
  }
  if (lastTitle) sections.set(lastTitle, content.slice(lastIndex));

  const bodyFor = (key: keyof typeof SECTION_ALIASES): string => {
    for (const [title, body] of sections) {
      if (SECTION_ALIASES[key].some((alias) => title.includes(alias))) return body;
    }
    return "";
  };

  const firstParagraph = (body: string): string => {
    for (const block of body.split(/\n\s*\n/)) {
      const cleaned = block.trim();
      if (!cleaned || /^[#!<\[*|>-]/.test(cleaned) || cleaned.startsWith("```")) continue;
      return cleaned.slice(0, 1200);
    }
    return "";
  };

  const bullets = (body: string): string[] => {
    const items = [...body.matchAll(/^\s*[-*+]\s+(?:\[[ xX]?\]\s*)?(.+)$/gm)]
      .map((m) => m[1].trim());
    const numbered = items.length
      ? items
      : [...body.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) => m[1].trim());
    return numbered
      .filter((item) => item.length > 2 && item.length < 200)
      .slice(0, 25);
  };

  const firstCodeBlock = (body: string): string => {
    const match2 = /```[^\n]*\n([\s\S]*?)```/.exec(body);
    return match2 ? match2[1].trim().slice(0, 800) : "";
  };

  const preamble = preambles.join("\n").trim();
  const description = preamble || bodyFor("description");
  const stackSection = bodyFor("technologies");
  const haystack = `${stackSection}\n${content}`.toLowerCase();

  return {
    path,
    present: content.trim().length > 0,
    description: firstParagraph(description),
    features: bullets(bodyFor("features")).length
      ? bullets(bodyFor("features")).slice(0, 20)
      : bullets(description).slice(0, 20),
    technologies: TECH_HINTS.filter((hint) => haystack.includes(hint)).slice(0, 20),
    setup: firstCodeBlock(bodyFor("setup")),
    usage: firstCodeBlock(bodyFor("usage")),
    sections: [...sections.keys()].slice(0, 30),
  };
}

// ── Evidence registry (§26) ────────────────────────────────────────────────

export interface Evidence {
  id: string;
  type: string;
  claim: string;
  file?: string;
  symbol?: string;
  lines?: string;
  confidence: "high" | "medium" | "low";
  detail?: Record<string, unknown>;
}

export class EvidenceRegistry {
  private items: Evidence[] = [];
  private byFingerprint = new Map<string, Evidence>();

  add(input: {
    type: string;
    claim: string;
    file?: string | null;
    symbol?: string | null;
    lines?: string | null;
    confidence?: "high" | "medium" | "low";
    detail?: Record<string, unknown>;
  }): Evidence {
    // A stable fingerprint keeps ids identical for the same commit, which is
    // what makes the AI cache in §58 safe.
    const source = [input.type, input.claim, input.file ?? "", input.symbol ?? "", input.lines ?? ""].join("|");
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
    }
    const fingerprint = hash.toString(16);

    const existing = this.byFingerprint.get(fingerprint);
    if (existing) return existing;

    const evidence: Evidence = {
      id: `EV-${String(this.items.length + 1).padStart(3, "0")}`,
      type: input.type,
      claim: input.claim,
      confidence: input.confidence ?? "medium",
      ...(input.file ? { file: input.file } : {}),
      ...(input.symbol ? { symbol: input.symbol } : {}),
      ...(input.lines ? { lines: input.lines } : {}),
      ...(input.detail && Object.keys(input.detail).length
        ? { detail: input.detail }
        : {}),
    };
    this.items.push(evidence);
    this.byFingerprint.set(fingerprint, evidence);
    return evidence;
  }

  toList(): Evidence[] {
    return this.items;
  }
}

/** The trimmed form handed to a model. Detail dictionaries are the scanner's
 *  business and would only burn tokens. */
export function compactEvidence(items: Evidence[], limit?: number): unknown[] {
  const compact = items.map((item) => ({
    id: item.id,
    type: item.type,
    claim: item.claim.slice(0, 220),
    file: item.file ?? null,
    lines: item.lines ?? null,
  }));
  const filtered = compact.filter(
    (item) =>
      item.file ||
      ["repository", "readme", "framework", "dependency", "test_framework", "analysis_mode"].includes(item.type),
  );
  return limit ? filtered.slice(0, limit) : filtered;
}

// ── Project map (§27) ──────────────────────────────────────────────────────

const MAX_ROUTES = 40;
const MAX_DEPENDENCIES = 45;
const MAX_IMPORTANT_FILES = 25;
const MAX_WARNINGS = 12;
const MAX_INTEGRATIONS = 12;
const MAX_FEATURES = 15;

const IMPORTANCE_RANK: Record<string, number> = {
  high: 0, medium: 1, low: 2, ignored: 3,
};

export interface ProjectMap {
  analysis_mode: "full" | "limited";
  identity: Record<string, unknown>;
  stack: Record<string, unknown>;
  architecture: Record<string, unknown>;
  frontend: Record<string, unknown>;
  backend: Record<string, unknown>;
  database: Record<string, unknown>;
  authentication: Record<string, unknown>;
  apis: Route[];
  external_integrations: unknown[];
  features: string[];
  testing: Record<string, unknown>;
  deployment: Record<string, unknown>;
  repository_stats: Record<string, number>;
  readme: Record<string, unknown>;
  security: Record<string, unknown>;
  important_files: unknown[];
  warnings: string[];
  truncated: Record<string, number>;
}

const STATE_PACKAGES: Record<string, string> = {
  redux: "Redux", "@reduxjs/toolkit": "Redux Toolkit", zustand: "Zustand",
  jotai: "Jotai", recoil: "Recoil", mobx: "MobX", pinia: "Pinia",
  vuex: "Vuex", "@tanstack/react-query": "TanStack Query", swr: "SWR",
  "react-hook-form": "React Hook Form",
};

export function buildProjectMap(input: {
  repository: Record<string, unknown>;
  files: Record<string, any>[];
  dependencies: Dependency[];
  frameworks: Detection[];
  databases: Detection[];
  auth: Detection[];
  routes: Route[];
  symbols: Symbol[];
  integrations: unknown[];
  tests: { file_count: number; frameworks: { name: string }[]; commands: string[] };
  readme: ReadmeFacts | null;
  secrets: SecretFinding[];
  analysisMode: "full" | "limited";
  warnings: string[];
}): ProjectMap {
  const warnings = [...input.warnings];
  const { files, dependencies, routes, analysisMode } = input;

  const hiddenRoutes = Math.max(0, routes.length - MAX_ROUTES);
  const hiddenDeps = Math.max(0, dependencies.length - MAX_DEPENDENCIES);
  const hiddenIntegrations = Math.max(0, input.integrations.length - MAX_INTEGRATIONS);
  const hiddenAuth = Math.max(0, input.auth.length - 12);
  const hiddenFrameworks = Math.max(0, input.frameworks.length - 15);

  if (hiddenRoutes) {
    warnings.push(`${hiddenRoutes} further endpoints exist and were not listed here.`);
  }
  if (hiddenDeps) {
    warnings.push(`${hiddenDeps} further dependencies were not listed here.`);
  }
  if (analysisMode === "limited") {
    warnings.push("Large repository detected. Analysis was limited to relevant files.");
  }

  const shownFiles = [...files]
    .sort((a, b) => (IMPORTANCE_RANK[a.importance] ?? 4) - (IMPORTANCE_RANK[b.importance] ?? 4))
    .slice(0, MAX_IMPORTANT_FILES);
  const hiddenFiles = Math.max(0, files.length - MAX_IMPORTANT_FILES);
  if (hiddenFiles) {
    warnings.push(`${hiddenFiles} further files exist and were not listed here.`);
  }

  const languageCounts: Record<string, number> = {};
  for (const file of files) {
    const language = file.language;
    if (!language || ["JSON", "YAML", "TOML", "Markdown"].includes(language)) continue;
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }
  const languages = Object.entries(languageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const byCategory: Record<string, string[]> = {};
  for (const dependency of dependencies.slice(0, MAX_DEPENDENCIES)) {
    const category = byCategory[dependency.category] ?? [];
    category.push(dependency.package);
    byCategory[dependency.category] = category;
  }

  const packageNames = new Set(dependencies.map((d) => d.package.toLowerCase()));
  const stateManagement = Object.entries(STATE_PACKAGES)
    .filter(([key]) => packageNames.has(key))
    .map(([, label]) => label);

  const styling: string[] = [];
  for (const [pkg, label] of [
    ["tailwindcss", "Tailwind CSS"], ["@mui/material", "Material UI"],
    ["antd", "Ant Design"], ["@chakra-ui/react", "Chakra UI"],
    ["bootstrap", "Bootstrap"], ["styled-components", "styled-components"],
    ["sass", "Sass"],
  ] as const) {
    if (packageNames.has(pkg)) styling.push(label);
  }
  if (files.some((f) => /\.(css|scss)$/.test(f.path))) styling.push("plain CSS");

  const backendLanguages = [
    ...new Set(
      files
        .filter((f) => ["Python", "Go", "Java", "Ruby", "PHP", "Rust", "C#", "Kotlin"].includes(f.language))
        .map((f) => f.language as string),
    ),
  ];

  return {
    analysis_mode: analysisMode,
    identity: {
      owner: input.repository.owner,
      repo: input.repository.repo_name,
      default_branch: input.repository.default_branch,
      commit: String(input.repository.analyzed_commit_sha ?? "").slice(0, 12),
      visibility: input.repository.visibility,
      stars: input.repository.stars,
      forks: input.repository.forks,
    },
    stack: {
      primary_language: input.repository.language,
      languages: Object.fromEntries(languages),
      frameworks: input.frameworks.slice(0, 15).map((f) => f.name),
      dependencies_by_category: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, v.slice(0, 20)]),
      ),
      package_managers: [
        ...new Set(files.filter((f) => f.file_category === "dependency").map((f) => f.file_name)),
      ],
    },
    architecture: {
      layers: [
        ...new Set(
          files
            .filter((f) => ["source", "component", "api", "model", "schema", "database"].includes(f.file_category))
            .map((f) => f.file_category as string),
        ),
      ],
      has_frontend: files.some((f) => f.file_category === "component" || f.file_name === "package.json"),
      has_backend:
        files.some((f) => ["api", "source", "database"].includes(f.file_category)) &&
        backendLanguages.length > 0,
      monorepo: files.some((f) =>
        String(f.path).split("/").slice(0, -1).some((part: string) =>
          ["apps", "packages", "services", "libs", "backend", "frontend"].includes(part),
        ),
      ),
    },
    frontend: {
      components: files.filter((f) => f.file_category === "component").length,
      pages: files
        .filter((f) => /^(app|pages|src\/pages|src\/app)\//.test(f.path) && /\.(tsx|jsx|vue|svelte|ts)$/.test(f.path))
        .map((f) => f.path)
        .slice(0, MAX_IMPORTANT_FILES),
      state_management: stateManagement,
      styling,
    },
    backend: {
      languages: backendLanguages,
      endpoint_count: routes.length,
      entrypoints: files
        .filter((f) =>
          ["main.py", "app.py", "server.js", "index.js", "main.go", "manage.py"].includes(f.file_name),
        )
        .map((f) => f.path)
        .slice(0, MAX_IMPORTANT_FILES),
    },
    database: {
      technologies: input.databases.map((d) => d.name),
      schema_files: files
        .filter((f) => ["schema", "database"].includes(f.file_category))
        .map((f) => f.path)
        .slice(0, MAX_IMPORTANT_FILES),
      orm_evidence: input.databases.slice(0, 10).map((d) => d.evidence),
    },
    authentication: {
      detected: input.auth.slice(0, 12).map((a) => a.name),
      evidence: input.auth.slice(0, 10).map((a) => a.evidence),
      authorization_checks: input.auth.some((a) => a.name.includes("Authorization")),
    },
    apis: routes.slice(0, MAX_ROUTES),
    external_integrations: input.integrations.slice(0, MAX_INTEGRATIONS),
    features: (input.readme?.features ?? []).slice(0, MAX_FEATURES),
    testing: {
      test_file_count: input.tests.file_count,
      frameworks: input.tests.frameworks.map((f) => f.name),
      commands: input.tests.commands,
      has_tests: input.tests.file_count > 0,
    },
    deployment: {
      files: files.filter((f) => f.file_category === "deployment").map((f) => f.path).slice(0, MAX_IMPORTANT_FILES),
      ci: files
        .filter((f) => f.path.startsWith(".github/workflows") || f.path === ".gitlab-ci.yml")
        .map((f) => f.path)
        .slice(0, 10),
    },
    repository_stats: {
      file_count: files.length,
      total_files_seen: Number(input.repository.total_files ?? files.length),
      line_count: files.reduce((total, f) => total + (f.line_count ?? 0), 0),
      symbol_count: input.symbols.length,
      secret_findings: input.secrets.length,
    },
    readme: {
      present: Boolean(input.readme?.present),
      description: (input.readme?.description ?? "").slice(0, 600),
      technologies: (input.readme?.technologies ?? []).slice(0, MAX_FEATURES),
    },
    security: {
      hardcoded_secrets: input.secrets.slice(0, MAX_WARNINGS).map((s) => ({
        type: s.secret_type,
        file: s.file,
        line: s.line,
      })),
      secret_file_present: files.some((f) => String(f.file_name ?? "").startsWith(".env")),
    },
    important_files: shownFiles.map((f) => ({
      path: f.path,
      category: f.file_category,
      importance: f.importance,
      lines: f.line_count,
    })),
    warnings: warnings.slice(0, MAX_WARNINGS),
    truncated: {
      routes: hiddenRoutes,
      dependencies: hiddenDeps,
      files: hiddenFiles,
      integrations: hiddenIntegrations,
      auth: hiddenAuth,
      frameworks: hiddenFrameworks,
    },
  };
}
