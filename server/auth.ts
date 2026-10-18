import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
