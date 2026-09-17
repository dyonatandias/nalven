"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect */

import { setTenantTimeZone, tenantTimeZone } from "@/lib/client-timezone";
import Link from "next/link";
import { DownloadLink } from "@/components/portal/download-link";
import { SupportWorkspace } from "@/components/portal/support-workspace";
import { LicenseWorkspace } from "@/components/portal/license-workspace";
import { displayMoney, safePaymentUrl } from "@/lib/billing/portal-data";
import Image from "next/image";
import { FormEvent, useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

const tabs = [
  ["conta", "Minha conta", "⌂"],
  ["assinatura", "Assinatura", "◆"],
  ["faturas", "Faturas e pagamentos", "R$"],
  ["contratos", "Contratos", "▤"],
  ["fiscal", "Documentos fiscais", "NF"],
  ["suporte", "Suporte", "?"],
  ["licenca", "Licença e recursos", "✓"]
];

type Action = (action: string, payload?: Record<string, unknown>) => Promise<any>;

export default function PortalClient({ user, organization, initialTab = "conta" }: { user: { name: string; email: string }; organization: { id: string; name: string; status: string; timezone: string }; initialTab?: string }) {
  setTenantTimeZone(organization.timezone);
  const router = useRouter();
  const tab = tabs.some(([id]) => id === initialTab) ? initialTab : "conta";
  const financialArea = tab !== "suporte" && tab !== "licenca";
  const [portal, setPortal] = useState<any>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutPending = useRef(false);
  const loadController = useRef<AbortController | null>(null);

  const [loading, setLoading] = useState(true);
  const pending = useRef(new Map<string,string>());
  const working = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    loadController.current?.abort();
    const controller = new AbortController(); loadController.current = controller;
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    setLoading(true);setError("");
    try {
      const response=await fetch("/api/portal/billing",{cache:"no-store",signal:requestSignal});
      if (requestSignal.aborted) return;
      if ([401,403].includes(response.status)) setPortal(undefined);
      const data=await readResponse(response);
      if (!requestSignal.aborted) setPortal(data);
    } catch(error) {if(!requestSignal.aborted)setError(error instanceof Error?error.message:"Não foi possível carregar o portal.");}
    finally {if(!requestSignal.aborted)setLoading(false);}
  },[]);
  // Support and licensing must remain available without invoice/catalog services.
  useEffect(()=>{
    if(tab === "suporte" || tab === "licenca") { loadController.current?.abort(); setLoading(false); return; }
    const controller=new AbortController();void load(controller.signal);return()=>controller.abort();
  },[load,tab]);
  useEffect(()=>{setNotice("");setError("");},[tab]);
  useEffect(()=>()=>loadController.current?.abort(),[]);
  async function action(actionName: string, payload: Record<string, unknown> = {}) {
    if(working.current || !portal?.capabilities?.canWrite)return undefined;
    working.current=true;setBusy(true);setError("");setNotice("");
    const fingerprint=JSON.stringify({action:actionName,...payload});
    const commandId=pending.current.get(fingerprint)||crypto.randomUUID();pending.current.set(fingerprint,commandId);
    try {
      const response=await fetch("/api/portal/billing",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:actionName,commandId,...payload})});
      const data=await readResponse(response);pending.current.delete(fingerprint);
      setNotice(actionName==="contract_otp"?"Solicitação do código recebida. Confira seu e-mail.":"Operação concluída com sucesso.");
      if(!["charge","contract_otp"].includes(actionName))await load();
      if(actionName==="customer_update")router.refresh();
      return data.result ?? {};
    } catch(error) {setError(error instanceof Error?error.message:"Não foi possível concluir a operação.");return undefined;}
    finally {working.current=false;setBusy(false);}
  }

  async function logout() {
    if(logoutPending.current || busy)return;
    logoutPending.current=true;setLoggingOut(true);setLogoutError("");
    try { await readResponse(await fetch("/api/auth/logout", { method: "POST" })); router.replace("/login"); router.refresh(); }
    catch {setLogoutError("Não foi possível sair. Sua sessão continua aberta; tente novamente.");logoutPending.current=false;setLoggingOut(false);}
  }

  const identity = portal?.organization || organization;
  const current = tabs.find(item => item[0] === tab);
  return <div className="customer-portal">
    <a className="portal-skip-link" href="#portal-content">Pular para o conteúdo</a>
    <aside>
      <Link href="/" className="public-logo light">NAL<span>VEN</span></Link>
      <div className="customer-org">
        <span>{identity.name.slice(0, 2).toUpperCase()}</span>
        <strong>{identity.name}</strong>
        <small>{statusLabel(identity.status)}</small>
      </div>
      <Link href="/erp" className="portal-erp-link">Abrir sistema de gestão</Link>
      <label className="portal-mobile-navigation">Navegar no portal<select aria-label="Navegar no portal" value={tab} onChange={event=>router.push(`/portal?area=${event.target.value}`,{scroll:false})}>{tabs.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><nav aria-label="Portal do cliente">{tabs.map(([id,label,icon])=><Link href={`/portal?area=${id}`} scroll={false} aria-current={tab===id?"page":undefined} className={tab===id?"active":""} key={id}><i aria-hidden="true">{icon}</i>{label}</Link>)}</nav>
      <button onClick={logout} disabled={loggingOut||busy}>{loggingOut?"Saindo…":"Sair da conta"}</button>
    </aside>
    <main>
      <header>
        <div><small>PORTAL DO CLIENTE</small><h1>{current?.[1]}</h1></div>
        <div><strong>{user.name}</strong><small>{user.email}</small></div>{financialArea&&<button className="portal-refresh" disabled={loading||busy} onClick={()=>void load()}>{loading?"Atualizando…":"Atualizar dados"}</button>}
      </header>
      <section id="portal-content" tabIndex={-1}>
        {logoutError && <div className="portal-alert error" role="alert"><span>{logoutError}</span><button onClick={()=>void logout()} disabled={loggingOut}>Tentar sair novamente</button></div>}
        {financialArea&&error && <div className="portal-alert error" role="alert"><strong>Não foi possível concluir</strong><span>{error}</span><button onClick={()=>void load()}>Tentar novamente</button></div>}
        <div hidden={tab!=="suporte"}><SupportWorkspace key={organization.id} organizationId={organization.id} active={tab==="suporte"}/></div>
        <div hidden={tab!=="licenca"}><LicenseWorkspace key={organization.id} organizationId={organization.id} active={tab==="licenca"}/></div>
        {financialArea&&<>
          {notice && <div className="portal-alert success" role="status"><strong>Tudo certo</strong><span>{notice}</span></div>}
          {portal && !portal.capabilities?.canWrite && <p className="portal-notice">Seu perfil permite consultar o portal. Alterações dependem de permissão financeira.</p>}
          {!portal ? loading ? <div className="module-loading" role="status">Carregando seu portal…</div> : <Empty icon="!" title="Portal indisponível" text="Tente atualizar os dados para continuar." /> : portal.section_errors?.portal ? <Empty icon="!" title="Consulta financeira indisponível" text={portal.section_errors.portal} /> : <PortalSection key={tab} tab={tab} data={portal} user={user} organization={identity} action={action} busy={busy} />}
          {portal?.generated_at && <p className="portal-sync">Consultado em {dateTime(portal.generated_at)}</p>}
        </>}
      </section>
      <footer>© {new Date().getFullYear()} NALVEN · Portal do cliente</footer>
    </main>
  </div>;
}

