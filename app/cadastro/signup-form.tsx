"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthField, AuthMessage, AuthPasswordField, AuthScreen, authFailure, authJson, authPasswordError, authStyles as styles, useAuthSubmission } from "@/components/auth/auth-ui";

const STATES = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];

export default function SignupForm({ plans, selectedPlan, paymentMethods, dueDay, unavailable = false }: {
  paymentMethods: string[]; dueDay: number; plans: Array<{ id: string; name: string; monthlyPrice: number }>; selectedPlan: string; unavailable?: boolean;
}) {
  const router = useRouter();
  const { busy, error, setError, begin, finish } = useAuthSubmission();
  const [planId, setPlanId] = useState(plans.find(plan => plan.id === selectedPlan)?.id || plans[0]?.id || "");
  const plan = plans.find(item => item.id === planId);
  const available = !unavailable && plans.length > 0 && paymentMethods.length > 0;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || !begin()) return;
    const form = new FormData(event.currentTarget);
    const passwordError = authPasswordError(form);
    if (passwordError) { setError(passwordError); finish(); return; }
    // Confirmation is local validation only; it is not stored or sent twice.
    const payload = Object.fromEntries(form); delete payload.confirmation;
    try {
      await authJson(await fetch("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), "Não foi possível concluir o cadastro. Revise os dados e tente novamente.");
      router.replace("/portal"); router.refresh();
    } catch (reason) { setError(authFailure(reason, "Não foi possível confirmar o cadastro. Verifique sua conexão; se a conta já foi criada, tente entrar antes de repetir.")); finish(); }
  }
  return <AuthScreen wide kicker="COMECE PELA SUA ORGANIZAÇÃO" title="Crie sua conta NALVEN" description="Cadastre seu acesso, os dados da empresa e o endereço de cobrança. Os dados financeiros são encaminhados ao Billing Expresso." footer={<>Já possui uma conta? <Link href="/login">Entrar</Link></>}>
    {!available ? <div className={styles.actions}><AuthMessage kind="info">A contratação não está disponível no momento. Nenhum dado foi enviado.</AuthMessage><Link className={styles.secondary} href="/cadastro">Tentar carregar os planos novamente</Link></div> : <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      <p className={styles.hint}>Todos os campos são obrigatórios, exceto onde indicado como opcional.</p>
      <fieldset disabled={busy}><legend>Seu acesso</legend><div className={styles.grid}>
        <AuthField name="name" label="Seu nome completo" autoComplete="name" minLength={2} maxLength={160} required />
        <AuthField name="email" label="E-mail de acesso" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} required />
        <AuthPasswordField label="Senha" newPassword disabled={busy} />
        <AuthPasswordField name="confirmation" label="Confirmar senha" newPassword confirmation disabled={busy} />
      </div></fieldset>
      <hr className={styles.divider} />
      <fieldset disabled={busy}><legend>Empresa e responsável</legend><div className={styles.grid}>
        <AuthField name="company" label="Empresa / razão social" autoComplete="organization" maxLength={180} required />
        <AuthField name="document" label="CNPJ ou CPF da empresa" inputMode="numeric" autoComplete="off" maxLength={18} hint="Informe o documento usado na cobrança." required />
        <AuthField name="responsibleCpf" label="CPF do responsável" inputMode="numeric" autoComplete="off" maxLength={14} required />
        <AuthField name="phone" label="Telefone com DDD" type="tel" autoComplete="tel" maxLength={24} placeholder="(00) 00000-0000" required />
      </div></fieldset>
      <hr className={styles.divider} />
      <fieldset disabled={busy}><legend>Endereço de cobrança</legend><div className={styles.grid}>
        <AuthField name="zip" label="CEP" inputMode="numeric" autoComplete="postal-code" maxLength={9} placeholder="00000-000" required />
        <AuthField name="street" label="Rua ou avenida" autoComplete="address-line1" maxLength={180} required />
        <AuthField name="number" label="Número" autoComplete="off" maxLength={30} hint="Use S/N quando não houver número." required />
        <AuthField name="district" label="Bairro (opcional)" autoComplete="address-level3" maxLength={120} />
        <AuthField name="city" label="Cidade" autoComplete="address-level2" maxLength={120} required />
        <div className={styles.field}><label htmlFor="signup-state">Estado</label><select id="signup-state" name="state" autoComplete="address-level1" required defaultValue=""><option value="" disabled>Selecione o estado</option>{STATES.map(state => <option key={state} value={state}>{state}</option>)}</select></div>
      </div></fieldset>
      <hr className={styles.divider} />
      <fieldset disabled={busy}><legend>Plano e cobrança</legend><div className={styles.grid}>
        <div className={styles.field}><label htmlFor="signup-plan">Plano</label><select id="signup-plan" name="planId" value={planId} onChange={event => setPlanId(event.target.value)} required>{plans.map(item => <option key={item.id} value={item.id}>{item.name} — {item.monthlyPrice.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}/mês</option>)}</select></div>
        <div className={styles.field}><label htmlFor="signup-payment">Pagamento preferido</label><select id="signup-payment" name="paymentMethod" required>{paymentMethods.map(method => <option key={method} value={method}>{method === "pix" ? "Pix" : "Boleto"}</option>)}</select></div>
        <AuthField name="dueDay" label="Dia do vencimento" type="number" inputMode="numeric" min={1} max={28} step={1} defaultValue={dueDay} required hint="Escolha um dia entre 1 e 28." />
      </div></fieldset>
      {plan && <dl className={styles.summary} aria-label="Resumo do plano selecionado"><div><dt>Plano selecionado</dt><dd>{plan.name}</dd></div><div><dt>Mensalidade do plano</dt><dd>{plan.monthlyPrice.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}/mês</dd></div></dl>}
      {error && <AuthMessage>{error}</AuthMessage>}
      <button className={styles.submit} disabled={busy}>{busy ? "Criando sua organização…" : "Criar organização"}</button>
      <p className={styles.hint}>Após o cadastro, você acompanhará a preparação do ambiente no portal. Não feche a página enquanto confirmamos a solicitação.</p>
    </form>}
  </AuthScreen>;
}
