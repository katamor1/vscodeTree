import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/analysis/impact";
import { buildFullIndex } from "../src/analysis/indexer";
import { scanFileStructureWithCustomParser } from "../src/analysis/customParser/customSourceScanner";

const fixtureRoot = path.resolve(__dirname, "fixtures", "vc6-sample");
const projectFile = path.join(fixtureRoot, "sample.dsw");
const threadMapFile = path.join(fixtureRoot, "thread-map.json");

describe("custom parser route", () => {
  it("parses VC6 fixture source through the isolated custom parser", async () => {
    const structure = await scanFileStructureWithCustomParser(path.join(fixtureRoot, "src", "main.cpp"));

    expect(structure.functions.map((func) => func.name)).toEqual(
      expect.arrayContaining(["CommonUpdate", "WorkerThread", "MonitorThread", "InterruptHandler"])
    );
    expect(structure.globals.map((global) => global.name)).toEqual(
      expect.arrayContaining(["g_counter", "g_mode", "g_deviceState", "g_devices"])
    );
  });

  it("builds a separate custom-parser index without changing the default parser route", async () => {
    const custom = await buildFullIndex({
      workspaceRoot: fixtureRoot,
      projectFile,
      threadMapFile,
      maxIndexWorkers: 1,
      parserMode: "custom"
    });
    const standard = await buildFullIndex({
      workspaceRoot: fixtureRoot,
      projectFile,
      threadMapFile,
      maxIndexWorkers: 1
    });
    const impact = buildImpact(custom, "g_deviceState.counter");

    expect(custom.build.parserMode).toBe("custom");
    expect(standard.build.parserMode).toBe("standard");
    expect(Object.keys(custom.functions).sort()).toEqual(Object.keys(standard.functions).sort());
    expect(custom.memberSymbols["g_deviceState.counter"]?.length).toBeGreaterThan(0);
    expect(impact.symbolKind).toBe("member");
    expect(impact.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ functionName: "WorkerThread", kind: "write" }),
        expect.objectContaining({ functionName: "MonitorThread", kind: "read" })
      ])
    );
  });
});