function PortalSection({ tab, data, user, organization, action, busy }: { tab: string; data: any; user: any; organization: any; action: Action; busy: boolean }) {
  if (tab === "conta") return <Account data={data} user={user} organization={organization} action={action} busy={busy} />;
  if (tab === "assinatura") return <Subscription data={data} action={action} busy={busy} />;
  if (tab === "faturas") return <Invoices data={data} action={action} busy={busy} />;
  if (tab === "contratos") return <Contracts data={data} action={action} busy={busy} />;
  if (tab === "fiscal") return <Fiscal data={data} />;
  return null;
}

function Account({ data, user, organization, action, busy }: { data: any; user: any; organization: any; action: Action; busy: boolean }) {
  const readOnly = !data.capabilities?.canWrite;
  const customer = data.customer || data.cliente || {};
  const installation = data.installation || data.instalacao || {};
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await action("customer_update", { payload: values });
  }
  return <div className="portal-stack">
    <section className="portal-summary">
      <div><span className="portal-kicker">CONTA FINANCEIRA</span><h2>{organization.name}</h2><p>{customer.razao_social || organization.name}</p></div>
      <Status value={customer.status || installation.status || organization.status} />
    </section>
    <div className="portal-detail-grid">
      <Info title="Empresa" icon="EP" rows={[["Razão social", customer.razao_social], ["CNPJ", document(customer.documento)], ["Inscrição estadual", customer.inscricao_estadual ?? "Não informado"]]} />
      <Info title="Responsável financeiro" icon="RF" rows={[["Nome", customer.responsavel_nome || user.name], ["E-mail", customer.responsavel_email || user.email], ["Telefone", phone(customer.responsavel_telefone)]]} />
      <Info title="Endereço de cobrança" icon="EN" rows={[["Endereço", join(customer.logradouro, customer.numero)], ["Bairro", customer.bairro], ["Cidade", join(customer.cidade, customer.estado, " / ")], ["CEP", customer.cep]]} />
      <Info title="Ambiente NALVEN" icon="NV" rows={[["Instalação", organization.name], ["Ambiente", statusLabel(installation.ambiente)], ["Versão", installation.versao], ["Criado em", date(installation.created_at)]]} />
    </div>
    <details className="portal-form-card">
      <summary>Editar contato e endereço de cobrança</summary>
      <form onSubmit={save} className="portal-form-grid">
        <Field name="nome_fantasia" label="Nome fantasia" value={customer.nome_fantasia} />
        <Field name="responsavel_nome" label="Responsável" value={customer.responsavel_nome} />
        <Field name="responsavel_email" label="E-mail financeiro" value={customer.responsavel_email} type="email" />
        <Field name="responsavel_telefone" label="Telefone" value={customer.responsavel_telefone} />
        <Field name="cep" label="CEP" value={customer.cep} />
        <Field name="logradouro" label="Logradouro" value={customer.logradouro} />
        <Field name="numero" label="Número" value={customer.numero} />
        <Field name="complemento" label="Complemento" value={customer.complemento} required={false} />
        <Field name="bairro" label="Bairro" value={customer.bairro} />
        <Field name="cidade" label="Cidade" value={customer.cidade} />
        <Field name="estado" label="UF" value={customer.estado} maxLength={2} />
        <button className="portal-primary" disabled={busy||readOnly}>{busy ? "Salvando…" : "Salvar alterações"}</button>
      </form>
    </details>
  </div>;
}

