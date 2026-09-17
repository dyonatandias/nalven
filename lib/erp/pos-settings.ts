export const POS_SETTINGS_REQUIRED = "As configurações da organização ainda não foram inicializadas. Solicite ao administrador a regularização do cadastro da empresa antes de utilizar o PDV.";

/** Never substitute financial policy when the tenant has not been configured. */
export function requirePosSettings<T extends object>(settings: T | null | undefined): T {
  if (!settings) throw new Error(POS_SETTINGS_REQUIRED);
  return settings;
}
