import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureArtifactIgnored, reportPaths, resolveArtifactRoot, reportRelativeLink } from "../src/analysis/store";

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
});
