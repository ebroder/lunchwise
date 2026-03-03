import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const timestamp = (name: string) =>
  text(name).notNull().default(sql`(datetime('now'))`);

export const credentials = sqliteTable("credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  splitwiseAccessToken: text("splitwise_access_token").notNull(),
  lunchMoneyApiKey: text("lunch_money_api_key"),
  updatedAt: timestamp("updated_at"),
});

export const links = sqliteTable("links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  splitwiseGroupId: text("splitwise_group_id"),
  lmAccountId: integer("lm_account_id").notNull(),
  startDate: text("start_date"),
  includePayments: integer("include_payments").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  lastSyncedAt: text("last_synced_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const syncedTransactions = sqliteTable(
  "synced_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    linkId: integer("link_id")
      .notNull()
      .references(() => links.id),
    splitwiseExpenseId: text("splitwise_expense_id").notNull(),
    lmTransactionId: integer("lm_transaction_id").notNull(),
    splitwiseUpdatedAt: text("splitwise_updated_at").notNull(),
    isDeleted: integer("is_deleted").notNull().default(0),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("idx_synced_link_expense").on(
      table.linkId,
      table.splitwiseExpenseId,
    ),
  ],
);

export const syncLog = sqliteTable("sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  linkId: integer("link_id")
    .notNull()
    .references(() => links.id),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull().default("running"),
  expensesFetched: integer("expenses_fetched").default(0),
  created: integer("created").default(0),
  updated: integer("updated").default(0),
  deleted: integer("deleted").default(0),
  errorMessage: text("error_message"),
});
