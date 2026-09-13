import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('docs/interface.md documents measured title floor at 375px window (#293)', () => {
  const doc = readFileSync(join(root, 'docs/interface.md'), 'utf8')
  // #192 recorded 165px before #143 merged the git chip (adding ~34px + gap),
  // reducing the measured title width to 139px with a repository checkout.
  assert.match(
    doc,
    /at a 375px window it keeps\s+about 139px with a repository checkout/,
  )
  assert.doesNotMatch(doc, /about 165px/)
})
