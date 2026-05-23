import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/analysis/impact";
import { buildFullIndex } from "../src/analysis/indexer";
import { renderGraphHtml } from "../src/analysis/renderGraph";

const fixtureRoot = path.resolve(__dirname, "fixtures", "vc6-sample");
const projectFile = path.join(fixtureRoot, "sample.dsw");
const threadMapFile = path.join(fixtureRoot, "thread-map.json");

describe("renderGraphHtml", () => {
  it("renders review sections with relative paths instead of long graph IDs", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, maxIndexWorkers: 1 });
    const impact = buildImpact(index, "g_counter");
    const html = renderGraphHtml(impact, { workspaceRoot: fixtureRoot, mode: "standalone" });

    expect(html).toContain("Read / Writeアクセス");
    expect(html).toContain("src/main.cpp:");
    expect(html).not.toContain(fixtureRoot.replace(/\\/g, "/"));
    expect(html).not.toContain(fixtureRoot.replace(/\//g, "\\"));
    expect(html).not.toContain("target:g_counter");
    expect(html).not.toContain("function:WorkerThread");
  });

  it("adds source jump attributes in webview mode", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, maxIndexWorkers: 1 });
    const impact = buildImpact(index, "g_counter");
    const html = renderGraphHtml(impact, { workspaceRoot: fixtureRoot, mode: "webview", nonce: "abc123" });

    expect(html).toContain('data-file="');
    expect(html).toContain('data-line="');
    expect(html).toContain("acquireVsCodeApi");
    expect(html).toContain("src/main.cpp:");
  });

  it("renders struct member targets with relative locations", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, maxIndexWorkers: 1 });
    const impact = buildImpact(index, "g_deviceState.counter");
    const html = renderGraphHtml(impact, { workspaceRoot: fixtureRoot, mode: "standalone" });

    expect(impact.symbolKind).toBe("member");
    expect(html).toContain("g_deviceState.counter");
    expect(html).toContain("src/main.cpp:");
    expect(html).not.toContain(fixtureRoot.replace(/\\/g, "/"));
  });

  it("renders accesses as wrapped review rows instead of a cramped multi-column table", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, maxIndexWorkers: 1 });
    const impact = buildImpact(index, "g_counter");
    const html = renderGraphHtml(impact, { workspaceRoot: fixtureRoot, mode: "standalone" });

    expect(html).toContain('class="access-list"');
    expect(html).toContain('class="access-card"');
    expect(html).toContain("access-evidence");
  });
});
