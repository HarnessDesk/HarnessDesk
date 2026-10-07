import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const { createDefaultHost, loadBuiltinPlugins } = await import(process.env.HD_BOOTSTRAP)
const root = process.env.HD_STATE
const work = process.env.HD_WORK
const hold = process.env.FAKE_CODEX_HOLD_ACCOUNT
await writeFile(hold, '')

// The desk's own order — packages/desktop/electron/main.mjs and bin.ts: the host built whole, the
// plugins loaded, the host started — and then the first thing a Team does: resolve a seat on Codex.
const { host, extensions, pathReady } = createDefaultHost({
  stateDir: root, codexHome: join(root, 'codex'), codexBinaryPath: process.env.HD_FAKE,
  console: false, logLevel: 'error',
})
try {
  await pathReady
  await loadBuiltinPlugins(extensions)
  await host.start()
  assert.equal(host.runtimeInfo('codex')?.version, 'codex-cli 0.149.0', 'the runtime has started')
  assert.ok((await host.call('runtime/models', { runtime: 'codex' })).length > 0, 'and lists its models')

  await mkdir(join(work, 'agents', 'implementer'), { recursive: true })
  await writeFile(join(work, 'agents', 'implementer', 'AGENT.md'), '---\nname: Implementer\nceiling: read\nprefer: [codex]\n---\nDo the work.\n')
  await host.call('workspace/open', { path: work })
  const noticed = new Promise((resolve) => {
    const stop = host.addBroadcaster((notification) => {
      if (notification.method !== 'event' || notification.params.event.type !== 'account/changed') return
      stop()
      resolve()
    })
  })
  const source = 'version: 2\nname: Account notice\nroles:\n  implementer: { kind: agent, uses: implementer }\nseed: { role: implementer, title: Work }\nrules: []\n'
  const preview = host.call('flow/preview', { root: work, source })
  await noticed // the account read the seat made is in flight, held, and the notice has just landed on it
  await rm(hold)
  const resolved = await preview
  assert.ok(resolved.token, `the seat was refused: ${JSON.stringify(resolved.problems)}`)
} finally {
  await host.dispose()
  await extensions.dispose()
}
