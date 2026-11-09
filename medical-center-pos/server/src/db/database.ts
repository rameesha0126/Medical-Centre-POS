import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

// src/db -> server/
const serverDirectory = path.resolve(currentDirectory, "../..");
const dataDirectory = path.join(serverDirectory, "data");
const databasePath = path.join(dataDirectory, "medical-center.sqlite");

fs.mkdirSync(dataDirectory, { recursive: true });

export const db: Database.Database = new Database(databasePath);

// Enable foreign-key enforcement for this connection.
db.pragma("foreign_keys = ON");

// Improve behavior for local concurrent reads and writes.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = FULL");

export function closeDatabase(): void {
  if (db.open) {
    db.close();
  }
}

console.log(`SQLite database opened at: ${databasePath}`);
