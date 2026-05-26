import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/analysis/impact";
import { assertReadableTargetUnchanged, buildFullIndex, updateIndex, verifySignaturesUnchanged } from "../src/analysis/indexer";
import { renderMarkdownReport, writeReviewReport } from "../src/analysis/report";
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

describe("Rust native impact index", () => {
  it("detects global read/write access, thread reachability, and risk candidates", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "g_counter");

    expect(index.build.parserMode).toBe("rust");
    expect(index.parserDiagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("low-memory analyze-many");
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
    expect(markdown).toContain("- HTML図: [reports/g_counter.html](g_counter.html)");
    expect(markdown).toContain("[src/main.cpp:");
    expect(markdown).not.toContain("file://");
    expect(markdown).not.toContain(fixtureRoot.replace(/\\/g, "/"));
    expect(html).toContain("変更影響グラフ: g_counter");
    expect(markdownPath.startsWith(fixtureRoot)).toBe(false);
    await expect(verifySignaturesUnchanged(before)).resolves.toEqual({ ok: true, changed: [] });
  });

  it("uses Rust native full reanalysis for changed-file update mode", async () => {
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
    expect(updated.build.changedFiles).toContain(path.join(tempRoot, "src", "main.cpp").replace(/\\/g, "/"));
    expect(updated.build.reusedFiles).toBe(0);
    expect(updated.build.fullRebuildReason).toBe("rust-native-update-rebuild");
    expect(updated.build.parserMode).toBe("rust");
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

  it("keeps member impact unresolved evidence scoped to exact target or direct parent", async () => {
    const sample2 = await createSample2ImpactFixture();
    const index = await buildFullIndex({
      workspaceRoot: sample2.root,
      projectFile: sample2.projectFile,
      threadMapFile: sample2.threadMapFile,
      maxIndexWorkers: 1
    });
    const impact = buildImpact(index, "PTR_GBL->sub3.sample_value1");
    const unresolvedNames = impact.unresolved.map((item) => item.variableName);
    const unresolvedEvidence = impact.unresolved.map((item) => item.evidence);

    expect(impact.symbolKind).toBe("member");
    expect(impact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variableName: "PTR_GBL->sub3.sample_value1", kind: "read" }),
        expect.objectContaining({ variableName: "PTR_GBL->sub3.sample_value1", kind: "write" })
      ])
    );
    expect(unresolvedNames).toContain("PTR_GBL->sub3");
    expect(unresolvedEvidence).toContain("thread_sub1ptr(&PTR_GBL->sub3);");
    expect(unresolvedNames).not.toContain("subLocal");
    expect(unresolvedNames).not.toContain("PTR_GBL->sub2.sample_value2");
    expect(unresolvedNames).not.toContain("PTR_GBL->sub3.sample_value3");
    expect(unresolvedEvidence).not.toContain("PTR_GBL->sub4.subsub_ptr = &subLocal;");
    expect(unresolvedEvidence).not.toContain("subPtr.sample_value2 = &PTR_GBL->sub2.sample_value2;");
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

  it("tracks object-like define aliases as macro impact targets", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const macroImpact = buildImpact(index, "DEVICE_COUNTER_ALIAS");
    const memberImpact = buildImpact(index, "g_deviceState.counter");

    expect(index.macroDefinitions.DEVICE_COUNTER_ALIAS?.[0]).toEqual(
      expect.objectContaining({ replacement: "g_deviceState.counter", isFunctionLike: false })
    );
    expect(index.macroAliases.DEVICE_COUNTER_ALIAS?.[0]).toEqual(
      expect.objectContaining({ targetName: "g_deviceState.counter", targetKind: "member" })
    );
    expect(index.macroAliases.GLOBALS_H).toBeUndefined();
    expect(macroImpact.symbolKind).toBe("macro");
    expect(macroImpact.macros).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "DEVICE_COUNTER_ALIAS", targetName: "g_deviceState.counter" })
      ])
    );
    expect(macroImpact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionName: "MacroAliasUse",
          kind: "read",
          variableName: "g_deviceState.counter",
          macroNames: expect.arrayContaining(["DEVICE_COUNTER_ALIAS"])
        })
      ])
    );
    expect(memberImpact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionName: "MacroAliasUse",
          variableName: "g_deviceState.counter",
          macroNames: expect.arrayContaining(["DEVICE_COUNTER_ALIAS"])
        })
      ])
    );
  });

  it("fails clearly when the Rust sidecar is unavailable instead of falling back", async () => {
    const previous = process.env.VC6_IMPACT_RUST_SIDECAR;
    process.env.VC6_IMPACT_RUST_SIDECAR = path.join(os.tmpdir(), `missing-vc6-impact-rust-${Date.now()}.exe`);
    try {
      await expect(buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile })).rejects.toThrow(
        /Rust sidecar is not built/
      );
    } finally {
      if (previous === undefined) {
        delete process.env.VC6_IMPACT_RUST_SIDECAR;
      } else {
        process.env.VC6_IMPACT_RUST_SIDECAR = previous;
      }
    }
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

