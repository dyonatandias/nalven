import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
// Fixed, non-account hash: unknown accounts perform the same KDF as valid ones.
export const DUMMY_PASSWORD_HASH = `scrypt:${Buffer.alloc(16).toString("base64")}:${Buffer.alloc(64).toString("base64")}`;

export async function hashPassword(password: string) {
  if (password.length < 12) throw new Error("A senha deve ter pelo menos 12 caracteres");
  if (password.length > 256) throw new Error("A senha deve ter no máximo 256 caracteres");
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString("base64")}:${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  if (!password || password.length > 256) return false;
  const [algorithm, saltValue, hashValue] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64");
  if (expected.length !== 64 || Buffer.from(saltValue, "base64").length !== 16) return false;
  const actual = await scrypt(password, Buffer.from(saltValue, "base64"), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
