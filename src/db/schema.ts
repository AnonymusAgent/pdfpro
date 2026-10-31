import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  size: integer("size").notNull().default(0),
  pages: integer("pages").notNull().default(0),
  kind: text("kind").notNull().default("pdf"),
  starred: boolean("starred").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const signatures = pgTable("signatures", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  dataUrl: text("data_url").notNull(),
  kind: text("kind").notNull().default("draw"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("completed"),
  inputSize: integer("input_size").notNull().default(0),
  outputSize: integer("output_size").notNull().default(0),
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
