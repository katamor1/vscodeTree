import { analyzeFilesWithClang } from "./clang/clangSourceScanner";
import { analyzeFilesWithRustSidecar } from "./rust/rustSourceScanner";
import { analyzeFilesWithTypeScript } from "./typescript/typescriptSourceScanner";
import type { FileAnalysis, ParserDiagnostic, ParserEngine } from "./types";
import type { TextEncoding } from "./textEncoding";

export interface ParserAnalysisResult {
  files: FileAnalysis[];
  workerCount: number;
  usedWorkers: boolean;
  diagnostics: ParserDiagnostic[];
  phaseDurationsMs: Record<string, number>;
}

export async function analyzeFilesWithParserBackend(args: {
  parserEngine: ParserEngine;
  files: string[];
  maxIndexWorkers?: number;
  maxNativeBatchFiles?: number;
  sourceEncoding?: TextEncoding;
  includePaths?: string[];
  macros?: string[];
}): Promise<ParserAnalysisResult> {
  if (args.parserEngine === "rust") {
    return analyzeFilesWithRustSidecar(
      args.files,
      args.maxIndexWorkers,
      args.sourceEncoding ?? "auto",
      args.maxNativeBatchFiles
    );
  }
  if (args.parserEngine === "clang") {
    return analyzeFilesWithClang(
      args.files,
      args.sourceEncoding ?? "auto",
      args.includePaths ?? [],
      args.macros ?? [],
      effectiveFileConcurrency(args.maxIndexWorkers)
    );
  }
  return analyzeFilesWithTypeScript(
    args.files,
    args.sourceEncoding ?? "auto",
    "typescript",
    [],
    effectiveFileConcurrency(args.maxIndexWorkers)
  );
}

export function normalizeParserEngine(value: string | undefined, fallback: ParserEngine = "rust"): ParserEngine {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "rust" || normalized === "typescript" || normalized === "clang") {
    return normalized;
  }
  return fallback;
}

function effectiveFileConcurrency(maxIndexWorkers: number | undefined): number {
  if (maxIndexWorkers && maxIndexWorkers > 0) {
    return Math.floor(maxIndexWorkers);
  }
  return 8;
}
