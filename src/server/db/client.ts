import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../env.js";
import * as schema from "./schema.js";

if (env.DATABASE_PATH !== ":memory:") mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });

export const sqlite = new Database(env.DATABASE_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });

// Migrasi dijalankan otomatis saat server start (idempotent: yang sudah jalan dilewati).
export function runMigrations() {
  migrate(db, { migrationsFolder: resolve("drizzle") });
}

export function dbHealthy(): boolean {
  try {
    return sqlite.prepare("SELECT 1 AS ok").get() !== undefined;
  } catch {
    return false;
  }
}
