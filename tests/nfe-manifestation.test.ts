import assert from "node:assert/strict";
import test from "node:test";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { buildScienceEvent, manifestationEnvelope, parseScienceResponse, pfxSigningIdentity } from "@/lib/erp/nfe-manifestation";

const accessKey = "33260906328612000275550040000473981543674922";
const document = "62119228000152";

test("Ciência da Operação gera XML assinado e vinculado à chave correta", () => {
  const { pfx, password } = certificateFixture();
  const identity = pfxSigningIdentity(pfx, password, document);
  const event = buildScienceEvent({ accessKey, document, environment: "production", occurredAt: new Date("2026-09-10T20:30:00.000Z"), ...identity });
  assert.match(event, new RegExp(`<chNFe>${accessKey}</chNFe>`));
  assert.match(event, /<tpEvento>210210<\/tpEvento>/);
  assert.match(event, /<dhEvento>2026-09-10T20:30:00\+00:00<\/dhEvento>/);
  assert.match(event, /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
  const verifier = new SignedXml({ publicCert: identity.certificatePem });
  verifier.loadSignature(event.match(/<Signature[\s\S]*?<\/Signature>/)?.[0] || "");
  assert.equal(verifier.checkSignature(event), true);
  const soap = manifestationEnvelope(event);
  assert.match(soap, /soap12:Envelope/);
  assert.equal((soap.match(/<\?xml/g) || []).length, 1);
});

test("resposta da SEFAZ exige evento e chave solicitados", () => {
  const xml = `<soap:Envelope><soap:Body><retEnvEvento><retEvento><infEvento><tpEvento>210210</tpEvento><chNFe>${accessKey}</chNFe><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><nProt>591263628651803</nProt></infEvento></retEvento></retEnvEvento></soap:Body></soap:Envelope>`;
  assert.deepEqual(parseScienceResponse(xml, accessKey), { status: "135", reason: "Evento registrado e vinculado a NF-e", protocol: "591263628651803", accessKey, eventType: "210210", registered: true, alreadyRegistered: false });
  assert.throws(() => parseScienceResponse(xml, `${accessKey.slice(0, -1)}0`), /outra chave/);
  const duplicate = parseScienceResponse(xml.replace("<cStat>135", "<cStat>573").replace("Evento registrado e vinculado a NF-e", "Duplicidade"), accessKey);
  assert.equal(duplicate.alreadyRegistered, true);
});

function certificateFixture() {
  const keys = forge.pki.rsa.generateKeyPair(1024), certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  certificate.validity.notAfter = new Date("2027-01-01T00:00:00Z");
  certificate.setSubject([{ name: "commonName", value: `TESTE:${document}` }]);
  certificate.setIssuer([{ name: "commonName", value: "NALVEN TEST CA" }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const password = "test-password";
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certificate, password, { algorithm: "3des" });
  return { pfx: Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary"), password };
}
