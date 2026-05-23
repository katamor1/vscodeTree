import { describe, expect, it } from "vitest";
import { normalizeOpenLocationMessage } from "../src/extension/openLocationMessage";

describe("normalizeOpenLocationMessage", () => {
  it("accepts valid open location messages", () => {
    expect(normalizeOpenLocationMessage({ type: "openLocation", file: "C:/tmp/main.cpp", line: "12" })).toEqual({
      file: "C:/tmp/main.cpp",
      line: 12
    });
  });

  it("rejects unrelated or invalid messages", () => {
    expect(normalizeOpenLocationMessage({ type: "other", file: "C:/tmp/main.cpp", line: 12 })).toBeUndefined();
    expect(normalizeOpenLocationMessage({ type: "openLocation", file: "C:/tmp/main.cpp", line: 0 })).toBeUndefined();
    expect(normalizeOpenLocationMessage(undefined)).toBeUndefined();
  });
});
