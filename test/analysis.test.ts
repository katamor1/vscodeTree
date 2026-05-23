import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/analysis/impact";
import { assertReadableTargetUnchanged, buildFullIndex, updateIndex, verifySignaturesUnchanged } from "../src/analysis/indexer";
import { renderMarkdownReport, writeReviewReport } from "../src/analysis/report";
import { analyzeFileStructure, scanFileStructure } from "../src/analysis/sourceScanner";
import { parseVc6Project } from "../src/analysis/vc6ProjectParser";

const fixtureRoot = path.resolve(__dirname, "fixtures", "vc6-sample");
const projectFile = path.join(fixtureRoot, "sample.dsw");
const threadMapFile = path.join(fixtureRoot, "thread-map.json");

describe("VC6 project parsing", () => {
  it("reads source files, include paths, and macros from DSW/DSP", async () => {
    const project = await parseVc6Project(fixtureRoot, projectFile);

    expect(project.sourceFiles.map((file) => path.basename(file)).sort()).toEqual([
      "device.cpp",
      "globals.h",
      "main.cpp"
    ]);
    expect(project.includePaths.some((includePath) => includePath.endsWith("/src"))).toBe(true);
    expect(project.macros).toContain("WIN32");
  });
});

describe("hybrid impact index", () => {
  it("detects global read/write access, thread reachability, and risk candidates", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "g_counter");

    expect(index.globals.g_counter?.length).toBeGreaterThan(0);
    expect(index.build.phaseDurationsMs.structureScan).toBeGreaterThanOrEqual(0);
    expect(index.build.phaseDurationsMs.accessAnalysis).toBeGreaterThanOrEqual(0);
    expect(index.build.workerCount).toBeGreaterThanOrEqual(1);
    expect(impact.symbolKind).toBe("global");
    expect(impact.accesses.some((access) => access.kind === "write" && access.functionName === "WorkerThread")).toBe(true);
    expect(impact.accesses.some((access) => access.kind === "write" && access.functionName === "InterruptHandler")).toBe(true);
    expect(impact.threadContexts.some((context) => context.threadIds.includes("worker"))).toBe(true);
    expect(impact.threadContexts.some((context) => context.interruptLikeThreadIds.includes("irq"))).toBe(true);
    expect(impact.risks.map((risk) => risk.code)).toEqual(
      expect.arrayContaining(["MULTI_THREAD_WRITE", "CROSS_THREAD_READ_WRITE", "INTERRUPT_CONTEXT"])
    );
  });

  it("keeps pointer alias uncertainty as unresolved review evidence", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "g_mode");

    expect(impact.unresolved.map((item) => item.kind)).toContain("address-taken");
    expect(impact.risks.map((risk) => risk.code)).toContain("POINTER_ALIAS");
  });

  it("renders Japanese Markdown and HTML reports outside the target source tree", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-"));
    const before = await assertReadableTargetUnchanged([
      path.join(fixtureRoot, "src", "globals.h"),
      path.join(fixtureRoot, "src", "main.cpp"),
      path.join(fixtureRoot, "src", "device.cpp")
    ]);
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "g_counter");
    const markdownPath = path.join(outputDir, "reports", "g_counter.md");
    const htmlPath = path.join(outputDir, "reports", "g_counter.html");

    await writeReviewReport(index, impact, markdownPath, htmlPath);

    const markdown = await fs.readFile(markdownPath, "utf8");
    const html = await fs.readFile(htmlPath, "utf8");
    expect(markdown).toContain("# 変更影響レビュー: g_counter");
    expect(markdown).toContain("## 干渉リスク候補");
    expect(html).toContain("変更影響グラフ: g_counter");
    expect(markdownPath.startsWith(fixtureRoot)).toBe(false);
    await expect(verifySignaturesUnchanged(before)).resolves.toEqual({ ok: true, changed: [] });
  });

  it("supports update mode and reuses unchanged file analyses when symbol sets are stable", async () => {
    const tempRoot = await copyFixtureToTemp();
    const tempProject = path.join(tempRoot, "sample.dsw");
    const tempThreadMap = path.join(tempRoot, "thread-map.json");
    const first = await buildFullIndex({ workspaceRoot: tempRoot, projectFile: tempProject, threadMapFile: tempThreadMap });

    const mainCpp = path.join(tempRoot, "src", "main.cpp");
    const original = await fs.readFile(mainCpp, "utf8");
    await fs.writeFile(mainCpp, original.replace("g_mode = 2;", "g_mode = 3;"), "utf8");

    const updated = await updateIndex(
      { workspaceRoot: tempRoot, projectFile: tempProject, threadMapFile: tempThreadMap },
      first
    );

    expect(updated.build.mode).toBe("update");
    expect(updated.build.changedFiles).toHaveLength(1);
    expect(updated.build.reusedFiles).toBeGreaterThan(0);
    expect(updated.build.fullRebuildReason).toBeUndefined();
  });

  it("produces the same core index shape with explicit single-worker and auto-worker options", async () => {
    const singleWorker = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, maxIndexWorkers: 1 });
    const autoWorker = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, maxIndexWorkers: 2 });

    expect(Object.keys(singleWorker.globals).sort()).toEqual(Object.keys(autoWorker.globals).sort());
    expect(Object.keys(singleWorker.functions).sort()).toEqual(Object.keys(autoWorker.functions).sort());
    expect(singleWorker.functions.WorkerThread.accesses).toEqual(autoWorker.functions.WorkerThread.accesses);
  });

  it("tracks struct member access through direct, array, and pointer-alias expressions", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const counterImpact = buildImpact(index, "g_deviceState.counter");
    const arrayImpact = buildImpact(index, "g_devices[].status");

    expect(index.memberSymbols["g_deviceState.counter"]?.length).toBeGreaterThan(0);
    expect(counterImpact.symbolKind).toBe("member");
    expect(counterImpact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ functionName: "WorkerThread", kind: "write", variableName: "g_deviceState.counter" }),
        expect.objectContaining({ functionName: "InterruptHandler", kind: "write", variableName: "g_deviceState.counter" }),
        expect.objectContaining({ functionName: "MonitorThread", kind: "read", variableName: "g_deviceState.counter" })
      ])
    );
    expect(counterImpact.threadContexts.some((context) => context.threadIds.includes("worker"))).toBe(true);
    expect(counterImpact.threadContexts.some((context) => context.interruptLikeThreadIds.includes("irq"))).toBe(true);
    expect(counterImpact.risks.map((risk) => risk.code)).toEqual(
      expect.arrayContaining(["MULTI_THREAD_WRITE", "CROSS_THREAD_READ_WRITE", "INTERRUPT_CONTEXT"])
    );

    expect(arrayImpact.symbolKind).toBe("member");
    expect(arrayImpact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ functionName: "MonitorThread", kind: "write", variableName: "g_devices[].status" })
      ])
    );
  });

  it("keeps unresolved typed pointer member access as review evidence", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const unresolved = index.functions.PointerMemberUnknown.unresolved;

    expect(unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unknown-member-access",
          variableName: "DEVICE_STATE::mode"
        })
      ])
    );
  });

  it("renders struct member impact in Japanese Markdown reports", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "g_deviceState.counter");
    const report = renderMarkdownReport(index, impact);

    expect(report).toContain("- 種別: 構造体メンバ");
    expect(report).toContain("member `g_deviceState.counter`");
    expect(report).toContain("WRITE `g_deviceState.counter`");
    expect(report).toContain("src/main.cpp:");
  });
});