function Subscription({ data, action, busy }: { data: any; action: Action; busy: boolean }) {
  const readOnly = !data.capabilities?.canWrite;
  const subscription = data.subscription || data.assinatura || {};
  const plans = asList(data.catalog?.plans);
  const availableMethods = data.payment_methods || {};
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action("subscription_update", { payload: { plano_codigo: form.get("plano_codigo"), forma_pagamento: form.get("forma_pagamento"), dia_vencimento: Number(form.get("dia_vencimento")), modulos: subscription.modulos_adicionais || [] } });
  }
  return <div className="portal-stack">
    <section className="portal-summary billing"><div><span className="portal-kicker">PLANO ATUAL</span><h2>{data.application_plan?.name || subscription.plano_nome || "Plano NALVEN"}</h2><p>Cobrança {statusLabel(subscription.tipo_cobranca)} · vencimento dia {subscription.dia_vencimento || "—"}</p></div><div className="portal-price"><strong>{money(subscription.valor_mensal)}</strong><small>por mês</small></div></section>
    <div className="portal-metrics">
      <Metric label="Situação" value={statusLabel(subscription.status)} />
      <Metric label="Plano" value={money(subscription.valor_plano_mensal)} />
      <Metric label="Módulos adicionais" value={money(subscription.valor_modulos_mensal)} />
      <Metric label="Próxima cobrança" value={date(subscription.data_proxima_cobranca)} />
    </div>
    <section className="portal-panel"><header><div><h3>Módulos incluídos</h3><p>Módulos habilitados neste ambiente.</p></div></header><div className="portal-chip-list">{data.application_plan ? data.application_plan.modules.map((module: {id:string;name:string}) => <span key={module.id}>✓ {module.name}</span>) : (subscription.modulos_efetivos || []).map((module: string) => <span key={module}>✓ {moduleLabel(module, data.catalog?.modules)}</span>)}</div></section>
    {data.section_errors?.catalog ? <p role="alert" className="portal-notice">{data.section_errors.catalog}</p> : <details className="portal-form-card">
      <summary>Alterar plano ou preferência de cobrança</summary>
      <form onSubmit={save} className="portal-form-grid compact">
        <label>Plano<select name="plano_codigo" defaultValue={subscription.plano_codigo}>{plans.map((plan: any) => <option value={plan.codigo} key={plan.codigo}>{plan.nome} — {money(plan.precos?.[subscription.forma_pagamento_preferida || "pix"])}</option>)}</select></label>
        <label>Pagamento<select name="forma_pagamento" defaultValue={subscription.forma_pagamento_preferida}>{availableMethods.pix && <option value="pix">Pix</option>}{availableMethods.boleto && <option value="boleto">Boleto</option>}{availableMethods.cartao && <option value="cartao">Cartão</option>}</select></label>
        <label>Dia do vencimento<input name="dia_vencimento" type="number" min="1" max="28" defaultValue={subscription.dia_vencimento || 10} /></label>
        <label className="portal-confirm"><input type="checkbox" required /> Confirmo que a alteração pode recalcular o valor da assinatura.</label>
        <button className="portal-primary" disabled={busy||readOnly}>{busy ? "Atualizando…" : "Atualizar assinatura"}</button>
      </form>
    </details>}
  </div>;
}

