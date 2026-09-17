// Shared by public forms and handlers. Existing credentials are still verified
// independently so policy changes never lock out an existing account.
export const PASSWORD_POLICY_MESSAGE = "Use de 12 a 256 caracteres, com letra maiúscula, minúscula e número.";

export function isValidNewPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 256
    && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}
