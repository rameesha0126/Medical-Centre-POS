import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDatabase } from "./database.js";
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(currentDirectory, "../..");
const migrationsDirectory = path.join(serverDirectory, "migrations");
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const appliedMigrations = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
const migrationFiles = fs
    .readdirSync(migrationsDirectory)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();
try {
    for (const file of migrationFiles) {
        if (appliedMigrations.has(file)) {
            console.log(`Already applied: ${file}`);
            continue;
        }
        const sql = fs.readFileSync(path.join(migrationsDirectory, file), "utf8");
        const applyMigration = db.transaction(() => {
            db.exec(sql);
            db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(file);
        });
        applyMigration();
        console.log(`Applied migration: ${file}`);
    }
    console.log("Database migrations completed successfully.");
}
catch (error) {
    console.error("Database migration failed:", error);
    process.exitCode = 1;
}
finally {
    closeDatabase();
}
//# sourceMappingURL=migrate.js.map