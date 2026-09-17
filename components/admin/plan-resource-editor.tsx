"use client";
import { useState } from "react";
import { PLAN_RESOURCES } from "@/lib/admin-plan-catalog";
import { changePlanGrant, PLAN_GROUPS, searchText, setPlanResourceMode } from "@/lib/admin-plan-builder";
import styles from "./plan-manager.module.css";

export default function PlanResourceEditor({ modules, onChange }: { modules: string[]; onChange: (modules: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const visible = PLAN_RESOURCES.filter(([key, label]) => searchText(`${key} ${label}`).includes(searchText(query)) && (group === "all" || PLAN_GROUPS.find(item => item.id === group)?.resources.some(resource => resource === key)) && (!onlyEnabled || modules.includes(`${key}.read`)));
  return <section id="plan-resources" className={styles.panel}>
    <div className={styles.sectionTitle}><span className={styles.step}>02</span><div><h2>Recursos e permissões</h2><p>Defina o que o cliente pode consultar, alterar e encontrar no menu.</p></div></div>
    <div className={styles.filters}><label>Buscar recurso<input aria-label="Filtrar recursos do plano" placeholder="Ex.: produtos, financeiro, usuários" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Área<select value={group} onChange={event => setGroup(event.target.value)}><option value="all">Todas as áreas</option>{PLAN_GROUPS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className={styles.check}><input type="checkbox" checked={onlyEnabled} onChange={event => setOnlyEnabled(event.target.checked)} />Somente habilitados</label></div>
    <details className={styles.help}><summary>Como funcionam as permissões?</summary><p><strong>Consultar</strong> libera leitura. <strong>Alterar</strong> inclui as operações de escrita disponíveis, inclusive exclusão. <strong>Menu</strong> controla a navegação, não o acesso direto. Desativar a consulta remove também alteração e menu. Perfis do usuário e licença externa continuam limitando o acesso.</p></details>
    <div className={styles.bulk}><span>{visible.length} recursos no filtro</span><button type="button" disabled={!visible.length} onClick={() => onChange(setPlanResourceMode(modules, visible.map(([key]) => key), "read"))}>Somente consulta no filtro</button><button type="button" disabled={!visible.length} onClick={() => onChange(setPlanResourceMode(modules, visible.map(([key]) => key), "write"))}>Acesso completo no filtro</button><button type="button" disabled={!visible.length} onClick={() => { if (window.confirm(`Bloquear os ${visible.length} recursos deste filtro? A alteração só será aplicada ao salvar o plano.`)) onChange(setPlanResourceMode(modules, visible.map(([key]) => key), "none")); }}>Bloquear no filtro</button></div>
    {!visible.length && <p className={styles.empty}>Nenhum recurso encontrado. Ajuste os filtros para continuar.</p>}
    {PLAN_GROUPS.map(section => {
      const rows = visible.filter(([key]) => section.resources.some(resource => resource === key));
      if (!rows.length) return null;
      return <section key={section.id} className={styles.resourceGroup}><h3>{section.name}<span>{rows.filter(([key]) => modules.includes(`${key}.read`)).length}/{rows.length} habilitados</span></h3><div className={styles.resourceGrid}>{rows.map(([resource, label]) => <article key={resource} className={`${styles.resource} ${modules.includes(`${resource}.read`) ? styles.enabled : ""}`}><h4>{label}</h4><div className={styles.grants}>{[[`${resource}.read`, "Consultar"], [`${resource}.write`, "Alterar"], [`menu:${resource}`, "Menu"]].map(([grant, title]) => <label key={grant}><input type="checkbox" aria-label={`${label}: ${title === "Menu" ? "mostrar menu" : title}`} checked={modules.includes(grant)} onChange={event => onChange(changePlanGrant(modules, resource, grant, event.target.checked))} />{title}</label>)}</div></article>)}</div></section>;
    })}
  </section>;
}
