import { randomUUID } from "node:crypto";
import { db, closeDatabase } from "../db/database.js";
import { hashPassword } from "./security.js";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      reject(
        new Error(
          "Run this command in an interactive PowerShell terminal.",
        ),
      );
      return;
    }

    const stdin = process.stdin;
    let value = "";

    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };

    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }

        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }

        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        if (character >= " " && character !== "\u007f") {
          value += character;
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const username = process.argv[2]?.trim();
  const displayName = process.argv.slice(3).join(" ").trim();

  if (
    !username ||
    !displayName ||
    username.length > 100 ||
    displayName.length > 150
  ) {
    throw new Error(
      'Usage: npm run auth:create-owner -- <username> "<display name>"',
    );
  }

  const existingOwner = db.prepare(`
    SELECT 1 FROM users WHERE role = 'OWNER' LIMIT 1
  `).get();

  if (existingOwner) {
    throw new Error(
      "An owner already exists. Do not use this command to reset an account.",
    );
  }

  if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
    throw new Error("That username already exists.");
  }

  const password = await readHidden("Create owner password: ");

  if (password.length < 12 || password.length > 256) {
    throw new Error("Use a password between 12 and 256 characters.");
  }

  const confirmation = await readHidden("Confirm owner password: ");

  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  const passwordHash = await hashPassword(password);
  const userId = randomUUID();

  const createOwner = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, username, display_name, role, is_active)
      VALUES (?, ?, ?, 'OWNER', 1)
    `).run(userId, username, displayName);

    db.prepare(`
      INSERT INTO user_credentials (user_id, password_hash)
      VALUES (?, ?)
    `).run(userId, passwordHash);
  });

  createOwner();

  console.log(`Owner account "${username}" created successfully.`);
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Could not create owner account.",
    );
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });