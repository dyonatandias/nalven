import { randomUUID, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { validAccessKey, validCnpj } from "./nfe-input";

const EVENT_ENDPOINTS = {
  production: "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  homologation: "https://hom.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
} as const;
const EVENT_ACTION = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEventoNF";
const XML_NS = "http://www.portalfiscal.inf.br/nfe";
const SOAP_MAX_BYTES = 2_000_000;

export class NfeManifestationError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "NfeManifestationError";
  }
}

type Environment = keyof typeof EVENT_ENDPOINTS;

export function buildScienceEvent(input: {
  accessKey: string;
  document: string;
  environment: Environment;
  occurredAt: Date;
  privateKeyPem: string;
  certificatePem: string;
}) {
  const document = input.document.replace(/\D/g, "");
  if (!validCnpj(document)) throw new NfeManifestationError("CNPJ do destinatário inválido.");
  if (!validAccessKey(input.accessKey)) throw new NfeManifestationError("Chave de acesso inválida.");
  if (!Number.isFinite(input.occurredAt.valueOf())) throw new NfeManifestationError("Data do evento inválida.");
  const id = `ID210210${input.accessKey}01`;
  const timestamp = fiscalTimestamp(input.occurredAt);
  const event = `<evento xmlns="${XML_NS}" versao="1.00"><infEvento Id="${id}"><cOrgao>91</cOrgao><tpAmb>${input.environment === "production" ? "1" : "2"}</tpAmb><CNPJ>${document}</CNPJ><chNFe>${input.accessKey}</chNFe><dhEvento>${timestamp}</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento></evento>`;
  const signer = new SignedXml({
    privateKey: input.privateKeyPem,
    publicCert: input.certificatePem,
    getKeyInfoContent: SignedXml.getKeyInfoContent,
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  });
  signer.addReference({
    xpath: "//*[local-name(.)='infEvento']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
  });
  signer.computeSignature(event, { location: { reference: "//*[local-name(.)='infEvento']", action: "after" } });
  const signedEvent = signer.getSignedXml();
  return `<envEvento xmlns="${XML_NS}" versao="1.00"><idLote>${Date.now()}</idLote>${signedEvent}</envEvento>`;
}

export function pfxSigningIdentity(pfx: Buffer, password: string, expectedDocument: string) {
  let store: forge.pkcs12.Pkcs12Pfx;
  try {
    store = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfx.toString("binary")), false, password);
  } catch {
    throw new NfeManifestationError("Não foi possível abrir o certificado A1 configurado.");
  }
  const keyBag = store.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.find(bag => bag.key);
  if (!keyBag?.key) throw new NfeManifestationError("Certificado A1 sem chave privada.");
  const privateKey = keyBag.key as forge.pki.rsa.PrivateKey;
  const certBag = store.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.find(bag => {
    const publicKey = bag.cert?.publicKey as forge.pki.rsa.PublicKey | undefined;
    return publicKey?.n?.compareTo(privateKey.n) === 0;
  });
  if (!certBag?.cert) throw new NfeManifestationError("Certificado público correspondente à chave privada não encontrado.");
  const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
  const certificatePem = forge.pki.certificateToPem(certBag.cert);
  const subjectDigits = new X509Certificate(certificatePem).subject.replace(/\D/g, "");
  const base = expectedDocument.replace(/\D/g, "").slice(0, 8);
  if (!base || !subjectDigits.includes(base)) throw new NfeManifestationError("O certificado A1 não pertence ao CNPJ-base da filial.", 403);
  return { privateKeyPem, certificatePem };
}

export function manifestationEnvelope(eventXml: string) {
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">${eventXml}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
}

export function parseScienceResponse(xml: string, expectedAccessKey?: string) {
  if (Buffer.byteLength(xml, "utf8") > SOAP_MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new NfeManifestationError("Resposta inválida do serviço de manifestação.", 502);
  const result = block(xml, "retEvento") || xml;
  const status = text(result, "cStat"), reason = text(result, "xMotivo").slice(0, 300), protocol = text(result, "nProt") || null;
  const accessKey = text(result, "chNFe"), eventType = text(result, "tpEvento");
  if (eventType && eventType !== "210210") throw new NfeManifestationError("A SEFAZ respondeu com um tipo de evento diferente do solicitado.", 502);
  if (expectedAccessKey && accessKey !== expectedAccessKey) throw new NfeManifestationError("A SEFAZ respondeu para outra chave de acesso.", 502);
  if (!["135", "573"].includes(status)) throw new NfeManifestationError(`SEFAZ ${status || "sem código"}: ${reason || "manifestação recusada"}.`, 422);
  return { status, reason, protocol, accessKey, eventType, registered: status === "135", alreadyRegistered: status === "573" };
}

export async function sendScienceEvent(input: { eventXml: string; accessKey: string; pfx: Buffer; passphrase: string; environment: Environment }) {
  const body = manifestationEnvelope(input.eventXml), endpoint = new URL(EVENT_ENDPOINTS[input.environment]);
  const response = await new Promise<string>((resolve, reject) => {
    const request = httpsRequest({ protocol: endpoint.protocol, hostname: endpoint.hostname, path: endpoint.pathname, method: "POST",
      pfx: input.pfx, passphrase: input.passphrase, minVersion: "TLSv1.2", rejectUnauthorized: true, timeout: 30_000,
      headers: { "content-type": `application/soap+xml; charset=utf-8; action="${EVENT_ACTION}"`, accept: "application/soap+xml", "content-length": Buffer.byteLength(body), "x-request-id": randomUUID() },
    }, result => { const chunks: Buffer[] = []; let size = 0, oversized = false; result.on("data", (chunk: Buffer) => { size += chunk.length; if (size > SOAP_MAX_BYTES) { oversized = true; result.destroy(); } else chunks.push(chunk); }); result.on("error", () => reject(new NfeManifestationError("Resposta interrompida pelo serviço de manifestação.", 502))); result.on("end", () => {
      if (oversized) return reject(new NfeManifestationError("Resposta do serviço de manifestação acima do limite seguro.", 502));
      const responseXml = Buffer.concat(chunks).toString("utf8");
      if (result.statusCode && result.statusCode >= 200 && result.statusCode < 300) resolve(responseXml);
      else reject(new NfeManifestationError(`Serviço de manifestação respondeu HTTP ${result.statusCode || 0}${soapFault(responseXml) ? `: ${soapFault(responseXml)}` : ""}.`, 502));
    }); });
    request.on("timeout", () => request.destroy());
    request.on("error", () => reject(new NfeManifestationError("Não foi possível conectar ao serviço de manifestação da NF-e.", 502)));
    request.end(body);
  });
  return { responseXml: response, result: parseScienceResponse(response, input.accessKey) };
}

function fiscalTimestamp(value: Date) {
  return `${value.toISOString().slice(0, 19)}+00:00`;
}
function block(xml: string, name: string) { return xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i"))?.[1] || ""; }
function text(xml: string, name: string) { return (xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i"))?.[1] || "").trim(); }
function soapFault(xml: string) { return (text(xml, "Text") || text(xml, "faultstring")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }
