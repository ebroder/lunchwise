import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { getUserDb } from "./db.js";
import { getGroups } from "./splitwise.js";
import { getUser } from "./lunch-money.js";
import {
  countedFetch,
  REQUEST_BUDGET,
  RequestBudgetExceededError,
  requestBudgetExceeded,
  requestsUsed,
  withRequestBudget,
} from "./request-budget.js";

function stubNetwork(respond: (request: Request) => unknown = () => ({})) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return Response.json(await respond(request));
  });
}

// Answers libsql's Hrana-over-HTTP pipeline the way Turso does, with one row per query.
async function hranaPipeline(request: Request) {
  const body = (await request.json()) as { requests: { type: string }[] };
  return {
    baton: null,
    base_url: null,
    results: body.requests.map((req) =>
      req.type === "execute"
        ? {
            type: "ok",
            response: {
              type: "execute",
              result: {
                cols: [{ name: "one", decltype: null }],
                rows: [[{ type: "integer", value: "1" }]],
                affected_row_count: 0,
                last_insert_rowid: null,
              },
            },
          }
        : { type: "ok", response: { type: req.type } },
    ),
  };
}

function interleavedRun(requests: number): Promise<number> {
  return withRequestBudget(async () => {
    for (let i = 0; i < requests; i++) {
      await countedFetch("https://example.com/");
      await new Promise((r) => {
        setTimeout(r, 1);
      });
    }
    return requestsUsed();
  });
}

describe("request budget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts requests made inside a budget", async () => {
    const network = stubNetwork();

    const used = await withRequestBudget(async () => {
      await countedFetch("https://example.com/a");
      await countedFetch("https://example.com/b");
      return requestsUsed();
    });

    expect(used).toBe(2);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it(`refuses requests past ${REQUEST_BUDGET} without sending them`, async () => {
    const network = stubNetwork();

    await withRequestBudget(async () => {
      for (let i = 0; i < REQUEST_BUDGET; i++) {
        await countedFetch("https://example.com/");
      }
      expect(requestBudgetExceeded()).toBe(false);

      await expect(countedFetch("https://example.com/")).rejects.toBeInstanceOf(
        RequestBudgetExceededError,
      );
      expect(requestBudgetExceeded()).toBe(true);
      expect(requestsUsed()).toBe(REQUEST_BUDGET);
    });

    expect(network).toHaveBeenCalledTimes(REQUEST_BUDGET);
  });

  it("keeps a separate count for each concurrent budget", async () => {
    stubNetwork();

    expect(await Promise.all([interleavedRun(3), interleavedRun(5)])).toEqual([3, 5]);
  });

  it("lets requests outside a budget through uncounted", async () => {
    const network = stubNetwork();

    await countedFetch("https://example.com/");

    expect(network).toHaveBeenCalledTimes(1);
    expect(requestsUsed()).toBe(0);
    expect(requestBudgetExceeded()).toBe(false);
  });

  it("counts Turso queries", async () => {
    const network = stubNetwork(hranaPipeline);
    const db = getUserDb("https://counted.turso.example");

    const [rows, used] = await withRequestBudget(async () => {
      const result = await db.all<{ one: number }>(sql`SELECT 1 AS one`);
      return [result, requestsUsed()] as const;
    });

    expect(rows).toEqual([{ one: 1 }]);
    expect(used).toBe(1);
    expect((network.mock.calls[0][0] as Request).url).toContain("counted.turso.example");
  });

  it("counts Splitwise requests", async () => {
    stubNetwork(() => ({ groups: [] }));

    const used = await withRequestBudget(async () => {
      await getGroups("sw-token");
      return requestsUsed();
    });

    expect(used).toBe(1);
  });

  it("counts Lunch Money requests", async () => {
    stubNetwork(() => ({ primary_currency: "usd" }));

    const used = await withRequestBudget(async () => {
      await getUser("lm-key");
      return requestsUsed();
    });

    expect(used).toBe(1);
  });
});
