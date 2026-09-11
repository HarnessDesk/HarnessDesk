import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { approvalId, type Session } from '@harnessdesk/protocol'

import { AuditLog, type AuditEntry } from '../src/audit.js'
import { Host, Logger, StateStore } from '../src/index.js'
import { FAKE_RUNTIME_ID, FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'

/**
 * The audit log's read side. The write side is exercised through the host; what
 * is checked here is the question a person actually asks of it — "what happened
 * in this repository" — because the filter that answers it is a path
 * comparison, and path comparisons written as string arithmetic go wrong at
 * exactly one place: the separator.
 */

const silent = new Logger('test', { level: 'error', console: false })

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

/*
 * The same wait, through the path the issue describes rather than through the
 * class. The unit test above holds `AuditLog`; this holds the host, because
 * "an entry recorded a moment earlier is missing from the answer" is a claim
 * about the policy fan-out and the view opened on the back of its notice
 * (#240), and nothing was driving that.
 */
test('a policy decision is in the audit as soon as the notice it pushed can be answered', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-audit-host-'))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    catalogRefreshMs: 0,
  })
  // Registered in this order because `t.after` hooks run in the order they
  // were added: the quit drains the writers, and only then is the directory
  // they write into removed.
  t.after(() => host.dispose())
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  host.register(runtime)
  await host.start()

  await host.call('app/state/set', {
    patch: {
      permissionPolicy: [{ id: 'r1', name: 'No rm -rf', match: { type: 'command', pattern: 'rm -rf' }, action: 'deny' }],
    },
  })
  const session = (await host.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  const live = runtime.sessions.get(session.id) as FakeSession

  /* No `await` between the ask and the query, deliberately. The fan-out is
     synchronous, so the rule has already appended by the time `askApproval`
     hands back its promise — and this is the earliest a window could ask,
     which is exactly when one that saw the notice does. */
  const answered = live.askApproval(approvalId('ap-policy'))
  const audit = (await host.call('audit/query', { root: '/w' })) as AuditEntry[]

  // Two controls, both true with or without the wait: the rule did answer the
  // agent, and the read side did answer the question it was asked.
  assert.deepEqual(await answered, { type: 'option', optionId: 'opt-1' }, 'the rule answered the agent')
  assert.equal(
    ((await host.call('audit/query', { root: '/somewhere-else' })) as AuditEntry[]).length,
    0,
    'a root with nothing under it answers with nothing',
  )

  assert.ok(
    audit.some((entry) => entry.kind === 'approval/autoDecided' && entry.rule === 'No rm -rf'),
    'the decision the notice announced is in the log that notice sends people to',
  )
})
