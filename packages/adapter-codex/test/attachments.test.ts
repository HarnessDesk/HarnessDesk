import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '../src/index.js'

/**
 * Decision 16/the plan's Codex-specific gate: generic shapes the real
 * protocol exposes — `selectedCapabilityRoots`, a per-thread `config`, a
 * cwd-scoped `SkillsListParams` — are not a measured per-Seat filtering
 * contract, and this adapter must say so honestly rather than guess from
 * their existence.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

test('unknown native filtering stays unsupported: a started Codex never claims scoped attachments', async (t) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test', env: {} })
  t.after(() => runtime.dispose())

  // Before start: nothing has been observed at all.
  const before = runtime.info.attachments
  assert.equal(before, undefined)

  await runtime.start()
  const after = runtime.info.attachments
  assert.equal(after?.skills, 'unsupported')
  assert.equal(after?.mcp, 'unsupported')
  assert.equal(after?.suppressUnapproved, false)
  assert.match(after?.reason ?? '', /no measured per-Seat attachment contract/)
})

test('mutation: promoting the existing skills capability to scoped is exactly the bug this guards', async (t) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test', env: {} })
  t.after(() => runtime.dispose())
  await runtime.start()
  // `capabilities.skills` (the broad, always-on flag) is a different fact
  // from `attachments.skills` (this stronger, per-Seat contract) — decision
  // 16 is explicit the first must never stand in for the second. If a future
  // edit conflated them, Codex's broad `skills: true` would leak into this
  // field, and this assertion is what would catch it.
  assert.notEqual(runtime.info.attachments?.skills, 'scoped')
})
