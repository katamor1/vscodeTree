import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePath } from "../pathUtils";
import type { TextEncoding } from "../textEncoding";
import type { FileAnalysis, ParserDiagnostic } from "../types";

const execFileAsync = promisify(execFile);
const defaultNativeAnalyzeBatchSize = 4;

export interface RustNativeAnalysisResult {
  files: FileAnalysis[];
  workerCount: number;
  usedWorkers: boolean;
  diagnostics: ParserDiagnostic[];
  phaseDurationsMs: Record<string, number>;
}

export interface RustOutput {
  files: FileAnalysis[];
  diagnostics?: ParserDiagnostic[];
  metrics?: Record<string, number>;
  workerCount?: number;
}

export interface RustSidecarOutputFile {
  outputPath: string;
  outputBytes: number;
  nativeBatchSize: number;
  diagnostics: ParserDiagnostic[];
  cleanup(): Promise<void>;
}

export class RustSidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RustSidecarUnavailableError";
  }
}

export async function analyzeFilesWithRustSidecar(
  files: string[],
  maxIndexWorkers = 0,
  sourceEncoding: TextEncoding = "auto",
  maxNativeBatchFiles = defaultNativeAnalyzeBatchSize
): Promise<RustNativeAnalysisResult> {
  const output = await runRustAnalyzeManyToOutput(files, maxIndexWorkers, sourceEncoding, maxNativeBatchFiles);
  try {
    let parsed: RustOutput;
    try {
      parsed = await parseRustOutputFile(output.outputPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const tail = await readFileTailForDiagnostics(output.outputPath);
      throw new Error(`Rust sidecar output JSON parse failed (${output.outputBytes} bytes): ${reason}. Tail: ${tail}`);
    }
    output.diagnostics.push(...(parsed.diagnostics ?? []));
    return {
      files: parsed.files ?? [],
      workerCount: parsed.workerCount ?? 1,
      usedWorkers: (parsed.workerCount ?? 1) > 1,
      diagnostics: output.diagnostics,
      phaseDurationsMs: rustPhaseDurations(parsed.metrics, files.length, output.outputBytes, output.nativeBatchSize)
    };
  } catch (error) {
    output.diagnostics.push({
      backend: "rust",
      severity: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await output.cleanup();
  }
}

export async function runRustAnalyzeManyToOutput(
  files: string[],
  maxIndexWorkers = 0,
  sourceEncoding: TextEncoding = "auto",
  maxNativeBatchFiles = defaultNativeAnalyzeBatchSize
): Promise<RustSidecarOutputFile> {
  const sidecar = await findRustSidecarExecutable();
  if (!sidecar) {
    throw new RustSidecarUnavailableError("Rust sidecar is not built or packaged. Run cargo build --release in native/vc6-impact-rust before building the index.");
  }

  const diagnostics: ParserDiagnostic[] = [{
    backend: "rust",
    severity: "info",
    message: `rust sidecar detected: ${sidecar}`
  }];
  const listPath = path.join(os.tmpdir(), `vc6-impact-rust-files-${process.pid}-${Date.now()}.json`);
  const outputPath = path.join(os.tmpdir(), `vc6-impact-rust-output-${process.pid}-${Date.now()}.json`);
  try {
    await fs.writeFile(listPath, JSON.stringify(files), "utf8");
    const workerArg = maxIndexWorkers > 0 ? String(Math.floor(maxIndexWorkers)) : "auto";
    const nativeBatchSize = normalizeNativeBatchFiles(maxNativeBatchFiles);
    await execFileAsync(sidecar, [
      "analyze-many",
      listPath,
      "--workers",
      workerArg,
      "--output",
      outputPath,
      "--encoding",
      sourceEncoding,
      "--batch-size",
      String(nativeBatchSize)
    ], {
      windowsHide: true,
      timeout: Math.max(30000, files.length * 250),
      maxBuffer: 16 * 1024 * 1024
    });
    const outputBytes = (await fs.stat(outputPath)).size;
    return {
      outputPath,
      outputBytes,
      nativeBatchSize,
      diagnostics,
      async cleanup(): Promise<void> {
        await fs.rm(listPath, { force: true }).catch(() => undefined);
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
      }
    };
  } catch (error) {
    diagnostics.push({
      backend: "rust",
      severity: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => undefined);
  }
}

export function rustPhaseDurations(
  metrics: Record<string, number> | undefined,
  fileCount: number,
  outputBytes: number,
  nativeBatchSize: number
): Record<string, number> {
  return {
    rustReadMaskDeclarationScan: metrics?.readMaskDeclarationScan ?? 0,
    rustSymbolMap: metrics?.symbolMap ?? 0,
    rustAccessAnalysis: metrics?.accessAnalysis ?? 0,
    rustTotalNative: metrics?.totalNative ?? 0,
    rustFileCount: metrics?.fileCount ?? fileCount,
    rustBatchSize: metrics?.batchSize ?? nativeBatchSize,
    rustSummaryBatchSize: metrics?.summaryBatchSize ?? nativeBatchSize,
    rustStreamedSummaryFileCount: metrics?.streamedSummaryFileCount ?? 0,
    rustMaxSummaryBatchFiles: metrics?.maxSummaryBatchFiles ?? 0,
    rustSummaryRetainedFileCount: metrics?.summaryRetainedFileCount ?? 0,
    rustStreamedFileCount: metrics?.streamedFileCount ?? 0,
    rustMaxStructureBatchFiles: metrics?.maxStructureBatchFiles ?? 0,
    rustContextGlobalCount: metrics?.contextGlobalCount ?? 0,
    rustContextFunctionNameCount: metrics?.contextFunctionNameCount ?? 0,
    rustContextStructTypeCount: metrics?.contextStructTypeCount ?? 0,
    rustContextGlobalTypeCount: metrics?.contextGlobalTypeCount ?? 0,
    rustContextMacroAliasCount: metrics?.contextMacroAliasCount ?? 0,
    rustOutputBytes: metrics?.outputBytes ?? outputBytes,
    rustPeakRssBytes: metrics?.peakRssBytes ?? 0
  };
}

function normalizeNativeBatchFiles(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultNativeAnalyzeBatchSize;
  }
  return Math.max(1, Math.min(64, Math.floor(value)));
}

export function looksLikeCompleteJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

export function jsonTailForDiagnostics(text: string): string {
  return text.slice(Math.max(0, text.length - 240)).replace(/\s+/g, " ").slice(0, 240);
}

export async function parseRustOutputFile(
  outputPath: string,
  onFile?: (file: FileAnalysis) => void | Promise<void>
): Promise<RustOutput> {
  const files: FileAnalysis[] = [];
  let buffer = "";
  let tail = "";
  let state: "prefix" | "files" | "tail" = "prefix";
  let sawTail = false;
  const marker = '"files":[';

  for await (const chunk of nodeFs.createReadStream(outputPath, { encoding: "utf8" })) {
    buffer += chunk;
    while (true) {
      if (state === "prefix") {
        const markerIndex = buffer.indexOf(marker);
        if (markerIndex < 0) {
          buffer = buffer.slice(Math.max(0, buffer.length - marker.length));
          break;
        }
        buffer = buffer.slice(markerIndex + marker.length);
        state = "files";
      }

      if (state === "files") {
        const beforeSkip = buffer.length;
        buffer = buffer.replace(/^\s+/, "");
        if (buffer.startsWith(",")) {
          buffer = buffer.slice(1);
          continue;
        }
        if (buffer.startsWith("]")) {
          tail += buffer.slice(1);
          buffer = "";
          state = "tail";
          sawTail = true;
          continue;
        }
        if (buffer.length === 0 || buffer.length !== beforeSkip && buffer.trimStart().length === 0) {
          break;
        }
        if (!buffer.startsWith("{")) {
          throw new Error(`unexpected token while parsing Rust files array: ${jsonTailForDiagnostics(buffer)}`);
        }
        const valueEnd = findJsonValueEnd(buffer, 0);
        if (valueEnd === undefined) {
          break;
        }
        const file = JSON.parse(buffer.slice(0, valueEnd)) as FileAnalysis;
        if (onFile) {
          await onFile(file);
        } else {
          files.push(file);
        }
        buffer = buffer.slice(valueEnd);
        continue;
      }

      tail += buffer;
      buffer = "";
      break;
    }
  }

  if (!sawTail) {
    throw new Error(`Rust sidecar output JSON is incomplete or truncated. Tail: ${jsonTailForDiagnostics(buffer)}`);
  }
  const tailText = tail.trim();
  if (!tailText.endsWith("}")) {
    throw new Error(`Rust sidecar output JSON is incomplete or truncated. Tail: ${jsonTailForDiagnostics(tailText)}`);
  }
  const restText = tailText.startsWith(",") ? `{${tailText.slice(1)}` : tailText;
  const rest = JSON.parse(restText) as Omit<RustOutput, "files">;
  return {
    files,
    diagnostics: rest.diagnostics,
    metrics: rest.metrics,
    workerCount: rest.workerCount
  };
}

function findJsonValueEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

async function readFileTailForDiagnostics(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    const length = Math.min(stat.size, 4096);
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      return jsonTailForDiagnostics(buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

export async function findRustSidecarExecutable(): Promise<string | undefined> {
  const explicitSidecar = process.env.VC6_IMPACT_RUST_SIDECAR?.trim();
  if (explicitSidecar) {
    const candidate = normalizePath(explicitSidecar);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }

  for (const candidate of rustSidecarCandidates()) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function rustSidecarCandidates(): string[] {
  const repoRoot = resolveRepoRoot();
  return [
    path.join(repoRoot, "native", "vc6-impact-rust", "target", "release", "vc6-impact-rust.exe"),
    path.join(repoRoot, "native", "vc6-impact-rust", "target", "debug", "vc6-impact-rust.exe"),
    path.join(repoRoot, "native", "vc6-impact-rust", "target", "release", "vc6-impact-rust"),
    path.join(repoRoot, "native", "vc6-impact-rust", "target", "debug", "vc6-impact-rust")
  ].map(normalizePath);
}

function resolveRepoRoot(): string {
  const fromDist = path.resolve(__dirname, "..", "..", "..");
  if (path.basename(fromDist).toLowerCase() !== "dist") {
    return fromDist;
  }
  return path.resolve(fromDist, "..");
}
