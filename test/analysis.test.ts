import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/analysis/impact";
import { assertReadableTargetUnchanged, buildFullIndex, buildFullIndexToStorage, updateIndex, updateIndexToStorage, verifySignaturesUnchanged } from "../src/analysis/indexer";
import { renderMarkdownReport, writeReviewReport } from "../src/analysis/report";
import { readIndex, readIndexForSymbol } from "../src/analysis/store";
import type { AnalysisIndex, FunctionInfo } from "../src/analysis/types";
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

  it("defaults to the Release CFG branch and avoids debug or source-local test macros", async () => {
    const fixture = await createReleaseConfigurationFixture();
    const project = await parseVc6Project(fixture.root, fixture.projectFile);

    expect(project.sourceFiles.map((file) => path.basename(file))).toEqual(["main.cpp"]);
    expect(project.includePaths.some((includePath) => includePath.endsWith("/src"))).toBe(true);
    expect(project.macros).toEqual(["NDEBUG", "WIN32"]);
  });
});

describe("Impact index", () => {
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

  it("writes Rust production indexes with a function sidecar and hydrates symbols on demand", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-prod-index-"));
    const indexPath = path.join(outputDir, "vc6-impact-index.json");

    const written = await buildFullIndexToStorage({
      workspaceRoot: fixtureRoot,
      projectFile,
      threadMapFile,
      parserEngine: "rust",
      maxIndexWorkers: 1
    }, indexPath);

    expect(written.storage?.layout).toBe("split-v1");
    expect(written.functions).toEqual({});
    await expect(fs.readFile(path.join(outputDir, "vc6-impact-index.functions.jsonl"), "utf8")).resolves.toContain("WorkerThread");
    const stored = await readIndex(indexPath);
    expect(stored?.functions).toEqual({});

    const hydrated = await readIndexForSymbol(indexPath, "g_counter");
    expect(hydrated).toBeDefined();
    const impact = buildImpact(hydrated!, "g_counter");
    expect(impact.accesses.some((access) => access.kind === "write" && access.functionName === "WorkerThread")).toBe(true);
    const hydratedFunction = await readIndexForSymbol(indexPath, "WorkerThread");
    expect(hydratedFunction?.functions.WorkerThread.accesses).toEqual([]);
    expect(
      Object.values(hydratedFunction?.functions ?? {}).flatMap((func) => func.unresolved.map((item) => item.kind))
    ).toEqual([]);
    const hydratedFunctionPointer = await readIndexForSymbol(indexPath, "DevicePump");
    expect(hydratedFunctionPointer?.functions.DevicePump.unresolved.map((item) => item.kind)).toEqual(["function-pointer"]);
  });

  it("rebuilds a split production index when the function sidecar is missing", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-prod-index-"));
    const indexPath = path.join(outputDir, "vc6-impact-index.json");
    const first = await buildFullIndexToStorage({
      workspaceRoot: fixtureRoot,
      projectFile,
      threadMapFile,
      parserEngine: "rust",
      maxIndexWorkers: 1
    }, indexPath);
    const sidecarPath = path.join(outputDir, "vc6-impact-index.functions.jsonl");
    await fs.rm(sidecarPath, { force: true });

    const updated = await updateIndexToStorage({
      workspaceRoot: fixtureRoot,
      projectFile,
      threadMapFile,
      parserEngine: "rust",
      maxIndexWorkers: 1
    }, first, indexPath);

    expect(updated.build.fullRebuildReason).toBe("function-sidecar-missing");
    await expect(fs.readFile(sidecarPath, "utf8")).resolves.toContain("WorkerThread");
  });

  it("can build comparable JSON indexes with TypeScript and clang fallback engines", async () => {
    const rust = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, parserEngine: "rust" });
    const typescript = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, parserEngine: "typescript" });
    const clang = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, parserEngine: "clang" });

    expect(typescript.build.parserMode).toBe("typescript");
    expect(clang.build.parserMode).toBe("clang");
    expect(typescript.parserDiagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("typescript parser backend");
    expect(clang.parserDiagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(/clang/);
    expect(typescript.build.phaseDurationsMs.typescriptFileConcurrency).toBe(3);
    expect(clang.build.phaseDurationsMs.clangFileConcurrency).toBe(3);
    expect(coreQualitySummary(typescript)).toEqual(coreQualitySummary(rust));
    expect(coreQualitySummary(clang)).toEqual(coreQualitySummary(rust));
  }, 60000);

  it("bounds TypeScript fallback file opens through maxIndexWorkers", async () => {
    const index = await buildFullIndex({
      workspaceRoot: fixtureRoot,
      projectFile,
      threadMapFile,
      parserEngine: "typescript",
      maxIndexWorkers: 2
    });

    expect(index.build.phaseDurationsMs.typescriptFileConcurrency).toBe(2);
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
  }, 30000);

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

  it("finds nested array member accesses selected from source text", async () => {
    const sample2 = await createSample2ImpactFixture();
    const index = await buildFullIndex({
      workspaceRoot: sample2.root,
      projectFile: sample2.projectFile,
      threadMapFile: sample2.threadMapFile,
      maxIndexWorkers: 1
    });
    const impact = buildImpact(index, "PTR_GBL->sub4.subsub[].sample_value1");

    expect(index.memberSymbols["PTR_GBL->sub4.subsub[].sample_value1"]?.length).toBeGreaterThan(0);
    expect(impact.symbolKind).toBe("member");
    expect(impact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ functionName: "api_major4_subsub", variableName: "PTR_GBL->sub4.subsub[].sample_value1", kind: "read" }),
        expect.objectContaining({ functionName: "thread_main_entry", variableName: "PTR_GBL->sub4.subsub[].sample_value1", kind: "write" })
      ])
    );
  });

  it.each(["typescript", "rust"] as const)("resolves typed pointer parameter member selections through caller arguments with %s backend", async (parserEngine) => {
    const sample2 = await createSample2ImpactFixture();
    const index = await buildFullIndex({
      workspaceRoot: sample2.root,
      projectFile: sample2.projectFile,
      threadMapFile: sample2.threadMapFile,
      parserEngine,
      maxIndexWorkers: 1
    });
    const impact = buildImpact(index, "ptr->sample_value1");

    expect(impact.symbolKind).toBe("member");
    expect(impact.members.map((member) => member.name)).toEqual(
      expect.arrayContaining(["PTR_GBL->sub1.sample_value1", "PTR_GBL->sub3.sample_value1"])
    );
    expect(impact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionName: "thread_sub1ptr",
          variableName: "SAMPLE_SUBSUB::sample_value1",
          kind: "write"
        }),
        expect.objectContaining({
          functionName: "thread1_entry",
          variableName: "PTR_GBL->sub1.sample_value1",
          targetName: "SAMPLE_SUBSUB::sample_value1",
          kind: "write",
          reasons: expect.arrayContaining(["call-argument-alias"])
        }),
        expect.objectContaining({
          functionName: "thread3_entry",
          variableName: "PTR_GBL->sub3.sample_value1",
          targetName: "SAMPLE_SUBSUB::sample_value1",
          kind: "write",
          reasons: expect.arrayContaining(["call-argument-alias"])
        })
      ])
    );
  }, 60000);

  it.each(["typescript", "rust"] as const)("tracks function-like define macros as member impact targets with %s backend", async (parserEngine) => {
    const sample2 = await createSample2ImpactFixture();
    const index = await buildFullIndex({
      workspaceRoot: sample2.root,
      projectFile: sample2.projectFile,
      threadMapFile: sample2.threadMapFile,
      parserEngine,
      maxIndexWorkers: 1
    });
    const macroImpact = buildImpact(index, "SUB4_ARRAY");
    const memberImpact = buildImpact(index, "PTR_GBL->sub4.subsub[].sample_value[]");

    expect(index.macroAliases.SUB4_ARRAY?.[0]).toEqual(
      expect.objectContaining({
        targetName: "PTR_GBL->sub4.subsub[].sample_value[]",
        targetKind: "member",
        isFunctionLike: true
      })
    );
    expect(macroImpact.symbolKind).toBe("macro");
    expect(macroImpact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionName: "thread_main_entry",
          variableName: "PTR_GBL->sub4.subsub[].sample_value[]",
          kind: "write",
          macroNames: expect.arrayContaining(["SUB4_ARRAY"])
        })
      ])
    );
    expect(memberImpact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionName: "thread_main_entry",
          variableName: "PTR_GBL->sub4.subsub[].sample_value[]",
          kind: "write",
          macroNames: expect.arrayContaining(["SUB4_ARRAY"])
        })
      ])
    );
  }, 60000);

  it("exposes nested pointer-global member declarations and accesses with clang fallback", async () => {
    const sample2 = await createSample2ImpactFixture();
    const index = await buildFullIndex({
      workspaceRoot: sample2.root,
      projectFile: sample2.projectFile,
      threadMapFile: sample2.threadMapFile,
      parserEngine: "clang",
      maxIndexWorkers: 1
    });
    const impact = buildImpact(index, "PTR_GBL->sub1.sample_value1");

    expect(index.memberSymbols["PTR_GBL->sub1.sample_value1"]?.length).toBeGreaterThan(0);
    expect(impact.symbolKind).toBe("member");
    expect(impact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variableName: "PTR_GBL->sub1.sample_value1", kind: "read" }),
        expect.objectContaining({ variableName: "PTR_GBL->sub1.sample_value1", kind: "write" })
      ])
    );
  }, 30000);

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

  it("does not require the Rust sidecar when TypeScript fallback is selected", async () => {
    const previous = process.env.VC6_IMPACT_RUST_SIDECAR;
    process.env.VC6_IMPACT_RUST_SIDECAR = path.join(os.tmpdir(), `missing-vc6-impact-rust-${Date.now()}.exe`);
    try {
      const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile, parserEngine: "typescript" });
      expect(index.build.parserMode).toBe("typescript");
      expect(index.globals.g_counter?.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) {
        delete process.env.VC6_IMPACT_RUST_SIDECAR;
      } else {
        process.env.VC6_IMPACT_RUST_SIDECAR = previous;
      }
    }
  });

  it("keeps unknown member impact scoped to the requested access symbol", async () => {
    const fixture = await createSingleFileProject([
      "typedef struct tagLeaf { int value; } LEAF;",
      "typedef struct tagChild { LEAF* ptr; } CHILD;",
      "typedef struct tagMain { CHILD child; } MAIN;",
      "MAIN* PTR_GBL;",
      "int g_other;",
      "void Worker(void) {",
      "  PTR_GBL->child.ptr->value++;",
      "  g_other++;",
      "}"
    ]);
    const index = await buildFullIndex({ workspaceRoot: fixture.root, projectFile: fixture.projectFile, parserEngine: "rust", maxIndexWorkers: 1 });
    const impact = buildImpact(index, "PTR_GBL->child.ptr->value");

    expect(impact.symbolKind).toBe("unknown");
    expect(impact.accesses.map((access) => access.variableName)).toEqual(["PTR_GBL->child.ptr->value"]);
  });

  it("classifies whitespace-separated TypeScript member expressions without leaking owner globals", async () => {
    const fixture = await createSingleFileProject([
      "typedef struct tagSub { int value; } SUB;",
      "typedef struct tagMain { SUB sub1; } MAIN;",
      "MAIN* PTR_GBL;",
      "void Worker(void) {",
      "  PTR_GBL -> sub1 . value++;",
      "}"
    ]);
    const index = await buildFullIndex({ workspaceRoot: fixture.root, projectFile: fixture.projectFile, parserEngine: "typescript", maxIndexWorkers: 1 });
    const accesses = index.functions.Worker.accesses;

    expect(accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variableName: "PTR_GBL->sub1.value",
          kind: "write",
          reasons: expect.arrayContaining(["increment-decrement"])
        })
      ])
    );
    expect(accesses.map((access) => access.variableName)).not.toContain("PTR_GBL");
  });

  it("tracks the release side through nested test-code conditionals", async () => {
    const fixture = await createReleaseConfigurationFixture();
    const index = await buildFullIndex({
      workspaceRoot: fixture.root,
      projectFile: fixture.projectFile,
      parserEngine: "typescript",
      projectConfiguration: "Release",
      maxIndexWorkers: 1
    });

    expect(index.macros).toEqual(["NDEBUG", "WIN32"]);
    expect(Object.keys(index.functions).sort()).toEqual(["ReleaseOnly"]);
    expect(index.globals.g_release?.length).toBe(1);
    expect(index.globals.g_test).toBeUndefined();
  });

  it.each(["typescript", "rust"] as const)("applies header macro define/undef in include order with %s backend", async (parserEngine) => {
    const fixture = await createIncludeOrderFixture();
    const index = await buildFullIndex({
      workspaceRoot: fixture.root,
      projectFile: fixture.projectFile,
      parserEngine,
      projectConfiguration: "Release",
      maxIndexWorkers: 1
    });

    expect(index.includePaths.some((includePath) => includePath.endsWith("/include"))).toBe(true);
    expect(Object.keys(index.functions).sort()).toEqual(["EnabledAfterSecondInclude", "ReleasePath"]);
    expect(index.globals.g_release?.length).toBe(1);
    expect(index.globals.g_wrong).toBeUndefined();
  }, 60000);

  it.each(["typescript", "rust"] as const)("indexes EXTERN macro globals from included headers omitted from the DSP with %s backend", async (parserEngine) => {
    const fixture = await createExternHeaderFixture();
    const index = await buildFullIndex({
      workspaceRoot: fixture.root,
      projectFile: fixture.projectFile,
      parserEngine,
      projectConfiguration: "Release",
      maxIndexWorkers: 1
    });
    const impact = buildImpact(index, "g_numptr");

    expect(index.projectFiles.map((file) => path.basename(file)).sort()).toEqual(["gbl_val001.h", "main.c", "worker.c"]);
    expect(index.globals.g_numptr).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "g_numptr",
          file: path.join(fixture.root, "src", "gbl_val001.h").replace(/\\/g, "/")
        })
      ])
    );
    expect(impact.symbolKind).toBe("global");
    expect(impact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ functionName: "MainEntry", kind: "write", variableName: "g_numptr" }),
        expect.objectContaining({ functionName: "WorkerEntry", kind: "read", variableName: "g_numptr" })
      ])
    );
  }, 60000);
});

