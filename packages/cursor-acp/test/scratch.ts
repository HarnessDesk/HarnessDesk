import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/**
 * A temp directory that goes away when the file's tests are done.
 *
 * The workspace, the state index and the Cursor home are all built at module
 * scope here, and one of them is rebuilt per spawn inside the runtime's env.
 * None of that has a `t` to hang a `t.after` on, so a single hook registered
 * at import removes what the file asked for. A run of this package used to
 * leave 17 directories behind.
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

/**
 * The bridge writes each chat's tool plugin to a *fixed* path under TMPDIR —
 * `writeToolPlugin`'s default root, and `bridge.ts` hardcodes the same one for
 * images. It is production's path, not the tests', and a real cursor-acp on
 * this machine may be using it, so the root is never removed wholesale: only
 * the per-chat directories that appeared while these tests ran. Three of them
 * were left behind by every run.
 */
const pluginRoot = join(tmpdir(), 'harnessdesk-cursor-acp')
const rootExisted = existsSync(pluginRoot)
const alreadyThere = new Set(rootExisted ? readdirSync(pluginRoot) : [])

after(() => {
  if (!existsSync(pluginRoot)) return
  if (!rootExisted) {
    rmSync(pluginRoot, { recursive: true, force: true })
    return
  }
  for (const entry of readdirSync(pluginRoot)) {
    if (!alreadyThere.has(entry)) rmSync(join(pluginRoot, entry), { recursive: true, force: true })
  }
})
