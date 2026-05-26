import { describe, expect, it } from "vitest";
import { formatIndexStatusLines } from "../src/extension/indexStatus";

describe("index status formatting", () => {
  it("splits build status into short tree rows", () => {
    const lines = formatIndexStatusLines({
      action: "built",
      sourceFileCount: 7002,
      durationMs: 19435,
      workerCount: 7
    });

    expect(lines).toEqual([
      { label: "Index built", description: "ready", icon: "check" },
      { label: "Files", description: "7,002", icon: "files" },
      { label: "Time", description: "19.4s", icon: "clock" },
      { label: "Workers", description: "7", icon: "server-process" }
    ]);
    expect(lines.map((line) => `${line.label} ${line.description}`).join(" ")).not.toContain("Index built: 7002 files");
  });

  it("formats a restored on-disk index without implying a rebuild ran", () => {
    const lines = formatIndexStatusLines({
      action: "loaded",
      sourceFileCount: 7002,
      durationMs: 19435,
      workerCount: 7
    });

    expect(lines[0]).toEqual({ label: "Index loaded", description: "from disk", icon: "database" });
    expect(lines).toEqual(
      expect.arrayContaining([
        { label: "Files", description: "7,002", icon: "files" },
        { label: "Time", description: "19.4s", icon: "clock" },
        { label: "Workers", description: "7", icon: "server-process" }
      ])
    );
  });
});
