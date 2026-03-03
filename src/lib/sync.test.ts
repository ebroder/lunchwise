import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as userSchema from "./schema-user.js";
import { syncedTransactions } from "./schema-user.js";
import { initUserDb, type UserDb } from "./db.js";
import { syncLink } from "./sync.js";
import { getUserShare, type SplitwiseExpense } from "./splitwise.js";
import type { User } from "./auth.js";

vi.mock("./splitwise.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./splitwise.js")>();
  return { ...mod, getAllExpenses: vi.fn().mockResolvedValue([]) };
});

vi.mock("./lunch-money.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lunch-money.js")>();
  return { ...mod, getTransactions: vi.fn().mockResolvedValue([]) };
});

import { getAllExpenses } from "./splitwise.js";
import { getTransactions } from "./lunch-money.js";

const mockGetAllExpenses = getAllExpenses as Mock;
const mockGetTransactions = getTransactions as Mock;

// --- Helpers ---

function createTestDb(): UserDb {
  const client = createClient({ url: ":memory:" });
  return drizzle({ client, schema: userSchema }) as UserDb;
}

function makeExpense(
  overrides: Partial<SplitwiseExpense> = {},
): SplitwiseExpense {
  return {
    id: 1,
    description: "Test expense",
    cost: "20.00",
    currency_code: "USD",
    date: "2024-06-15T00:00:00Z",
    updated_at: "2024-06-15T12:00:00Z",
    deleted_at: null,
    payment: false,
    users: [{ user_id: 123, net_balance: "-10.00" }],
    ...overrides,
  } as SplitwiseExpense;
}

const defaultUser: User = {
  id: 1,
  splitwiseUserId: "123",
  tursoDbUrl: ":memory:",
  splitwiseAccessToken: "sw-token",
  lunchMoneyApiKey: "lm-key",
};

// --- getUserShare ---

describe("getUserShare", () => {
  it("returns positive amount when user owes money", () => {
    const expense = makeExpense({
      users: [{ user_id: 123, net_balance: "-10.00" }],
    });
    expect(getUserShare(expense, "123")).toBe(10);
  });

  it("returns negative amount when user is owed money", () => {
    const expense = makeExpense({
      users: [{ user_id: 123, net_balance: "15.50" }],
    });
    expect(getUserShare(expense, "123")).toBe(-15.5);
  });

  it("returns null when user is not in the expense", () => {
    const expense = makeExpense({
      users: [{ user_id: 456, net_balance: "-10.00" }],
    });
    expect(getUserShare(expense, "123")).toBeNull();
  });

  it("returns null when user balance is zero", () => {
    const expense = makeExpense({
      users: [{ user_id: 123, net_balance: "0" }],
    });
    expect(getUserShare(expense, "123")).toBeNull();
  });
});

// --- planSync (via syncLink dry run) ---

