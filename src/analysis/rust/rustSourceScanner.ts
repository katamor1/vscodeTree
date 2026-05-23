import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePath } from "../pathUtils";
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
  maxIndexWorkers = 0
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
  try {
    await fs.writeFile(listPath, JSON.stringify(files), "utf8");
    const workerArg = maxIndexWorkers > 0 ? String(Math.floor(maxIndexWorkers)) : "auto";
    const { stdout } = await execFileAsync(sidecar, ["analyze-many", listPath, "--workers", workerArg], {
      windowsHide: true,
      timeout: Math.max(30000, files.length * 250),
      maxBuffer: 512 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout) as {
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
        rustTotalNative: parsed.metrics?.totalNative ?? 0
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
