import { describe, expect, it } from "vitest";
import { extractCallIdentifiers, extractIdentifiers } from "../src/analysis/sourceScanner";

describe("token scanner", () => {
  it("extracts identifiers from masked code lines", () => {
    expect(extractIdentifiers("g_value++")).toEqual(["g_value"]);
    expect(extractIdentifiers("x = g_value + step;")).toEqual(["x", "g_value", "step"]);
  });

  it("extracts call identifiers without control-flow keywords", () => {
    expect(extractCallIdentifiers("if (ready) { CommonUpdate(step); WorkerThread(param); }")).toEqual([
      "CommonUpdate",
      "WorkerThread"
    ]);
  });

  it("does not treat non-call identifiers as calls", () => {
    expect(extractCallIdentifiers("g_value = x + y;")).toEqual([]);
  });
});
