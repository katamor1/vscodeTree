import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureArtifactIgnored, readIndexBuildSummary, reportPaths, resolveArtifactRoot, reportRelativeLink, writeIndex } from "../src/analysis/store";
import type { AnalysisIndex } from "../src/analysis/types";

describe("artifact storage policy", () => {
  it("defaults artifacts under .vscode/vc6-impact-review", async () => {
    const workspaceRoot = path.resolve("C:/tmp/project");

    expect(resolveArtifactRoot(workspaceRoot)).toBe(
      path.resolve(workspaceRoot, ".vscode", "vc6-impact-review").replace(/\\/g, "/")
    );
  });

  it("keeps review report paths stable per symbol", () => {
    const outputDir = path.resolve("C:/tmp/project/.vscode/vc6-impact-review");
    const first = reportPaths(outputDir, "g_state.counter");
    const second = reportPaths(outputDir, "g_state.counter");

    expect(first).toEqual(second);
    expect(first.markdown.endsWith("/reports/g_state.counter.md")).toBe(true);
    expect(first.html.endsWith("/reports/g_state.counter.html")).toBe(true);
  });

  it("adds artifact root to .git/info/exclude without touching tracked gitignore", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-store-"));
    await fs.mkdir(path.join(tempRoot, ".git", "info"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, ".gitignore"), "dist/\n", "utf8");

    await ensureArtifactIgnored(tempRoot, path.join(tempRoot, ".vscode", "vc6-impact-review"));
    await ensureArtifactIgnored(tempRoot, path.join(tempRoot, ".vscode", "vc6-impact-review"));

    await expect(fs.readFile(path.join(tempRoot, ".gitignore"), "utf8")).resolves.toBe("dist/\n");
    const exclude = await fs.readFile(path.join(tempRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/\.vscode\/vc6-impact-review\//g)).toHaveLength(1);
  });

  it("adds nested workspace artifact roots to the containing git repo exclude", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-store-"));
    const workspaceRoot = path.join(tempRoot, "sub", "project");
    await fs.mkdir(path.join(tempRoot, ".git", "info"), { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });

    await ensureArtifactIgnored(workspaceRoot, path.join(workspaceRoot, ".vscode", "vc6-impact-review"));

    const exclude = await fs.readFile(path.join(tempRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("sub/project/.vscode/vc6-impact-review/");
  });

  it("builds markdown links relative to the markdown report directory", () => {
    const reportPath = path.resolve("C:/tmp/project/.vscode/vc6-impact-review/reports/g_counter.md");
    const sourcePath = path.resolve("C:/tmp/project/src/main.cpp");

    expect(reportRelativeLink(reportPath, sourcePath, 8)).toBe("../../../src/main.cpp#L8");
  });

  it("writes compact index JSON by default", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-store-"));
    const indexPath = path.join(tempRoot, "vc6-impact-index.json");

    await writeIndex(indexPath, minimalIndex());

    const text = await fs.readFile(indexPath, "utf8");
    expect(text).not.toContain("\n  ");
    expect(JSON.parse(text).version).toBe(1);
  });

  it("reads build summary from the index tail without requiring the whole JSON object", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-store-"));
    const indexPath = path.join(tempRoot, "vc6-impact-index.json");
    const index = minimalIndex();
    index.build.durationMs = 19435;
    index.build.workerCount = 7;
    index.build.sourceFileCount = 7002;
    index.build.reusedFiles = 123;
    await writeIndex(indexPath, index);

    await expect(readIndexBuildSummary(indexPath)).resolves.toEqual({
      durationMs: 19435,
      workerCount: 7,
      sourceFileCount: 7002,
      reusedFiles: 123
    });
  });

  it("returns undefined for missing index build summary", async () => {
    const tempRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? "C:/tmp", "vc6-impact-store-"));

    await expect(readIndexBuildSummary(path.join(tempRoot, "missing.json"))).resolves.toBeUndefined();
  });
});

function minimalIndex(): AnalysisIndex {
  return {
    version: 1,
    generatedAt: "2026-05-26T00:00:00.000Z",
    workspaceRoot: "C:/tmp/project",
    projectFile: "C:/tmp/project/sample.dsw",
    projectFiles: [],
    includePaths: [],
    macros: [],
    files: [],
    globals: {},
    structTypes: {},
    memberSymbols: {},
    macroDefinitions: {},
    macroAliases: {},
    parserDiagnostics: [],
    functions: {},
    callGraph: {},
    calledBy: {},
    threads: [],
    threadReachability: {},
    build: {
      mode: "full",
      parserMode: "rust",
      durationMs: 0,
      phaseDurationsMs: {},
      workerCount: 0,
      changedFiles: [],
      reusedFiles: 0,
      sourceFileCount: 0
    }
  };
}
