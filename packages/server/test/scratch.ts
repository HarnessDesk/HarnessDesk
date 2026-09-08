import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/**
 * A temp directory that goes away when the file's tests are done.
 *
 * These files make their directories through their own small helpers —
 * `scratch()`, `workspace()` — which several tests call, some of them more
 * than once in a single test. None of those call sites has a `t`, and giving
 * every test one to thread through would be a large change for a small
 * guarantee. One hook per file, registered at import, removes the lot: a run
 * of this package used to leave 44 directories behind.
 */
const made: string[] = []

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  made.length = 0
})

export const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
