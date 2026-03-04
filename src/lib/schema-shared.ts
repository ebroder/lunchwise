import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const timestamp = (name: string) => text(name).notNull().default(sql`(datetime('now'))`);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  splitwiseUserId: text("splitwise_user_id").notNull().unique(),
  tursoDbUrl: text("turso_db_url"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});
