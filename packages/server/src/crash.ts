import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Crash capture, deliberately boring.
 *
 * A crash is written to disk synchronously — the process may be about to die,
 * so nothing here awaits — and picked up by the diagnostics bundle. Nothing is
 * transmitted anywhere: remote crash reporting is worthless until there is an
 * endpoint someone operates, and silently phoning home is worse than nothing.
 */
export const recordCrash = (kind: string, error: unknown): void => {
  try {
    const dir = join(
      process.env['HARNESSDESK_HOME'] ?? join(homedir(), '.harnessdesk'),
      'logs',
      'crashes',
    )
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(
      join(dir, `${stamp}-${kind}.json`),
      JSON.stringify(
        {
          kind,
          at: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          versions: process.versions,
          platform: `${process.platform} ${process.arch}`,
        },
        null,
        2,
      ),
    )
  } catch {
    // A crash reporter that crashes helps nobody; stderr still has the original.
  }
}
