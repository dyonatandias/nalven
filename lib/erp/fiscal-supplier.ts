import type { Prisma } from "@/generated/tenant/client";
import type { parseNfeXml } from "./nfe-input";
import { validCnpj } from "./nfe-input";

/** XML enriches empty fields only; a historical invoice must not overwrite reviewed data. */
export async function ensureFiscalSupplier(tx: Prisma.TransactionClient, parsed: Pick<ReturnType<typeof parseNfeXml>, "supplierDocument" | "supplierName" | "supplierProfile">, category = "goods") {
  const { address, ...profile } = parsed.supplierProfile;
  const existing = await tx.supplier.findUnique({ where: { document: parsed.supplierDocument } });
  const fill = Object.fromEntries(Object.entries(profile).filter(([key, value]) =>
    value && !existing?.[key as keyof typeof existing]));
  const supplier = await tx.supplier.upsert({
    where: { document: parsed.supplierDocument },
    update: Object.keys(fill).length ? { ...fill, version: { increment: 1 } } : {},
    create: { name: parsed.supplierName, document: parsed.supplierDocument, ...profile,
      origin: "invoice", category, homologationStatus: "pending", status: "active" },
    select: { id: true },
  });
  if (address.street && !await tx.supplierAddress.findFirst({ where: { supplierId: supplier.id }, select: { id: true } })) {
    await tx.supplierAddress.create({ data: { supplierId: supplier.id, ...address, label: "Fiscal (XML)", primary: true } });
  }
  return supplier;
}

export async function ensureDistributedIssuer(tx: Prisma.TransactionClient, document: { xml: string; documentType: string; fullDocumentAvailable: boolean; issuerDocument: string | null }, ownDocument: string) {
  if (!document.fullDocumentAvailable || !["nfe", "nfse", "cte"].includes(document.documentType)) return;
  const read = (xml: string, tag: string) => (xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"))?.[1] || "").trim();
  const emit = read(document.xml, "emit");
  const value = (xml: string, tag: string, max = 180) => read(xml, tag).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").slice(0, max) || null;
  const cnpj = read(emit, "CNPJ"), name = value(emit, "xNome", 200);
  if (!validCnpj(cnpj) || !name || cnpj !== document.issuerDocument || cnpj === ownDocument.replace(/\D/g, "")) return;
  const address = read(emit, "enderEmit") || read(emit, "enderNac");
  await ensureFiscalSupplier(tx, { supplierDocument: cnpj, supplierName: name, supplierProfile: {
    tradeName: value(emit, "xFant", 200), stateRegistration: value(emit, "IE", 40), municipalRegistration: value(emit, "IM", 40),
    email: value(emit, "email", 200), phone: value(emit, "fone", 30),
    address: { zip: value(address, "CEP", 10), street: value(address, "xLgr"), number: value(address, "nro", 30),
      complement: value(address, "xCpl", 120), district: value(address, "xBairro", 120), city: value(address, "xMun", 120), state: value(address, "UF", 2) },
  } }, document.documentType === "cte" ? "logistics" : document.documentType === "nfse" ? "services" : "goods");
}