describe("function impact", () => {
  it("shows variables and callers/callees around a selected function", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "CommonUpdate", 2);
    const report = renderMarkdownReport(index, impact);

    expect(impact.symbolKind).toBe("function");
    expect(impact.functions.map((func) => func.name)).toContain("WorkerThread");
    expect(impact.accesses.map((access) => access.variableName)).toContain("g_counter");
    expect(report).toContain("function `CommonUpdate`");
  });
});

async function copyFixtureToTemp(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-fixture-"));
  await fs.cp(fixtureRoot, tempRoot, { recursive: true });
  return tempRoot;
}

describe("source token analysis", () => {
  it("ignores identifiers inside comments and strings during access analysis", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-token-"));
    const file = path.join(tempRoot, "token.cpp");
    await fs.writeFile(
      file,
      [
        "int g_value = 0;",
        "void TokenCase(void)",
        "{",
        "    const char *text = \"g_value++;\";",
        "    // g_value = 10;",
        "    g_value++;",
        "}"
      ].join("\n"),
      "utf8"
    );
    const structure = await scanFileStructure(file);
    const analysis = analyzeFileStructure(structure, new Set(["g_value"]), new Map([["TokenCase", ["TokenCase"]]]));

    expect(analysis.functions[0]?.accesses).toHaveLength(1);
    expect(analysis.functions[0]?.accesses[0]?.kind).toBe("write");
  });
});
