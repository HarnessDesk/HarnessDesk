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
/**
 * How many crash files one run of the process may leave behind.
 *
 * A crash reporter with no bound is a disk-filling device: on 2026-09-13 a
 * broken stdout put the shell's `uncaughtException` handler into a loop and
 * this function wrote **267,665 files and 1.0 GB in six minutes** before the
 * process died. The loop itself is fixed where it lives, in the handler; this
 * is the bound that means the next one — from a road nobody has thought of —
 * costs a few hundred small files instead of the volume.
 *
 * Deliberately per-process and not per-directory: reading the directory to
 * count is one more thing to fail while the process is dying, and a bound
 * that survives a restart would silence a genuinely crashy build.
 */
export const CRASH_FILE_LIMIT = 200

let written = 0

/** Forget how many have been written — for a test that wants a fresh count. */
export const forgetCrashCount = (): void => {
  written = 0
}

export const recordCrash = (kind: string, error: unknown): void => {
  if (written >= CRASH_FILE_LIMIT) return
  written += 1
  try {
    const dir = join(
      process.env['HARNESSDESK_HOME'] ?? join(homedir(), '.harnessdesk'),
      'logs',
      'crashes',
    )
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    /* The stamp alone is not a name. Two crashes inside one millisecond wrote
       the same file and the second overwrote the first — which is the case
       that matters, because crashes that arrive together are the ones worth
       reading, and a loop arrives 800 times a second (measured 2026-09-13).
       The pid and the count make it this process's nth crash and nobody
       else's. */
    writeFileSync(
      join(dir, `${stamp}-${process.pid}-${written}-${kind}.json`),
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
