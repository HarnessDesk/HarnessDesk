import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AuditLog, type AuditEntry } from '../src/audit.js'

/**
 * The audit log's read side. The write side is exercised through the host; what
 * is checked here is the question a person actually asks of it — "what happened
 * in this repository" — because the filter that answers it is a path
 * comparison, and path comparisons written as string arithmetic go wrong at
 * exactly one place: the separator.
 */

const withLog = async (
  t: { after: (fn: () => unknown) => void },
  entries: readonly Record<string, unknown>[],
): Promise<AuditLog> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.ndjson')
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return new AuditLog(path)
}

const entry = (cwd: string): Record<string, unknown> => ({
  at: Date.now(),
  runtime: 'codex',
  sessionId: 's1',
  cwd,
  kind: 'turn/completed',
})

test('query filters to a root, and a lookalike sibling is not under it', async (t) => {
  const log = await withLog(t, [entry('/repo'), entry('/repo/src'), entry('/repo-other/src'), entry('/elsewhere')])
  const found = await log.query({ root: '/repo' })
  assert.deepEqual(found.map((e) => e.cwd).sort(), ['/repo', '/repo/src'])
})

test('a root given with a trailing separator means the same root', async (t) => {
  // `${root}/` on a root that already ends in one makes `//`, which no cwd
  // begins with — so the whole log came back empty rather than filtered.
  const log = await withLog(t, [entry('/repo'), entry('/repo/src'), entry('/elsewhere')])
  const found = await log.query({ root: '/repo/' })
  assert.deepEqual(found.map((e) => e.cwd).sort(), ['/repo', '/repo/src'])
})

test('a cwd that walks out of the root is not under it', async (t) => {
  const log = await withLog(t, [entry('/repo/src'), entry('/repo/../etc')])
  const found = await log.query({ root: '/repo' })
  assert.deepEqual(found.map((e) => e.cwd), ['/repo/src'])
})

test('a query waits for every entry appended before it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const log = new AuditLog(join(dir, 'audit.ndjson'))
  /* Fifty rather than one: each write waits for the one before it, so the
     last of them lands long after a read that did not wait has answered. */
  for (let n = 0; n < 50; n += 1) log.append({ ...entry('/repo'), sessionId: `s${n}` } as unknown as AuditEntry)
  const found = await log.query({ root: '/repo' })
  assert.equal(found.length, 50)
  assert.equal(found[0]?.sessionId, 's49', 'newest first')
})
