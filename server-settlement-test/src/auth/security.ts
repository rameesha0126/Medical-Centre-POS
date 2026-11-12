import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

function scrypt(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_LENGTH,
      SCRYPT_OPTIONS,
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

export async function hashPassword(
  password: string,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);

  return [
    "scrypt",
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");

  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const nText = parts[1];
  const rText = parts[2];
  const pText = parts[3];
  const saltHex = parts[4];
  const keyHex = parts[5];

  if (
    !nText ||
    !rText ||
    !pText ||
    !saltHex ||
    !keyHex
  ) {
    return false;
  }

  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);

  // Accept only the parameters used by this application.
  if (
    n !== SCRYPT_OPTIONS.N ||
    r !== SCRYPT_OPTIONS.r ||
    p !== SCRYPT_OPTIONS.p ||
    !/^[a-f0-9]{32}$/i.test(saltHex) ||
    !/^[a-f0-9]{128}$/i.test(keyHex)
  ) {
    return false;
  }

  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(
    password,
    Buffer.from(saltHex, "hex"),
  );

  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

export function createSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}