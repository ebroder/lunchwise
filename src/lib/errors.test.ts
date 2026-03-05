import { describe, it, expect } from "vitest";
import { describeError } from "./errors.js";

describe("describeError", () => {
  it("serializes plain objects as JSON", () => {
    expect(describeError({ message: "not found", code: 404 })).toBe(
      '{"message":"not found","code":404}',
    );
  });

  it("serializes Error instances with message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("includes class name for Error subclasses", () => {
    expect(describeError(new TypeError("bad type"))).toBe("[TypeError] bad type");
  });

  it("includes cause chain", () => {
    const inner = new Error("root");
    const outer = new Error("wrapper", { cause: inner });
    expect(describeError(outer)).toBe("wrapper | cause: root");
  });

  it("serializes strings directly", () => {
    expect(describeError("simple string")).toBe("simple string");
  });

  it("serializes null", () => {
    expect(describeError(null)).toBe("null");
  });

  it("serializes undefined", () => {
    expect(describeError(undefined)).toBe("undefined");
  });

  it("serializes arrays as JSON", () => {
    expect(describeError(["a", "b"])).toBe('["a","b"]');
  });
});
