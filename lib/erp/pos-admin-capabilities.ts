import { restrictedFeature } from "./plan-features";

export function posAdminCapabilities(input: {
  modules: unknown;
  role: string;
  permissions: string[];
  activeOperationalProfile: boolean;
}) {
  const admin = ["owner", "admin"].includes(input.role);
  const canRead = (resource: string) => !restrictedFeature(input.modules, `${resource}.read`) &&
    (input.role === "owner" || input.permissions.some(permission =>
      ["*", "*.read", `${resource}.*`, `${resource}.read`, `${resource}.write`].includes(permission)));
  return {
    reconciliation: admin && canRead("reconciliation"),
    manualApplications: admin && canRead("pdv") && input.activeOperationalProfile,
  };
}