async function createSample2ImpactFixture(): Promise<{ root: string; projectFile: string; threadMapFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-sample2-impact-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const projectFile = path.join(root, "sample2_base.dsw");
  const threadMapFile = path.join(root, "thread-map.json");
  await fs.writeFile(
    projectFile,
    'Microsoft Developer Studio Workspace File, Format Version 6.00\r\nProject: "sample2_base"=".\\sample2_base.dsp" - Package Owner=<4>\r\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "sample2_base.dsp"),
    [
      '# Microsoft Developer Studio Project File - Name="sample2_base" - Package Owner=<4>',
      '# ADD CPP /nologo /W3 /I ".\\src" /D "WIN32" /D "PERF_SAMPLE2_BASE" /D "_DEBUG" /c',
      '# Begin Source File',
      'SOURCE=.\\src\\main.c',
      '# End Source File',
      '# Begin Source File',
      'SOURCE=.\\src\\header.h',
      '# End Source File',
      '# Begin Source File',
      'SOURCE=.\\src\\api.c',
      '# End Source File',
      ''
    ].join("\r\n"),
    "utf8"
  );
  await fs.writeFile(
    threadMapFile,
    JSON.stringify({
      threads: [
        { threadId: "main", entryFunction: "thread_main_entry" },
        { threadId: "worker3", entryFunction: "thread3_entry", isInterruptLike: true }
      ]
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "header.h"),
    [
      "typedef struct tagSampleSubSub { int sample_value1; int sample_value2; int sample_value3; } SAMPLE_SUBSUB;",
      "typedef struct tagSampleSub4 { SAMPLE_SUBSUB *subsub_ptr; } SAMPLE_SUB4;",
      "typedef struct tagSampleMain { SAMPLE_SUBSUB sub1; SAMPLE_SUBSUB sub2; SAMPLE_SUBSUB sub3; SAMPLE_SUB4 sub4; } SAMPLE_MAIN;",
      "typedef struct tagSampleSubPtr { int *sample_value1; int *sample_value2; int *sample_value3; } SAMPLE_SUBPTR;",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "api.c"),
    [
      '#include "header.h"',
      "extern SAMPLE_MAIN* PTR_GBL;",
      "int api_major3_sub1(int minor) { return PTR_GBL->sub3.sample_value1 + minor; }",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "main.c"),
    [
      '#include "header.h"',
      "SAMPLE_SUBSUB subLocal = {0};",
      "SAMPLE_MAIN* PTR_GBL = 0;",
      "void thread_sub1ptr(SAMPLE_SUBSUB *ptr) { ptr->sample_value1++; }",
      "void thread_main_entry(void) {",
      "    SAMPLE_SUBPTR subPtr;",
      "    PTR_GBL->sub4.subsub_ptr = &subLocal;",
      "    subPtr.sample_value2 = &PTR_GBL->sub2.sample_value2;",
      "    subPtr.sample_value3 = &PTR_GBL->sub3.sample_value3;",
      "    PTR_GBL->sub3.sample_value1++;",
      "}",
      "void thread3_entry(void) {",
      "    thread_sub1ptr(&PTR_GBL->sub3);",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  return { root, projectFile, threadMapFile };
}
