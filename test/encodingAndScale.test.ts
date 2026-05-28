import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFullIndex } from "../src/analysis/indexer";
import { analyzeFilesWithRustSidecar, jsonTailForDiagnostics, looksLikeCompleteJsonObject } from "../src/analysis/rust/rustSourceScanner";
import { parseVc6Project } from "../src/analysis/vc6ProjectParser";

const cp932Japanese = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

describe("VC6 encoding and path parsing", () => {
  it("parses CP932 DSW/DSP files with mixed quoted and unquoted paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-cp932-project-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "include path"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "日本語.cpp"), "int g_cp932;\n", "utf8");
    await fs.writeFile(path.join(root, "src", "plain.cpp"), "int g_plain;\n", "utf8");

    await fs.writeFile(
      path.join(root, "sample.dsw"),
      cp932([
        ascii("# "),
        cp932Japanese,
        ascii("\r\nProject: \"quoted\"=\"quoted project.dsp\" - Package Owner=<4>\r\nProject: plain=plain.dsp - Package Owner=<4>\r\n")
      ])
    );
    await fs.writeFile(
      path.join(root, "quoted project.dsp"),
      cp932([
        ascii("# "),
        cp932Japanese,
        ascii("\r\nSOURCE=\".\\src\\"),
        cp932Japanese,
        ascii(".cpp\"\r\n# ADD CPP /I\".\\include path\" /DWIN32 /D \"NAME=VALUE\"\r\n")
      ])
    );
    await fs.writeFile(
      path.join(root, "plain.dsp"),
      cp932([ascii("# plain\r\nSOURCE=.\\src\\plain.cpp\r\n# ADD CPP /I .\\src /DPLAIN\r\n")])
    );

    const project = await parseVc6Project(root, path.join(root, "sample.dsw"), [], "auto");

    expect(project.sourceFiles).toEqual(
      [
        path.join(root, "src", "plain.cpp"),
        path.join(root, "src", "日本語.cpp")
      ].map((file) => file.replace(/\\/g, "/")).sort()
    );
    expect(project.includePaths).toEqual(
      [
        path.join(root, "include path"),
        path.join(root, "src")
      ].map((file) => file.replace(/\\/g, "/")).sort()
    );
    expect(project.macros).toEqual(["NAME=VALUE", "PLAIN", "WIN32"]);
  });

  it("skips generated source files and missing DSW projects that are absent during parsing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-missing-generated-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "main.cpp"), "int g_existing;\n", "utf8");
    await fs.writeFile(
      path.join(root, "sample.dsw"),
      [
        'Project: "existing"=".\\existing.dsp" - Package Owner=<4>',
        'Project: "generated"=".\\generated_project.dsp" - Package Owner=<4>',
        ""
      ].join("\r\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "existing.dsp"),
      [
        "SOURCE=.\\src\\main.cpp",
        "SOURCE=.\\src\\generated_header.h",
        "SOURCE=.\\src\\generated_source.cpp",
        ""
      ].join("\r\n"),
      "utf8"
    );

    const project = await parseVc6Project(root, path.join(root, "sample.dsw"), [], "auto");

    expect(project.sourceFiles).toEqual([
      path.join(root, "src", "main.cpp").replace(/\\/g, "/")
    ]);
  });
});

