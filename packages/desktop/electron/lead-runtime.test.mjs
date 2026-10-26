import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { LEAD_NODE, LEAD_NODE_RESOURCE, leadRuntimes } from './lead-runtime.mjs'

const versions = { node: '24.19.0', electron: '42.11.10' }

test("a packaged app offers its own runtime first, then the Node it bundles for the Lead", () => {
  assert.deepEqual(leadRuntimes({ execPath: '/Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk', versions, resourcesPath: '/Applications/HarnessDesk.app/Contents/Resources', packaged: true }), [
    { binary: '/Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk', version: '24.19.0', electron: true, label: "this app's runtime" },
    { binary: `/Applications/HarnessDesk.app/Contents/Resources/${LEAD_NODE_RESOURCE}`, version: LEAD_NODE.version, electron: false, label: 'the bundled runtime' },
  ])
})

test('a development launch has no bundled Node to offer', () => {
  assert.deepEqual(leadRuntimes({ execPath: '/demo/electron', versions, resourcesPath: '/demo/resources', packaged: false }),
    [{ binary: '/demo/electron', version: '24.19.0', electron: true, label: "this app's runtime" }])
})

test('main hands the host these candidates', async () => {
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8')
  assert.match(source, /import\s*\{\s*leadRuntimes\s*\}\s*from ['"]\.\/lead-runtime\.mjs['"]/)
  assert.match(source, /leadRuntimes: leadRuntimes\(\{ execPath: process\.execPath, versions: process\.versions, resourcesPath: process\.resourcesPath, packaged: app\.isPackaged \}\)/)
})
