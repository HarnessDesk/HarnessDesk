import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { seatFor } from '../src/insight/attribution.js'

const seat = (id: string, openedAt: number, closedAt: number | null, restored = false) => ({
  id, runtime: 'runtime', sessionId: 'session', project: '/work/project', openedAt, closedAt, restored,
})
const sample = (from: number, to: number) => ({ runtime: 'runtime', sessionId: 'session', project: '/work/project', from, to })

test('usage through a project alias belongs to its canonical Seat without crossing projects', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'hd-insight-alias-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const project = join(parent, 'project')
  const alias = join(parent, 'alias')
  const foreign = join(parent, 'foreign')
  await mkdir(project)
  await mkdir(foreign)
  await symlink(project, alias)
  const held = { ...seat('one', 1, 5), project: await realpath(project) }
  assert.equal(seatFor({ ...sample(2, 3), project: alias }, [held]), 'one')
  assert.equal(seatFor({ ...sample(2, 3), project: foreign }, [held]), null)
})

test('unique temporal seat; overlap and boundary remain unknown', () => {
  assert.equal(seatFor(sample(2, 3), [seat('one', 1, 5)]), 'one')
  assert.equal(seatFor(sample(2, 3), [seat('one', 1, 5), seat('two', 2, 4)]), null)
  assert.equal(seatFor(sample(4, 5), [seat('one', 1, 5)]), null)
  assert.equal(seatFor(sample(2, 3), [seat('one', 1, 5, true)]), null)
})

test('reassignment never transfers old spend', () => {
  assert.equal(seatFor(sample(2, 4), [seat('old', 1, 5), seat('new', 5, null)]), 'old')
  assert.equal(seatFor(sample(5, 6), [seat('old', 1, 5), seat('new', 5, null)]), 'new')
  assert.equal(seatFor(sample(4, 5), [seat('old', 1, 5), seat('new', 5, null)]), null)
})
