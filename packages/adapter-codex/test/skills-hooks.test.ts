import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
