import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifySyncError, describeError } from "./errors.js";
import {
  getExpenses,
  getGroup,
  getGroups,
  getUserBalances,
  type SplitwiseGroup,
} from "./splitwise.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

beforeEach(() => {
  fetchSpy.mockReset();
});

afterEach(() => {
  fetchSpy.mockReset();
});

function fullPage(from: number) {
  return Array.from({ length: 1000 }, (_, i) => ({ id: from + i }));
}

function requestedOffsets() {
  return fetchSpy.mock.calls.map(([request]) =>
    new URL((request as Request).url).searchParams.get("offset"),
  );
}

describe("getExpenses", () => {
  it("returns expenses from a single page", async () => {
    const expenses = [{ id: 1 }, { id: 2 }];
    fetchSpy.mockResolvedValueOnce(jsonResponse({ expenses }));

    const result = await getExpenses("token", { maxPages: 4 });

    expect(result).toEqual({ expenses, nextOffset: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("paginates when a page is full", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ expenses: fullPage(0) }))
      .mockResolvedValueOnce(jsonResponse({ expenses: [{ id: 1000 }, { id: 1001 }] }));

    const result = await getExpenses("token", { maxPages: 4 });

    expect(result.expenses).toHaveLength(1002);
    expect(result.nextOffset).toBeNull();
    expect(requestedOffsets()).toEqual(["0", "1000"]);
  });

  it("starts at the offset it is given", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ expenses: [{ id: 3000 }] }));

    const result = await getExpenses("token", { offset: 3000, maxPages: 4 });

    expect(result).toEqual({ expenses: [{ id: 3000 }], nextOffset: null });
    expect(requestedOffsets()).toEqual(["3000"]);
  });

  it("stops after maxPages full pages and says where the next one starts", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ expenses: fullPage(2000) }))
      .mockResolvedValueOnce(jsonResponse({ expenses: fullPage(3000) }));

    const result = await getExpenses("token", { offset: 2000, maxPages: 2 });

    expect(result.expenses).toHaveLength(2000);
    expect(result.nextOffset).toBe(4000);
    expect(requestedOffsets()).toEqual(["2000", "3000"]);
  });

  it("reports nothing more after a short last page", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ expenses: fullPage(0) }))
      .mockResolvedValueOnce(jsonResponse({ expenses: [] }));

    const result = await getExpenses("token", { maxPages: 2 });

    expect(result.expenses).toHaveLength(1000);
    expect(result.nextOffset).toBeNull();
  });

  it("passes group_id and updated_after as query params", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ expenses: [] }));

    await getExpenses("token", {
      group_id: 42,
      updated_after: "2024-01-01T00:00:00Z",
      maxPages: 4,
    });

    const request = fetchSpy.mock.calls[0][0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("group_id")).toBe("42");
    expect(url.searchParams.get("updated_after")).toBe("2024-01-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("1000");
  });

  it("throws on API error", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401));

    await expect(getExpenses("bad-token", { maxPages: 4 })).rejects.toThrow(
      "Splitwise API error (401)",
    );
  });
});

function makeGroup(balances: { currency_code: string; amount: string }[]): SplitwiseGroup {
  return {
    id: 1,
    members: [{ id: 123, balance: balances }],
  } as SplitwiseGroup;
}

describe("getUserBalances", () => {
  it("returns balances for the matching user", () => {
    const group = makeGroup([{ currency_code: "USD", amount: "25.50" }]);
    const result = getUserBalances(group, "123");
    expect(result).toEqual([{ currency: "USD", amount: 25.5 }]);
  });

  it("returns empty array when user is not a member", () => {
    const group = makeGroup([{ currency_code: "USD", amount: "10.00" }]);
    expect(getUserBalances(group, "999")).toEqual([]);
  });

  it("skips zero-amount balances", () => {
    const group = makeGroup([
      { currency_code: "USD", amount: "0" },
      { currency_code: "EUR", amount: "5.00" },
    ]);
    const result = getUserBalances(group, "123");
    expect(result).toEqual([{ currency: "EUR", amount: 5 }]);
  });

  it("handles multiple currencies", () => {
    const group = makeGroup([
      { currency_code: "USD", amount: "10.00" },
      { currency_code: "EUR", amount: "-5.00" },
    ]);
    const result = getUserBalances(group, "123");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ currency: "USD", amount: 10 });
    expect(result[1]).toEqual({ currency: "EUR", amount: -5 });
  });
});

describe("rejected access", () => {
  it.each([
    ["getExpenses", () => getExpenses("token", { maxPages: 4 })],
    ["getGroups", () => getGroups("token")],
    ["getGroup", () => getGroup("token", 10)],
  ])("fails %s with an error the sync recognizes", async (_name, call) => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ error: "Invalid API request: you are not logged in" }, 401),
    );

    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );

    expect(classifySyncError(describeError(err))).toBe("splitwise-access");
  });
});