function Invoices({ data, action, busy }: { data: any; action: Action; busy: boolean }) {
  const readOnly = !data.capabilities?.canWrite;
  const invoices = asList(data.invoices || data.faturas);
  const [charge, setCharge] = useState<any>();
  const [search,setSearch]=useState("");const [status,setStatus]=useState("");const [selected,setSelected]=useState<any>();const [detailError,setDetailError]=useState("");
  const filtered=invoices.filter((i:any)=>(!status||i.status===status)&&(!search||`${i.numero||i.id} ${i.descricao||""}`.toLowerCase().includes(search.toLowerCase())));
  async function detail(id:string){try {setDetailError("");setSelected(await readResponse(await fetch(`/api/portal/billing?resource=invoice&id=${encodeURIComponent(id)}`)));}catch(e){setDetailError(e instanceof Error?e.message:"Não foi possível abrir a fatura.");}}
  async function issue(invoiceId: unknown, method: "pix" | "boleto" | "cartao") { const result=await action("charge", { invoiceId: String(invoiceId), payload: { metodo: method } });if(result!==undefined)setCharge(result.charge || result.cobranca || result); }
  const pending = invoices.filter((item: any) => ["pendente", "vencida"].includes(item.status));
  const pendingTotal = pending.every((item:any)=>(item.valor_total ?? item.valor)!=null && Number.isFinite(Number(item.valor_total ?? item.valor))) ? pending.reduce((total:number,item:any)=>total+Number(item.valor_total ?? item.valor),0) : undefined;
  const paymentUrl=safePaymentUrl(charge?.checkout_url || charge?.init_point || charge?.payment_url);
  const paymentReady=Boolean(charge?.pix_copy_paste || charge?.linha_digitavel || charge?.digitable_line || paymentUrl);
  return <div className="portal-stack">
    <div className="portal-metrics"><Metric label="Faturas" value={String(invoices.length)} /><Metric label="Pendentes" value={String(pending.length)} /><Metric label="Em aberto" value={money(pendingTotal)} /><Metric label="Meios disponíveis" value={[data.payment_methods?.pix && "Pix", data.payment_methods?.boleto && "Boleto", data.payment_methods?.cartao && "Cartão"].filter(Boolean).join(" · ") || "—"} /></div>
    {charge && <section className="portal-payment-result"><header><div><span>COBRANÇA GERADA</span><h3>{charge.status === "processing" ? "Pagamento em processamento" : paymentReady ? "Pronto para pagamento" : "Aguardando instruções de pagamento"}</h3></div><Status value={charge.status || (paymentReady ? "disponivel" : "pending")} /></header>{charge.pix_qr_code_base64 && <Image width={170} height={170} unoptimized src={`data:image/png;base64,${charge.pix_qr_code_base64}`} alt="QR Code Pix" />}{charge.pix_copy_paste && <CopyValue label="Pix copia e cola" value={charge.pix_copy_paste} />}{(charge.linha_digitavel || charge.digitable_line) && <CopyValue label="Linha digitável" value={charge.linha_digitavel || charge.digitable_line} />}{safePaymentUrl(charge.checkout_url || charge.init_point || charge.payment_url) && <a className="portal-primary" href={safePaymentUrl(charge.checkout_url || charge.init_point || charge.payment_url)!} target="_blank" rel="noopener noreferrer">Abrir pagamento seguro</a>}{charge.expires_at && <p>Válido até {dateTime(charge.expires_at)}</p>}</section>}
    {detailError&&<p role="alert" className="portal-alert error">{detailError}</p>}
    <div className="portal-filters"><label>Buscar fatura<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Número ou descrição" /></label><label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">Todos</option>{[...new Set(invoices.map((i:any)=>String(i.status)))].map(status=><option key={status} value={status}>{statusLabel(status)}</option>)}</select></label></div>
    {selected&&<section className="portal-panel"><header><h3>Detalhes da fatura {selected.numero || selected.id}</h3><button onClick={()=>setSelected(undefined)}>Fechar</button></header><Info title="Cobrança" icon="R$" rows={[["Descrição",selected.descricao],["Valor",money(selected.valor_total ?? selected.valor)],["Vencimento",date(selected.data_vencimento ?? selected.vencimento)],["Situação",statusLabel(selected.status)]]}/></section>}
    <section className="portal-panel"><header><div><h3>Histórico de faturas</h3><p>Valores e cobranças gerenciados pelo Billing Expresso.</p></div></header>{invoices.length ? <div className="portal-table-wrap"><table><thead><tr><th>Fatura</th><th>Vencimento</th><th>Valor</th><th>Status</th><th>Ações</th></tr></thead><tbody>{filtered.map((invoice: any, index: number) => <tr key={invoice.id || index}><td><strong>{invoice.numero || invoice.descricao || `#${invoice.id}`}</strong><small>{date(invoice.created_at || invoice.data_emissao)}</small></td><td>{date(invoice.data_vencimento || invoice.vencimento || invoice.due_at)}</td><td>{money(invoice.valor_total ?? invoice.valor ?? invoice.amount)}</td><td><Status value={invoice.status} /></td><td><div className="portal-row-actions"><button onClick={()=>void detail(String(invoice.id))}>Detalhes</button>{["pendente", "vencida"].includes(invoice.status) && data.payment_methods?.cartao && <button disabled={busy||readOnly} onClick={()=>issue(invoice.id,"cartao")}>Pagar com cartão</button>}{["pendente", "vencida"].includes(invoice.status) && data.payment_methods?.pix && <button disabled={busy||readOnly} onClick={() => issue(invoice.id, "pix")}>Gerar Pix</button>}{["pendente", "vencida"].includes(invoice.status) && data.payment_methods?.boleto && <button disabled={busy||readOnly} onClick={() => issue(invoice.id, "boleto")}>Gerar boleto</button>}{invoice.boleto_disponivel && <DownloadLink href={`/api/portal/billing/files?type=boleto&invoiceId=${encodeURIComponent(invoice.id)}`}>Baixar boleto</DownloadLink>}</div></td></tr>)}{!filtered.length && <tr><td colSpan={5}>Nenhuma fatura corresponde aos filtros.</td></tr>}</tbody></table></div> : <Empty icon="R$" title="Nenhuma fatura emitida" text="Quando o Billing gerar a primeira cobrança, ela aparecerá aqui com Pix, boleto e comprovantes disponíveis." />}</section>
  </div>;
}

