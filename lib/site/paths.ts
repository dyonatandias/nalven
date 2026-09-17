export class NavigationInputError extends Error {}
export const LOGIN_ALIASES = ["/entrar", "/signin", "/sign-in", "/sign_in", "/auth/login", "/auth/signin", "/admin/login", "/saas/login", "/portal/login", "/erp/login", "/signin-with-chatgpt"];
export const PUBLIC_PAGES = ["/", "/blog", "/glossario"];

export function loginAlias(path: string) {
  return LOGIN_ALIASES.includes(path.toLowerCase().replace(/\/$/, ""));
}

export function localPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 || !/^\/(?!\/)/.test(value) || /[\\?#\s%\u0000-\u001f]/.test(value)) throw new NavigationInputError("Use um caminho local sem parâmetros, fragmentos ou caracteres codificados.");
  const path = new URL(value, "https://internal.invalid").pathname;
  if (path !== value || /\/\//.test(path)) throw new NavigationInputError("Caminho não normalizado.");
  return path === "/" ? path : path.replace(/\/$/, "");
}

export function reservedPath(path: string) {
  return /^\/(?:api|_next|admin|erp|portal|login|cadastro|esqueci-senha|redefinir-senha|convite|avaliar|rastrear-pedido)(?:\/|$)/i.test(path) || loginAlias(path) || /\.[a-z0-9]+$/i.test(path);
}

export function safeObservedPath(path: string) {
  return path.split(/[?#]/, 1)[0].slice(0, 500)
    .replace(/(\/(?:convite|redefinir-senha|avaliar)\/)[^/]+/gi, "$1[token]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[id]");
}

export function assertNoRedirectCycle(source: string, destination: string, rules: Array<{ source: string; destination: string }>) {
  const map = new Map(rules.filter(rule => rule.source !== source).map(rule => [rule.source, rule.destination]));
  map.set(source, destination);
  const seen = new Set<string>();
  let cursor: string | undefined = source;
  while (cursor) {
    if (seen.has(cursor)) throw new NavigationInputError("O redirecionamento criaria um ciclo.");
    seen.add(cursor);
    cursor = map.get(cursor);
  }
}