describe("function impact", () => {
  it("does not reverse traversal direction for related functions, threads, or edges", () => {
    const index = createDirectionalFunctionIndex();
    const impact = buildImpact(index, "Target", 3);

    expect(impact.functions.map((func) => func.name)).toEqual([
      "Callee",
      "Caller",
      "GrandCallee",
      "GrandCaller",
      "Target"
    ]);
    expect(impact.threadContexts.map((context) => context.functionName)).toEqual([
      "Callee",
      "Caller",
      "GrandCallee",
      "GrandCaller",
      "Target"
    ]);
    expect(impact.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "function:GrandCaller", label: "calls", to: "function:Caller" }),
        expect.objectContaining({ from: "function:Caller", label: "calls", to: "function:Target" }),
        expect.objectContaining({ from: "function:Target", label: "calls", to: "function:Callee" }),
        expect.objectContaining({ from: "function:Callee", label: "calls", to: "function:GrandCallee" })
      ])
    );
    expect(impact.functions.map((func) => func.name)).not.toContain("CallerOnlyCallee");
    expect(impact.functions.map((func) => func.name)).not.toContain("CalleeOtherCaller");
    expect(impact.threadContexts.map((context) => context.functionName)).not.toContain("CallerOnlyCallee");
    expect(impact.threadContexts.map((context) => context.functionName)).not.toContain("CalleeOtherCaller");
    expect(impact.graph.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "function:Caller", label: "calls", to: "function:CallerOnlyCallee" }),
        expect.objectContaining({ from: "function:CalleeOtherCaller", label: "calls", to: "function:Callee" })
      ])
    );
  });

  it("focuses on call relationships and thread context without expanding variable accesses", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "CommonUpdate", 2);
    const report = renderMarkdownReport(index, impact);

    expect(impact.symbolKind).toBe("function");
    expect(impact.functions.map((func) => func.name)).toContain("WorkerThread");
    expect(impact.functions.every((func) => func.accesses.length === 0)).toBe(true);
    expect(impact.threadContexts.map((context) => context.functionName)).toContain("WorkerThread");
    expect(impact.accesses).toEqual([]);
    expect(impact.unresolved).toEqual([]);
    expect(impact.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "function:WorkerThread", label: "calls", to: "function:CommonUpdate" })
      ])
    );
    expect(report).toContain("function `CommonUpdate`");
    expect(report).toContain("関数調査では変数アクセスを展開しません");
    expect(report).not.toContain("READ `g_counter`");
    expect(report).not.toContain("address-taken");
  });

  it("keeps function-pointer unresolved evidence but not variable-chain unresolved evidence for function impact", async () => {
    const index = await buildFullIndex({ workspaceRoot: fixtureRoot, projectFile, threadMapFile });
    const impact = buildImpact(index, "DevicePump", 1);
    const report = renderMarkdownReport(index, impact);

    expect(impact.symbolKind).toBe("function");
    expect(impact.accesses).toEqual([]);
    expect(impact.unresolved.map((item) => item.kind)).toEqual(["function-pointer"]);
    expect(report).toContain("function-pointer");
    expect(report).not.toContain("address-taken");
  });
});

