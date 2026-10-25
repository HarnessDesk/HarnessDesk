import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LeadPermissionPolicy } from '@harnessdesk/protocol'
import { loadLeadProjectPolicy } from '../src/lead/project-policy.js'

const desk: LeadPermissionPolicy = { version: 1, revision: 1, mode: 'default', rules: [] }
const rig = async (t: { after(fn: () => Promise<void>): void }) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-lead-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.harnessdesk'))
  return { root, path: join(root, '.harnessdesk', 'lead.json') }
}

test('Lead project policy is absent or a detached parsed narrowing policy', async t => {
  const { root, path } = await rig(t)
  assert.equal(await loadLeadProjectPolicy(root, desk), null)
  const narrowing = { ...desk, mode: 'plan' }
  await writeFile(path, JSON.stringify(narrowing))
  assert.deepEqual(await loadLeadProjectPolicy(root, desk), narrowing)
})

test('a widening or mixed Lead project policy blocks management', async t => {
  const { root, path } = await rig(t)
  for (const policy of [{ ...desk, mode: 'manage' }, { ...desk, rules: [
    { id: 'allow-start', effect: 'allow', method: 'flow/start-goal', action: null, project: null },
    { id: 'deny-goal', effect: 'deny', method: 'goal/read', action: null, project: null },
  ] }]) {
    await writeFile(path, JSON.stringify(policy))
    await assert.rejects(loadLeadProjectPolicy(root, desk), /widen/i)
  }
})

test('malformed, oversized, and linked Lead policy files fail closed', async t => {
  const { root, path } = await rig(t)
  for (const text of ['{', JSON.stringify({ ...desk, unexpected: true }), ' '.repeat(64 * 1024 + 1)]) {
    await writeFile(path, text)
    await assert.rejects(loadLeadProjectPolicy(root, desk))
  }
  const target = join(root, 'outside.json')
  await writeFile(target, JSON.stringify(desk))
  await rm(path)
  await symlink(target, path)
  await assert.rejects(loadLeadProjectPolicy(root, desk), /link/)
  await rm(path)
  await link(target, path)
  await assert.rejects(loadLeadProjectPolicy(root, desk), /link/)
  await rm(join(root, '.harnessdesk'), { recursive: true })
  const other = join(root, 'other')
  await mkdir(other); await writeFile(join(other, 'lead.json'), JSON.stringify(desk))
  await symlink(other, join(root, '.harnessdesk'))
  await assert.rejects(loadLeadProjectPolicy(root, desk), /link/)
})
