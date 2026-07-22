/**
 * Environment-variable access with legacy-alias fallback.
 *
 * The platform rebranded Oriel → StayLeased. All configuration now uses the
 * `STAYLEASED_` prefix, but any deployment still setting the old `ORIEL_`
 * names keeps working: `env('MODE')` reads `STAYLEASED_MODE`, then falls back
 * to `ORIEL_MODE`. This makes the rename safe to ship without a coordinated
 * env-var change on the hosting dashboard — nothing breaks at deploy time.
 */
export function env(name: string): string | undefined {
  const primary = process.env[`STAYLEASED_${name}`];
  if (primary !== undefined && primary !== '') return primary;
  const legacy = process.env[`ORIEL_${name}`];
  return legacy !== undefined && legacy !== '' ? legacy : undefined;
}

/** Set the canonical (`STAYLEASED_`) name at runtime (used by the e2e harness). */
export function setEnv(name: string, value: string): void {
  process.env[`STAYLEASED_${name}`] = value;
}
