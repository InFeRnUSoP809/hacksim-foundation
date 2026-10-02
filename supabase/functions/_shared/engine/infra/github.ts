/**
 * Generic GitHub/material utilities only — no legacy analyzer orchestration.
 */
export { GitHubClient, GitHubError } from "../../github-api.ts";
export {
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
  extractDependencies,
  extractIntegrations,
  extractRoutes,
  extractSymbols,
  importanceOf,
  isIgnored,
  isSensitive,
  isTestFile,
  languageOf,
  looksBinary,
  parseReadme,
  scanFileForSecrets,
  type Dependency,
  type Detection,
  type Evidence,
  type FileRecord,
  type Route,
  type SecretFinding,
  type Symbol,
} from "../../github.ts";
export { EvidenceRegistry } from "../../github.ts";
