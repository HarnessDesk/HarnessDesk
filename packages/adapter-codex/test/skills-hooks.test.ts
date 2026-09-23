import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { SessionAttachments } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * Skills toggle and the read-only hooks view. Skills round-trip through
 * Codex's config write; hooks come back with their trust and managed state,
 * which is the whole point of showing them.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const start = async (t: { after(fn: () => Promise<void>): void }): Promise<CodexRuntime> => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  return runtime
}

test('a skill can be turned on and off, and the change reads back', async (t) => {
  const runtime = await start(t)
  const before = await runtime.listSkills!('/w')
  assert.equal(before.find((s) => s.name === 'release-notes')?.enabled, false)
  await runtime.setSkillEnabled!({ name: 'release-notes', path: '/w/.agents/skills/release-notes' }, true)
  const after = await runtime.listSkills!('/w')
  assert.equal(after.find((s) => s.name === 'release-notes')?.enabled, true)
})

test('a skill keeps its display name, one-liner, scope and accent', async (t) => {
  const runtime = await start(t)
  const skills = await runtime.listSkills!('/w')
  const rich = skills.find((s) => s.name === 'add-admin-task')
  assert.equal(rich?.displayName, 'Add Admin Task')
  assert.equal(rich?.shortDescription, 'Add a testable task')
  assert.equal(rich?.scope, 'user', 'the scope word, not the folder it was scanned from')
  assert.equal(rich?.brandColor, '#0f766e')
  assert.equal(
    skills.find((s) => s.name === 'review-checklist')?.scope,
    'repo',
    'a plain skill still says where it came from',
  )
})

test("a skill's icon is inlined from disk, and a remote one is dropped", async (t) => {
  const runtime = await start(t)
  const skills = await runtime.listSkills!('/w')
  assert.match(
    skills.find((s) => s.name === 'add-admin-task')?.iconUrl ?? '',
    /^data:image\/svg\+xml;base64,/,
    'the installed skill’s own icon file travels as a data URI',
  )
  assert.equal(
    skills.find((s) => s.name === 'review-checklist')?.iconUrl,
    null,
    'a remote iconSmallUrl is not carried: the renderer’s CSP forbids remote images, ' +
      'so it would only fail into the fallback tile one paint later',
  )
})

test('hooks come back with trust and managed state, managed ones flagged', async (t) => {
  const runtime = await start(t)
  const hooks = await runtime.listHooks!('/w')
  assert.deepEqual(
    hooks.map((hook) => [hook.id, hook.event, hook.trust, hook.managed]),
    [
      ['guard-1', 'preToolUse', 'trusted', false],
      ['managed-1', 'postToolUse', 'managed', true],
    ],
  )
})

test('seating an Agent — create and resume, with attachments asked for — never calls the global skills/config/write', async (t) => {
  // Codex reports `attachments.skills: 'unsupported'` (attachments.test.ts),
  // so a real Seat's `prepare()` would never hand it a filter in the first
  // place — but this proves the stronger, adapter-level fact directly: even
  // handed one anyway, Codex's session lifecycle touches no *global* skill
  // toggle, which would leak a filter meant for one Seat into every other
  // session on the same account.
  const dir = await mkdtemp(join(tmpdir(), 'hd-codex-attach-calls-'))
  const callLog = join(dir, 'calls.log')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test', env: { FAKE_CODEX_CALLS: callLog } })
  t.after(() => runtime.dispose())
  await runtime.start()

  const attachments: SessionAttachments = {
    key: 'k-1',
    skills: [{ name: 'demo', digest: 'd'.repeat(64), path: '~/demo' }],
    mcp: null,
    notes: null,
  }
  const session = await runtime.createSession({ cwd: '/w', attachments })
  await runtime.resumeSession(session.id, { attachments })

  const calls = (await readFile(callLog, 'utf8')).split('\n').filter(Boolean)
  assert.ok(calls.length > 0, 'sanity: the call log actually captured something')
  assert.ok(!calls.includes('skills/config/write'), `seating must never write the global skill config; saw: ${calls.join(', ')}`)
})
