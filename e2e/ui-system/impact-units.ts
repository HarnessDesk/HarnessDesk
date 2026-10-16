/**
 * Impact units: the tests of a spec that CI can plan one by one.
 *
 * A spec of many independent tests, each rendering a page of its own (the
 * guides standard measures one review scene per test), tags each test with a
 * unit. The recording run keeps what every unit ran apart
 * (`script/ui-impact/test.ts`), and a pull request that reaches only some of
 * them runs only those: the runner passes them in `UI_SYSTEM_UNITS`, keyed by
 * the spec's path under the suite (`script/ui-system-run.mjs`).
 */

/** The details argument of `test(title, details, body)` that tags a test with its unit. */
export const impactUnit = (id: string) => ({ annotation: { type: 'impact-unit', description: id } })

/** The units this run of `spec` covers, or null for all of them. */
export const unitsToRun = (spec: string, known: readonly string[]): ReadonlySet<string> | null => {
  const raw = process.env.UI_SYSTEM_UNITS
  if (!raw) return null
  try {
    const selection: unknown = JSON.parse(raw)
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null
    const units: unknown = (selection as Record<string, unknown>)[spec]
    // A stale or malformed selection must broaden coverage, never silently omit tests.
    if (!Array.isArray(units) || units.length === 0 || !units.every(unit => typeof unit === 'string' && known.includes(unit))) return null
    return new Set(units as string[])
  } catch {
    return null
  }
}
