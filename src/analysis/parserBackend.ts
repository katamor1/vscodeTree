import { analyzeFilesWithClang } from "./clang/clangSourceScanner";
import { analyzeFilesWithRustSidecarAutoSkip } from "./rust/rustSourceScanner";
import { analyzeFilesWithTypeScript } from "./typescript/typescriptSourceScanner";
import type { FileAnalysis, ParserDiagnostic, ParserEngine, SkippedSourceFile } from "./types";
import type { TextEncoding } from "./textEncoding";

export interface ParserAnalysisResult {
  files: FileAnalysis[];
  workerCount: number;
  usedWorkers: boolean;
  diagnostics: ParserDiagnostic[];
  phaseDurationsMs: Record<string, number>;
  skippedFiles?: SkippedSourceFile[];
}

export async function analyzeFilesWithParserBackend(args: {
  parserEngine: ParserEngine;
  files: string[];
  maxIndexWorkers?: number;
  maxNativeBatchFiles?: number;
  sourceEncoding?: TextEncoding;
  includePaths?: string[];
  macros?: string[];
  diagnosticsDir?: string;
  maxRustAutoSkippedFiles?: number;
}): Promise<ParserAnalysisResult> {
  if (args.parserEngine === "rust") {
    return analyzeFilesWithRustSidecarAutoSkip({
      files: args.files,
      maxIndexWorkers: args.maxIndexWorkers,
      sourceEncoding: args.sourceEncoding ?? "auto",
      maxNativeBatchFiles: args.maxNativeBatchFiles,
      diagnosticsDir: args.diagnosticsDir,
      maxSkippedFiles: args.maxRustAutoSkippedFiles
    });
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
