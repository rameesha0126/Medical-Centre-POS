import { randomUUID } from "node:crypto";
import { db, closeDatabase } from "../db/database.js";
import { hashPassword } from "./security.js";
function readHidden(prompt) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || !process.stdin.setRawMode) {
            reject(new Error("Run this command in an interactive PowerShell terminal."));
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
        const onData = (chunk) => {
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
async function main() {
    const username = process.argv[2]?.trim();
    const displayName = process.argv.slice(3).join(" ").trim();
    if (!username ||
        !displayName ||
        username.length > 100 ||
        displayName.length > 150) {
        throw new Error('Usage: npm run auth:create-staff -- <username> "<display name>"');
    }
    if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
        throw new Error("That username already exists.");
    }
    const password = await readHidden("Create staff password: ");
    if (password.length < 12 || password.length > 256) {
        throw new Error("Use a password between 12 and 256 characters.");
    }
    const confirmation = await readHidden("Confirm staff password: ");
    if (password !== confirmation) {
        throw new Error("Passwords do not match.");
    }
    const passwordHash = await hashPassword(password);
    const userId = randomUUID();
    const createStaff = db.transaction(() => {
        db.prepare(`
      INSERT INTO users (id, username, display_name, role, is_active)
      VALUES (?, ?, ?, 'STAFF', 1)
    `).run(userId, username, displayName);
        db.prepare(`
      INSERT INTO user_credentials (user_id, password_hash)
      VALUES (?, ?)
    `).run(userId, passwordHash);
    });
    createStaff();
    console.log(`Staff account "${username}" created successfully.`);
}
main()
    .catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not create staff account.");
    process.exitCode = 1;
})
    .finally(() => {
    closeDatabase();
});
//# sourceMappingURL=create-staff.js.map