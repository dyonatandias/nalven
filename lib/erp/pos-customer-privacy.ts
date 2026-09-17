export type PosCustomerPublicInput = {
  id: number;
  name: string;
  tradeName: string | null;
  document: string;
  phone?: string | null;
};

export function maskPosDocument(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length <= 4 ? "••••" : `${"•".repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}`;
}

export function maskPosPhone(value: string | null | undefined) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length <= 4 ? "••••" : `••••${digits.slice(-4)}`;
}

/** Minimal DTO allowed at the operator workstation. */
export function publicPosCustomer(value: PosCustomerPublicInput) {
  return {
    id: value.id,
    name: value.name,
    tradeName: value.tradeName,
    document: maskPosDocument(value.document),
    ...(value.phone === undefined ? {} : { phone: maskPosPhone(value.phone) }),
  };
}
