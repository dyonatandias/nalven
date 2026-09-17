"use client";
import { useState, type FormEvent } from "react";
import type { ProductionSnapshot } from "@/lib/erp/production-domain";
import { Field, FormFooter, RemoteChoice } from "./production-ui";
import {
  fmt,
  moneyCents,
  priorityLabels,
  type Bom,
  type Center,
  type Command,
  type Detail,
  type Order,
  type ProductOption,
  type Report,
  type Requirement,
  units,
} from "./production-types";
import styles from "./production-workspace.module.css";

type Props = { busy: boolean; close: () => void; command: Command };
const formValues = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget));
};
const inputCents = (value: FormDataEntryValue | undefined) =>
  Math.round(Number(value || 0) * 100);

function PlanningFields({ order }: { order?: Order }) {
  return (
    <>
      <Field label="Prioridade">
        <select name="priority" defaultValue={order?.priority || "normal"}>
          {Object.entries(priorityLabels).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Prazo">
        <input
          name="dueAt"
          type="date"
          defaultValue={order?.dueAt?.slice(0, 10) || ""}
        />
      </Field>
      <Field label="Responsável">
        <input
          name="assignedTo"
          maxLength={120}
          defaultValue={order?.assignedTo || ""}
          placeholder="Pessoa ou equipe"
        />
      </Field>
      <Field label="Etiquetas" hint="Separe por vírgulas. Até 12 etiquetas.">
        <input
          name="tags"
          defaultValue={order?.tags.join(", ") || ""}
          maxLength={380}
        />
      </Field>
      <Field label="Observações" wide>
        <textarea
          name="notes"
          maxLength={2000}
          defaultValue={order?.notes || ""}
        />
      </Field>
    </>
  );
}
export function OrderForm({
  order,
  edit,
  busy,
  close,
  command,
}: Props & { order?: Order; edit?: boolean }) {
  const [bom, setBom] = useState<Bom | null>(null),
    [warehouse, setWarehouse] = useState<{ id: number; name: string } | null>(
      order?.warehouse || null,
    );
  async function save(event: FormEvent<HTMLFormElement>) {
    const values = formValues(event);
    if (
      await command(
        edit && order
          ? {
              action: "order.update",
              orderId: order.id,
              version: order.version,
              ...values,
            }
          : {
              action: "order.create",
              ...values,
              bomId: bom?.id ?? order?.bom.id,
              warehouseId: warehouse?.id,
            },
      )
    )
      close();
  }
  return (
    <form className={styles.form} onSubmit={save}>
      {!edit && (
        <>
          <RemoteChoice<Bom>
            resource="boms"
            label="Ficha técnica"
            value={String(bom?.id ?? order?.bom.id ?? "")}
            change={setBom}
            initial={
              order
                ? {
                    ...order.bom,
                    active: true,
                    outputProduct: order.outputProduct,
                    revisions: [],
                    _count: { orders: 0, revisions: 0 },
                  }
                : undefined
            }
          />
          <RemoteChoice
            resource="warehouses"
            label="Depósito"
            value={String(warehouse?.id || "")}
            change={(item) =>
              setWarehouse(
                item ? { id: Number(item.id), name: item.name } : null,
              )
            }
            initial={warehouse || undefined}
          />
          <Field label="Quantidade planejada">
            <input
              name="plannedQuantity"
              type="number"
              min="0.000001"
              step="0.000001"
              required
              defaultValue={order?.plannedQuantity || 1}
            />
          </Field>
          <p className={styles.note}>
            A ordem utiliza a revisão aprovada e vigente da ficha. A reserva dos
            materiais pode ser feita após a criação ou ao iniciar a produção.
          </p>
        </>
      )}
      {edit && (
        <Field label="Posição na fila">
          <input
            name="position"
            type="number"
            min="0"
            max="1000000"
            defaultValue={order?.position ?? 0}
            required
          />
        </Field>
      )}
      <PlanningFields order={order} />
      <FormFooter
        busy={busy}
        close={close}
        label={edit ? "Salvar planejamento" : "Criar ordem"}
      />
    </form>
  );
}
export function BomForm({
  template,
  bomId,
  busy,
  close,
  command,
}: Props & { template?: ProductionSnapshot; bomId?: number }) {
  const [output, setOutput] = useState<ProductOption | null>(
    template
      ? {
          id: template.outputProductId,
          name: "Produto da ficha",
          variations: template.outputVariationId
            ? [
                {
                  id: template.outputVariationId,
                  sku: `Variação ${template.outputVariationId}`,
                  attributes: {},
                },
              ]
            : [],
        }
      : null,
  );
  const [rows, setRows] = useState(
    () =>
      template?.items.map((item) => ({
        ...item,
        product: {
          id: item.productId,
          name: `Material #${item.productId}`,
          variations: item.variationId
            ? [
                {
                  id: item.variationId,
                  sku: `Variação ${item.variationId}`,
                  attributes: {},
                },
              ]
            : [],
        } as ProductOption,
      })) || [
        {
          productId: 0,
          variationId: null as number | null,
          quantity: 1,
          wastePercent: 0,
          product: null as ProductOption | null,
        },
      ],
  );
  async function save(event: FormEvent<HTMLFormElement>) {
    const values = formValues(event);
    const snapshot = {
      ...values,
      outputProductId: output?.id,
      outputVariationId: values.outputVariationId || null,
      items: rows.map(({ product: _product, ...item }) => {
        void _product;
        return item;
      }),
      checklist: String(values.checklist)
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
      laborHourlyCents: inputCents(values.laborRate),
      machineHourlyCents: inputCents(values.machineRate),
      energyBatchCents: inputCents(values.energyRate),
      overheadBatchCents: inputCents(values.overheadRate),
    };
    if (
      await command({
        action: bomId ? "bom.revise" : "bom.create",
        ...(bomId ? { bomId } : {}),
        snapshot,
      })
    )
      close();
  }
  const update = (index: number, patch: Partial<(typeof rows)[number]>) =>
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  return (
    <form className={styles.form} onSubmit={save}>
      <Field label="Nome">
        <input
          name="name"
          maxLength={180}
          defaultValue={
            template ? `${template.name}${bomId ? "" : " (cópia)"}` : ""
          }
          required
        />
      </Field>
      <Field label="Código">
        <input
          name="code"
          maxLength={40}
          defaultValue={
            template ? `${template.code}${bomId ? "" : "-COPIA"}` : ""
          }
          required
        />
      </Field>
      <RemoteChoice<ProductOption>
        resource="products"
        label="Produto acabado"
        value={String(output?.id || "")}
        change={setOutput}
        initial={output || undefined}
      />
      <Field label="Variação do produto acabado">
        <select
          name="outputVariationId"
          defaultValue={template?.outputVariationId || ""}
        >
          <option value="">Produto simples</option>
          {output?.variations?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.sku || `Variação ${item.id}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Rendimento por lote">
        <input
          name="yieldQuantity"
          type="number"
          min="0.000001"
          step="0.000001"
          defaultValue={template?.yieldQuantity || 1}
          required
        />
      </Field>
      <section className={`${styles.wide} ${styles.materialEditor}`}>
        <header>
          <h3>Composição</h3>
          <button
            type="button"
            disabled={rows.length >= 200}
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  productId: 0,
                  variationId: null,
                  quantity: 1,
                  wastePercent: 0,
                  product: null,
                },
              ])
            }
          >
            Adicionar material
          </button>
        </header>
        {rows.map((row, index) => (
          <fieldset key={index}>
            <legend>Material {index + 1}</legend>
            <RemoteChoice<ProductOption>
              resource="products"
              label="Material"
              value={String(row.productId || "")}
              initial={row.product || undefined}
              change={(product) =>
                update(index, {
                  product,
                  productId: product?.id || 0,
                  variationId: null,
                })
              }
            />
            <Field label="Variação">
              <select
                value={row.variationId || ""}
                onChange={(event) =>
                  update(index, {
                    variationId: event.target.value
                      ? Number(event.target.value)
                      : null,
                  })
                }
              >
                <option value="">Produto simples</option>
                {row.product?.variations?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku || `Variação ${item.id}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantidade por lote">
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={row.quantity}
                required
                onChange={(event) =>
                  update(index, { quantity: Number(event.target.value) })
                }
              />
            </Field>
            <Field label="Perda prevista (%)">
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={row.wastePercent}
                onChange={(event) =>
                  update(index, { wastePercent: Number(event.target.value) })
                }
              />
            </Field>
            <button
              type="button"
              disabled={rows.length === 1}
              onClick={() =>
                setRows((current) => current.filter((_, i) => i !== index))
              }
            >
              Remover material {index + 1}
            </button>
          </fieldset>
        ))}
      </section>
      {[
        {
          name: "laborRate",
          label: "Mão de obra / hora (R$)",
          value: template?.laborHourlyCents,
        },
        {
          name: "machineRate",
          label: "Máquina / hora (R$)",
          value: template?.machineHourlyCents,
        },
        {
          name: "energyRate",
          label: "Energia / lote (R$)",
          value: template?.energyBatchCents,
        },
        {
          name: "overheadRate",
          label: "Custos indiretos / lote (R$)",
          value: template?.overheadBatchCents,
        },
      ].map((item) => (
        <Field key={item.name} label={item.label}>
          <input
            type="number"
            min="0"
            step="0.01"
            name={item.name}
            defaultValue={(item.value || 0) / 100}
            required
          />
        </Field>
      ))}
      <Field
        label="Checklist de qualidade"
        wide
        hint="Uma verificação por linha. A aprovação da saída exige todas conformes."
      >
        <textarea
          name="checklist"
          required
          rows={4}
          defaultValue={
            template?.checklist.join("\n") ||
            "Quantidade conferida\nComposição conferida\nIntegridade do produto"
          }
        />
      </Field>
      <Field label="Instruções de produção" wide>
        <textarea
          name="notes"
          maxLength={2000}
          defaultValue={template?.notes || ""}
        />
      </Field>
      <FormFooter
        busy={busy}
        close={close}
        label="Criar revisão para aprovação"
      />
    </form>
  );
}
export function ReportForm({
  detail,
  busy,
  close,
  command,
}: Props & { detail: Detail }) {
  const { order } = detail;
  const [produced, setProduced] = useState(1),
    [scrap, setScrap] = useState(0),
    [rework, setRework] = useState(0),
    [actual, setActual] = useState<Record<string, string>>({});
  const processed = produced + scrap + rework;
  const expected = order.snapshot.items.map((item) => ({
    ...item,
    amount:
      Math.ceil(
        ((item.quantity * processed) / order.snapshot.yieldQuantity) *
          (1 + item.wastePercent / 100) *
          1e6,
      ) / 1e6,
    key: `${item.productId}:${item.variationId}`,
  }));
  async function save(event: FormEvent<HTMLFormElement>) {
    const values = formValues(event);
    if (
      await command({
        action: "order.report",
        orderId: order.id,
        version: order.version,
        ...values,
        producedQuantity: produced,
        scrapQuantity: scrap,
        reworkQuantity: rework,
        materials: expected.map((item) => ({
          productId: item.productId,
          variationId: item.variationId,
          quantity: actual[item.key] ?? item.amount,
        })),
        output: {
          lotCode: values.lotCode,
          serialNumbers: values.serialNumbers,
          manufacturedOn: values.manufacturedOn,
          expiresOn: values.expiresOn,
        },
      })
    )
      close();
  }
  return (
    <form className={styles.form} onSubmit={save}>
      <p className={`${styles.note} ${styles.wide}`}>
        Registre somente este apontamento. Os insumos serão consumidos agora; a
        saída ficará em quarentena até a inspeção. A ordem continua aberta para
        novos apontamentos.
      </p>
      {[
        { label: "Quantidade boa", value: produced, setter: setProduced },
        { label: "Refugo", value: scrap, setter: setScrap },
        { label: "Para retrabalho", value: rework, setter: setRework },
      ].map((item) => (
        <Field key={item.label} label={item.label}>
          <input
            type="number"
            min="0"
            step="0.000001"
            required
            value={item.value}
            onChange={(event) => item.setter(Number(event.target.value))}
          />
        </Field>
      ))}
      <Field label="Mão de obra (minutos)">
        <input
          name="laborMinutes"
          type="number"
          min="0"
          max="525600"
          defaultValue="0"
          required
        />
      </Field>
      <Field label="Máquina (minutos)">
        <input
          name="machineMinutes"
          type="number"
          min="0"
          max="525600"
          defaultValue="0"
          required
        />
      </Field>
      <section className={`${styles.wide} ${styles.materialEditor}`}>
        <h3>Consumo real</h3>
        {expected.map((item) => (
          <Field
            key={item.key}
            label={`${detail.materials.find((row) => row.productId === item.productId)?.product.name || `Material #${item.productId}`}${item.variationId ? ` · variação ${item.variationId}` : ""}`}
            hint={`Previsto para este apontamento: ${fmt.format(item.amount)}`}
          >
            <input
              type="number"
              min="0"
              step="0.000001"
              required
              value={actual[item.key] ?? item.amount}
              onChange={(event) =>
                setActual((current) => ({
                  ...current,
                  [item.key]: event.target.value,
                }))
              }
            />
          </Field>
        ))}
      </section>
      <Field
        label="Lote de saída"
        hint="Em branco: gerado automaticamente por apontamento."
      >
        <input name="lotCode" maxLength={160} />
      </Field>
      <Field label="Fabricação">
        <input name="manufacturedOn" type="date" />
      </Field>
      <Field label="Validade">
        <input name="expiresOn" type="date" />
      </Field>
      <Field
        label="Números de série"
        wide
        hint="Se o produto é serializado, informe uma série por unidade, separada por linha ou vírgula."
      >
        <textarea name="serialNumbers" rows={2} />
      </Field>
      <Field label="Observações e justificativa das perdas" wide>
        <textarea
          name="notes"
          maxLength={2000}
          required={scrap + rework > 0 || Object.keys(actual).length > 0}
        />
      </Field>
      <FormFooter
        busy={busy}
        close={close}
        label="Registrar apontamento parcial"
      />
    </form>
  );
}
export function InspectionForm({
  order,
  report,
  busy,
  close,
  command,
}: Props & { order: Order; report: Report }) {
  const [decision, setDecision] = useState("approved");
  async function save(event: FormEvent<HTMLFormElement>) {
    const values = formValues(event);
    if (
      await command({
        action: "report.inspect",
        orderId: order.id,
        version: order.version,
        reportId: report.id,
        decision,
        notes: values.notes,
        checklist: order.snapshot.checklist.map((name, index) => ({
          name,
          passed: values[`check-${index}`] === "pass",
        })),
      })
    )
      close();
  }
  return (
    <form className={styles.form} onSubmit={save}>
      <p className={`${styles.note} ${styles.wide}`}>
        Lote {report.outputIdentity.lotCode} ·{" "}
        {fmt.format(units(report.producedMicros))} unidades em quarentena.
      </p>
      {order.snapshot.checklist.map((name, index) => (
        <Field key={name} label={name}>
          <select name={`check-${index}`} required defaultValue="">
            <option value="">Avaliar</option>
            <option value="pass">Conforme</option>
            <option value="fail">Não conforme</option>
          </select>
        </Field>
      ))}
      <Field label="Decisão">
        <select
          value={decision}
          onChange={(event) => setDecision(event.target.value)}
        >
          <option value="approved">Aprovar e liberar estoque</option>
          <option value="rejected">Reprovar e descartar saída</option>
        </select>
      </Field>
      <Field label="Parecer do inspetor" wide>
        <textarea name="notes" required maxLength={2000} />
      </Field>
      <p className={`${styles.note} ${styles.wide}`}>
        {decision === "approved"
          ? "A aprovação libera a quantidade conferida e atualiza o custo médio."
          : "A reprovação registra o descarte da saída e mantém os custos e consumos no histórico. Depois é possível criar uma ordem de reposição/retrabalho."}
      </p>
      <FormFooter
        busy={busy}
        close={close}
        label="Registrar decisão e certificado"
      />
    </form>
  );
}
export function CenterForm({
  center,
  busy,
  close,
  command,
}: Props & { center?: Center }) {
  const [shifts, setShifts] = useState(
    center?.shifts ||
      [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "17:00" })),
  );
  async function save(event: FormEvent<HTMLFormElement>) {
    const values = formValues(event);
    if (
      await command({
        action: "center.save",
        ...values,
        ...(center ? { centerId: center.id, version: center.version } : {}),
        active: values.active === "on",
        hourlyCostCents: inputCents(values.hourlyCost),
        shifts,
      })
    )
      close();
  }
  return (
    <form className={styles.form} onSubmit={save}>
      <Field label="Nome do recurso">
        <input
          name="name"
          defaultValue={center?.name}
          required
          maxLength={180}
        />
      </Field>
      <Field label="Tipo">
        <select name="kind" defaultValue={center?.kind || "machine"}>
          <option value="machine">Máquina</option>
          <option value="team">Equipe</option>
          <option value="line">Linha de produção</option>
        </select>
      </Field>
      <Field label="Ordens simultâneas">
        <input
          name="wipLimit"
          type="number"
          min="1"
          max="1000"
          defaultValue={center?.wipLimit || 1}
          required
        />
      </Field>
      <Field label="Custo por hora (R$)">
        <input
          name="hourlyCost"
          type="number"
          min="0"
          step="0.01"
          defaultValue={(center?.hourlyCostCents || 0) / 100}
          required
        />
      </Field>
      <Field label="Fuso horário">
        <input
          name="timeZone"
          defaultValue={center?.timeZone || "America/Sao_Paulo"}
          required
        />
      </Field>
      <label className={styles.checkbox}>
        <input
          name="active"
          type="checkbox"
          defaultChecked={center?.active ?? true}
        />
        Recurso ativo
      </label>
      <section className={`${styles.wide} ${styles.materialEditor}`}>
        <header>
          <h3>Turnos semanais</h3>
          <button
            type="button"
            disabled={shifts.length >= 21}
            onClick={() =>
              setShifts((current) => [
                ...current,
                { day: 1, start: "08:00", end: "17:00" },
              ])
            }
          >
            Adicionar turno
          </button>
        </header>
        {shifts.map((shift, index) => (
          <div className={styles.shift} key={index}>
            <label>
              Dia
              <select
                value={shift.day}
                onChange={(event) =>
                  setShifts((current) =>
                    current.map((row, i) =>
                      i === index
                        ? { ...row, day: Number(event.target.value) }
                        : row,
                    ),
                  )
                }
              >
                {[
                  "Domingo",
                  "Segunda",
                  "Terça",
                  "Quarta",
                  "Quinta",
                  "Sexta",
                  "Sábado",
                ].map((day, value) => (
                  <option key={day} value={value}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Início
              <input
                type="time"
                required
                value={shift.start}
                onChange={(event) =>
                  setShifts((current) =>
                    current.map((row, i) =>
                      i === index ? { ...row, start: event.target.value } : row,
                    ),
                  )
                }
              />
            </label>
            <label>
              Fim
              <input
                type="time"
                required
                value={shift.end}
                onChange={(event) =>
                  setShifts((current) =>
                    current.map((row, i) =>
                      i === index ? { ...row, end: event.target.value } : row,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              disabled={shifts.length === 1}
              onClick={() =>
                setShifts((current) => current.filter((_, i) => i !== index))
              }
            >
              Remover
            </button>
          </div>
        ))}
      </section>
      <FormFooter busy={busy} close={close} label="Salvar recurso" />
    </form>
  );
}
export function ScheduleForm({
  order,
  busy,
  close,
  command,
}: Props & { order: Order }) {
  const [center, setCenter] = useState<Center | null>(order.workCenter);
  const local = (date: string | null) => {
    if (!date) return "";
    const value = new Date(date);
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    const values = formValues(event);
    if (
      await command({
        action: "order.schedule",
        orderId: order.id,
        version: order.version,
        workCenterId: center?.id,
        scheduledStart: new Date(String(values.start)).toISOString(),
        scheduledEnd: new Date(String(values.end)).toISOString(),
        predecessorIds: String(values.predecessors || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .map(Number),
      })
    )
      close();
  }
  return (
    <form className={styles.form} onSubmit={save}>
      <RemoteChoice<Center>
        resource="centers"
        label="Recurso"
        value={center?.id || ""}
        change={setCenter}
        initial={center || undefined}
      />
      <div className={styles.note}>
        {center && (
          <>
            Limite: {center.wipLimit} ordens simultâneas. Fuso dos turnos:{" "}
            {center.timeZone}. Custo cadastrado:{" "}
            {moneyCents(center.hourlyCostCents)}/h.
          </>
        )}
      </div>
      <Field label="Início (horário deste dispositivo)">
        <input
          name="start"
          type="datetime-local"
          required
          defaultValue={local(order.scheduledStart)}
        />
      </Field>
      <Field label="Fim (horário deste dispositivo)">
        <input
          name="end"
          type="datetime-local"
          required
          defaultValue={local(order.scheduledEnd)}
        />
      </Field>
      <Field
        label="Ordens predecessoras"
        wide
        hint="IDs das ordens que precisam estar concluídas e aprovadas. Separe por vírgulas."
      >
        <input
          name="predecessors"
          placeholder="Ex.: 12, 15"
          defaultValue={
            order.dependencies?.map((item) => item.predecessorId).join(", ") ||
            ""
          }
        />
      </Field>
      <FormFooter
        busy={busy}
        close={close}
        label="Validar capacidade e agendar"
      />
    </form>
  );
}
export function ProcurementForm({
  order,
  material,
  kind,
  busy,
  close,
  command,
}: Props & {
  order: Order;
  material: Requirement;
  kind: "purchase" | "transfer";
}) {
  const [supplier, setSupplier] = useState<{ id: number; name: string } | null>(
    null,
  );
  async function save(event: FormEvent<HTMLFormElement>) {
    const values = formValues(event);
    if (
      await command({
        action: `mrp.${kind}`,
        orderId: order.id,
        version: order.version,
        productId: material.productId,
        variationId: material.variationId,
        ...values,
        supplierId: supplier?.id,
        unitCostCents: inputCents(values.unitCost),
      })
    )
      close();
  }
  return (
    <form className={styles.form} onSubmit={save}>
      <p className={`${styles.note} ${styles.wide}`}>
        {material.product.name} · necessidade líquida:{" "}
        {fmt.format(material.netShortage)}. Compras pendentes já vinculadas são
        descontadas deste cálculo.
      </p>
      <Field label="Quantidade">
        <input
          name="quantity"
          type="number"
          min="0.000001"
          max={material.netShortage}
          step="0.000001"
          defaultValue={material.netShortage}
          required
        />
      </Field>
      {kind === "purchase" ? (
        <>
          <RemoteChoice
            resource="suppliers"
            label="Fornecedor"
            value={String(supplier?.id || "")}
            change={(item) =>
              setSupplier(
                item ? { id: Number(item.id), name: item.name } : null,
              )
            }
          />
          <Field label="Custo unitário (R$)">
            <input
              name="unitCost"
              type="number"
              min="0"
              step="0.01"
              defaultValue={material.product.cost || 0}
              required
            />
          </Field>
        </>
      ) : (
        <Field label="Depósito de origem">
          <select name="fromWarehouseId" defaultValue="" required>
            <option value="">Selecione</option>
            {material.sources.map((source) => (
              <option key={source.warehouseId} value={source.warehouseId}>
                {source.name} · {fmt.format(source.available)} disponíveis
              </option>
            ))}
          </select>
        </Field>
      )}
      <FormFooter
        busy={busy}
        close={close}
        label={
          kind === "purchase"
            ? "Gerar compra em rascunho"
            : "Transferir material"
        }
      />
    </form>
  );
}
