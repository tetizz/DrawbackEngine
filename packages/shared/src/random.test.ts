import { describe, expect, it } from "vitest";
import { Mulberry32 } from "./index.js";

describe("Mulberry32", () => {
  it("repeats an identical sequence for an identical seed", () => {
    const first = new Mulberry32(42);
    const second = new Mulberry32(42);
    expect(Array.from({ length: 20 }, () => first.next())).toEqual(
      Array.from({ length: 20 }, () => second.next()),
    );
  });

  it("rejects invalid integer bounds", () => {
    expect(() => new Mulberry32(1).integer(0)).toThrow(RangeError);
  });
});
