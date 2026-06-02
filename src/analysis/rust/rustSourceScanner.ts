import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePath } from "../pathUtils";
import type { TextEncoding } from "../textEncoding";
import type { FileAnalysis, ParserDiagnostic, SkippedSourceFile } from "../types";

const execFileAsync = promisify(execFile);
const defaultNativeAnalyzeBatchSize = 4;

export interface RustNativeAnalysisResult {
  files: FileAnalysis[];
  workerCount: number;
  usedWorkers: boolean;
  diagnostics: ParserDiagnostic[];
  phaseDurationsMs: Record<string, number>;
  skippedFiles?: SkippedSourceFile[];
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
  skippedFiles?: SkippedSourceFile[];
  analyzedFileCount?: number;
  diagnosticSummaryPath?: string;
  diagnosticEventsPath?: string;
  cleanup(): Promise<void>;
}

export interface RustAnalyzeManyArgs {
  files: string[];
  maxIndexWorkers: number;
  sourceEncoding: TextEncoding;
  maxNativeBatchFiles: number;
  timeoutMs?: number;
  macros?: string[];
  progressLogPath?: string;
}

export type RustAnalyzeManyRunner = (args: RustAnalyzeManyArgs) => Promise<RustSidecarOutputFile>;

export interface RustAutoSkipOptions {
  files: string[];
  maxIndexWorkers?: number;
  sourceEncoding?: TextEncoding;
  maxNativeBatchFiles?: number;
  timeoutMs?: number;
  macros?: string[];
  diagnosticsDir?: string;
  maxSkippedFiles?: number;
  runner?: RustAnalyzeManyRunner;
}

export interface RustProgressEvent {
  runId?: string;
  phase?: string;
  event?: string;
  file?: string;
  sourceBytes?: number;
  rssBeforeBytes?: number;
  rssAfterBytes?: number;
  rssDeltaBytes?: number;
  elapsedMs?: number;
  error?: string;
}

export class RustSidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RustSidecarUnavailableError";
  }
}

export interface RustSidecarExecutionErrorOptions {
  stderr?: string;
  stdout?: string;
  exitCode?: number | string;
  signal?: string;
  outputPath?: string;
  progressLogPath?: string;
  diagnostics?: ParserDiagnostic[];
  cause?: unknown;
}

export class RustSidecarExecutionError extends Error {
  stderr?: string;
  stdout?: string;
  exitCode?: number | string;
  signal?: string;
  outputPath?: string;
  progressLogPath?: string;
  diagnostics: ParserDiagnostic[];
  cause?: unknown;

  constructor(message: string, options: RustSidecarExecutionErrorOptions = {}) {
    super(message);
    this.name = "RustSidecarExecutionError";
    this.stderr = options.stderr;
    this.stdout = options.stdout;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.outputPath = options.outputPath;
    this.progressLogPath = options.progressLogPath;
    this.diagnostics = options.diagnostics ?? [];
    this.cause = options.cause;
  }
}

