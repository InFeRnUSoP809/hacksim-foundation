/**
 * Semantic analysis: what the code actually does.
 *
 * Technology detection answers "which libraries are present". That is a
 * description, and it is not evidence of anything. A project can import a
 * forecasting library and never call it; a project can implement forecasting
 * with three lines of arithmetic and no library at all.
 *
 * This module looks for the other thing — behaviour. A calculation, a
 * comparison against a threshold, a model being fitted or called, a file being
 * read, a form being submitted, a branch that decides something. Those are the
 * things a reviewer can be shown, and they are language-agnostic by design: the
 * same three extractors run over Python, JavaScript, TypeScript, Java, Go,
 * Ruby, PHP, C#, SQL and plain HTML, because a hackathon submission may be any
 * of them and a single-file HTML page is a perfectly valid answer to some
 * briefs.
 *
 * Everything is deterministic. Nothing here decides whether a requirement is
 * met; it produces the raw material the retrieval engine and the model need.
 */

export type SemanticKind =
  | "calculation"
  | "rule"
  | "model"
  | "data_access"
  | "ui"
  | "import";

export interface SemanticFinding {
  kind: SemanticKind;
  /** A factual, checkable sentence. Never a judgement. */
  claim: string;
  symbol: string | null;
  line: number;
  lines: string;
  /** The matched line, trimmed. Enough to verify the claim by eye. */
  excerpt: string;
  /** The kind of operation, e.g. "arithmetic", "threshold", "aggregation". */
  operation: string;
  identifiers: string[];
}

export interface SemanticsResult {
  path: string;
  language: string | null;
  calculations: SemanticFinding[];
  rules: SemanticFinding[];
  models: SemanticFinding[];
  dataAccess: SemanticFinding[];
  ui: SemanticFinding[];
  imports: string[];
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".py": "Python",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".swift": "Swift",
  ".dart": "Dart",
  ".html": "HTML",
  ".htm": "HTML",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".sql": "SQL",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".md": "Markdown",
  ".sh": "Shell",
  ".css": "CSS",
};

export function languageOfPath(path: string): string | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return LANGUAGE_BY_EXT[lower.slice(dot)] ?? null;
}

const MAX_PER_KIND = 14;
const MAX_EXCERPT = 220;

/**
 * Languages whose files contain behaviour. A requirements file, a JSON manifest
 * and a README are text, and running an arithmetic detector over
 * "scikit-learn==1.5.0" happily matches the hyphen in a package name and calls
 * it a calculation. Only code is scanned for behaviour.
 */
const CODE_LANGUAGES = new Set([
  "Python", "TypeScript", "JavaScript", "Go", "Java", "Kotlin", "Ruby", "Rust",
  "PHP", "C", "C++", "C#", "Swift", "Dart", "HTML", "Vue", "Svelte", "SQL",
  "Shell", "PowerShell",
]);

export function isCodeLanguage(language: string | null): boolean {
  return language !== null && CODE_LANGUAGES.has(language);
}

/** Lines that are comments or blank are never behaviour. */
function isCode(line: string, language: string | null): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (language === "Python" && trimmed.startsWith("#")) return false;
  if (language === "SQL" && trimmed.startsWith("--")) return false;
  if (language === "Shell" && trimmed.startsWith("#")) return false;
  if (language && ["JavaScript", "TypeScript", "Java", "Go", "Rust", "C", "C++", "C#", "PHP", "Swift", "Dart", "Kotlin", "CSS", "Vue", "Svelte"].includes(language)) {
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      return false;
    }
  }
  return true;
}

function excerptOf(line: string): string {
  const text = line.trim().replace(/\s+/g, " ");
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
}

function identifiersIn(text: string): string[] {
  const found = text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const stop = new Set([
    "def", "class", "return", "import", "from", "const", "let", "var", "function",
    "if", "else", "elif", "for", "while", "try", "except", "catch", "self", "this",
    "true", "false", "None", "null", "async", "await", "export", "default", "new",
    "print", "str", "int", "float", "len", "range", "list", "dict", "set", "type",
    "public", "private", "static", "void", "string", "number", "boolean", "value",
    "data", "result", "results", "item", "items", "self", "super",
  ]);
  const unique = new Set<string>();
  for (const name of found) {
    if (stop.has(name.toLowerCase())) continue;
    if (name.length < 3) continue;
    unique.add(name);
    if (unique.size >= 6) break;
  }
  return [...unique];
}

function operandList(identifiers: string[]): string {
  if (identifiers.length === 0) return "computed values";
  if (identifiers.length === 1) return identifiers[0];
  if (identifiers.length === 2) return `${identifiers[0]} and ${identifiers[1]}`;
  return `${identifiers.slice(0, 3).join(", ")} and others`;
}

