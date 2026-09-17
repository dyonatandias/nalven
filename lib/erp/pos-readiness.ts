export const POS_READINESS_STATES = ["DONE", "PARTIAL", "TODO", "EXTERNAL"] as const;
export type PosReadinessState = typeof POS_READINESS_STATES[number];
export type PosReadinessItem = { id: string; capability: string; priority: "P0" | "P1" | "P2"; state: PosReadinessState; evidence: string };

export function parsePosReadinessMatrix(markdown: string) {
  const items: PosReadinessItem[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*POS-\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 5) throw new Error(`Linha de capacidade PDV inválida: ${line.slice(0, 120)}`);
    const [id, capability, priority, state, evidence] = cells;
    if (!/^POS-\d{3,4}$/.test(id) || !capability || !(["P0", "P1", "P2"] as const).includes(priority as "P0" | "P1" | "P2") || !(POS_READINESS_STATES as readonly string[]).includes(state) || !evidence) throw new Error(`Capacidade PDV malformada: ${id || "sem ID"}`);
    items.push({ id, capability, priority: priority as PosReadinessItem["priority"], state: state as PosReadinessState, evidence });
  }
  if (!items.length) throw new Error("Matriz de capacidade PDV ausente.");
  const duplicate = items.find((item, index) => items.findIndex(candidate => candidate.id === item.id) !== index);
  if (duplicate) throw new Error(`ID de capacidade PDV duplicado: ${duplicate.id}`);
  return items;
}

export function summarizePosReadiness(items: readonly PosReadinessItem[]) {
  const counts = Object.fromEntries(POS_READINESS_STATES.map(state => [state, items.filter(item => item.state === state).length])) as Record<PosReadinessState, number>;
  const productionBlockers = items.filter(item => item.priority !== "P2" && item.state !== "DONE");
  return {
    designation: "pdv-readiness-from-traceability-matrix",
    productionReady: productionBlockers.length === 0,
    total: items.length,
    counts,
    productionBlockers: productionBlockers.map(item => ({ id: item.id, priority: item.priority, state: item.state, capability: item.capability, gate: item.evidence })),
  };
}
