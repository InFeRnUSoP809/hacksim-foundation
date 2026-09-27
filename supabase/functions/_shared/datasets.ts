/**
 * Dataset analysis.
 *
 * A CSV in a hackathon repository is evidence, and ignoring it is how a data
 * requirement gets answered "not_evidenced" while a 1.6 MB file sits in the
 * repo. But a dataset is also the one thing that can blow a prompt to six
 * figures, so it is profiled deterministically and reduced to a description
 * plus a handful of sample rows before anything reaches a model.
 *
 * The profile answers the questions a reviewer actually has:
 *
 *   • what is in it, and how much of it is there
 *   • which columns carry dates, quantities, stock levels, prices, suppliers
 *   • whether it looks like the history the brief is about
 *   • whether the code actually reads it
 *
 * Nothing here looks at a technology, and nothing here decides whether a
 * requirement is met. It describes; the model and the human-facing evidence
 * interpret.
 */

import { termsOf, stem, type ConceptSet } from "./concepts.ts";

/** The most of a dataset that is ever read into memory. */
const MAX_PROFILE_BYTES = 2_000_000;
/** How many lines are used to infer types and cardinality. */
const SAMPLE_LINES = 200;
/** How many sample rows reach a model prompt. */
const MAX_SAMPLE_ROWS = 4;
const MAX_CELL_CHARS = 40;

export type DatasetFormat = "csv" | "tsv" | "json" | "jsonl" | "text";

export type ColumnRole =
  | "date"
  | "identifier"
  | "entity"
  | "quantity"
  | "stock"
  | "price"
  | "supplier"
  | "category"
  | "numeric"
  | "text"
  | "boolean";

export interface DatasetColumn {
  name: string;
  inferred_type: "number" | "date" | "boolean" | "text";
  role: ColumnRole;
  /** Distinct values seen in the sample, capped. */
  approx_distinct: number;
  nullable: boolean;
  sample: string[];
}

export interface DatasetProfile {
  path: string;
  format: DatasetFormat;
  size_bytes: number;
  approx_row_count: number;
  row_count_exact: boolean;
  columns: DatasetColumn[];
  column_names: string[];
  date_columns: string[];
  entity_columns: string[];
  quantity_columns: string[];
  stock_columns: string[];
  price_columns: string[];
  supplier_columns: string[];
  identifier_columns: string[];
  numeric_columns: string[];
  categorical_columns: string[];
  sample_rows: string[][];
  likely_purpose: string;
  /** Whether the column names and filename speak the brief's vocabulary. */
  relevance: "high" | "medium" | "low" | "none";
  relevance_terms: string[];
  notes: string[];
}

export interface DatasetInput {
  path: string;
  content: string;
  sizeBytes: number;
}

/**
 * Re-score a stored profile against the hackathon actually being judged.
 *
 * The scanner cannot know the brief, so it records neutral facts. Relevance is a
 * question about *this* challenge, and it is answered here, in Phase 6, where
 * the brief is finally in hand.
 */
export function rescoreRelevance(
  profile: DatasetProfile,
  concepts: ConceptSet[],
): DatasetProfile {
  const { level, terms } = relevanceOf(profile.path, profile.column_names, concepts);
  return { ...profile, relevance: level, relevance_terms: terms };
}

const EXTENSION_FORMATS: Record<string, DatasetFormat> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".json": "json",
  ".txt": "text",
  ".dat": "text",
};

const MAX_DATASET_BYTES = 20 * 1024 * 1024;

export function datasetFormatOf(path: string): DatasetFormat | null {
  const lower = path.toLowerCase();
  for (const [extension, format] of Object.entries(EXTENSION_FORMATS)) {
    if (lower.endsWith(extension)) return format;
  }
  return null;
}

// ── Column role vocabulary ────────────────────────────────────────────────
// Generic data vocabulary. A column called "medicine_id" is an identifier and
// an entity; nothing in this table knows what a medicine is.

