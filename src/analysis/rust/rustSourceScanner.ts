import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePath } from "../pathUtils";
import type { TextEncoding } from "../textEncoding";
import type { FileAnalysis, ParserDiagnostic } from "../types";

const execFileAsync = promisify(execFile);

export interface RustNativeAnalysisResult {
  files: FileAnalysis[];
  workerCount: number;
  usedWorkers: boolean;
  diagnostics: ParserDiagnostic[];
  phaseDurationsMs: Record<string, number>;
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
  sourceEncoding: TextEncoding = "auto"
): Promise<RustNativeAnalysisResult> {
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
      "256"
    ], {
      windowsHide: true,
      timeout: Math.max(30000, files.length * 250),
      maxBuffer: 16 * 1024 * 1024
    });
    const outputText = await fs.readFile(outputPath, "utf8");
    const outputBytes = (await fs.stat(outputPath)).size;
    const parsed = JSON.parse(outputText) as {
      files: FileAnalysis[];
      diagnostics?: ParserDiagnostic[];
      metrics?: Record<string, number>;
      workerCount?: number;
    };
    diagnostics.push(...(parsed.diagnostics ?? []));
    return {
      files: parsed.files ?? [],
      workerCount: parsed.workerCount ?? 1,
      usedWorkers: (parsed.workerCount ?? 1) > 1,
      diagnostics,
      phaseDurationsMs: {
        rustReadMaskDeclarationScan: parsed.metrics?.readMaskDeclarationScan ?? 0,
        rustSymbolMap: parsed.metrics?.symbolMap ?? 0,
        rustAccessAnalysis: parsed.metrics?.accessAnalysis ?? 0,
        rustTotalNative: parsed.metrics?.totalNative ?? 0,
        rustFileCount: parsed.metrics?.fileCount ?? files.length,
        rustBatchSize: parsed.metrics?.batchSize ?? 256,
        rustOutputBytes: parsed.metrics?.outputBytes ?? outputBytes,
        rustPeakRssBytes: parsed.metrics?.peakRssBytes ?? 0
      }
    };
  } catch (error) {
    diagnostics.push({
      backend: "rust",
      severity: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => undefined);
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
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
