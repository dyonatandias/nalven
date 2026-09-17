export type Feature = { title: string; description: string };
export const siteGroups: Record<string, string> = { brand: "Marca", hero: "Apresentação principal", features: "Recursos em destaque", plans: "Apresentação dos planos", footer: "Rodapé" };
export function isFeatureList(value: unknown): value is Feature[] {
  return Array.isArray(value) && value.length <= 50 && value.every(item => item && typeof item === "object" && typeof item.title === "string" && item.title.length <= 160 && typeof item.description === "string" && item.description.length <= 2000 && Object.keys(item).every(key => key === "title" || key === "description"));
}
export function isSiteContentValue(key: string, type: string, value: unknown) {
  if (key === "features.items") return isFeatureList(value);
  return ["text", "textarea"].includes(type) && typeof value === "string" && value.length <= (type === "textarea" ? 10000 : 500);
}
