import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFullIndex } from "../src/analysis/indexer";
import { analyzeFilesWithRustSidecar } from "../src/analysis/rust/rustSourceScanner";
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
});

describe("Rust sidecar output and encoding", () => {
  it("uses output-file JSON and reports output/memory metrics", async () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures", "vc6-sample");
    const result = await analyzeFilesWithRustSidecar(
      [path.join(fixtureRoot, "src", "main.cpp"), path.join(fixtureRoot, "src", "globals.h")],
      1,
      "auto"
    );

    expect(result.files.length).toBe(2);
    expect(result.phaseDurationsMs.rustOutputBytes).toBeGreaterThan(0);
    expect(result.phaseDurationsMs.rustPeakRssBytes).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("low-memory analyze-many");
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