describe("Rust sidecar output and encoding", () => {
  it("builds an index from a sample2-style C fixture with DSP and DSW metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-sample2-project-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "sample2_base.dsw"),
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
      path.join(root, "thread-map.json"),
      JSON.stringify({
        threads: [
          { threadId: "main", entryFunction: "thread_main_entry" },
          { threadId: "worker", entryFunction: "thread1_entry" }
        ]
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "src", "header.h"),
      [
        "typedef struct tagSampleSubSub { int sample_value1; int sample_value11; int sample_value22; } SAMPLE_SUBSUB;",
        "typedef struct tagSampleSub4 { int sample_value1; SAMPLE_SUBSUB *subsub_ptr; } SAMPLE_SUB4;",
        "typedef struct tagSampleMain { SAMPLE_SUBSUB sub1; SAMPLE_SUB4 sub4; } SAMPLE_MAIN;",
        "typedef struct tagSampleBuffer { int sample_value11; } SAMPLE_BUFFER;",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "src", "api.c"),
      [
        '#include "header.h"',
        "extern SAMPLE_MAIN* PTR_GBL;",
        "int api_major1_sub1(int minor) { return PTR_GBL->sub1.sample_value1; }",
        "int api_major1_sub2(int minor) { return PTR_GBL->sub4.subsub_ptr->sample_value1 + minor; }",
        "int api_get_main(int major, int minor) {",
        "    int (*major1[])(int minor) =",
        "    {",
        "        &api_major1_sub1,",
        "        &api_major1_sub2",
        "    };",
        "    return major1[major - 1](minor);",
        "}",
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
        "SAMPLE_BUFFER* PTR_BUFF = 0;",
        "void thread_sub1ptr(SAMPLE_SUBSUB *ptr) { ptr->sample_value1++; }",
        "void thread_main_entry(void) {",
        "    PTR_GBL->sub4.subsub_ptr = &subLocal;",
        "    PTR_GBL->sub4.subsub_ptr->sample_value1++;",
        "    (PTR_BUFF + 1)->sample_value11++;",
        "}",
        "void thread1_entry(void) { thread_sub1ptr(&PTR_GBL->sub1); }",
        ""
      ].join("\n"),
      "utf8"
    );

    const project = await parseVc6Project(root, path.join(root, "sample2_base.dsw"));
    const index = await buildFullIndex({
      workspaceRoot: root,
      projectFile: path.join(root, "sample2_base.dsw"),
      threadMapFile: path.join(root, "thread-map.json")
    });

    expect(project.sourceFiles.map((file) => path.basename(file)).sort()).toEqual(["api.c", "header.h", "main.c"]);
    expect(index.functions.api_get_main.calls).toEqual(
      expect.arrayContaining(["api_major1_sub1", "api_major1_sub2"])
    );
    expect(index.functions.thread_main_entry.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variableName: "PTR_GBL->sub4.subsub_ptr->sample_value1", kind: "write" }),
        expect.objectContaining({ variableName: "PTR_BUFF[]->sample_value11", kind: "write" })
      ])
    );
    expect(index.functions.thread1_entry.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variableName: "PTR_GBL->sub1.sample_value1",
          kind: "write",
          reasons: expect.arrayContaining(["call-argument-alias"])
        })
      ])
    );
    expect(index.threadReachability.thread_sub1ptr.threadIds).toContain("worker");
  });

  it("uses output-file JSON and reports output/memory metrics", async () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures", "vc6-sample");
    const result = await analyzeFilesWithRustSidecar(
      [path.join(fixtureRoot, "src", "main.cpp"), path.join(fixtureRoot, "src", "globals.h")],
      1,
      "auto",
      2
    );

    expect(result.files.length).toBe(2);
    expect(result.phaseDurationsMs.rustBatchSize).toBe(2);
    expect(result.phaseDurationsMs.rustStreamedSummaryFileCount).toBe(2);
    expect(result.phaseDurationsMs.rustMaxSummaryBatchFiles).toBe(2);
    expect(result.phaseDurationsMs.rustSummaryRetainedFileCount).toBe(0);
    expect(result.phaseDurationsMs.rustMaxStructureBatchFiles).toBe(2);
    expect(result.phaseDurationsMs.rustStreamedFileCount).toBe(2);
    expect(result.phaseDurationsMs.rustOutputBytes).toBeGreaterThan(0);
    expect(result.phaseDurationsMs.rustPeakRssBytes).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("low-memory analyze-many");
  });

  it("detects truncated Rust output JSON before parsing", () => {
    expect(looksLikeCompleteJsonObject('{"files":[]}')).toBe(true);
    expect(looksLikeCompleteJsonObject('{"files":[')).toBe(false);
    expect(jsonTailForDiagnostics("a\n".repeat(300))).not.toContain("\n");
  });

  it("builds an index from a CP932 source file through the Rust sidecar", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-cp932-source-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "sample.dsw"), 'Project: "sample"="sample.dsp" - Package Owner=<4>\r\n', "utf8");
    await fs.writeFile(path.join(root, "sample.dsp"), "SOURCE=.\\src\\main.cpp\r\n", "utf8");
    await fs.writeFile(path.join(root, "thread-map.json"), JSON.stringify({ threads: [] }), "utf8");
    await fs.writeFile(
      path.join(root, "src", "main.cpp"),
      cp932([
        ascii("// "),
        cp932Japanese,
        ascii("\r\nint g_cp932_counter;\r\nvoid Worker(void) { g_cp932_counter++; }\r\n")
      ])
    );

    const index = await buildFullIndex({
      workspaceRoot: root,
      projectFile: path.join(root, "sample.dsw"),
      threadMapFile: path.join(root, "thread-map.json"),
      sourceEncoding: "auto"
    });

    expect(index.globals.g_cp932_counter?.length).toBe(1);
    expect(index.functions.Worker.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variableName: "g_cp932_counter", kind: "write" })
      ])
    );
    expect(index.build.phaseDurationsMs.rustOutputBytes).toBeGreaterThan(0);
  });
});

function ascii(value: string): Buffer {
  return Buffer.from(value, "ascii");
}

function cp932(parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}
