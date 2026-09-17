export type AccessProfile = {
  status: string;
  accessExpiresAt?: Date | string | null;
  lastAccessReviewAt?: Date | string | null;
};

export function accessState(profile: AccessProfile | null | undefined, membershipStatus = "active", now = new Date()) {
  if (membershipStatus !== "active" || profile?.status === "disabled") return "disabled" as const;
  if (profile?.accessExpiresAt && new Date(profile.accessExpiresAt) <= now) return "expired" as const;
  return "active" as const;
}

export function needsAccessReview(profile: AccessProfile | null | undefined, createdAt: Date | string, now = new Date()) {
  const reference = profile?.lastAccessReviewAt ? new Date(profile.lastAccessReviewAt) : new Date(createdAt);
  return now.getTime() - reference.getTime() > 90 * 86_400_000;
}

export function isStaleLogin(lastLoginAt: Date | string | null | undefined, createdAt: Date | string, now = new Date()) {
  const reference = lastLoginAt ? new Date(lastLoginAt) : new Date(createdAt);
  return now.getTime() - reference.getTime() > 45 * 86_400_000;
}

export function maskIp(value: string | null | undefined) {
  if (!value) return "IP não informado";
  if (value.includes(":")) return `${value.split(":").slice(0, 3).join(":")}:…`;
  const parts = value.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : "IP protegido";
}

export function deviceLabel(value: string | null | undefined) {
  if (!value) return "Dispositivo não identificado";
  const browser = /Edg\//.test(value) ? "Edge" : /Firefox\//.test(value) ? "Firefox" : /Chrome\//.test(value) ? "Chrome" : /Safari\//.test(value) ? "Safari" : "Navegador";
  const system = /Android/.test(value) ? "Android" : /iPhone|iPad/.test(value) ? "iOS" : /Windows/.test(value) ? "Windows" : /Mac OS/.test(value) ? "macOS" : /Linux/.test(value) ? "Linux" : "sistema desconhecido";
  return `${browser} · ${system}`;
}

export function csvCell(value: unknown) {
  const text = String(value ?? "").replaceAll('"', '""');
  return `"${text}"`;
}