function Contracts({ data, action, busy }: { data: any; action: Action; busy: boolean }) {
  const readOnly = !data.capabilities?.canWrite;
  const contracts = asList(data.contracts || data.contratos);
  const [selected, setSelected] = useState<any>();
  const [detailError,setDetailError]=useState("");const [opening,setOpening]=useState(false);
  async function open(token: string) {setOpening(true);setDetailError("");try {if(!token)throw new Error("Identificador do documento não informado.");const detail=await readResponse(await fetch(`/api/portal/billing?resource=contract&token=${encodeURIComponent(token)}`,{cache:"no-store"}));setSelected({...detail,token:detail.token||token});}catch(error){setDetailError(error instanceof Error?error.message:"Não foi possível abrir o detalhe.");}finally{setOpening(false);}}

  async function otp(token: string) { await action("contract_otp", { token }); }
  async function sign(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const result=await action("contract_sign", { token: selected.token, otp: form.get("otp"), accepted:true }); if(result!==undefined)setSelected(undefined); }
  return <div className="portal-stack">{detailError && <p role="alert" className="portal-alert error">{detailError}</p>}{opening && <p role="status">Carregando documento…</p>}<section className="portal-panel"><header><div><h3>Contratos da assinatura</h3><p>Leia, assine com código OTP e baixe o documento final.</p></div></header>{contracts.length ? <div className="portal-card-list">{contracts.map((contract: any) => <article key={contract.token || contract.id}><div><strong>{contract.titulo || contract.modelo_nome || `Contrato ${contract.numero || contract.id}`}</strong><small>Atualizado em {date(contract.updated_at || contract.created_at)}</small></div><Status value={contract.status} /><button disabled={opening} onClick={() => open(contract.token)}>Visualizar</button>{contract.status === "assinado" && <DownloadLink href={`/api/portal/billing/files?type=contrato&token=${encodeURIComponent(contract.token)}`}>Baixar PDF</DownloadLink>}</article>)}</div> : <Empty icon="▤" title="Nenhum contrato disponível" text="Os contratos vinculados ao seu plano serão exibidos aqui para leitura e assinatura eletrônica." />}</section>{selected && <section className="portal-contract"><header><div><span>DOCUMENTO PARA CONFERÊNCIA</span><h3>{selected.titulo || selected.modelo_nome || "Contrato NALVEN"}</h3></div><button onClick={() => setSelected(undefined)}>Fechar</button></header><ContractBody content={String(selected.corpo || selected.conteudo || "Conteúdo indisponível.")} /><footer><small>Integridade: {selected.corpo_hash || "Hash não informado"}</small>{["pendente","enviado","aguardando_assinatura"].includes(selected.status) && <><button onClick={() => otp(selected.token)} disabled={busy||readOnly}>Enviar código por e-mail</button><form onSubmit={sign}><input name="otp" aria-label="Código de assinatura" autoComplete="one-time-code" pattern="[0-9]{6,8}" inputMode="numeric" minLength={6} maxLength={8} placeholder="Código OTP" required /><label><input type="checkbox" required /> Li e aceito os termos</label><button className="portal-primary" disabled={busy||readOnly}>Assinar contrato</button></form></>}</footer></section>}</div>;
}