const ROLE_TERMS: Record<ColumnRole, string[]> = {
  date: [
    "date", "day", "month", "year", "week", "time", "timestamp", "datetime",
    "period", "expiry", "expires", "expiration", "created", "updated", "due",
    "issued", "received", "recorded", "birth", "start", "end", "valid_from",
    "valid_to", "age", "horizon",
  ],
  identifier: [
    "id", "uuid", "guid", "pk", "key", "code", "ref", "reference", "sku",
    "isbn", "serial", "number", "no", "hash", "token",
  ],
  entity: [
    "product", "item", "items", "medicine", "medicines", "drug", "drugs",
    "medication", "patient", "customer", "user", "account", "company", "org",
    "organisation", "organization", "supplier_item", "article", "article_id",
    "name", "title", "label", "category_name", "vehicle", "asset", "device",
    "sensor", "course", "student", "room", "booking", "ticket", "asset_id",
  ],
  quantity: [
    "quantity", "qty", "amount", "count", "units", "unit", "packs", "volume",
    "sold", "purchased", "ordered", "consumed", "issued", "delivered",
    "dispensed", "received", "net", "gross", "total", "sum", "n",
  ],
  stock: [
    "stock", "stocklevel", "stock_level", "inventory", "onhand", "on_hand",
    "balance", "available", "remaining", "reserved", "in_stock", "capacity",
    "min_stock", "max_stock", "reorder", "reorder_level", "safety",
  ],
  price: [
    "price", "cost", "revenue", "spend", "spent", "budget", "fee", "charge",
    "rate", "value", "total_price", "unit_price", "mrp", "sell", "buying",
  ],
  supplier: [
    "supplier", "vendor", "distributor", "manufacturer", "provider", "seller",
    "wholesaler", "source", "agency", "pharmacy", "store", "branch", "warehouse",
  ],
  category: [
    "category", "type", "kind", "class", "group", "segment", "status", "state",
    "tag", "label", "level", "tier", "priority", "region", "zone", "location",
    "city", "country", "department",
  ],
  numeric: ["value", "score", "rate", "ratio", "index", "metric", "weight"],
  text: ["name", "description", "notes", "note", "comment", "text", "title",
    "reason", "detail", "details", "summary", "address", "email", "phone",
    "message", "body", "content"],
  boolean: ["active", "enabled", "disabled", "deleted", "archived", "flag",
    "valid", "verified", "available", "expired", "is_"],
};

const BOOLEAN_VALUES = new Set(["true", "false", "yes", "no", "0", "1", "y", "n"]);
const DATE_RE =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;

function looksNumeric(value: string): boolean {
  return /^-?[\d,]*\.?\d+([eE][-+]?\d+)?%?$/.test(value.trim()) &&
    /\d/.test(value);
}

function looksDate(value: string): boolean {
  const text = value.trim();
  if (DATE_RE.test(text)) return true;
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(text)) return true;
  if (/^\d{4}-\d{2}$/.test(text)) return true;
  const monthNames = "jan feb mar apr may jun jul aug sep oct nov dec";
  const lower = text.toLowerCase();
  return lower.length >= 6 && monthNames.split(" ").some((m) => lower.startsWith(m));
}

function roleFor(name: string, numeric: boolean, date: boolean): ColumnRole {
  const tokens = new Set<string>();
  for (const token of termsOf(name)) {
    tokens.add(token);
    tokens.add(stem(token));
  }
  const joined = name.toLowerCase();

  // A name that is *only* an identifier is an identifier even when it also
  // names an entity, which is why "medicine_id" is checked first.
  if (tokens.has("id") || /(?:^|_)id$/.test(joined) || tokens.has("uuid")) {
    return "identifier";
  }
  if (date) return "date";
  for (const [role, words] of Object.entries(ROLE_TERMS) as [ColumnRole, string[]][]) {
    if (words.some((word) => tokens.has(word) || tokens.has(stem(word)))) return role;
  }
  if (numeric) return "numeric";
  return "text";
}