export async function analyzeFilesWithRustSidecar(
  files: string[],
  maxIndexWorkers = 0,
  sourceEncoding: TextEncoding = "auto",
  maxNativeBatchFiles = defaultNativeAnalyzeBatchSize,
  macros: string[] = [],
  timeoutMs?: number
): Promise<RustNativeAnalysisResult> {
  const output = await runRustAnalyzeManyToOutput(files, maxIndexWorkers, sourceEncoding, maxNativeBatchFiles, undefined, macros, timeoutMs);
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

export async function analyzeFilesWithRustSidecarAutoSkip(options: RustAutoSkipOptions): Promise<RustNativeAnalysisResult> {
  const output = await runRustAnalyzeManyToOutputWithAutoSkip(options);
  try {
    let parsed: RustOutput;
    try {
      parsed = await parseRustOutputFile(output.outputPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const tail = await readFileTailForDiagnostics(output.outputPath);
      throw new RustSidecarExecutionError(`Rust sidecar output JSON parse failed (${output.outputBytes} bytes): ${reason}. Tail: ${tail}`, {
        outputPath: output.outputPath,
        diagnostics: output.diagnostics,
        cause: error
      });
    }
    output.diagnostics.push(...(parsed.diagnostics ?? []));
    const phaseDurationsMs = rustPhaseDurations(parsed.metrics, output.analyzedFileCount ?? options.files.length, output.outputBytes, output.nativeBatchSize);
    phaseDurationsMs.rustSkippedFileCount = output.skippedFiles?.length ?? 0;
    phaseDurationsMs.rustAnalyzedFileCount = output.analyzedFileCount ?? parsed.files?.length ?? options.files.length;
    return {
      files: parsed.files ?? [],
      workerCount: parsed.workerCount ?? 1,
      usedWorkers: (parsed.workerCount ?? 1) > 1,
      diagnostics: output.diagnostics,
      phaseDurationsMs,
      skippedFiles: output.skippedFiles ?? []
    };
  } finally {
    await output.cleanup();
  }
}

export async function runRustAnalyzeManyToOutput(
  files: string[],
  maxIndexWorkers = 0,
  sourceEncoding: TextEncoding = "auto",
  maxNativeBatchFiles = defaultNativeAnalyzeBatchSize,
  progressLogPath?: string,
  macros: string[] = [],
  timeoutMs?: number
): Promise<RustSidecarOutputFile> {
  return defaultRustAnalyzeManyRunner({
    files,
    maxIndexWorkers,
    sourceEncoding,
    maxNativeBatchFiles,
    timeoutMs,
    macros,
    progressLogPath
  });
}

export const defaultRustAnalyzeManyRunner: RustAnalyzeManyRunner = async ({
  files,
  maxIndexWorkers = 0,
  sourceEncoding = "auto",
  maxNativeBatchFiles = defaultNativeAnalyzeBatchSize,
  timeoutMs,
  macros = [],
  progressLogPath
}: RustAnalyzeManyArgs): Promise<RustSidecarOutputFile> => {
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
    const args = [
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
    ];
    for (const macro of macros) {
      args.push("--define", macro);
    }
    if (progressLogPath) {
      args.push("--progress-log", progressLogPath);
    }
    await execFileAsync(sidecar, args, {
      windowsHide: true,
      timeout: resolveRustSidecarTimeoutMs(timeoutMs, files.length),
      maxBuffer: 16 * 1024 * 1024
    });
    const outputBytes = (await fs.stat(outputPath)).size;
    return {
      outputPath,
      outputBytes,
      nativeBatchSize,
      diagnostics,
      analyzedFileCount: files.length,
      diagnosticEventsPath: progressLogPath,
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
    throw rustExecutionError(error, {
      outputPath,
      progressLogPath,
      diagnostics
    });
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => undefined);
  }
};

export async function runRustAnalyzeManyToOutputWithAutoSkip(options: RustAutoSkipOptions): Promise<RustSidecarOutputFile> {
  const runner = options.runner ?? defaultRustAnalyzeManyRunner;
  const files = [...options.files];
  const sourceEncoding = options.sourceEncoding ?? "auto";
  const maxIndexWorkers = options.maxIndexWorkers ?? 0;
  const maxNativeBatchFiles = normalizeNativeBatchFiles(options.maxNativeBatchFiles ?? defaultNativeAnalyzeBatchSize);
  const timeoutMs = options.timeoutMs;
  const macros = options.macros ?? [];
  const diagnosticsDir = options.diagnosticsDir ?? path.join(os.tmpdir(), "vc6-impact-native-diagnostics");
  const maxSkippedFiles = normalizeMaxSkippedFiles(options.maxSkippedFiles);
  const runStamp = diagnosticStamp();
  const diagnosticSummaryPath = path.join(diagnosticsDir, `rust-memory-summary-${runStamp}.json`);
  const diagnostics: ParserDiagnostic[] = [];
  await fs.mkdir(diagnosticsDir, { recursive: true });

  try {
    return await runValidatedRustOutput(runner, {
      files,
      maxIndexWorkers,
      sourceEncoding,
      maxNativeBatchFiles,
      timeoutMs,
      macros
    });
  } catch (error) {
    if (!isRustMemoryFailure(error)) {
      throw error;
    }
    diagnostics.push({
      backend: "rust",
      severity: "warning",
      message: `Rust sidecar failed with a memory-classified error; retrying with safe auto-skip diagnostics: ${rustErrorMessage(error)}`
    });
  }

  const skippedFiles: SkippedSourceFile[] = [];
  let remainingFiles = [...files];
  let attempt = 0;
  while (true) {
    attempt += 1;
    const progressLogPath = path.join(diagnosticsDir, `rust-memory-events-${runStamp}-attempt-${attempt}.jsonl`);
    try {
      const output = await runValidatedRustOutput(runner, {
        files: remainingFiles,
        maxIndexWorkers: 1,
        sourceEncoding,
        maxNativeBatchFiles: 1,
        timeoutMs,
        macros,
        progressLogPath
      });
      const summary = await writeAutoSkipSummary(diagnosticSummaryPath, {
        status: "recovered",
        originalFileCount: files.length,
        analyzedFileCount: remainingFiles.length,
        skippedFiles
      });
      output.diagnostics = [
        ...diagnostics,
        ...output.diagnostics
      ];
      output.skippedFiles = skippedFiles.map((file) => ({ ...file, diagnosticSummaryPath: summary }));
      output.analyzedFileCount = remainingFiles.length;
      output.diagnosticSummaryPath = summary;
      output.diagnosticEventsPath = progressLogPath;
      return output;
    } catch (error) {
      if (!isRustMemoryFailure(error)) {
        throw error;
      }
      const failed = await identifyFailedProgressFile(progressLogPath);
      if (!failed?.file) {
        const summary = await writeAutoSkipSummary(diagnosticSummaryPath, {
          status: "failed",
          originalFileCount: files.length,
          analyzedFileCount: remainingFiles.length,
          skippedFiles,
          failure: rustErrorMessage(error),
          progressLogPath
        });
        throw new RustSidecarExecutionError(`Rust auto-skip could not identify the failing file. Diagnostic summary: ${summary}`, {
          progressLogPath,
          diagnostics,
          cause: error
        });
      }
      if (skippedFiles.length >= maxSkippedFiles) {
        const summary = await writeAutoSkipSummary(diagnosticSummaryPath, {
          status: "failed",
          originalFileCount: files.length,
          analyzedFileCount: remainingFiles.length,
          skippedFiles,
          failure: `auto-skip limit reached before skipping ${failed.file}`,
          progressLogPath
        });
        throw new RustSidecarExecutionError(`Rust auto-skip limit reached (${maxSkippedFiles}). Diagnostic summary: ${summary}`, {
          progressLogPath,
          diagnostics,
          cause: error
        });
      }
      const skipped: SkippedSourceFile = {
        file: failed.file,
        phase: normalizeProgressPhase(failed.phase),
        reason: rustErrorMessage(error),
        sourceBytes: failed.sourceBytes,
        rssBeforeBytes: failed.rssBeforeBytes,
        rssAfterBytes: failed.rssAfterBytes,
        rssDeltaBytes: failed.rssDeltaBytes,
        requestedBytes: requestedBytesFromText(rustErrorText(error)),
        diagnosticLogPath: progressLogPath,
        diagnosticSummaryPath,
        skippedAt: new Date().toISOString()
      };
      skippedFiles.push(skipped);
      diagnostics.push({
        backend: "rust",
        file: skipped.file,
        severity: "warning",
        message: skippedDiagnosticMessage(skipped)
      });
      remainingFiles = remainingFiles.filter((file) => file !== skipped.file);
    }
  }
}

async function runValidatedRustOutput(runner: RustAnalyzeManyRunner, args: RustAnalyzeManyArgs): Promise<RustSidecarOutputFile> {
  const output = await runner(args);
  try {
    await parseRustOutputFile(output.outputPath, () => undefined);
    return output;
  } catch (error) {
    const tail = await readFileTailForDiagnostics(output.outputPath);
    await output.cleanup();
    throw new RustSidecarExecutionError(`Rust sidecar output JSON is incomplete or truncated: ${error instanceof Error ? error.message : String(error)}. Tail: ${tail}`, {
      outputPath: output.outputPath,
      progressLogPath: args.progressLogPath,
      diagnostics: output.diagnostics,
      cause: error
    });
  }
}

function rustExecutionError(error: unknown, options: RustSidecarExecutionErrorOptions): RustSidecarExecutionError {
  if (error instanceof RustSidecarExecutionError) {
    return error;
  }
  const execError = error as Error & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    code?: number | string;
    signal?: string;
  };
  return new RustSidecarExecutionError(error instanceof Error ? error.message : String(error), {
    ...options,
    stderr: bufferText(execError.stderr),
    stdout: bufferText(execError.stdout),
    exitCode: execError.code,
    signal: execError.signal,
    cause: error
  });
}