function Fiscal({ data }: { data: any }) {
  const documents = asList(data.fiscal_documents || data.documentos_fiscais);
  if(data.section_errors?.fiscal)return <Empty icon="!" title="Consulta fiscal indisponível" text={data.section_errors.fiscal} />;
  return <section className="portal-panel"><header><div><h3>Notas fiscais e arquivos</h3><p>Consulte DANFSe e XML emitidos para suas cobranças.</p></div></header>{documents.length ? <div className="portal-table-wrap"><table><thead><tr><th>Documento</th><th>Emissão</th><th>Valor</th><th>Status</th><th>Downloads</th></tr></thead><tbody>{documents.map((item: any, index: number) => <tr key={item.token || item.id || index}><td><strong>{item.numero || item.numero_nfse || `NFS-e #${item.id}`}</strong><small>{item.descricao || item.serie}</small></td><td>{date(item.data_emissao || item.created_at)}</td><td>{money(item.valor_total ?? item.valor)}</td><td><Status value={item.status} /></td><td><div className="portal-row-actions">{item.token && <DownloadLink href={`/api/portal/billing/files?type=danfse&token=${encodeURIComponent(item.token)}`}>DANFSe</DownloadLink>}{item.token && <DownloadLink href={`/api/portal/billing/files?type=xml&token=${encodeURIComponent(item.token)}`}>XML</DownloadLink>}{!item.token && <span>Arquivo ainda não disponível</span>}</div></td></tr>)}</tbody></table></div> : <Empty icon="NF" title="Nenhum documento fiscal" text="Notas fiscais autorizadas aparecerão aqui após o processamento financeiro correspondente." />}</section>;
}

