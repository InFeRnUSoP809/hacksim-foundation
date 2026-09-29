import { extractSymbols, type Symbol } from "../github.ts";
import type { V2FileRecord, V2SymbolRecord } from "./types.ts";

function symbolKey(filePath: string, name: string, startLine: number): string {
  return `${filePath}::${name}@${startLine}`;
}

export function indexSymbols(files: V2FileRecord[]): V2SymbolRecord[] {
  const symbols: V2SymbolRecord[] = [];
  for (const file of files) {
    if (file.ignored || !file.content || file.binary) continue;
    const { symbols: extracted } = extractSymbols(file.path, file.content);
    for (const sym of extracted) {
      symbols.push({
        symbolKey: symbolKey(file.path, sym.name, sym.line),
        filePath: file.path,
        name: sym.name,
        symbolType: sym.symbol_type,
        language: file.language,
        startLine: sym.line,
        endLine: sym.line + 30,
        signature: sym.signature ?? null,
        parentSymbol: null,
        importance: file.importanceScore,
        uncertain: false,
      });
    }
    // Route-level pseudo symbols for files with HTTP handlers but no named functions
    if (file.category === "api" || file.path.includes("functions/")) {
      const serveMatch = file.content.match(/Deno\.serve\s*\(/);
      if (serveMatch) {
        const line = file.content.slice(0, serveMatch.index).split("\n").length;
        symbols.push({
          symbolKey: symbolKey(file.path, "Deno.serve", line),
          filePath: file.path,
          name: "Deno.serve",
          symbolType: "handler",
          language: file.language,
          startLine: line,
          endLine: line + 40,
          signature: "Deno.serve(...)",
          parentSymbol: null,
          importance: Math.max(file.importanceScore, 0.7),
          uncertain: false,
        });
      }
    }
  }
  return symbols;
}

export function symbolsByKey(symbols: V2SymbolRecord[]): Map<string, V2SymbolRecord> {
  return new Map(symbols.map((s) => [s.symbolKey, s]));
}
