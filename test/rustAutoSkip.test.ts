import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RustSidecarExecutionError,
  resolveRustSidecarTimeoutMs,
  runRustAnalyzeManyToOutputWithAutoSkip,
  type RustAnalyzeManyRunner,
  type RustSidecarOutputFile
} from "../src/analysis/rust/rustSourceScanner";

describe("Rust native auto-skip fallback", () => {
  it("resolves Rust sidecar timeout settings", () => {
    expect(resolveRustSidecarTimeoutMs(undefined, 10)).toBe(30000);
    expect(resolveRustSidecarTimeoutMs(-1, 200)).toBe(50000);
    expect(resolveRustSidecarTimeoutMs(0, 200)).toBe(0);
    expect(resolveRustSidecarTimeoutMs(1234.9, 200)).toBe(1234);
  });

  it("reruns in safe mode, skips the file identified by the progress log, and continues", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-autoskip-"));
    const goodA = path.join(tempRoot, "good-a.cpp").replace(/\\/g, "/");
    const bad = path.join(tempRoot, "bad.cpp").replace(/\\/g, "/");
    const goodB = path.join(tempRoot, "good-b.cpp").replace(/\\/g, "/");
    const includePath = path.join(tempRoot, "include").replace(/\\/g, "/");
    const calls: Array<{ files: string[]; maxIndexWorkers: number; maxNativeBatchFiles: number; timeoutMs?: number; includePaths?: string[]; progressLogPath?: string }> = [];
    const runner: RustAnalyzeManyRunner = async (args) => {
      calls.push({
        files: args.files,
        maxIndexWorkers: args.maxIndexWorkers,
        maxNativeBatchFiles: args.maxNativeBatchFiles,
        timeoutMs: args.timeoutMs,
        includePaths: args.includePaths,
        progressLogPath: args.progressLogPath
      });
      if (!args.progressLogPath) {
        throw new RustSidecarExecutionError("memory allocation of 10737418240 bytes failed", {
          stderr: "memory allocation of 10737418240 bytes failed"
        });
      }
      if (args.files.includes(bad)) {
        await fs.writeFile(
          args.progressLogPath,
          JSON.stringify({
            runId: "test",
            phase: "access",
            event: "start",
            file: bad,
            sourceBytes: 123,
            rssBeforeBytes: 1000,
            elapsedMs: 1
          }) + "\n",
          "utf8"
        );
        throw new RustSidecarExecutionError("process abort after memory allocation failed", {
          stderr: "process abort after memory allocation failed",
          progressLogPath: args.progressLogPath
        });
      }
      return writeRustOutput(tempRoot, args.files);
    };

    const result = await runRustAnalyzeManyToOutputWithAutoSkip({
      files: [goodA, bad, goodB],
      maxIndexWorkers: 8,
      sourceEncoding: "auto",
      maxNativeBatchFiles: 4,
      timeoutMs: 0,
      includePaths: [includePath],
      diagnosticsDir: path.join(tempRoot, "native-diagnostics"),
      maxSkippedFiles: 2,
      runner
    });

    expect(calls[0]).toMatchObject({ files: [goodA, bad, goodB], maxIndexWorkers: 8, maxNativeBatchFiles: 4, timeoutMs: 0, includePaths: [includePath] });
    expect(calls[1]).toMatchObject({ files: [goodA, bad, goodB], maxIndexWorkers: 1, maxNativeBatchFiles: 1, timeoutMs: 0, includePaths: [includePath] });
    expect(calls[2]).toMatchObject({ files: [goodA, goodB], maxIndexWorkers: 1, maxNativeBatchFiles: 1, timeoutMs: 0, includePaths: [includePath] });
    expect(result.skippedFiles).toEqual([
      expect.objectContaining({
        file: bad,
        phase: "access",
        sourceBytes: 123,
        reason: expect.stringContaining("process abort")
      })
    ]);
    expect(result.analyzedFileCount).toBe(2);
    expect(result.diagnosticSummaryPath).toContain("rust-memory-summary-");
    await expect(fs.readFile(result.diagnosticSummaryPath!, "utf8")).resolves.toContain(bad);
    await result.cleanup();
  });

  it("does not skip files for non-memory Rust errors", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-autoskip-"));
    const file = path.join(tempRoot, "main.cpp").replace(/\\/g, "/");
    const runner: RustAnalyzeManyRunner = async () => {
      throw new RustSidecarExecutionError("invalid source encoding option", { stderr: "invalid source encoding option" });
    };

    await expect(runRustAnalyzeManyToOutputWithAutoSkip({
      files: [file],
      diagnosticsDir: path.join(tempRoot, "native-diagnostics"),
      maxSkippedFiles: 1,
      runner
    })).rejects.toThrow(/invalid source encoding option/);
  });

  it("fails when the auto-skip cap is reached", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-autoskip-"));
    const firstBad = path.join(tempRoot, "bad-1.cpp").replace(/\\/g, "/");
    const secondBad = path.join(tempRoot, "bad-2.cpp").replace(/\\/g, "/");
    const runner: RustAnalyzeManyRunner = async (args) => {
      if (!args.progressLogPath) {
        throw new RustSidecarExecutionError("out of memory", { stderr: "out of memory" });
      }
      const failing = args.files.includes(firstBad) ? firstBad : secondBad;
      await fs.writeFile(
        args.progressLogPath,
        JSON.stringify({ runId: "test", phase: "summary", event: "start", file: failing, elapsedMs: 1 }) + "\n",
        "utf8"
      );
      throw new RustSidecarExecutionError("out of memory", { stderr: "out of memory", progressLogPath: args.progressLogPath });
    };

    await expect(runRustAnalyzeManyToOutputWithAutoSkip({
      files: [firstBad, secondBad],
      diagnosticsDir: path.join(tempRoot, "native-diagnostics"),
      maxSkippedFiles: 1,
      runner
    })).rejects.toThrow(/auto-skip limit reached/);
  });
});

async function writeRustOutput(tempRoot: string, files: string[]): Promise<RustSidecarOutputFile> {
  const outputPath = path.join(tempRoot, `rust-output-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(
    outputPath,
    JSON.stringify({
      files: files.map((file) => ({
        file,
        signature: { size: 0, mtimeMs: 0 },
        globals: [],
        structTypes: [],
        macroDefinitions: [],
        functions: [],
        unresolved: []
      })),
      diagnostics: [],
      metrics: { outputBytes: 1 },
      workerCount: 1
    }),
    "utf8"
  );
  return {
    outputPath,
    outputBytes: 1,
    nativeBatchSize: 1,
    diagnostics: [],
    async cleanup(): Promise<void> {
      await fs.rm(outputPath, { force: true });
    }
  };
}