function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function sniffDelimiter(sample: string): string {
  const firstLine = sample.split("\n", 1)[0] ?? "";
  const counts: Record<string, number> = {
    ",": (firstLine.match(/,/g) ?? []).length,
    "\t": (firstLine.match(/\t/g) ?? []).length,
    ";": (firstLine.match(/;/g) ?? []).length,
    "|": (firstLine.match(/\|/g) ?? []).length,
  };
  let best = ",";
  let bestCount = 0;
  for (const [delimiter, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function truncateCell(value: string): string {
  const text = String(value ?? "").trim();
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

/**
 * Profile one dataset.
 *
 * `concepts` are the requirement concept sets for the hackathon being analysed.
 * They are used for *relevance* only — to say "this file looks like the history
 * the brief is about" — never to decide that a requirement is satisfied.
 */
export function profileDataset(
  input: DatasetInput,
  concepts: ConceptSet[] = [],
): DatasetProfile | null {
  const format = datasetFormatOf(input.path);
  if (!format) return null;

  const notes: string[] = [];
  if (input.sizeBytes > MAX_DATASET_BYTES) {
    notes.push("File exceeds the dataset size limit and was not profiled.");
    return null;
  }

  // The scanner hands over only the head of a large file, so "exact" has to be
  // decided by what actually arrived rather than by the file's size alone: a
  // 1.6 MB CSV read as a 512 KB head is an estimate even though it is under the
  // profiling ceiling.
  const truncatedForProfiling =
    input.sizeBytes > MAX_PROFILE_BYTES || input.content.length < input.sizeBytes * 0.95;
  const content = truncatedForProfiling
    ? input.content.slice(0, MAX_PROFILE_BYTES)
    : input.content;

  let columns: DatasetColumn[] = [];
  let sampleRows: string[][] = [];
  let dataLines = 0;
  let approxRowCount = 0;
  let rowCountExact = false;

  if (format === "csv" || format === "tsv" || format === "text") {
    const delimiter = format === "tsv" ? "\t" : sniffDelimiter(content);
    const lines = content.split("\n");
    const nonEmpty: string[] = [];
    for (const line of lines) {
      if (line.trim()) nonEmpty.push(line);
    }
    if (nonEmpty.length === 0) return null;

    const header = splitDelimited(nonEmpty[0], delimiter);
    // A header of one cell means the delimiter was wrong for this file, so the
    // whole file is re-read with the delimiter the other lines agree on.
    if (header.length === 1 && nonEmpty.length > 1) {
      const retry = sniffDelimiter(nonEmpty.slice(0, 5).join("\n"));
      return retry === delimiter ? null : withDelimiter(input, concepts, retry);
    }
    columns = header.map((name) => buildColumn(name, []));
    const body = nonEmpty.slice(1, 1 + SAMPLE_LINES);
    for (const line of body) {
      const cells = splitDelimited(line, delimiter);
      sampleRows.push(cells);
    }
    columns = columns.map((column, index) =>
      buildColumn(
        column.name,
        sampleRows.map((row) => row[index] ?? ""),
      ),
    );

    dataLines = Math.max(0, nonEmpty.length - 1);
    if (truncatedForProfiling) {
      const bytesPerLine = content.length / Math.max(1, nonEmpty.length);
      approxRowCount = Math.round(
        (input.sizeBytes / Math.max(1, bytesPerLine)) - 1,
      );
      notes.push(
        `Profiled the first ${Math.round(MAX_PROFILE_BYTES / 1024)} KB of a ` +
          `${Math.round(input.sizeBytes / 1024)} KB file; the row count is an estimate.`,
      );
    } else {
      approxRowCount = dataLines;
      rowCountExact = true;
    }
  } else {
    const parsed = profileJsonLike(content, format);
    if (!parsed) return null;
    columns = parsed.columns;
    sampleRows = parsed.rows;
    approxRowCount = parsed.approxRowCount;
    rowCountExact = parsed.rowCountExact;
  }

  if (columns.length === 0) return null;

  const columnNames = columns.map((column) => column.name);
  const byRole = (role: ColumnRole) =>
    columns.filter((column) => column.role === role).map((column) => column.name);

  const { level, terms } = relevanceOf(input.path, columnNames, concepts);
  if (level === "none" && format === "text") return null;

  return {
    path: input.path,
    format,
    size_bytes: input.sizeBytes,
    approx_row_count: approxRowCount,
    row_count_exact: rowCountExact,
    columns,
    column_names: columnNames,
    date_columns: byRole("date"),
    entity_columns: byRole("entity"),
    quantity_columns: byRole("quantity"),
    stock_columns: byRole("stock"),
    price_columns: byRole("price"),
    supplier_columns: byRole("supplier"),
    identifier_columns: byRole("identifier"),
    numeric_columns: columns
      .filter((column) => column.inferred_type === "number")
      .map((column) => column.name),
    categorical_columns: columns
      .filter((column) => column.inferred_type === "text")
      .map((column) => column.name)
      .slice(0, 12),
    sample_rows: sampleRows.slice(0, MAX_SAMPLE_ROWS).map((row) =>
      row.map(truncateCell),
    ),
    likely_purpose: purposeOf(input.path, columns),
    relevance: level,
    relevance_terms: terms,
    notes,
  };
}

function withDelimiter(
  input: DatasetInput,
  concepts: ConceptSet[],
  delimiter: string,
): DatasetProfile | null {
  // Re-run with an explicit delimiter by temporarily treating the file as TSV.
  const lines = input.content.split("\n");
  if (lines.length === 0) return null;
  const header = splitDelimited(lines[0], delimiter);
  if (header.length === 1) return null;
  const sampleRows = lines
    .slice(1, 1 + SAMPLE_LINES)
    .filter((line) => line.trim())
    .map((line) => splitDelimited(line, delimiter));
  const columns = header.map((name, index) =>
    buildColumn(name, sampleRows.map((row) => row[index] ?? "")),
  );
  const dataLines = lines.filter((line) => line.trim()).length - 1;
  const columnNames = columns.map((column) => column.name);
  const { level, terms } = relevanceOf(input.path, columnNames, concepts);
  const byRole = (role: ColumnRole) =>
    columns.filter((column) => column.role === role).map((column) => column.name);

  return {
    path: input.path,
    format: "csv",
    size_bytes: input.sizeBytes,
    approx_row_count: Math.max(0, dataLines),
    row_count_exact: input.sizeBytes <= MAX_PROFILE_BYTES,
    columns,
    column_names: columnNames,
    date_columns: byRole("date"),
    entity_columns: byRole("entity"),
    quantity_columns: byRole("quantity"),
    stock_columns: byRole("stock"),
    price_columns: byRole("price"),
    supplier_columns: byRole("supplier"),
    identifier_columns: byRole("identifier"),
    numeric_columns: columns
      .filter((column) => column.inferred_type === "number")
      .map((column) => column.name),
    categorical_columns: columns
      .filter((column) => column.inferred_type === "text")
      .map((column) => column.name)
      .slice(0, 12),
    sample_rows: sampleRows.slice(0, MAX_SAMPLE_ROWS).map((row) =>
      row.map(truncateCell),
    ),
    likely_purpose: purposeOf(input.path, columns),
    relevance: level,
    relevance_terms: terms,
    notes: [`Delimiter inferred as "${delimiter === "\t" ? "\\t" : delimiter}".`],
  };
}

function buildColumn(name: string, values: string[]): DatasetColumn {
  const present = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  const nonEmpty = present.length;
  const numericCount = present.filter(looksNumeric).length;
  const dateCount = present.filter(looksDate).length;
  const boolCount = present.filter((value) =>
    BOOLEAN_VALUES.has(value.toLowerCase()),
  ).length;

  let inferredType: DatasetColumn["inferred_type"] = "text";
  if (nonEmpty > 0) {
    if (dateCount / nonEmpty >= 0.7) inferredType = "date";
    else if (numericCount / nonEmpty >= 0.8) inferredType = "number";
    else if (boolCount / nonEmpty >= 0.9) inferredType = "boolean";
  }

  const distinct = new Set(present.slice(0, SAMPLE_LINES));
  return {
    name: truncateCell(name) || "(unnamed)",
    inferred_type: inferredType,
    role: roleFor(name, inferredType === "number", inferredType === "date"),
    approx_distinct: distinct.size,
    nullable: nonEmpty < values.length,
    sample: [...distinct].slice(0, 3).map(truncateCell),
  };
}

function profileJsonLike(
  content: string,
  format: DatasetFormat,
): {
  columns: DatasetColumn[];
  rows: string[][];
  approxRowCount: number;
  rowCountExact: boolean;
} | null {
  if (format === "jsonl") {
    const lines = content.split("\n").filter((line) => line.trim());
    if (!lines.length) return null;
    const objects: Record<string, unknown>[] = [];
    for (const line of lines.slice(0, SAMPLE_LINES)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          objects.push(parsed as Record<string, unknown>);
        }
      } catch {
        // A malformed line is data, not an error worth failing on.
      }
    }
    if (!objects.length) return null;
    const names = new Set<string>();
    for (const object of objects) for (const key of Object.keys(object)) names.add(key);
    const keys = [...names].slice(0, 40);
    const rows = objects.map((object) => keys.map((key) => stringify(object[key])));
    return {
      columns: keys.map((key) =>
        buildColumn(key, objects.map((object) => stringify(object[key]))),
      ),
      rows,
      approxRowCount: lines.length,
      rowCountExact: content.length < MAX_PROFILE_BYTES,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const array = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.items)
    ? ((parsed as Record<string, unknown>).items as unknown[])
    : Array.isArray((parsed as Record<string, unknown>)?.data)
    ? ((parsed as Record<string, unknown>).data as unknown[])
    : null;
  if (!array) return null;

  const objects = array
    .slice(0, SAMPLE_LINES)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
  if (!objects.length) return null;
  const names = new Set<string>();
  for (const object of objects) for (const key of Object.keys(object)) names.add(key);
  const keys = [...names].slice(0, 40);
  return {
    columns: keys.map((key) =>
      buildColumn(key, objects.map((object) => stringify(object[key]))),
    ),
    rows: objects.map((object) => keys.map((key) => stringify(object[key]))),
    approxRowCount: array.length,
    rowCountExact: true,
  };
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value).slice(0, MAX_CELL_CHARS);
  return String(value);
}

function relevanceOf(
  path: string,
  columnNames: string[],
  concepts: ConceptSet[],
): { level: DatasetProfile["relevance"]; terms: string[] } {
  if (concepts.length === 0) return { level: "low", terms: [] };

  const haystack = new Set<string>();
  for (const token of [...termsOf(path), ...columnNames.flatMap(termsOf)]) {
    haystack.add(token);
    haystack.add(stem(token));
  }

  const matched = new Set<string>();
  let strong = 0;
  for (const concept of concepts) {
    for (const term of [...concept.domainTerms, ...concept.subjects, ...concept.actions]) {
      if (haystack.has(term) || haystack.has(stem(term))) {
        matched.add(term);
        if (concept.subjects.includes(term) || concept.domainTerms.includes(term)) {
          strong += 1;
        }
      }
    }
  }

  if (matched.size === 0) return { level: "none", terms: [] };
  if (strong >= 2 || matched.size >= 4) return { level: "high", terms: [...matched] };
  if (strong === 1 || matched.size >= 2) return { level: "medium", terms: [...matched] };
  return { level: "low", terms: [...matched] };
}

const PURPOSE_PATTERNS: { re: RegExp; purpose: string }[] = [
  { re: /sales|transaction|purchase|order|invoice|receipt/i, purpose: "transactional history" },
  { re: /stock|inventory|onhand|balance|warehouse/i, purpose: "stock or inventory state" },
  { re: /forecast|prediction|demand|projection/i, purpose: "precomputed forecast output" },
  { re: /model|weights|result|metric|score|eval/i, purpose: "model artefact or evaluation result" },
  { re: /medicine|product|item|sku|catalog|catalogue|master/i, purpose: "item or entity master data" },
  { re: /supplier|vendor|distributor/i, purpose: "supplier reference data" },
  { re: /customer|patient|user|client|member/i, purpose: "customer or user records" },
  { re: /location|city|region|store|branch|pharmacy/i, purpose: "location reference data" },
  { re: /log|event|audit|trace/i, purpose: "event or audit log" },
];

function purposeOf(path: string, columns: DatasetColumn[]): string {
  const haystack = `${path} ${columns.map((column) => column.name).join(" ")}`;
  const parts: string[] = [];
  for (const pattern of PURPOSE_PATTERNS) {
    if (pattern.re.test(haystack)) parts.push(pattern.purpose);
    if (parts.length === 2) break;
  }

  const roles = new Set(columns.map((column) => column.role));
  if (roles.has("date")) parts.push("dated over time");
  if (roles.has("entity")) parts.push("keyed by an item");
  if (roles.has("quantity") || roles.has("stock")) parts.push("carrying measured amounts");
  if (roles.has("price")) parts.push("carrying monetary values");

  if (parts.length === 0) return "tabular data of unrecognised shape";
  return [...new Set(parts)].slice(0, 3).join(", ");
}

/** The compact form handed to a model. Never the rows. */
export function compactDatasetProfile(profile: DatasetProfile): Record<string, unknown> {  return {
    path: profile.path,
    format: profile.format,
    approx_row_count: profile.approx_row_count,
    row_count_exact: profile.row_count_exact,
    columns: profile.columns.map((column) => ({
      name: column.name,
      type: column.inferred_type,
      role: column.role,
      sample: column.sample.slice(0, 2),
    })),
    likely_purpose: profile.likely_purpose,
    sample_rows: profile.sample_rows.slice(0, 2),
    notes: profile.notes.slice(0, 2),
  };
}
