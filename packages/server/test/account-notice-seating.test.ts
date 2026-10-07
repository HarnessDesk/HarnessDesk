import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '@harnessdesk/adapter-codex'

import { Host, StateStore } from '../src/index.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * A signed-in Codex says `account/updated` once, on its own, about 0.6 s after
 * it is up (`script/probe/account-notice.mjs`). The desk reads that account the
 * moment it resolves a seat — which, after a start, is inside that window — so
 * the notice lands on a read in flight. It used to fail that read with "Account
 * changed during a read. Try again.", which the seat offer reported as
 * `unavailable`: every Flow seat on Codex was refused for the first second after
 * each start of its process, and the refusal said only "No seat could be opened".
 *
 * The scripted Codex plays it exactly there: it says the notice as the first
 * `account/read` arrives, and holds that read until the test lets it go.
 */

const FAKE = fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url))

const AGENT = '---\nname: Implementer\nceiling: read\nprefer: [codex]\n---\nDo the work.\n'
const FLOW = [
  'version: 2',
  'name: Account notice',
  'roles:',
  '  implementer: { kind: agent, uses: implementer }',
  'seed: { role: implementer, title: Work }',
  'rules: []',
  '',
].join('\n')

test('a Flow seat on a signed-in Codex is not refused because its account notice lands while the account is read', { timeout: 30_000 }, async (t) => {
  const home = tempDir('hd-account-notice-')
  const hold = join(home, 'hold-account')
  await writeFile(hold, '')
  const runtime = new CodexRuntime({
    binaryPath: FAKE,
    codexHome: join(home, 'codex'),
    env: { FAKE_CODEX_ACCOUNT_NOTICE: 'first-read', FAKE_CODEX_HOLD_ACCOUNT: hold },
  })
  const host = new Host({ logger: silent, state: new StateStore(join(home, 'state.json')), version: '9.9.9', catalogRefreshMs: 0 })
  host.register(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await host.start()
  await mkdir(join(home, 'agents', 'implementer'), { recursive: true })
  await writeFile(join(home, 'agents', 'implementer', 'AGENT.md'), AGENT)
  await host.call('workspace/open', { path: home })

  const noticed = new Promise<void>((resolve) => {
    const stop = host.addBroadcaster((notification) => {
      if (notification.method !== 'event' || notification.params.event.type !== 'account/changed') return
      stop()
      resolve()
    })
  })
  const preview = host.call('flow/preview', { root: home, source: FLOW })
  await noticed // the preview's account read is in flight, held, and the notice has just landed on it
  await rm(hold) // now Codex answers it
  const resolved = await preview
  assert.ok(resolved.token, `the seat was refused: ${JSON.stringify(resolved.problems)}`)
})
