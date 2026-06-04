import { describe, expect, it } from "vitest";
import { commandProgress } from "../src/extension/progress";

describe("commandProgress", () => {
  it("defines notification progress for slow inspect and report commands", () => {
    expect(commandProgress.inspectSelectedSymbol).toEqual(
      expect.objectContaining({
        title: "VC6 Impact: inspecting selected symbol",
        initialMessage: "Loading index and resolving symbol..."
      })
    );
    expect(commandProgress.generateReviewReport).toEqual(
      expect.objectContaining({
        title: "VC6 Impact: generating review report",
        initialMessage: "Loading index and resolving symbol..."
      })
    );
  });
});