describe("syncLink dry run", () => {
  let db: UserDb;

  type LinkInsert = typeof userSchema.links.$inferInsert;

  async function insertLink(
    overrides: Partial<LinkInsert> = {},
  ): Promise<typeof userSchema.links.$inferSelect> {
    const [row] = await db
      .insert(userSchema.links)
      .values({
        lmAccountId: 100,
        lastSyncedAt: "2024-01-01T00:00:00Z",
        ...overrides,
      })
      .returning();
    return row;
  }

  beforeEach(async () => {
    db = createTestDb();
    await initUserDb(db);
    mockGetAllExpenses.mockReset().mockResolvedValue([]);
    mockGetTransactions.mockReset().mockResolvedValue([]);
  });

  it("creates a transaction for a new expense", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.created).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions![0]).toMatchObject({
      type: "create",
      expenseId: "1001",
      amount: 10,
      payee: "Test expense",
    });
  });

  it("skips an expense that is already synced and unchanged", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
    });

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, updated_at: "2024-06-15T12:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("updates a transaction when the expense has been modified", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
    });

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({
        id: 1001,
        updated_at: "2024-06-16T08:00:00Z",
        cost: "30.00",
      }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.updated).toBe(1);
    expect(result.actions![0]).toMatchObject({
      type: "update",
      expenseId: "1001",
    });
  });

  it("deletes a tracked expense that was deleted in Splitwise", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
    });

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, deleted_at: "2024-06-16T00:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.deleted).toBe(1);
    expect(result.actions![0]).toMatchObject({
      type: "delete",
      expenseId: "1001",
    });
  });

  it("ignores a deleted expense that was already marked deleted", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
      isDeleted: 1,
    });

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, deleted_at: "2024-06-16T00:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("ignores a deleted expense that was never tracked", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 9999, deleted_at: "2024-06-16T00:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("skips expenses before start_date", async () => {
    const link = await insertLink({ startDate: "2024-07-01" });
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, date: "2024-06-15T00:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("skips payments when includePayments is off", async () => {
    const link = await insertLink({ includePayments: 0 });
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, payment: true }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("includes payments with prefix when includePayments is on", async () => {
    const link = await insertLink({ includePayments: 1 });
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, payment: true, description: "Settlement" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.created).toBe(1);
    expect(result.actions![0].payee).toBe("Splitwise Payment: Settlement");
  });

  it("skips expenses where user has no share", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({
        id: 1001,
        users: [{ user_id: 456, net_balance: "-10.00" }],
      }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("carries splitwiseUpdatedAt from the expense", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, updated_at: "2024-06-15T12:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].splitwiseUpdatedAt).toBe(
      "2024-06-15T12:00:00Z",
    );
  });

  it("includes category in notes", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, category: { id: 5, name: "Groceries" } }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.notes).toContain("Groceries");
  });

  it("includes total in notes when user share differs from total", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({
        id: 1001,
        cost: "30.00",
        users: [{ user_id: 123, net_balance: "-10.00" }],
      }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.notes).toContain("Total: USD 30.00");
  });

  it("classifies a mix of expenses correctly in one sync", async () => {
    const link = await insertLink();
    // Seed tracked rows for expenses that already exist
    await db.insert(syncedTransactions).values([
      {
        linkId: link.id,
        splitwiseExpenseId: "2001",
        lmTransactionId: 5001,
        splitwiseUpdatedAt: "2024-06-10T00:00:00Z",
      },
      {
        linkId: link.id,
        splitwiseExpenseId: "3001",
        lmTransactionId: 5002,
        splitwiseUpdatedAt: "2024-06-10T00:00:00Z",
      },
      {
        linkId: link.id,
        splitwiseExpenseId: "5001",
        lmTransactionId: 5003,
        splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
      },
    ]);

    mockGetAllExpenses.mockResolvedValue([
      // New expense → create
      makeExpense({ id: 1001 }),
      // Modified expense → update
      makeExpense({ id: 2001, updated_at: "2024-06-20T00:00:00Z" }),
      // Deleted expense → delete
      makeExpense({ id: 3001, deleted_at: "2024-06-18T00:00:00Z" }),
      // User has no share → skip
      makeExpense({
        id: 4001,
        users: [{ user_id: 456, net_balance: "-5.00" }],
      }),
      // Already synced, unchanged → skip
      makeExpense({ id: 5001, updated_at: "2024-06-15T12:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.expenses_fetched).toBe(5);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.actions).toHaveLength(3);

    const types = result.actions!.map((a) => `${a.type}:${a.expenseId}`);
    expect(types).toContain("create:1001");
    expect(types).toContain("update:2001");
    expect(types).toContain("delete:3001");
  });

  describe("backfill on first sync", () => {
    it("does not re-create expenses that already exist in LM", async () => {
      const link = await insertLink({ lastSyncedAt: null });
      mockGetTransactions.mockResolvedValue([
        { id: 5000, external_id: "1001" },
      ]);
      mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);

      const result = await syncLink(db, link, defaultUser, { dryRun: true });

      expect(result.created).toBe(0);
      // An update is expected: the backfilled row has splitwiseUpdatedAt=""
      // so the expense's real updated_at triggers a harmless update.
      expect(result.actions!.every((a) => a.type !== "create")).toBe(true);
    });

    it("ignores LM transactions with non-numeric external_id", async () => {
      const link = await insertLink({ lastSyncedAt: null });
      mockGetTransactions.mockResolvedValue([
        { id: 5000, external_id: "not-a-number" },
      ]);
      mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);

      const result = await syncLink(db, link, defaultUser, { dryRun: true });

      expect(result.created).toBe(1);
    });
  });
});
