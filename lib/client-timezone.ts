import {
  BRAZIL_LOCALE,
  BRAZIL_TIME_ZONE,
  normalizeBrazilTimeZone,
} from "@/lib/timezone";

let configuredTimeZone = BRAZIL_TIME_ZONE;

export function setTenantTimeZone(value: unknown) {
  configuredTimeZone = normalizeBrazilTimeZone(value);
}

export function tenantTimeZone() {
  return configuredTimeZone;
}

/**
 * A formatter whose timezone is resolved at format time. This lets client
 * modules keep reusable formatters while the active organization/branch can
 * change without rebuilding the bundle.
 */
export function tenantDateTimeFormatter(
  options: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {},
) {
  const formatters = new Map<string, Intl.DateTimeFormat>();
  return {
    format(value?: Date | number) {
      const timeZone = tenantTimeZone();
      let formatter = formatters.get(timeZone);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat(BRAZIL_LOCALE, {
          ...options,
          timeZone,
        });
        formatters.set(timeZone, formatter);
      }
      return formatter.format(value);
    },
  };
}