export function isRustMemoryFailure(error: unknown): boolean {
  const text = rustErrorText(error).toLowerCase();
  return [
    "memory allocation",
    "out of memory",
    "oom",
    "enomem",
    "cannot allocate memory",
    "process abort",
    "abort",
    "incomplete or truncated"
  ].some((pattern) => text.includes(pattern));
}

function rustErrorText(error: unknown): string {
  if (error instanceof RustSidecarExecutionError) {
    return [error.message, error.stderr, error.stdout].filter(Boolean).join("\n");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function rustErrorMessage(error: unknown): string {
  const text = rustErrorText(error).replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function bufferText(value: string | Buffer | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

async function identifyFailedProgressFile(progressLogPath: string): Promise<RustProgressEvent | undefined> {
  let text = "";
  try {
    text = await fs.readFile(progressLogPath, "utf8");
  } catch {
    return undefined;
  }
  const events = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RustProgressEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is RustProgressEvent => Boolean(event?.file));
  const completed = new Set<string>();
  for (const event of events) {
    if (event.event === "end" || event.event === "error") {
      completed.add(progressEventKey(event));
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event === "start" && !completed.has(progressEventKey(event))) {
      return event;
    }
  }
  return [...events].reverse().find((event) => event.event === "error") ?? [...events].reverse().find((event) => event.file);
}

function progressEventKey(event: RustProgressEvent): string {
  return `${event.phase ?? "unknown"}\0${event.file ?? ""}`;
}

function normalizeProgressPhase(value: string | undefined): SkippedSourceFile["phase"] {
  return value === "summary" || value === "access" ? value : "unknown";
}

function requestedBytesFromText(text: string): number | undefined {
  const match = /(?:memory allocation of|allocate)\s+(\d+)\s+bytes/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function skippedDiagnosticMessage(file: SkippedSourceFile): string {
  const requested = typeof file.requestedBytes === "number" ? `, requestedBytes=${file.requestedBytes}` : "";
  return `Rust auto-skip excluded ${file.file} during ${file.phase ?? "unknown"} phase: ${file.reason}${requested}. Diagnostics: ${file.diagnosticLogPath ?? file.diagnosticSummaryPath ?? "unavailable"}`;
}

async function writeAutoSkipSummary(summaryPath: string, summary: Record<string, unknown>): Promise<string> {
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...summary
  }, null, 2)}\n`, "utf8");
  return summaryPath;
}

function normalizeMaxSkippedFiles(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 16;
  }
  return Math.max(0, Math.min(1000, Math.floor(value ?? 16)));
}

export function resolveRustSidecarTimeoutMs(value: number | undefined, fileCount: number): number {
  if (value === undefined || value < 0 || !Number.isFinite(value)) {
    return Math.max(30000, fileCount * 250);
  }
  return Math.floor(value);
}

function diagnosticStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
