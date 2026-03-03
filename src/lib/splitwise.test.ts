import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAllExpenses, getUserBalances, type SplitwiseGroup } from "./splitwise.js";

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

describe("getAllExpenses", () => {
  it("returns expenses from a single page", async () => {
    const expenses = [{ id: 1 }, { id: 2 }];
    fetchSpy.mockResolvedValueOnce(jsonResponse({ expenses }));

    const result = await getAllExpenses("token", {});

    expect(result).toEqual(expenses);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("paginates when a page is full", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 100 }, { id: 101 }];

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ expenses: page1 }))
      .mockResolvedValueOnce(jsonResponse({ expenses: page2 }));

    const result = await getAllExpenses("token", {});

    expect(result).toHaveLength(102);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("passes group_id and updated_after as query params", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ expenses: [] }));

    await getAllExpenses("token", {
      group_id: 42,
      updated_after: "2024-01-01T00:00:00Z",
    });

    const request = fetchSpy.mock.calls[0][0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("group_id")).toBe("42");
    expect(url.searchParams.get("updated_after")).toBe("2024-01-01T00:00:00Z");
  });

  it("throws on API error", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401));

    await expect(getAllExpenses("bad-token", {})).rejects.toThrow("Splitwise API error (401)");
  });
});

describe("getUserBalances", () => {
  function makeGroup(balances: { currency_code: string; amount: string }[]): SplitwiseGroup {
    return {
      id: 1,
      members: [{ id: 123, balance: balances }],
    } as SplitwiseGroup;
  }

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
