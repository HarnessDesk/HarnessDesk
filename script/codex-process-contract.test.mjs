import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const decision = () => {
  const section = read('docs/decisions.md').split('## One Codex process per account, shared by every seat')[1]?.split('\n## ')[0]
  assert.ok(section, 'the one-process decision is documented')
  return section
}

test('the one-process decision says what was measured and what was not', () => {
  const section = decision()
  assert.match(section, /sixty seconds later/, 'the release it relies on is the measured minute')
  assert.match(section, /`thread\/closed`/)
  assert.match(section, /stayed loaded and the turn finished/, 'a working thread is not closed under its turn')
  assert.match(section, /Codex subscribes the parent's client to the sub-agent\s+without\s+announcing it/, 'a sub-agent outlives its root unless it is let go of')
  assert.match(section, /Not reproduced: the refusal a resume gets in the instant of the close/)
  assert.match(section, /how long a real tool set\s+takes to exit/)
})

test('the one-process decision names every property a seat keeps and where a separate process is called for', () => {
  const section = decision()
  for (const property of ['Working folder', 'Lane environment', 'Per-seat settings', 'Isolation', 'Accounts', 'Finishing a seat', 'The process failing']) {
    assert.match(section, new RegExp(`\\*${property}\\.\\*`), property)
  }
  assert.match(section, /\*\*Where a separate process is still called for\.\*\*/)
  assert.match(section, /\*\*What it costs\.\*\*/)
})

test('the earlier per-conversation entry points at its reversal, and the architecture says one process', () => {
  const decisions = read('docs/decisions.md')
  const earlier = decisions.split('## Finished conversations recycle their own processes')[1]?.split('\n## ')[0]
  assert.ok(earlier, 'the earlier entry stays as the record of why')
  assert.match(earlier, /Reversed by \[One Codex process per account\]\(#one-codex-process-per-account-shared-by-every-seat\)/)
  const architecture = read('docs/architecture.md')
  assert.match(architecture, /One Codex\s+process serves every conversation of an account/)
  assert.doesNotMatch(architecture, /loads in a fresh process/)
})

test('no layer of per-conversation processes is left to the runtime', () => {
  assert.equal(existsSync(new URL('../packages/adapter-codex/src/thread-servers.ts', import.meta.url)), false)
  const runtime = read('packages/adapter-codex/src/runtime.ts')
  assert.match(runtime, /this\.#server = new CodexAppServer\(serverOptions\)/)
  assert.doesNotMatch(runtime, /CodexThreadServers/)
})
