import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/**
 * A temp directory that goes away when the file's tests are done.
 *
 * Most of the directories these tests need are made outside any test: a
 * workspace at module scope, and one state directory per spawn inside
 * `make()`, which is called dozens of times. Neither has a `t` to hang a
 * `t.after` on, so a single hook registered here — at import, before the
 * first test runs — removes everything the file asked for. One run of the
 * suite used to leave 48 of them behind.
 */
const made: string[] = []

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  made.length = 0
})

export const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
