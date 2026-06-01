import { describe, expect, it } from "vitest";

const sample2ScaleGenerator = require("../scripts/generate-sample2-scale.js") as {
  assertSafeScaleOutput: (outputRoot: string) => void;
  outputRootForEntries: (entries: number) => string;
  parseTierEntries: (value: string) => number[];
  projectedIndexSizeMiB: (sourceEntries: number) => number;
};

const benchmarkIndex = require("../scripts/benchmark-index.js") as {
  countFunctionAccesses: (index: { functions: Record<string, { accesses?: unknown[] }> }) => number;
  parseArgs: (argv: string[]) => { sample?: string; workers?: string; batch?: string };
  samples: Record<string, { root: string; project: string; threadMap: string }>;
};

describe("sample2 scale generator tiers", () => {
  it("parses the production tier list and projects the 190 MiB tier", () => {
    expect(sample2ScaleGenerator.parseTierEntries("7000,16000,31000")).toEqual([7000, 16000, 31000]);
    expect(sample2ScaleGenerator.projectedIndexSizeMiB(7000)).toBe(44.7);
    expect(sample2ScaleGenerator.projectedIndexSizeMiB(16000)).toBe(99.4);
    expect(sample2ScaleGenerator.projectedIndexSizeMiB(31000)).toBe(190.6);
  });

  it("derives tier output roots under the external perf sample workspace", () => {
    expect(sample2ScaleGenerator.outputRootForEntries(16000).replace(/\\/g, "/")).toBe(
      "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-scale-16000"
    );
    expect(sample2ScaleGenerator.outputRootForEntries(31000).replace(/\\/g, "/")).toBe(
      "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-scale-31000"
    );
  });

  it("rejects tier output directories outside the external fixture boundary", () => {
    expect(() => sample2ScaleGenerator.assertSafeScaleOutput("C:/Users/stell/source/repos/vscodeTree/vc6-large-sample2-scale-31000")).toThrow(
      /Refusing to delete unexpected output directory/
    );
    expect(() => sample2ScaleGenerator.assertSafeScaleOutput("C:/Users/stell/source/repos/vscodeTree_perf_samples/not-sample2-scale")).toThrow(
      /Refusing to delete unexpected output directory/
    );
  });

  it("exposes benchmark sample keys for all sample2 tiers", () => {
    expect(benchmarkIndex.samples["sample2-scale"].root).toBe(
      "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-scale-7000"
    );
    expect(benchmarkIndex.samples["sample2-scale-7000"].root).toBe(
      "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-scale-7000"
    );
    expect(benchmarkIndex.samples["sample2-scale-16000"].root).toBe(
      "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-scale-16000"
    );
    expect(benchmarkIndex.samples["sample2-scale-31000"].root).toBe(
      "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-scale-31000"
    );
  });

  it("counts function accesses for benchmark reports", () => {
    expect(benchmarkIndex.countFunctionAccesses({
      functions: {
        first: { accesses: [{}, {}] },
        second: {},
        third: { accesses: [{}] }
      }
    })).toBe(3);
  });

  it("accepts positional batch size after npm normalizes benchmark flags", () => {
    expect(benchmarkIndex.parseArgs(["small", "1", "1"])).toMatchObject({
      sample: "small",
      workers: "1",
      batch: "1"
    });
  });
});
