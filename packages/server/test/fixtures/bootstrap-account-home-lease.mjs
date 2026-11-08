import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.HD_STATE
const primary = join(root, 'codex')
const parent = join(root, 'accounts', 'parent')
const nested = join(parent, 'child')
await mkdir(primary, { recursive: true })
await mkdir(nested, { recursive: true })
await writeFile(join(parent, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-parent' }))
if (process.env.HD_LEASE_MODE !== 'unknown') await writeFile(join(nested, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-child' }))
await writeFile(join(nested, 'sentinel'), 'keep nested owner')
await writeFile(join(root, 'accounts.json'), JSON.stringify({ accounts: [
  { id: 'codex-parent', agent: 'codex', home: parent, createdAt: 1 },
  { id: 'codex-child', agent: 'codex', home: nested, createdAt: 2 },
] }))

const { CodexRuntime } = await import(process.env.HD_ADAPTER)
const originalDispose = CodexRuntime.prototype.dispose
let entered
const stopping = new Promise(resolve => { entered = resolve })
let release
const hold = new Promise(resolve => { release = resolve })
let childDisposals = 0
CodexRuntime.prototype.dispose = async function () {
  if (this.info.id === 'codex-child' && ++childDisposals === 1) {
    entered(); await hold
    if (process.env.HD_LEASE_MODE === 'failed') throw new Error('synthetic child stop failure')
  }
  return originalDispose.call(this)
}
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { host, extensions, pathReady } = createDefaultHost({ stateDir: root, codexHome: primary, codexBinaryPath: process.env.HD_FAKE, console: false, logLevel: 'error' })
let childRemoval
try {
  await pathReady
  const ids = host.syncPayload().params.runtimes.map(runtime => runtime.id)
  assert.ok(ids.includes('codex-parent') && ids.includes('codex-child'), 'both saved owners survive startup')
  await host.start()
  childRemoval = host.call('runtime/account/remove', { runtime: 'codex-child' })
  await stopping
  if (process.env.HD_LEASE_MODE !== 'held') {
    release()
    if (process.env.HD_LEASE_MODE === 'failed') await assert.rejects(childRemoval, /did not shut down/)
    else await childRemoval
  }
  await host.call('runtime/account/remove', { runtime: 'codex-parent' })
  assert.equal(await readFile(join(nested, 'sentinel'), 'utf8'), 'keep nested owner', 'parent removal must not delete the protected child home')
  release()
  if (process.env.HD_LEASE_MODE === 'held') await childRemoval
} finally {
  release()
  if (childRemoval) await childRemoval.catch(() => {})
  await host.dispose()
  await extensions.dispose()
  CodexRuntime.prototype.dispose = originalDispose
}