async function copyFixtureToTemp(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-fixture-"));
  await fs.cp(fixtureRoot, tempRoot, { recursive: true });
  return tempRoot;
}

function createDirectionalFunctionIndex(): AnalysisIndex {
  const functionNames = [
    "Target",
    "Caller",
    "GrandCaller",
    "CallerOnlyCallee",
    "Callee",
    "GrandCallee",
    "CalleeOtherCaller"
  ];
  const functions = Object.fromEntries(functionNames.map((name) => [name, createFunctionInfo(name)]));
  functions.Target.calls = ["Callee"];
  functions.Caller.calls = ["Target", "CallerOnlyCallee"];
  functions.GrandCaller.calls = ["Caller"];
  functions.Callee.calls = ["GrandCallee"];
  functions.CalleeOtherCaller.calls = ["Callee"];
  return {
    version: 1,
    generatedAt: "2026-06-09T00:00:00.000Z",
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
    functions,
    callGraph: {
      Target: ["Callee"],
      Caller: ["Target", "CallerOnlyCallee"],
      GrandCaller: ["Caller"],
      CallerOnlyCallee: [],
      Callee: ["GrandCallee"],
      GrandCallee: [],
      CalleeOtherCaller: ["Callee"]
    },
    calledBy: {
      Target: ["Caller"],
      Caller: ["GrandCaller"],
      GrandCaller: [],
      CallerOnlyCallee: ["Caller"],
      Callee: ["Target", "CalleeOtherCaller"],
      GrandCallee: ["Callee"],
      CalleeOtherCaller: []
    },
    threads: functionNames.map((name) => ({ threadId: `thread-${name}`, entryFunction: name })),
    threadReachability: Object.fromEntries(functionNames.map((name) => [
      name,
      { functionName: name, threadIds: [`thread-${name}`], interruptLikeThreadIds: [] }
    ])),
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

function createFunctionInfo(name: string): FunctionInfo {
  return {
    name,
    file: "C:/tmp/project/main.cpp",
    startLine: 1,
    endLine: 1,
    signature: `void ${name}(void)`,
    calls: [],
    accesses: [],
    unresolved: []
  };
}

async function createSingleFileProject(sourceLines: string[]): Promise<{ root: string; projectFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-single-file-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const projectFile = path.join(root, "sample.dsw");
  await fs.writeFile(projectFile, 'Project: "sample"="sample.dsp" - Package Owner=<4>\r\n', "utf8");
  await fs.writeFile(path.join(root, "sample.dsp"), "SOURCE=.\\src\\main.cpp\r\n", "utf8");
  await fs.writeFile(path.join(root, "src", "main.cpp"), `${sourceLines.join("\n")}\n`, "utf8");
  return { root, projectFile };
}

async function createReleaseConfigurationFixture(): Promise<{ root: string; projectFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-release-config-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const projectFile = path.join(root, "sample.dsw");
  await fs.writeFile(projectFile, 'Project: "sample"=".\\sample.dsp" - Package Owner=<4>\r\n', "utf8");
  await fs.writeFile(
    path.join(root, "sample.dsp"),
    [
      '# Microsoft Developer Studio Project File - Name="sample" - Package Owner=<4>',
      '# Name "sample - Win32 Release"',
      '# Name "sample - Win32 Debug"',
      '!IF  "$(CFG)" == "sample - Win32 Release"',
      '# ADD CPP /nologo /W3 /I ".\\src" /D "WIN32" /D "NDEBUG" /c',
      '!ELSEIF  "$(CFG)" == "sample - Win32 Debug"',
      '# ADD CPP /nologo /W3 /I ".\\src" /D "WIN32" /D "_DEBUG" /D "TEST_CODE1" /c',
      '!ENDIF',
      '# Begin Source File',
      'SOURCE=.\\src\\main.cpp',
      '# End Source File',
      '# Begin Source File',
      'SOURCE=.\\src\\test_only.cpp',
      '!IF  "$(CFG)" == "sample - Win32 Release"',
      '# PROP Exclude_From_Build 1',
      '!ELSEIF  "$(CFG)" == "sample - Win32 Debug"',
      '# ADD CPP /D "TEST_CODE3"',
      '!ENDIF',
      '# End Source File',
      ''
    ].join("\r\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "main.cpp"),
    [
      "int g_release;",
      "#if defined (TEST_CODE1)",
      "int g_test;",
      "void TestOnly(void) { g_test++; }",
      "#ifndef TEST_CODE2",
      "#if 1",
      "void NestedTestOnly(void) { g_test++; }",
      "#endif",
      "#else",
      "void HeaderDefinedTestOnly(void) { g_test++; }",
      "#endif",
      "#ifdef TEST_CODE3",
      "void UnitTestOnly(void) { g_test++; }",
      "#endif",
      "#else",
      "void ReleaseOnly(void) { g_release++; }",
      "#endif",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "test_only.cpp"),
    [
      "#if defined(TEST_CODE1)",
      "void WholeFileTestOnly(void) {}",
      "#endif",
      ""
    ].join("\n"),
    "utf8"
  );
  return { root, projectFile };
}

async function createIncludeOrderFixture(): Promise<{ root: string; projectFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-include-order-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "include"), { recursive: true });
  const projectFile = path.join(root, "sample.dsw");
  await fs.writeFile(projectFile, 'Project: "sample"=".\\sample.dsp" - Package Owner=<4>\r\n', "utf8");
  await fs.writeFile(
    path.join(root, "sample.dsp"),
    [
      '# Microsoft Developer Studio Project File - Name="sample" - Package Owner=<4>',
      '# Name "sample - Win32 Release"',
      '# ADD CPP /nologo /W3 /I ".\\include" /D "WIN32" /D "NDEBUG" /c',
      '# Begin Source File',
      'SOURCE=.\\src\\main.cpp',
      '# End Source File',
      ''
    ].join("\r\n"),
    "utf8"
  );
  await fs.writeFile(path.join(root, "include", "macro_on.h"), "#define FEATURE_FLAG 1\n", "utf8");
  await fs.writeFile(path.join(root, "include", "macro_off.h"), "#undef FEATURE_FLAG\n", "utf8");
  await fs.writeFile(
    path.join(root, "src", "main.cpp"),
    [
      "int g_release;",
      '#include "macro_on.h"',
      '#include "macro_off.h"',
      "#ifdef FEATURE_FLAG",
      "int g_wrong;",
      "void WrongTest(void) { g_wrong++; }",
      "#else",
      "void ReleasePath(void) { g_release++; }",
      "#endif",
      '#include "macro_on.h"',
      "#ifdef FEATURE_FLAG",
      "void EnabledAfterSecondInclude(void) { g_release++; }",
      "#endif",
      ""
    ].join("\n"),
    "utf8"
  );
  return { root, projectFile };
}

async function createExternHeaderFixture(): Promise<{ root: string; projectFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-extern-header-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const projectFile = path.join(root, "sample.dsw");
  await fs.writeFile(projectFile, 'Project: "sample"=".\\sample.dsp" - Package Owner=<4>\r\n', "utf8");
  await fs.writeFile(
    path.join(root, "sample.dsp"),
    [
      '# Microsoft Developer Studio Project File - Name="sample" - Package Owner=<4>',
      '# Name "sample - Win32 Release"',
      '# ADD CPP /nologo /W3 /I ".\\src" /D "WIN32" /D "NDEBUG" /c',
      '# Begin Source File',
      'SOURCE=.\\src\\main.c',
      '# End Source File',
      '# Begin Source File',
      'SOURCE=.\\src\\worker.c',
      '# End Source File',
      ''
    ].join("\r\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "gbl_val001.h"),
    [
      "#undef EXTERN",
      "#ifndef MAIN",
      "#define EXTERN extern",
      "#else",
      "#define EXTERN",
      "#endif",
      "",
      "EXTERN int *g_numptr;",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "main.c"),
    [
      "#define MAIN",
      '#include "gbl_val001.h"',
      "void MainEntry(void) {",
      "  g_numptr = 0;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "worker.c"),
    [
      '#include "gbl_val001.h"',
      "int WorkerEntry(void) {",
      "  return g_numptr ? 1 : 0;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  return { root, projectFile };
}

function coreQualitySummary(index: Awaited<ReturnType<typeof buildFullIndex>>): Record<string, unknown> {
  return {
    globals: Object.keys(index.globals).sort(),
    functions: Object.keys(index.functions).sort(),
    macroAliases: Object.keys(index.macroAliases).sort(),
    counterAccesses: accessSummary(index, "g_counter"),
    memberAccesses: accessSummary(index, "g_deviceState.counter"),
    arrayMemberAccesses: accessSummary(index, "g_devices[].status"),
    pointerUnknown: index.functions.PointerMemberUnknown?.unresolved.map((item) => `${item.kind}:${item.variableName}`).sort() ?? []
  };
}

function accessSummary(index: Awaited<ReturnType<typeof buildFullIndex>>, symbolName: string): string[] {
  return buildImpact(index, symbolName).accesses
    .map((access) => `${access.functionName}:${access.kind}:${access.variableName}:${access.reasons.join("+")}:${access.macroNames?.join("+") ?? ""}`)
    .sort();
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
      "typedef struct tagSampleSubSub { int sample_value1; int sample_value2; int sample_value3; int sample_value[4]; } SAMPLE_SUBSUB;",
      "typedef struct tagSampleSub4 { SAMPLE_SUBSUB *subsub_ptr; SAMPLE_SUBSUB subsub[4]; } SAMPLE_SUB4;",
      "typedef struct tagSampleMain { SAMPLE_SUBSUB sub1; SAMPLE_SUBSUB sub2; SAMPLE_SUBSUB sub3; SAMPLE_SUB4 sub4; } SAMPLE_MAIN;",
      "typedef struct tagSampleSubPtr { int *sample_value1; int *sample_value2; int *sample_value3; } SAMPLE_SUBPTR;",
      "#define SUB4_ARRAY(i, j) PTR_GBL->sub4.subsub[i].sample_value[j]++;",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "api.c"),
    [
      '#include "header.h"',
      "extern SAMPLE_MAIN* PTR_GBL;",
      "int api_major1_sub1(int minor) { return PTR_GBL->sub1.sample_value1 + minor; }",
      "int api_major3_sub1(int minor) { return PTR_GBL->sub3.sample_value1 + minor; }",
      "int api_major4_subsub(int minor) { return PTR_GBL->sub4.subsub[minor].sample_value1; }",
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
      "    PTR_GBL->sub4.subsub[0].sample_value1++;",
      "    SUB4_ARRAY(0, 1);",
      "}",
      "void thread1_entry(void) {",
      "    thread_sub1ptr(&PTR_GBL->sub1);",
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
