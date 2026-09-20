import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseClientMessage, ValidationError, type ProjectChecks } from '@harnessdesk/protocol'

import { canonical } from '../src/evidence/revision.js'
import { CommandsSeen, incarnationOf, SEEN_FILE } from '../src/evidence/seen.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * A project's page lists its checks as committed, each command verbatim and
 * whether this machine has approved it for this generation of the file — and
 * says when the working copy holds something else, which is not what runs.
 * Reading them runs nothing.
 */

test("through the host: a project's checks, verbatim, and whether this machine has approved each as the file is now", async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  await mkdir(join(repo.dir, '.harnessdesk'))
  const file = join(repo.dir, '.harnessdesk', 'checks.yml')
  const commit = async (text: string): Promise<void> => {
    await writeFile(file, text)
    await repo.git('add', '.harnessdesk')
    await repo.git('commit', '-q', '-m', 'checks')
  }
  await commit('verify: { run: pnpm verify, timeout: 1200 }\nlint: { run: pnpm lint }\nodd: { run: pnpm odd, cwd: x }\n')
  const project = await canonical(repo.dir)

  const first = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.equal(first.project, project)
  assert.equal(first.exists, true)
  assert.deepEqual([first.at, first.uncommitted], [await repo.git('rev-parse', 'HEAD'), false])
  assert.deepEqual(first.checks, [
    { name: 'verify', run: 'pnpm verify', timeout: 1200, seen: 'no' },
    { name: 'lint', run: 'pnpm lint', timeout: 600, seen: 'no' },
  ])
  assert.deepEqual(first.problems.map((one) => one.at), ['odd.cwd'])

  const scope = {
    project,
    incarnation: await incarnationOf(project),
    digest: await repo.git('rev-parse', 'HEAD:.harnessdesk/checks.yml'),
  }
  await new CommandsSeen(join(stateDir, SEEN_FILE)).approve(scope, { name: 'verify', run: 'pnpm verify' })
  const seen = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.deepEqual(seen.checks.map((one) => [one.name, one.seen]), [['verify', 'yes'], ['lint', 'no']])

  // Edited in the working copy only: nothing changes but the note that it is not what runs.
  await writeFile(file, 'verify: { run: pnpm verify --all }\nlint: { run: pnpm lint }\n')
  const edited = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.deepEqual(edited.checks.map((one) => [one.name, one.run, one.seen]), [['verify', 'pnpm verify', 'yes'], ['lint', 'pnpm lint', 'no']])
  assert.equal(edited.uncommitted, true)

  // Committed: a changed command says so, and asks again.
  await commit('verify: { run: pnpm verify --all }\nlint: { run: pnpm lint }\n')
  const changed = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.deepEqual(changed.checks.map((one) => [one.name, one.seen]), [['verify', 'changed'], ['lint', 'no']])
  assert.equal(changed.uncommitted, false)
})

test('through the host: a folder the person did not open is refused before anything is read', async (t) => {
  const { host } = await evidenceDesk(t)
  await assert.rejects(
    host.call('evidence/checks', { project: tempDir('hd-not-opened-') }),
    /is outside every open workspace\. Open its folder first/,
  )
})

test('the wire refuses a checks read that names no project', () => {
  assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/checks', params: { project: '' } }), ValidationError)
  assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/checks', params: {} }), ValidationError)
})
