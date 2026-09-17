import { createHmac, randomInt } from "node:crypto";
import { hashPassword, verifyPassword } from "@/lib/password";

const GIFT_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GIFT_GROUPS = [4, 4, 4, 4, 4, 4, 2] as const;

export class PosValueSecretError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosValueSecretError";
  }
}

export function generatePosGiftCode() {
  const groups = GIFT_GROUPS.map(size => Array.from({ length: size }, () => GIFT_ALPHABET[randomInt(0, GIFT_ALPHABET.length)]).join(""));
  return `GC-${groups.join("-")}`;
}

export function normalizePosGiftCode(value: unknown) {
  if (typeof value !== "string" || value.length > 64) throw new PosValueSecretError("Código do gift card inválido.");
  const compact = value.normalize("NFKC").trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^GC[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{26}$/.test(compact)) throw new PosValueSecretError("Código do gift card inválido.");
  return compact;
}

export function validatePosGiftPin(value: unknown) {
  if (typeof value !== "string" || !/^\d{6,12}$/.test(value)) throw new PosValueSecretError("PIN deve possuir de 6 a 12 dígitos.");
  return value;
}

export function hashPosGiftCode(code: string) {
  return `hmac-sha256:v1:${createHmac("sha256", secretPepper()).update(`gift-code:v1:${normalizePosGiftCode(code)}`).digest("hex")}`;
}

export function hashPosValueRequestSecret(value: string) {
  return createHmac("sha256", secretPepper()).update(`request-secret:v1:${value}`).digest("hex");
}

export async function hashPosGiftPin(pin: string) {
  return hashPassword(pinMaterial(validatePosGiftPin(pin)));
}

export async function verifyPosGiftPin(pin: string, stored: string) {
  try {
    return await verifyPassword(pinMaterial(validatePosGiftPin(pin)), stored);
  } catch (error) {
    if (error instanceof PosValueSecretError) return false;
    throw error;
  }
}

export function posGiftCodeLastFour(code: string) {
  return normalizePosGiftCode(code).slice(-4);
}

function pinMaterial(pin: string) {
  return `pos-value-pin:v1:${secretPepper()}:${pin}`;
}

function secretPepper() {
  const value = process.env.POS_VALUE_SECRET_PEPPER || "";
  if (Buffer.byteLength(value, "utf8") < 32) throw new PosValueSecretError("POS_VALUE_SECRET_PEPPER deve possuir ao menos 32 bytes.", 503);
  return value;
}
