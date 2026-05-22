import { describe, expect, it } from "vitest";
import { normalizeCommandSymbolArg } from "../src/extension/commandArgs";

describe("normalizeCommandSymbolArg", () => {
  it("accepts plain string symbols", () => {
    expect(normalizeCommandSymbolArg("  g_counter  ")).toBe("g_counter");
  });

  it("extracts explicit symbol fields from command objects", () => {
    expect(normalizeCommandSymbolArg({ symbolName: "g_mode" })).toBe("g_mode");
    expect(normalizeCommandSymbolArg({ name: "CommonUpdate" })).toBe("CommonUpdate");
    expect(normalizeCommandSymbolArg({ label: { label: "ThreadEntry_00" } })).toBe("ThreadEntry_00");
  });

  it("ignores VS Code context objects without symbol fields", () => {
    expect(normalizeCommandSymbolArg({ scheme: "file", fsPath: "C:/tmp/main.cpp" })).toBeUndefined();
    expect(normalizeCommandSymbolArg({ label: 123 })).toBeUndefined();
    expect(normalizeCommandSymbolArg(undefined)).toBeUndefined();
  });
});