function Info({ title, icon, rows }: { title: string; icon: string; rows: Array<[string, unknown]> }) { return <article className="portal-info"><header><span>{icon}</span><h3>{title}</h3></header>{rows.map(([label, value]) => <p key={label}><small>{label}</small><strong>{String(value || "—")}</strong></p>)}</article>; }
function Metric({ label, value }: { label: string; value: string }) { return <article><small>{label}</small><strong>{value}</strong></article>; }
function Status({ value }: { value: unknown }) { const text = String(value || "indisponível"); return <span className={`portal-status ${statusTone(text)}`}>{statusLabel(text)}</span>; }
function Empty({ icon, title, text }: { icon: string; title: string; text: string }) { return <div className="portal-empty"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>; }
function Field({ name, label, value, type = "text", required = true, ...props }: { name: string; label: string; value?: unknown; type?: string; required?: boolean; [key: string]: unknown }) { return <label>{label}<input name={name} type={type} defaultValue={String(value || "")} required={required} {...props} /></label>; }
function CopyValue({ label, value }: { label: string; value: string }) { const [copied, setCopied] = useState(false),[error,setError]=useState(""); async function copy() {try {if(!navigator.clipboard)throw new Error();await navigator.clipboard.writeText(value);setCopied(true);setError("");}catch{setCopied(false);setError("Não foi possível copiar automaticamente. Selecione o código e copie manualmente.");}} return <div className="portal-copy"><small>{label}</small><code tabIndex={0}>{value}</code><button onClick={copy}>{copied ? "Copiado" : "Copiar"}</button>{error&&<small role="status">{error}</small>}</div>; }

function asList(value: any): any[] { if (Array.isArray(value)) return value; if(Array.isArray(value?.documents))return value.documents; if (Array.isArray(value?.items)) return value.items; if (Array.isArray(value?.data)) return value.data; return []; }
function money(value: unknown) {return displayMoney(value);}
function date(value: unknown) { if (!value) return "—"; const parsed = new Date(String(value)); return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString("pt-BR", { timeZone: "UTC" }); }
function dateTime(value: unknown) { if (!value) return "—"; const parsed = new Date(String(value)); return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("pt-BR", { timeZone: tenantTimeZone() }); }
function document(value: unknown) { const digits = String(value || "").replace(/\D/g, ""); return digits.length === 14 ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : String(value || "—"); }
function phone(value: unknown) { const digits = String(value || "").replace(/\D/g, ""); return digits.length === 11 ? digits.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3") : String(value || "—"); }
function join(a: unknown, b: unknown, separator = ", ") { return [a, b].filter(Boolean).join(separator) || "—"; }
function statusLabel(value: unknown) { const text = String(value || "").toLowerCase(); const labels: Record<string, string> = { trial: "Período de teste", active: "Ativo", ativo: "Ativo", ativa: "Ativa", producao: "Produção", mensal: "Mensal", pending: "Pendente", pendente: "Pendente", paid: "Paga", paga: "Paga", overdue: "Vencida", vencida: "Vencida", cancelled: "Cancelada", cancelada: "Cancelada", processing: "Processando", disponivel: "Disponível", media: "Média", duvida: "Dúvida" }; return labels[text] || (text ? text.charAt(0).toUpperCase() + text.slice(1).replaceAll("_", " ") : "—"); }
function statusTone(value: string) { const text = value.toLowerCase(); if (["active", "ativo", "ativa", "paid", "paga", "assinado", "disponível"].includes(text)) return "ok"; if (["pending", "pendente", "processing", "trial"].includes(text)) return "warn"; if (["vencida", "overdue", "cancelada", "failed", "suspensa"].includes(text)) return "danger"; return "neutral"; }
function moduleLabel(code: string, modules: any) { return asList(modules).find((module: any) => module.codigo === code)?.nome || code.replaceAll("_", " "); }

async function readResponse(response: Response) {
  let data;try {data=await response.json();}catch {throw new Error("Resposta inválida do serviço. Tente novamente.");}
  if(!response.ok)throw new Error(data.error || "Não foi possível concluir a solicitação.");
  return data;
}

function ContractBody({content}:{content:string}) {
 if(/<(?:p|div|html|section|table)\b/i.test(content))return <iframe className="portal-contract-frame" title="Conteúdo do contrato" sandbox="" srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:15px/1.6 system-ui;color:#253b4b;padding:20px;overflow-wrap:anywhere}</style>${content}`}/>;
 return <div className="portal-contract-body">{content.split("\n").map((line,index)=><p key={index}>{line||" "}</p>)}</div>;
}
