import { describe, it, expect } from "vitest";
import { apiError, classifySyncError, describeError, INTERRUPTED_MESSAGE } from "./errors.js";

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
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined handling
    expect(describeError(undefined)).toBe("undefined");
  });

  it("serializes arrays as JSON", () => {
    expect(describeError(["a", "b"])).toBe('["a","b"]');
  });
});

describe("classifySyncError", () => {
  it("recognizes Lunch Money rejecting the API key", () => {
    const err = apiError("Lunch Money", 401, { message: "Unauthorized" });
    expect(classifySyncError(describeError(err))).toBe("lunch-money-key");
  });

  it("recognizes Splitwise rejecting Lunchwise's access", () => {
    const err = apiError("Splitwise", 401, { error: "Invalid API request: you are not logged in" });
    expect(classifySyncError(describeError(err))).toBe("splitwise-access");
  });

  it("reads messages already stored in sync_log", () => {
    expect(
      classifySyncError(
        'Lunch Money API error (401): {"message":"Unauthorized","errors":[{"errMsg":"Access token does not exist."}]}',
      ),
    ).toBe("lunch-money-key");
  });

  it("recognizes a sync marked interrupted", () => {
    expect(classifySyncError(INTERRUPTED_MESSAGE)).toBe("interrupted");
  });

  it.each([
    'Lunch Money API error (500): {"message":"Internal error"}',
    'Splitwise API error (403): {"errors":{"base":["Forbidden"]}}',
    "[LibsqlError] code=SERVER_ERROR Server returned HTTP status 503",
    "Lunch Money API key not configured",
  ])("treats %s as other", (message) => {
    expect(classifySyncError(message)).toBe("other");
  });
});