interface SymbolLine {
  name: string;
  line: number;
  symbol_type: string;
}

function enclosingSymbol(symbols: SymbolLine[], line: number): string | null {
  let best: string | null = null;
  let bestLine = -1;
  for (const symbol of symbols) {
    if (symbol.line <= line && symbol.line > bestLine) {
      best = symbol.name;
      bestLine = symbol.line;
    }
  }
  return best;
}

// ── Calculations ───────────────────────────────────────────────────────────

interface OperationPattern {
  operation: string;
  re: RegExp;
  describe: (operands: string, symbol: string | null) => string;
}

const CALCULATION_PATTERNS: OperationPattern[] = [
  {
    operation: "aggregation",
    re: /\b(sum|mean|median|avg|average|aggregate|count|total)\s*\(|\.(sum|mean|median|min|max)\s*\(|reduce\s*\(|groupby|group_by|rollup|pivot_table/i,
    describe: (operands, symbol) =>
      `aggregates ${operands} into a single value` +
      (symbol ? ` inside \`${symbol}\`` : ""),
  },
  {
    operation: "statistic",
    re: /\b(std|stddev|variance|percentile|quantile|correlation|covariance|linregress|polyfit|zscore|normaliz|minmaxscaler|standardscaler)\s*\(|\bnp\.(mean|std|percentile|corr|polyfit|interp)|scipy\./i,
    describe: (operands, symbol) =>
      `computes a statistical measure over ${operands}` +
      (symbol ? ` inside \`${symbol}\`` : ""),
  },
  {
    operation: "date_math",
    re: /\b(timedelta|date_add|date_sub|addDays|addMonths|add_years|strftime|strptime|toDate|getTime|getDate|setDate|Date\.now|new Date)\b|\bdate\s*[+\-]|\+\s*timedelta/i,
    describe: (operands, symbol) =>
      `performs date arithmetic on ${operands}` +
      (symbol ? ` inside \`${symbol}\`` : ""),
  },
  {
    operation: "formula",
    re: /[A-Za-z0-9_)\]]\s*[*\/]\s*[A-Za-z0-9_(]|Math\.(round|floor|ceil|min|max|pow|sqrt|abs)|\b(round|floor|ceil|abs|sqrt|pow)\s*\(/,
    describe: (operands, symbol) =>
      `multiplies, divides or scales ${operands}` +
      (symbol ? ` inside \`${symbol}\`` : ""),
  },
  {
    operation: "arithmetic",
    re: /[A-Za-z0-9_)\]]\s*[+\-]\s*[A-Za-z0-9_(]|\b(int|float)\s*\(|\*\s*\d|\+\s*\d/,
    describe: (operands, symbol) =>
      `adds to or subtracts from ${operands}` +
      (symbol ? ` inside \`${symbol}\`` : ""),
  },
];

export function extractCalculations(
  path: string,
  content: string,
  symbols: SymbolLine[],
): SemanticFinding[] {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out: SemanticFinding[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    for (const pattern of CALCULATION_PATTERNS) {
      if (!pattern.re.test(line)) continue;
      const lineNumber = index + 1;
      const symbol = enclosingSymbol(symbols, lineNumber);
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${symbol ?? lineNumber}:${identifiers[0] ?? ""}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "calculation",
        claim: `\`${path}\` ${pattern.describe(operandList(identifiers), symbol)}.`,
        symbol,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers,
      });
      break;
    }
  });

  return out;
}

// ── Decision rules ─────────────────────────────────────────────────────────

const RULE_PATTERNS: RegExp[] = [
  /\bif\b[^{]*[<>]=?|[<>]=?\s*\d/, // if x < 10
  /\bif\b\s*\(?\s*!|not\s+\w+/, // if not x
  /\?.*:/, // ternary
  /\bswitch\b|\bmatch\s+\w+\s*\{/,
  /\belsif\b|\belif\b/,
  /\bmatch\s*\(/,
];

export function extractRules(
  path: string,
  content: string,
  symbols: SymbolLine[],
): SemanticFinding[] {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out: SemanticFinding[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    if (!RULE_PATTERNS.some((re) => re.test(line))) return;
    // A bare `if` with no comparison is a branch, not a rule.
    if (!/[<>!=]|\bnot\b|\?|true|false/.test(line)) return;

    const lineNumber = index + 1;
    const symbol = enclosingSymbol(symbols, lineNumber);
    const identifiers = identifiersIn(line);
    const hasLiteral = /\d/.test(line);
    const key = `${symbol ?? lineNumber}:${identifiers[0] ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: "rule",
      claim:
        `\`${path}\` branches on a condition involving ${operandList(identifiers)}` +
        (hasLiteral ? `, compared against a literal value` : ``) +
        (symbol ? ` inside \`${symbol}\`` : ``) + `.`,
      symbol,
      line: lineNumber,
      lines: String(lineNumber),
      excerpt: excerptOf(line),
      operation: hasLiteral ? "threshold" : "branch",
      identifiers,
    });
  });

  return out;
}

// ── Models ─────────────────────────────────────────────────────────────────

const MODEL_USAGE: { re: RegExp; operation: string; describe: string }[] = [
  {
    re: /\.(fit|train|partial_fit)\s*\(/,
    operation: "training",
    describe: "trains a model in code",
  },
  {
    re: /\.(predict|predict_proba|transform|decision_function|forward|generate)\s*\(/,
    operation: "inference",
    describe: "runs a model or transform to produce a result",
  },
  {
    re: /\b(LinearRegression|LogisticRegression|RandomForest|GradientBoost|DecisionTree|SVC|KMeans|Ridge|Lasso|ARIMA|ETS|ExponentialSmoothing|Prophet|IsolationForest|GradientBoostingRegressor|RandomForestRegressor|torch|nn\.|tf\.|keras|xgboost|lightgbm)\b/,
    operation: "model_type",
    describe: "names a predictive or statistical model",
  },
  {
    re: /\b(joblib|pickle|torch\.load|load_model|np\.load|model\.pt|model\.pkl|onnx|load_weights|from_pretrained)\b/,
    operation: "model_artifact",
    describe: "loads a trained model artefact",
  },
  {
    re: /\b(moving_average|movingaverage|expanding\(|rolling\(|ewm\(|seasonal_decompose|adf\(|auto_arima|trend|forecast)\s*\(|\.forecast\s*\(/,
    operation: "statistical_forecast",
    describe: "computes a moving average, rolling window or time-series forecast",
  },
  {
    re: /\b(StandardScaler|MinMaxScaler|normalize|tokenize|embed|embedding|cosine_similarity|similarity)\b/i,
    operation: "representation",
    describe: "transforms values into a normalised or vector representation",
  },
];

export function extractModels(path: string, content: string): SemanticFinding[] {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out: SemanticFinding[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    for (const pattern of MODEL_USAGE) {
      if (!pattern.re.test(line)) continue;
      const lineNumber = index + 1;
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${identifiers[0] ?? lineNumber}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "model",
        claim: `\`${path}\` ${pattern.describe} (line ${lineNumber}${
          identifiers[0] ? `, near \`${identifiers[0]}\`` : ""
        }).`,
        symbol: null,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers,
      });
      break;
    }
  });

  return out;
}

// ── Data access ────────────────────────────────────────────────────────────

const DATA_ACCESS: { re: RegExp; operation: string; describe: string }[] = [
  {
    re: /pd\.read_csv|pd\.read_json|pd\.read_excel|pd\.read_sql|csv\.(reader|DictReader|reader)|read_csv|load_csv|open\s*\(\s*['"`][^'"`]*\.(csv|json|jsonl|txt|parquet|xlsx|tsv)/i,
    operation: "file_ingest",
    describe: "reads a data file from disk",
  },
  {
    re: /fetch\s*\(|axios\.|requests\.(get|post|put|patch|delete)|httpx\.|urlopen|XMLHttpRequest|supabase\.|firebase\./,
    operation: "network_call",
    describe: "calls an external service or API",
  },
  {
    re: /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[\s\S]{0,80}\b(FROM|INTO|SET|WHERE)\b/i,
    operation: "sql",
    describe: "executes a database query",
  },
  {
    re: /\.(query|execute|executemany|find|findOne|find_many|insert|update|delete|upsert|save|create)\s*\(|\.collection\s*\(|\.table\s*\(/,
    operation: "orm",
    describe: "reads or writes records through a data-access layer",
  },
  {
    re: /localStorage|sessionStorage|indexedDB|FileReader|readAsText|readAsDataURL|\.read\(\)/,
    operation: "client_state",
    describe: "reads data held in the client or uploaded by the user",
  },
  {
    re: /glob\s*\(|listdir|walk\s*\(|readdir|fs\.|open\s*\(\s*['"`][^'"`]*\.(csv|json|jsonl|parquet)/i,
    operation: "file_scan",
    describe: "scans the filesystem for input data",
  },
  {
    re: /write\s*\(|to_csv|to_json|writerow|json\.dump|FileWriter|createWriteStream/i,
    operation: "file_write",
    describe: "writes data out to a file",
  },
];

export function extractDataAccess(
  path: string,
  content: string,
  symbols: SymbolLine[],
): SemanticFinding[] {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out: SemanticFinding[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    for (const pattern of DATA_ACCESS) {
      if (!pattern.re.test(line)) continue;
      const lineNumber = index + 1;
      const symbol = enclosingSymbol(symbols, lineNumber);
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${identifiers[0] ?? lineNumber}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "data_access",
        claim: `\`${path}\` ${pattern.describe}` +
          (symbol ? ` inside \`${symbol}\`` : "") +
          (identifiers[0] ? `, near \`${identifiers[0]}\`` : "") + `.`,
        symbol,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers,
      });
      break;
    }
  });

  return out;
}

// ── Interface ──────────────────────────────────────────────────────────────

const UI_PATTERNS: { re: RegExp; operation: string; describe: string }[] = [
  {
    re: /<form[\s>]|onsubmit|addEventListener\s*\(\s*['"`]submit|onclick\s*=|addEventListener\s*\(\s*['"`]click/,
    operation: "form_submit",
    describe: "captures a user action through a form or click handler",
  },
  {
    re: /<table|<thead|tbody|DataTable|\.map\s*\(\s*\(?\s*\w+\s*\)?\s*=>[\s\S]{0,40}<tr|createElement\s*\(\s*['"`]tr/,
    operation: "data_table",
    describe: "renders rows of data as a table or list",
  },
  {
    re: /<canvas|chart|Chart\s*\(|plotly|d3\.|plot\s*\(|sparkline|svg/i,
    operation: "chart",
    describe: "renders a chart or visual plot of data",
  },
  {
    re: /<input|<select|<textarea|useState|setState|v-model|ng-model/,
    operation: "input_control",
    describe: "provides an input control the user can change",
  },
  {
    re: /<button|type=["']submit["']|onClick|@click|addEventListener/,
    operation: "button",
    describe: "offers a control the user can activate",
  },
  {
    re: /<h1|<h2|<h3|class=["'][^"']*(card|panel|grid|table|stat|kpi|dashboard)|innerHTML|textContent\s*=|dangerouslySetInnerHTML/,
    operation: "display",
    describe: "displays content to the user",
  },
];

export function extractUi(
  path: string,
  content: string,
  symbols: SymbolLine[],
): SemanticFinding[] {
  const language = languageOfPath(path);
  const lines = content.split("\n");
  const out: SemanticFinding[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    for (const pattern of UI_PATTERNS) {
      if (!pattern.re.test(line)) continue;
      // Markup counts as interface; everything else must be live code, so a
      // commented-out button does not become evidence of one.
      if (language !== "HTML" && !isCode(line, language)) continue;
      const lineNumber = index + 1;
      const symbol = enclosingSymbol(symbols, lineNumber);
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${identifiers[0] ?? lineNumber}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "ui",
        claim: `\`${path}\` ${pattern.describe}` +
          (identifiers[0] ? ` (near \`${identifiers[0]}\`)` : "") + `.`,
        symbol,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers,
      });
      break;
    }
  });

  return out;
}

// ── Imports ────────────────────────────────────────────────────────────────

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/gm,
  /^\s*from\s+([\w.]+)\s+import\s+/gm,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  /^\s*use\s+([\w:]+)\s*;/gm,
  /^\s*#include\s*[<"]([^>"]+)[>"]/gm,
  /^\s*import\s+([\w.]+)\s*$/gm,
];

/** Module specifiers only. Nothing is imported from here; this is descriptive. */
export function extractImports(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1]?.trim();
      if (value) found.add(value);
      if (found.size > 60) break;
    }
  }
  return [...found].slice(0, 60);
}

// ── One call ───────────────────────────────────────────────────────────────

export function analyseSemantics(
  path: string,
  content: string,
  symbols: SymbolLine[],
): SemanticsResult {
  return {
    path,
    language: languageOfPath(path),
    calculations: extractCalculations(path, content, symbols),
    rules: extractRules(path, content, symbols),
    models: extractModels(path, content),
    dataAccess: extractDataAccess(path, content, symbols),
    ui: extractUi(path, content, symbols),
    imports: extractImports(content),
  };
}

/** A compact, model-facing summary of everything semantic in one file. */
export function compactSemantics(
  result: SemanticsResult,
  limit = 10,
): Record<string, unknown> {
  const take = (items: SemanticFinding[]) =>
    items.slice(0, limit).map((item) => ({
      claim: item.claim,
      operation: item.operation,
      line: item.line,
      excerpt: item.excerpt,
    }));
  return {
    path: result.path,
    language: result.language,
    calculations: take(result.calculations),
    decision_rules: take(result.rules),
    model_usage: take(result.models),
    data_access: take(result.dataAccess),
    interface: take(result.ui),
  };
}
