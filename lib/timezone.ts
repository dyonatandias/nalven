export const BRAZIL_LOCALE = "pt-BR";
export const BRAZIL_TIME_ZONE = "America/Sao_Paulo";
export const BRAZIL_TIME_ZONE_LABEL = "horário de Brasília";

export const BRAZIL_TIME_ZONES = [
  ["America/Noronha", "Fernando de Noronha (UTC−02:00)"],
  ["America/Sao_Paulo", "Brasília, Sul e Sudeste (UTC−03:00)"],
  ["America/Araguaina", "Tocantins (UTC−03:00)"],
  ["America/Bahia", "Bahia (UTC−03:00)"],
  ["America/Belem", "Pará — Belém (UTC−03:00)"],
  ["America/Fortaleza", "Ceará e Nordeste oriental (UTC−03:00)"],
  ["America/Maceio", "Alagoas e Sergipe (UTC−03:00)"],
  ["America/Recife", "Pernambuco (UTC−03:00)"],
  ["America/Santarem", "Pará — Santarém (UTC−03:00)"],
  ["America/Boa_Vista", "Roraima (UTC−04:00)"],
  ["America/Campo_Grande", "Mato Grosso do Sul (UTC−04:00)"],
  ["America/Cuiaba", "Mato Grosso (UTC−04:00)"],
  ["America/Manaus", "Amazonas — Manaus (UTC−04:00)"],
  ["America/Porto_Velho", "Rondônia (UTC−04:00)"],
  ["America/Eirunepe", "Amazonas — Eirunepé (UTC−05:00)"],
  ["America/Rio_Branco", "Acre (UTC−05:00)"],
] as const;

const supportedBrazilTimeZones = new Set<string>(
  BRAZIL_TIME_ZONES.map(([value]) => value),
);

export function isBrazilTimeZone(value: unknown): value is string {
  return typeof value === "string" && supportedBrazilTimeZones.has(value);
}

export function normalizeBrazilTimeZone(value: unknown) {
  return isBrazilTimeZone(value) ? value : BRAZIL_TIME_ZONE;
}

export function dateTimeFormatter(
  timeZone: string,
  options: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {
    dateStyle: "short",
    timeStyle: "short",
  },
) {
  return new Intl.DateTimeFormat(BRAZIL_LOCALE, {
    ...options,
    timeZone: normalizeBrazilTimeZone(timeZone),
  });
}

export function brazilDateTimeFormatter(
  options: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {
    dateStyle: "short",
    timeStyle: "short",
  },
) {
  return dateTimeFormatter(BRAZIL_TIME_ZONE, options);
}

export function brazilDateFormatter(
  options: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {
    dateStyle: "short",
  },
) {
  return new Intl.DateTimeFormat(BRAZIL_LOCALE, {
    ...options,
    timeZone: BRAZIL_TIME_ZONE,
  });
}

export function formatBrazilDateTime(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.valueOf())
    ? brazilDateTimeFormatter().format(date)
    : "Data indisponível";
}
