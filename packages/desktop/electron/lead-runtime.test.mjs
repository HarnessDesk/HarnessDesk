import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assert.deepEqual(leadRuntimes({ execPath: '/demo/electron', versions, resourcesPath: '/demo/resources', packaged: false, desktopPath: '/demo/desktop', arch: 'arm64' }),
    [{ binary: '/demo/electron', version: '24.19.0', electron: true, label: "this app's runtime" }])
})

test('main hands the host these candidates', async () => {
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8')
  assert.match(source, /import\s*\{\s*leadRuntimes\s*\}\s*from ['"]\.\/lead-runtime\.mjs['"]/)
  assert.match(source, /leadRuntimes: leadRuntimes\(\{ execPath: process\.execPath, versions: process\.versions, resourcesPath: process\.resourcesPath, packaged: app\.isPackaged, arch: process\.arch \}\)/)
})


test('a development launch offers an existing fetched runtime after the app runtime', async t => {
  const desktopPath = await mkdtemp(join(tmpdir(), 'hd-lead-dev-'))
  t.after(() => rm(desktopPath, { recursive: true, force: true }))
  const binary = join(desktopPath, '.lead-node', 'arm64', 'bin', 'node')
  await mkdir(join(desktopPath, '.lead-node', 'arm64', 'bin'), { recursive: true })
  await writeFile(binary, 'fixture')
  const candidates = leadRuntimes({ execPath: '/demo/electron', versions, resourcesPath: '/demo/resources', packaged: false, desktopPath, arch: 'arm64' })
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates[1], { binary, version: LEAD_NODE.version, electron: false, label: 'the fetched runtime' })
  assert.equal(leadRuntimes({ execPath: '/demo/electron', versions, packaged: false, desktopPath, arch: 'x64' }).length, 1)
})
