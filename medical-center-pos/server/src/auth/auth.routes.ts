import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import {
  createSessionToken,
  hashSessionToken,
  verifyPassword,
} from "./security.js";

const router = Router();

const SESSION_COOKIE = "mcpos_session";
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

type UserRole = "OWNER" | "STAFF";

type AuthUser = {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
};

function getCookie(
  request: Request,
  cookieName: string,
): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name === cookieName) {
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function setSessionCookie(
  response: Response,
  token: string,
): void {
  response.setHeader(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${SESSION_DURATION_MS / 1000}`,
    ].join("; "),
  );
}

function clearSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

function getCurrentUser(token: string): AuthUser | undefined {
  const tokenHash = hashSessionToken(token);

  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > datetime('now')
      AND u.is_active = 1
  `).get(tokenHash) as AuthUser | undefined;

  return row;
}

export function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const token = getCookie(request, SESSION_COOKIE);

  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const user = getCurrentUser(token);

  if (!user) {
    response.status(401).json({ error: "Session expired. Please log in again." });
    return;
  }

  response.locals.user = user;

  db.prepare(`
    UPDATE auth_sessions
    SET last_seen_at = datetime('now')
    WHERE token_hash = ?
  `).run(hashSessionToken(token));

  next();
}

export function requireOwner(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const user = response.locals.user as AuthUser | undefined;

  if (!user || user.role !== "OWNER") {
    response.status(403).json({ error: "Owner permission required." });
    return;
  }

  next();
}

// A small in-memory login throttle. It resets when the server restarts.
const loginAttempts = new Map<
  string,
  { count: number; windowStarted: number; blockedUntil: number }
>();

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

function loginIsBlocked(key: string): boolean {
  const now = Date.now();
  const current = loginAttempts.get(key);

  if (!current) return false;

  if (current.blockedUntil > now) return true;

  if (now - current.windowStarted > WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }

  return false;
}

function recordFailedLogin(key: string): void {
  const now = Date.now();
  let current = loginAttempts.get(key);

  if (!current || now - current.windowStarted > WINDOW_MS) {
    current = {
      count: 0,
      windowStarted: now,
      blockedUntil: 0,
    };
  }

  current.count += 1;

  if (current.count >= MAX_ATTEMPTS) {
    current.blockedUntil = now + BLOCK_MS;
  }

  loginAttempts.set(key, current);
}

function clearFailedLogins(key: string): void {
  loginAttempts.delete(key);
}

router.post("/login", async (request, response) => {
  const username =
    typeof request.body?.username === "string"
      ? request.body.username.trim()
      : "";

  const password =
    typeof request.body?.password === "string"
      ? request.body.password
      : "";

  if (
    username.length < 1 ||
    username.length > 100 ||
    password.length < 1 ||
    password.length > 256
  ) {
    response.status(400).json({ error: "Enter a valid username and password." });
    return;
  }

  const attemptKey = username.toLowerCase();

  if (loginIsBlocked(attemptKey)) {
    response.status(429).json({
      error: "Too many failed attempts. Try again in 15 minutes.",
    });
    return;
  }

  const account = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.display_name,
      u.role,
      c.password_hash
    FROM users u
    JOIN user_credentials c ON c.user_id = u.id
    WHERE u.username = ? COLLATE NOCASE
      AND u.is_active = 1
  `).get(username) as
    | (AuthUser & { password_hash: string })
    | undefined;

  const passwordIsValid = account
    ? await verifyPassword(password, account.password_hash)
    : false;

  if (!account || !passwordIsValid) {
    recordFailedLogin(attemptKey);
    response.status(401).json({ error: "Invalid username or password." });
    return;
  }

  clearFailedLogins(attemptKey);

  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(
    Date.now() + SESSION_DURATION_MS,
  )
  .toISOString()
  .slice(0, 19)
  .replace("T", " ");

  db.prepare(`
    INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(tokenHash, account.id, expiresAt);

  setSessionCookie(response, token);

  response.json({
    user: {
      id: account.id,
      username: account.username,
      displayName: account.display_name,
      role: account.role,
    },
  });
});

router.get("/me", requireAuth, (_request, response) => {
  const user = response.locals.user as AuthUser;

  response.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    },
  });
});

router.post("/logout", (request, response) => {
  const token = getCookie(request, SESSION_COOKIE);

  if (token && /^[a-f0-9]{64}$/i.test(token)) {
    db.prepare(`
      DELETE FROM auth_sessions WHERE token_hash = ?
    `).run(hashSessionToken(token));
  }

  clearSessionCookie(response);
  response.status(204).end();
});

// Owner-only endpoint example for testing authorization.
router.get("/owner-check", requireAuth, requireOwner, (_request, response) => {
  response.json({ ok: true });
});

export default router;