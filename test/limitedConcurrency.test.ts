import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/analysis/limitedConcurrency";

describe("mapWithConcurrency", () => {
  it("preserves result order while bounding active tasks", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      3,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
      }
    );

    expect(result).toEqual(Array.from({ length: 12 }, (_, index) => index * 2));
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
