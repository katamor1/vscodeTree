import { describe, expect, it } from "vitest";
import { extractSymbolAtTextOffset, normalizeCommandSymbolArg } from "../src/extension/commandArgs";

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

describe("extractSymbolAtTextOffset", () => {
  it("selects a whole struct member expression around the cursor", () => {
    const source = "void f(void) { PTR_GBL->sub1.sample_value1++; }";

    expect(extractSymbolAtTextOffset(source, source.indexOf("sub1") + 1)).toBe("PTR_GBL->sub1.sample_value1");
    expect(extractSymbolAtTextOffset(source, source.indexOf("sample_value1") + 2)).toBe("PTR_GBL->sub1.sample_value1");
  });

  it("keeps nested array members in the selected symbol", () => {
    const source = "return PTR_GBL->sub4.subsub[minor].sample_value1;";

    expect(extractSymbolAtTextOffset(source, source.indexOf("sample_value1") + 2)).toBe("PTR_GBL->sub4.subsub[].sample_value1");
  });

  it("selects dotted members and plain function names", () => {
    expect(extractSymbolAtTextOffset("g_state.mode = 1;", "g_state.mode".length - 1)).toBe("g_state.mode");
    expect(extractSymbolAtTextOffset("CommonUpdate();", 2)).toBe("CommonUpdate");
  });
});
