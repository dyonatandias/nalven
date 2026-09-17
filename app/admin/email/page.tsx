import EmailSettings from "@/components/admin/email-settings";

export default function EmailPage() {
  return <><div className="module-heading"><div><p>CONFIGURAÇÕES DA PLATAFORMA</p><h1>E-mail e SMTP</h1><span>Transporte e entrega dos e-mails do NALVEN, separados da cobrança externa.</span></div></div><EmailSettings /></>;
}
