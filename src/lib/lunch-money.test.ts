import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  insertTransactions,
  updateTransactions,
  getTransactions,
  type LmInsertTransaction,
} from "./lunch-money.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function makeTx(i: number): LmInsertTransaction {
  return {
    date: "2024-01-01",
    amount: i,
    payee: `Payee ${i}`,
    currency: "usd",
    manual_account_id: 100,
    external_id: String(i),
  };
}

beforeEach(() => {
  fetchSpy.mockReset();
});

afterEach(() => {
  fetchSpy.mockReset();
});

describe("insertTransactions", () => {
  it("sends all transactions in one request when under 500", async () => {
    const txs = [makeTx(1), makeTx(2)];
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        transactions: [
          { id: 1, external_id: "1" },
          { id: 2, external_id: "2" },
        ],
        skipped_duplicates: [],
      }),
    );

    const result = await insertTransactions("key", txs);

    expect(result.transactions).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("chunks requests at 500 transactions", async () => {
    const txs = Array.from({ length: 501 }, (_, i) => makeTx(i));

    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          transactions: txs.slice(0, 500).map((t, i) => ({ id: i, external_id: t.external_id })),
          skipped_duplicates: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          transactions: [{ id: 500, external_id: "500" }],
          skipped_duplicates: [],
        }),
      );

    const result = await insertTransactions("key", txs);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.transactions).toHaveLength(501);
  });

  it("throws on API error", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "Invalid key" }, 401));

    await expect(insertTransactions("bad-key", [makeTx(1)])).rejects.toThrow(
      "Lunch Money API error (401)",
    );
  });

  it("accumulates skipped duplicates across chunks", async () => {
    const txs = Array.from({ length: 501 }, (_, i) => makeTx(i));

    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          transactions: [],
          skipped_duplicates: [
            { request_transaction: { external_id: "0" }, existing_transaction_id: 9000 },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          transactions: [],
          skipped_duplicates: [
            { request_transaction: { external_id: "500" }, existing_transaction_id: 9001 },
          ],
        }),
      );

    const result = await insertTransactions("key", txs);

    expect(result.skippedDuplicates).toHaveLength(2);
  });
});

describe("updateTransactions", () => {
  it("sends all updates in one request when under 500", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ transactions: [] }));

    await updateTransactions("key", [{ id: 1, amount: 10 }]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("chunks requests at 500 updates", async () => {
    const updates = Array.from({ length: 501 }, (_, i) => ({ id: i, amount: i }));

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ transactions: [] }))
      .mockResolvedValueOnce(jsonResponse({ transactions: [] }));

    await updateTransactions("key", updates);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for empty array", async () => {
    await updateTransactions("key", []);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on API error", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "Server error" }, 500));

    await expect(updateTransactions("key", [{ id: 1, amount: 10 }])).rejects.toThrow(
      "Lunch Money API error (500)",
    );
  });

  it("reports no missing IDs on success", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ transactions: [] }));

    const result = await updateTransactions("key", [{ id: 1, amount: 10 }]);

    expect(result.missingIds).toEqual([]);
  });

  it("retries without the IDs Lunch Money reports as missing", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(notFound([2]), 404))
      .mockResolvedValueOnce(jsonResponse({ transactions: [] }));

    const result = await updateTransactions("key", [
      { id: 1, amount: 10 },
      { id: 2, amount: 20 },
      { id: 3, amount: 30 },
    ]);

    expect(result.missingIds).toEqual([2]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await sentIds(1)).toEqual([1, 3]);
  });

  it("keeps retrying when each attempt reveals another missing ID", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(notFound([1]), 404))
      .mockResolvedValueOnce(jsonResponse(notFound([3]), 404))
      .mockResolvedValueOnce(jsonResponse({ transactions: [] }));

    const result = await updateTransactions("key", [
      { id: 1, amount: 10 },
      { id: 2, amount: 20 },
      { id: 3, amount: 30 },
    ]);

    expect(result.missingIds).toEqual([1, 3]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(await sentIds(2)).toEqual([2]);
  });

  it("does not retry when every ID in the request is missing", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(notFound([1]), 404));

    const result = await updateTransactions("key", [{ id: 1, amount: 10 }]);

    expect(result.missingIds).toEqual([1]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws on a 404 that does not name any requested ID", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ message: "Not Found", errors: [{ errMsg: "Route not found" }] }, 404),
    );

    await expect(updateTransactions("key", [{ id: 1, amount: 10 }])).rejects.toThrow(
      "Lunch Money API error (404)",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("collects missing IDs across chunks", async () => {
    const updates = Array.from({ length: 501 }, (_, i) => ({ id: i, amount: i }));

    fetchSpy
      .mockResolvedValueOnce(jsonResponse(notFound([7]), 404))
      .mockResolvedValueOnce(jsonResponse({ transactions: [] }))
      .mockResolvedValueOnce(jsonResponse(notFound([500]), 404));

    const result = await updateTransactions("key", updates);

    expect(result.missingIds).toEqual([7, 500]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

function notFound(ids: number[]) {
  return {
    message: "Not Found",
    errors: ids.map((id, i) => ({
      errMsg: `There is no transaction with the id ${id}.`,
      id,
      ids_index: i,
    })),
  };
}

async function sentIds(callIndex: number): Promise<number[]> {
  const request = fetchSpy.mock.calls[callIndex][0] as Request;
  const body = (await request.json()) as { transactions: { id: number }[] };
  return body.transactions.map((t) => t.id);
}

describe("getTransactions", () => {
  it("returns all transactions from a single page", async () => {
    const txs = [{ id: 1 }, { id: 2 }];
    fetchSpy.mockResolvedValueOnce(jsonResponse({ transactions: txs, has_more: false }));

    const result = await getTransactions("key", { manual_account_id: 100 });

    expect(result).toEqual(txs);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("paginates when has_more is true", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 3 }];

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ transactions: page1, has_more: true }))
      .mockResolvedValueOnce(jsonResponse({ transactions: page2, has_more: false }));

    const result = await getTransactions("key", { manual_account_id: 100 });

    expect(result).toHaveLength(4);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("passes query parameters", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ transactions: [], has_more: false }));

    await getTransactions("key", {
      manual_account_id: 100,
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });

    const request = fetchSpy.mock.calls[0][0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("manual_account_id")).toBe("100");
    expect(url.searchParams.get("start_date")).toBe("2024-01-01");
    expect(url.searchParams.get("end_date")).toBe("2024-12-31");
  });

  it("throws on API error", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "Forbidden" }, 403));

    await expect(getTransactions("key", { manual_account_id: 100 })).rejects.toThrow(
      "Lunch Money API error (403)",
    );
  });
});
