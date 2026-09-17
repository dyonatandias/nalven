export const POS_MANUAL_T2_DLP_CLASS_A_VECTORS = [
  { label: "PAN Luhn contínuo", value: "4111111111111111" },
  { label: "PAN Luhn formatado", value: "4111 1111 1111 1111" },
  { label: "CVV", value: "cvv:123" },
  { label: "PIN", value: "pin:1234" },
  { label: "track 1", value: "track1:secret" },
  { label: "vault token", value: "vault_token:secret" },
  { label: "referência aberta", value: "open_reference:secret" },
  { label: "código de autorização", value: "authorization_code:ABC123" },
  { label: "NSU", value: "nsu:123456" },
  { label: "E2E", value: "e2e:E123" },
] as const;

export const POS_MANUAL_T2_DLP_CLASS_B_VECTORS = [
  { label: "e-mail", value: "ana@example.com" },
  { label: "CPF", value: "529.982.247-25" },
  { label: "CNPJ", value: "04.252.011/0001-10" },
  { label: "telefone", value: "(11) 91234-5678" },
  { label: "CEP", value: "01310-100" },
  { label: "endereço", value: "Rua Augusta 100" },
  { label: "boundary Unicode em CPF", value: "écpfé" },
  { label: "boundary Unicode em nome", value: "中name中" },
] as const;

export const POS_MANUAL_T2_DLP_SAFE_VECTORS = [
  { label: "locator fiscal opaco", value: "opaque:v1:abc" },
  { label: "hash de evidência", value: `evt:${"a".repeat(64)}` },
  { label: "id opaco", value: "actor_opaque_7f3b" },
  { label: "últimos quatro mascarados", value: "A*9_" },
  { label: "sequência não-Luhn", value: "4111111111111112" },
  { label: "marcador entre ASCII", value: "scpfz" },
] as const;
